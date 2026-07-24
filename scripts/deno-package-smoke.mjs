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
  const row = await db.sql.one(
    "SELECT $1::jsonb AS payload, $2::int[] AS values",
    db.sql.json({ ok: true }),
    db.sql.array([1, 2, 3]),
  );
  assert.deepEqual(row, { payload: { ok: true }, values: [1, 2, 3] });

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
