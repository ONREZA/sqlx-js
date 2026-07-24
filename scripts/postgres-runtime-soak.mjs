import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import process from "node:process";
import { createClient, createSqlClient } from "../dist/src/index.js";

const databaseUrl = process.env.SQLX_JS_SOAK_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("runtime soak requires SQLX_JS_SOAK_DATABASE_URL");
}

const durationMs = Number(process.env.SQLX_JS_SOAK_DURATION_MS ?? 60_000);
const maxConnections = Number(process.env.SQLX_JS_SOAK_MAX_CONNECTIONS ?? 8);
const concurrency = Number(process.env.SQLX_JS_SOAK_CONCURRENCY ?? maxConnections * 2);
const operationTimeoutMs = Number(process.env.SQLX_JS_SOAK_OPERATION_TIMEOUT_MS ?? 500);
const applicationName = `sqlx-js-soak-${process.pid}-${Date.now()}`;
const deadline = Date.now() + durationMs;
const metrics = {
  successfulOperations: 0,
  expectedFaults: 0,
  unexpectedErrorCount: 0,
  unexpectedErrors: [],
  terminatedBackends: 0,
  timeoutOperations: 0,
  maxBackends: 0,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileDescriptorCount() {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

function recordFault(error) {
  const name = error instanceof Error ? error.name : "UnknownError";
  if (
    name === "ConnectionLostError"
    || name === "GenerationRecycledError"
    || name === "QueryTimeoutError"
    || (name === "PgError" && (error.code === "57014" || error.code === "57P01"))
  ) {
    metrics.expectedFaults++;
    if (name === "QueryTimeoutError") metrics.timeoutOperations++;
    return;
  }
  recordUnexpectedError(error);
}

function recordUnexpectedError(error) {
  metrics.unexpectedErrorCount++;
  if (metrics.unexpectedErrors.length < 20) {
    metrics.unexpectedErrors.push(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}

const fdStart = fileDescriptorCount();
let fdPeak = fdStart;
const workload = createSqlClient(databaseUrl, {
  max: maxConnections,
  applicationName,
  operationTimeoutMs,
  cancelGraceMs: 100,
});
const controller = createClient(databaseUrl, {
  max: 1,
  applicationName: `${applicationName}-controller`,
  statementTimeoutMs: 5_000,
});

async function backendCount() {
  const rows = await controller.unsafe(
    `SELECT pg_catalog.count(*)::int4 AS count
     FROM pg_catalog.pg_stat_activity
     WHERE application_name = $1`,
    [applicationName],
  );
  return rows[0].count;
}

async function worker(workerId) {
  let sequence = 0;
  while (Date.now() < deadline) {
    try {
      if (sequence % 20 === 0) {
        await workload.sql.transaction({ timeoutMs: operationTimeoutMs }, async (tx) => {
          await tx.one("SELECT $1::int4 AS worker_id", workerId);
          await tx.one("SELECT $1::int4 AS sequence", sequence);
        });
      } else {
        await workload.unsafe(
          "SELECT pg_backend_pid()::int4 AS pid, pg_sleep(0.005), $1::int4 AS value",
          sequence,
        );
      }
      metrics.successfulOperations++;
    } catch (error) {
      recordFault(error);
    }
    sequence++;
  }
}

async function injectFaults() {
  let nextTimeout = Date.now();
  while (Date.now() < deadline) {
    try {
      const rows = await controller.unsafe(
        `SELECT pg_catalog.pg_terminate_backend(pid) AS terminated
         FROM pg_catalog.pg_stat_activity
         WHERE application_name = $1
           AND pid <> pg_catalog.pg_backend_pid()
         ORDER BY backend_start
         LIMIT 1`,
        [applicationName],
      );
      if (rows[0]?.terminated === true) metrics.terminatedBackends++;
      const count = await backendCount();
      metrics.maxBackends = Math.max(metrics.maxBackends, count);
      const currentFds = fileDescriptorCount();
      if (currentFds !== null) fdPeak = Math.max(fdPeak ?? currentFds, currentFds);
    } catch (error) {
      recordUnexpectedError(error);
    }

    if (Date.now() >= nextTimeout) {
      try {
        await workload.unsafe("SELECT pg_sleep(2)");
      } catch (error) {
        recordFault(error);
      }
      nextTimeout = Date.now() + 1_000;
    }
    await delay(100);
  }
}

async function waitForRecovery() {
  const recoveryDeadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < recoveryDeadline) {
    try {
      await workload.ping({ timeoutMs: 2_000 });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}

try {
  await workload.ready({ timeoutMs: 5_000 });
  await Promise.all([
    ...Array.from({ length: concurrency }, (_, index) => worker(index)),
    injectFaults(),
  ]);
  await waitForRecovery();
  const snapshot = workload.snapshot();

  assert.equal(snapshot.state, "healthy");
  assert.equal(snapshot.activeOperations, 0);
  assert.ok(snapshot.recycleCount > 0);
  assert.ok(metrics.successfulOperations > 0);
  assert.ok(metrics.terminatedBackends > 0);
  assert.ok(metrics.timeoutOperations > 0);
  assert.ok(metrics.maxBackends <= maxConnections);
  assert.equal(metrics.unexpectedErrorCount, 0);

  await workload.close({ graceMs: 1_000, forceAfterMs: 5_000 });
  const backendDeadline = Date.now() + 5_000;
  let remainingBackends = await backendCount();
  while (remainingBackends !== 0 && Date.now() < backendDeadline) {
    await delay(100);
    remainingBackends = await backendCount();
  }
  const fdEnd = fileDescriptorCount();
  assert.equal(remainingBackends, 0);
  if (fdStart !== null && fdEnd !== null) assert.ok(fdEnd <= fdStart + 4);

  process.stdout.write(`${JSON.stringify({
    durationMs,
    maxConnections,
    concurrency,
    operationTimeoutMs,
    ...metrics,
    recycleCount: snapshot.recycleCount,
    fdStart,
    fdPeak,
    fdEnd,
    remainingBackends,
  })}\n`);
} finally {
  await workload.close({ graceMs: 0, forceAfterMs: 5_000 }).catch(() => {});
  await controller.end().catch(() => {});
}
