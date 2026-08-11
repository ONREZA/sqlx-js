import assert from "node:assert/strict";
import { Temporal } from "npm:temporal-polyfill@1.0.3";
import {
  createSqlClient,
  JsonNumber,
  queryId,
  QueryAbortedError,
  SqlxJson,
  tryAcquirePostgresAdvisoryLock,
} from "@onreza/sqlx-js";
import descriptorVersions from "../example/.sqlx-js/runtime-descriptors.json" with { type: "json" };

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) throw new Error("deno package smoke requires DATABASE_URL");

const descriptorQuery = "SELECT $1::int4 AS descriptor_value";
const db = createSqlClient(databaseUrl, {
  max: 1,
  keepAliveMs: 0,
  temporalApi: Temporal,
  queryDescriptors: {
    formatVersion: descriptorVersions.formatVersion,
    cacheFormat: descriptorVersions.cacheFormat,
    generatorRevision: descriptorVersions.generatorRevision,
    jsonProtocol: descriptorVersions.jsonProtocol,
    configHash: "deno-package-smoke",
    temporal: descriptorVersions.temporal,
    types: {},
    queries: {
      [queryId(descriptorQuery)]: { params: [23] },
    },
    profiles: {},
  },
});
try {
  await db.ready({ timeoutMs: 5_000 });
  assert.deepEqual(await db.sql.one(descriptorQuery, 42), { descriptor_value: 42 });
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
    db.sql.json({
      ok: true,
      id: 9_007_199_254_740_993n,
      exact: JsonNumber.from("12345678901234567890.125"),
      at: Temporal.Instant.from("2026-08-04T10:15:30.123456789Z"),
    }),
    db.sql.array([1, 2, 3]),
    bytes,
  );
  assert.ok(row.payload instanceof SqlxJson);
  assert.deepEqual(row.payload.value, {
    ok: true,
    id: 9_007_199_254_740_993n,
    exact: JsonNumber.from("12345678901234567890.125"),
    at: Temporal.Instant.from("2026-08-04T10:15:30.123456789Z"),
  });
  assert.deepEqual({ ...row, payload: undefined }, {
    payload: undefined,
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
    const requestTx = tx.with({ timeoutMs: 5_000 });
    await requestTx.execute("CREATE TEMP TABLE deno_values (value int NOT NULL)");
    await Promise.all([
      requestTx.execute("INSERT INTO deno_values (value) VALUES ($1)", 1),
      requestTx.execute("INSERT INTO deno_values (value) VALUES ($1)", 2),
    ]);
    return await requestTx("SELECT value FROM deno_values ORDER BY value");
  });
  assert.deepEqual(values, [{ value: 1 }, { value: 2 }]);

  const controller = new AbortController();
  const pending = db.sql.with({ signal: controller.signal })("SELECT pg_sleep(10)");
  setTimeout(() => controller.abort("deno smoke"), 50);
  await assert.rejects(
    pending,
    (error) => error instanceof QueryAbortedError && error.reason === "deno smoke",
  );
  await db.ping({ timeoutMs: 5_000 });
  const lockKey = { namespace: 1_728_194_883, resource: 102 };
  const lockOptions = {
    temporalApi: Temporal,
    applicationName: "sqlx-js-deno-smoke-lock",
    operationTimeoutMs: 5_000,
  };
  const lock = await tryAcquirePostgresAdvisoryLock(databaseUrl, lockKey, lockOptions);
  assert.ok(lock);
  try {
    await lock.assertHeld();
    assert.equal(await tryAcquirePostgresAdvisoryLock(databaseUrl, lockKey, lockOptions), null);
  } finally {
    await lock.release();
  }
} finally {
  await db.close({ graceMs: 100, forceAfterMs: 1_000 });
}

console.log("deno built package entrypoint ok");
