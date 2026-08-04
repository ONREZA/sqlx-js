import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import { Temporal } from "@js-temporal/polyfill";
import {
  createClient,
  createSqlClient,
  defineQuery,
} from "../dist/src/index.js";

const configPath = process.argv[2];
if (!configPath) throw new Error("PostgreSQL auth/TLS client requires a config path");

const config = JSON.parse(readFileSync(configPath, "utf8"));
const cases = config.cases;
const runtime = globalThis.Deno
  ? `deno-${globalThis.Deno.version.deno}`
  : process.versions.bun
    ? `bun-${process.versions.bun}`
    : `node-${process.versions.node}`;

async function connectionState(client) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await client.unsafe(`
      SELECT
        current_user AS current_user,
        ssl,
        client_dn
      FROM pg_catalog.pg_stat_ssl
      WHERE pid = pg_catalog.pg_backend_pid()
    `);
    if (rows.length === 1) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("current PostgreSQL TLS backend was not observable");
}

for (const testCase of cases) {
  process.stdout.write(`${runtime} ${testCase.name} start\n`);
  const client = createClient(testCase.url, {
    max: 1,
    temporalApi: Temporal,
    applicationName: `sqlx-js-compat-${runtime}-${testCase.name}`,
  });
  try {
    if (testCase.failure) {
      await assert.rejects(Promise.resolve(client.unsafe("SELECT 1")));
    } else {
      const state = await connectionState(client);
      assert.equal(state.current_user, testCase.user);
      assert.equal(state.ssl, testCase.tls);
      if (testCase.clientCertificate) {
        assert.match(state.client_dn, /CN=tls_user/);
      }
    }
    process.stdout.write(`${runtime} ${testCase.name} ok\n`);
  } finally {
    await client.end();
  }

  if (testCase.managedFailure) {
    const errors = [];
    const managed = createSqlClient(testCase.url, {
      max: 1,
      temporalApi: Temporal,
      onQueryError: (event) => errors.push(event),
    });
    try {
      await assert.rejects(managed.ready());
      assert.equal(errors.length, 1);
      assert.equal(errors[0].queryName, "sqlx-js.ready");
      assert.equal(errors[0].phase, "bootstrap");
      assert.equal(errors[0].outcome, "not_sent");
      assert.equal(typeof errors[0].errorName, "string");
      assert.equal("query" in errors[0], false);
      assert.equal("params" in errors[0], false);
      assert.equal("url" in errors[0], false);
    } finally {
      await managed.close({ graceMs: 0, forceAfterMs: 1_000 });
    }
  }
}

async function tlsBackends(client) {
  const rows = await Promise.all(Array.from({ length: 20 }, async () => {
    const result = await client.unsafe(`
      SELECT pg_backend_pid()::int4 AS pid, ssl, pg_sleep(0.05)
      FROM pg_catalog.pg_stat_ssl
      WHERE pid = pg_backend_pid()
    `);
    assert.equal(result.length, 1);
    assert.equal(result[0].ssl, true);
    return result[0].pid;
  }));
  return new Set(rows);
}

async function eventually(operation) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

if (config.managedUrl) {
  process.stdout.write(`${runtime} managed-generations start\n`);
  const starts = [];
  const errors = [];
  const first = createSqlClient(config.managedUrl, {
    max: 10,
    temporalApi: Temporal,
    applicationName: `sqlx-js-compat-${runtime}-managed-first`,
    onQueryStart: (event) => starts.push(event),
    onQueryError: (event) => errors.push(event),
    cancelGraceMs: 100,
  });
  const second = createSqlClient(config.managedUrl, {
    max: 10,
    temporalApi: Temporal,
    applicationName: `sqlx-js-compat-${runtime}-managed-second`,
  });
  try {
    await Promise.all([first.ready(), second.ready()]);
    const firstGeneration = await tlsBackends(first);
    const secondGeneration = await tlsBackends(second);
    assert.equal(firstGeneration.size, 10);
    assert.equal(secondGeneration.size, 10);

    const terminatedPid = firstGeneration.values().next().value;
    const termination = await second.unsafe(
      "SELECT pg_terminate_backend($1::int4) AS terminated",
      terminatedPid,
    );
    assert.equal(termination[0].terminated, true);
    await first.ping().catch(() => {});
    const replacedSlot = await eventually(() => tlsBackends(first));
    assert.equal(replacedSlot.size, 10);
    assert.equal([...replacedSlot].some((pid) => !firstGeneration.has(pid)), true);

    const timeoutQuery = defineQuery(
      "tls-generation-timeout",
      "SELECT pg_sleep(1)",
    );
    await assert.rejects(
      timeoutQuery.runWith({ timeoutMs: 25 }, first.sql),
      (error) => error?.name === "QueryTimeoutError",
    );
    await eventually(async () => {
      const snapshot = first.snapshot();
      assert.equal(snapshot.state, "healthy");
      assert.equal(snapshot.generation, 2);
    });
    const recycledGeneration = await eventually(() => tlsBackends(first));
    assert.equal(recycledGeneration.size, 10);
    assert.equal([...recycledGeneration].every((pid) => !replacedSlot.has(pid)), true);
    assert.equal(
      starts.filter((event) => event.queryName === "tls-generation-timeout").length,
      1,
    );
    assert.equal(
      errors.some((event) =>
        event.queryName === "tls-generation-timeout"
        && event.phase === "execution"
        && event.outcome === "unknown"
        && event.errorName === "QueryTimeoutError"
      ),
      true,
    );
    assert.equal(second.snapshot().generation, 1);
    assert.equal((await tlsBackends(second)).size, 10);
    process.stdout.write(`${runtime} managed-generations ok\n`);
  } finally {
    await Promise.all([
      first.close({ graceMs: 0, forceAfterMs: 1_000 }),
      second.close({ graceMs: 0, forceAfterMs: 1_000 }),
    ]);
  }
}
