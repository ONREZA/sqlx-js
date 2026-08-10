import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import process from "node:process";
import { promisify } from "node:util";
import { Temporal } from "temporal-polyfill";
import { createSqlClient } from "../dist/src/index.js";

const execFileAsync = promisify(execFile);
const suffix = `${process.pid}-${Date.now()}`;
const network = `sqlx-js-chaos-${suffix}`;
const postgresContainer = `sqlx-js-chaos-postgres-${suffix}`;
const proxyContainer = `sqlx-js-chaos-proxy-${suffix}`;
const postgresImage = process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg18";
const proxyImage = process.env.SQLX_JS_TOXIPROXY_IMAGE ?? "ghcr.io/shopify/toxiproxy:2.12.0";
const maxConnections = Number(process.env.SQLX_JS_CHAOS_MAX_CONNECTIONS ?? 8);
const concurrency = Number(process.env.SQLX_JS_CHAOS_CONCURRENCY ?? maxConnections * 2);
const operationTimeoutMs = Number(process.env.SQLX_JS_CHAOS_OPERATION_TIMEOUT_MS ?? 500);
const blackholeMs = Number(process.env.SQLX_JS_CHAOS_BLACKHOLE_MS ?? 2_000);
const applicationName = `sqlx-js-chaos-${suffix}`;
const expectedFaultNames = new Set([
  "ConnectionLostError",
  "GenerationRecycledError",
  "QueryTimeoutError",
]);
const expectedPgCodes = new Set(["57P01", "57P02", "57P03"]);
const expectedNetworkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);
const faultPhases = new Set([
  "blackhole",
  "blackhole-recovery",
  "restart",
  "restart-recovery",
]);
const metrics = {
  successfulOperations: 0,
  expectedFaults: 0,
  unexpectedErrors: [],
  phases: Object.create(null),
  stateTransitions: [],
};
let phase = "baseline";
let stopping = false;

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

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${details ? `\n${details}` : ""}`, {
      cause: error,
    });
  }
}

async function docker(args) {
  return await run("docker", args);
}

async function cleanup() {
  await execFileAsync("docker", ["rm", "--force", proxyContainer]).catch(() => {});
  await execFileAsync("docker", ["rm", "--force", postgresContainer]).catch(() => {});
  await execFileAsync("docker", ["network", "rm", network]).catch(() => {});
}

function mappedPort(output) {
  const value = output.trim();
  const separator = value.lastIndexOf(":");
  if (separator === -1) throw new Error(`unexpected Docker port mapping: ${value}`);
  return value.slice(separator + 1);
}

async function waitFor(check, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(message, { cause: lastError });
}

async function waitForPostgres() {
  await waitFor(async () => {
    try {
      const logs = await docker(["logs", postgresContainer]);
      if (!`${logs.stdout}${logs.stderr}`.includes(
        "PostgreSQL init process complete; ready for start up.",
      )) {
        return false;
      }
      await docker([
        "exec",
        postgresContainer,
        "psql",
        "-U",
        "postgres",
        "-d",
        "sqlx_js_chaos",
        "-Atqc",
        "SELECT 1",
      ]);
      return true;
    } catch {
      return false;
    }
  }, "PostgreSQL chaos container did not become ready");
}

async function proxyRequest(controlUrl, path, options = {}) {
  const response = await fetch(`${controlUrl}${path}`, {
    ...options,
    headers: options.body === undefined
      ? options.headers
      : { "content-type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    throw new Error(`Toxiproxy ${options.method ?? "GET"} ${path} returned ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function phaseMetrics(name = phase) {
  metrics.phases[name] ??= { successfulOperations: 0, expectedFaults: 0 };
  return metrics.phases[name];
}

function errorChain(error) {
  const chain = [];
  let current = error;
  while (current && typeof current === "object" && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function isExpectedFault(error) {
  if (!faultPhases.has(phase)) return false;
  return errorChain(error).some((item) => (
    expectedFaultNames.has(item.name)
    || expectedPgCodes.has(item.code)
    || expectedNetworkCodes.has(item.code)
    || (
      (phase === "restart" || phase === "restart-recovery")
      && item.message === "sqlx-js: unexpected SSL handshake reply byte 0x45"
    )
  ));
}

function recordError(error) {
  if (isExpectedFault(error)) {
    metrics.expectedFaults++;
    phaseMetrics().expectedFaults++;
    return;
  }
  if (metrics.unexpectedErrors.length < 20) {
    metrics.unexpectedErrors.push(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}

async function waitForRecovery(client, previousSuccesses) {
  await waitFor(async () => {
    try {
      await client.ping({ timeoutMs: 2_000 });
      return true;
    } catch {
      return false;
    }
  }, `managed client did not recover after ${phase}`, 20_000);
  await waitFor(
    () => metrics.successfulOperations >= previousSuccesses + 100,
    `workload did not resume after ${phase}`,
    20_000,
  );
}

async function backendCount() {
  const sql = `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${applicationName}'`;
  const { stdout } = await docker([
    "exec",
    postgresContainer,
    "psql",
    "-U",
    "postgres",
    "-d",
    "sqlx_js_chaos",
    "-Atqc",
    sql,
  ]);
  return Number(stdout.trim());
}

async function main() {
  await docker(["network", "create", network]);
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    postgresContainer,
    "--network",
    network,
    "--network-alias",
    "postgres",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    "POSTGRES_PASSWORD=postgres",
    "--env",
    "POSTGRES_DB=sqlx_js_chaos",
    postgresImage,
  ]);
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    proxyContainer,
    "--network",
    network,
    "--publish",
    "127.0.0.1::8474",
    "--publish",
    "127.0.0.1::8666",
    proxyImage,
  ]);
  await waitForPostgres();

  const controlPort = mappedPort((await docker(["port", proxyContainer, "8474/tcp"])).stdout);
  const databasePort = mappedPort((await docker(["port", proxyContainer, "8666/tcp"])).stdout);
  const controlUrl = `http://127.0.0.1:${controlPort}`;
  await waitFor(async () => {
    try {
      const response = await fetch(`${controlUrl}/version`);
      return response.ok;
    } catch {
      return false;
    }
  }, "Toxiproxy control API did not become ready");
  await proxyRequest(controlUrl, "/proxies", {
    method: "POST",
    body: JSON.stringify({
      name: "postgres",
      listen: "0.0.0.0:8666",
      upstream: "postgres:5432",
    }),
  });

  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${databasePort}/sqlx_js_chaos`;
  const fdStart = fileDescriptorCount();
  let fdPeak = fdStart;
  const client = createSqlClient(databaseUrl, {
    max: maxConnections,
    temporalApi: Temporal,
    applicationName,
    connectTimeoutMs: operationTimeoutMs,
    operationTimeoutMs,
    cancelGraceMs: 100,
    onLifecycle: (event) => {
      if (event.kind !== "state-change") return;
      metrics.stateTransitions.push({
        from: event.from,
        to: event.to,
        generation: event.generation,
      });
    },
  });

  async function worker(workerId) {
    let sequence = 0;
    while (!stopping) {
      try {
        await client.unsafe(
          "SELECT pg_sleep(0.01), $1::int4 AS worker_id, $2::int4 AS sequence",
          workerId,
          sequence,
        );
        metrics.successfulOperations++;
        phaseMetrics().successfulOperations++;
      } catch (error) {
        recordError(error);
      }
      const currentFds = fileDescriptorCount();
      if (currentFds !== null) fdPeak = Math.max(fdPeak ?? currentFds, currentFds);
      sequence++;
    }
  }

  try {
    await client.ready({ timeoutMs: 5_000 });
    const workers = Array.from({ length: concurrency }, (_, index) => worker(index));
    await waitFor(
      () => metrics.successfulOperations >= 200,
      "baseline workload did not become healthy",
      10_000,
    );

    phase = "blackhole";
    await proxyRequest(controlUrl, "/proxies/postgres/toxics", {
      method: "POST",
      body: JSON.stringify({
        name: "blackhole",
        type: "timeout",
        stream: "downstream",
        toxicity: 1,
        attributes: { timeout: 0 },
      }),
    });
    await delay(blackholeMs);
    assert.ok(phaseMetrics("blackhole").expectedFaults > 0);

    phase = "blackhole-recovery";
    const beforeBlackholeRecovery = metrics.successfulOperations;
    await proxyRequest(controlUrl, "/proxies/postgres/toxics/blackhole", { method: "DELETE" });
    await waitForRecovery(client, beforeBlackholeRecovery);

    phase = "restart";
    const beforeRestart = metrics.successfulOperations;
    await docker(["restart", "--time", "0", postgresContainer]);
    await waitForPostgres();

    phase = "restart-recovery";
    await waitForRecovery(client, beforeRestart);
    assert.ok(
      phaseMetrics("restart").expectedFaults + phaseMetrics("restart-recovery").expectedFaults > 0,
    );

    phase = "steady";
    const beforeSteady = metrics.successfulOperations;
    await waitFor(
      () => metrics.successfulOperations >= beforeSteady + 200,
      "steady workload did not remain healthy",
      10_000,
    );
    stopping = true;
    await Promise.all(workers);
    await client.ping({ timeoutMs: 2_000 });

    const snapshot = client.snapshot();
    assert.equal(snapshot.state, "healthy");
    assert.equal(snapshot.activeOperations, 0);
    assert.ok(snapshot.recycleCount >= 2);
    assert.equal(
      metrics.unexpectedErrors.length,
      0,
      `unexpected chaos errors: ${metrics.unexpectedErrors.join("; ")}`,
    );

    await client.close({ graceMs: 1_000, forceAfterMs: 5_000 });
    await waitFor(() => backendCount().then((count) => count === 0), "chaos backends remained after close");
    const fdEnd = fileDescriptorCount();
    if (fdStart !== null && fdEnd !== null) assert.ok(fdEnd <= fdStart + 4);

    process.stdout.write(`${JSON.stringify({
      postgresImage,
      proxyImage,
      maxConnections,
      concurrency,
      operationTimeoutMs,
      blackholeMs,
      successfulOperations: metrics.successfulOperations,
      expectedFaults: metrics.expectedFaults,
      unexpectedErrors: metrics.unexpectedErrors,
      phases: metrics.phases,
      stateTransitions: metrics.stateTransitions,
      generation: snapshot.generation,
      recycleCount: snapshot.recycleCount,
      fdStart,
      fdPeak,
      fdEnd,
      remainingBackends: 0,
    })}\n`);
  } finally {
    stopping = true;
    await client.close({ graceMs: 0, forceAfterMs: 5_000 }).catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  const logs = await execFileAsync("docker", ["logs", postgresContainer], {
    encoding: "utf8",
  }).catch(() => ({ stdout: "", stderr: "" }));
  process.stderr.write(logs.stdout ?? "");
  process.stderr.write(logs.stderr ?? "");
  throw error;
} finally {
  await cleanup();
}
