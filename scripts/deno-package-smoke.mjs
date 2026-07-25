import assert from "node:assert/strict";
import {
  createSqlClient,
  defineQuery,
  QueryAbortedError,
} from "@onreza/sqlx-js";

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) throw new Error("deno package smoke requires DATABASE_URL");

const db = createSqlClient(databaseUrl, { max: 1 });
try {
  await db.ready({ timeoutMs: 5_000 });
  const bytes = new Uint8Array([0x00, 0x5c, 0x7f, 0xff]);
  const row = await db.sql.one(
    `SELECT
       $1::jsonb AS payload,
       $2::int[] AS values,
       $3::bytea AS bytes,
       9007199254740993::int8 AS bigint,
       '[0:2]={-2,NULL,3}'::int2[] AS bounded,
       ARRAY[[-1,2],[3,-4]]::int4[][] AS matrix,
       ARRAY[0::oid, 4294967295::oid, NULL]::oid[] AS oids`,
    db.sql.json({ ok: true }),
    db.sql.array([1, 2, 3]),
    bytes,
  );
  assert.deepEqual(row, {
    payload: { ok: true },
    values: [1, 2, 3],
    bytes,
    bigint: 9007199254740993n,
    bounded: [-2, null, 3],
    matrix: [[-1, 2], [3, -4]],
    oids: [0, 4294967295, null],
  });
  await db.sql.execute("SET bytea_output=escape");
  assert.deepEqual(
    await db.sql.one("SELECT decode('005c7fff', 'hex') AS bytes"),
    { bytes },
  );

  const values = await db.sql.transaction(async (tx) => {
    await tx.execute("CREATE TEMP TABLE deno_values (value int NOT NULL)");
    await Promise.all([
      tx.execute("INSERT INTO deno_values (value) VALUES ($1)", 1),
      tx.execute("INSERT INTO deno_values (value) VALUES ($1)", 2),
    ]);
    return await tx("SELECT value FROM deno_values ORDER BY value");
  });
  assert.deepEqual(values, [{ value: 1 }, { value: 2 }]);

  const controller = new AbortController();
  const pending = defineQuery("SELECT pg_sleep(10)").runWith(
    { signal: controller.signal },
    db.sql,
  );
  setTimeout(() => controller.abort("deno smoke"), 50);
  await assert.rejects(
    pending,
    (error) => error instanceof QueryAbortedError && error.reason === "deno smoke",
  );
  await db.ping({ timeoutMs: 5_000 });
} finally {
  await db.close({ graceMs: 100, forceAfterMs: 1_000 });
}

console.log("deno built package entrypoint ok");
