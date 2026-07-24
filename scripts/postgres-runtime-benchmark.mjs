import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import postgres from "postgres";
import { createClient, createSqlClient } from "../dist/src/index.js";

const execFileAsync = promisify(execFile);
const suffix = `${process.pid}-${Date.now()}`;
const container = `sqlx-js-benchmark-${suffix}`;
const postgresImage = process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg18";
const warmupMs = Number(process.env.SQLX_JS_BENCHMARK_WARMUP_MS ?? 1_000);
const durationMs = Number(process.env.SQLX_JS_BENCHMARK_DURATION_MS ?? 3_000);
const rounds = Number(process.env.SQLX_JS_BENCHMARK_ROUNDS ?? 3);
const providedDatabaseUrl = process.env.SQLX_JS_BENCHMARK_DATABASE_URL;
const scenarioFilter = process.env.SQLX_JS_BENCHMARK_SCENARIO;
const driverFilter = process.env.SQLX_JS_BENCHMARK_DRIVER;
const results = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function docker(args) {
  return await execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function waitForPostgres() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const logs = await docker(["logs", container]);
      if (!`${logs.stdout}${logs.stderr}`.includes(
        "PostgreSQL init process complete; ready for start up.",
      )) {
        await delay(100);
        continue;
      }
      await docker([
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "sqlx_js_benchmark",
        "-Atqc",
        "SELECT 1",
      ]);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("PostgreSQL benchmark container did not become ready");
}

function mappedPort(output) {
  const value = output.trim();
  const separator = value.lastIndexOf(":");
  if (separator === -1) throw new Error(`unexpected Docker port mapping: ${value}`);
  return value.slice(separator + 1);
}

function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor((sorted.length - 1) * value)];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return percentile(sorted, 0.5);
}

async function runWindow(operation, concurrency, windowMs, collect) {
  const startedAt = performance.now();
  const deadline = startedAt + windowMs;
  const latencies = [];
  let operations = 0;
  let sequence = 0;

  async function worker() {
    while (performance.now() < deadline) {
      const current = sequence++;
      const operationStartedAt = performance.now();
      await operation(current);
      if (collect) latencies.push(performance.now() - operationStartedAt);
      operations++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = performance.now() - startedAt;
  latencies.sort((left, right) => left - right);
  return {
    operations,
    elapsedMs,
    operationsPerSecond: operations / (elapsedMs / 1_000),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
}

async function internalAdapter(databaseUrl, max, name) {
  const client = createSqlClient(databaseUrl, {
    max,
    applicationName: name,
    connectTimeoutMs: 5_000,
  });
  await client.ready({ timeoutMs: 5_000 });
  return {
    simple: async (value) => (await client.unsafe("SELECT $1::int4 AS value", value))[0].value,
    rows100: async () => (await client.unsafe(
      "SELECT generate_series(1, 100)::int4 AS value",
    )).length,
    transaction: async (value) => await client.sql.transaction(async (tx) => {
      const first = await tx("SELECT $1::int4 AS value", value);
      const second = await tx("SELECT $1::int4 AS value", value + 1);
      return [first[0].value, second[0].value];
    }),
    close: async () => await client.close({ graceMs: 1_000, forceAfterMs: 5_000 }),
  };
}

async function rawAdapter(databaseUrl, max, name) {
  const client = createClient(databaseUrl, {
    max,
    applicationName: name,
    connectTimeoutMs: 5_000,
  });
  await client.unsafe("SELECT 1");
  return {
    simple: async (value) => (await client.unsafe("SELECT $1::int4 AS value", [value]))[0].value,
    rows100: async () => (await client.unsafe(
      "SELECT generate_series(1, 100)::int4 AS value",
    )).length,
    transaction: async (value) => await client.begin(async (tx) => {
      const first = await tx.unsafe("SELECT $1::int4 AS value", [value]);
      const second = await tx.unsafe("SELECT $1::int4 AS value", [value + 1]);
      return [first[0].value, second[0].value];
    }),
    close: async () => await client.end(),
  };
}

async function postgresJsAdapter(databaseUrl, max, name, maxPipeline) {
  const sql = postgres(databaseUrl, {
    max,
    max_pipeline: maxPipeline,
    prepare: false,
    connection: { application_name: name },
  });
  await sql.unsafe("SELECT 1");
  return {
    simple: async (value) => (await sql.unsafe("SELECT $1::int4 AS value", [value]))[0].value,
    rows100: async () => (await sql.unsafe(
      "SELECT generate_series(1, 100)::int4 AS value",
    )).length,
    transaction: async (value) => await sql.begin(async (tx) => {
      const first = await tx.unsafe("SELECT $1::int4 AS value", [value]);
      const second = await tx.unsafe("SELECT $1::int4 AS value", [value + 1]);
      return [first[0].value, second[0].value];
    }),
    close: async () => await sql.end({ timeout: 5 }),
  };
}

const scenarios = [
  {
    name: "simple-sequential",
    operation: "simple",
    max: 1,
    concurrency: 1,
    verify: (value) => assert.equal(value, 7),
    verificationInput: 7,
  },
  {
    name: "simple-concurrent",
    operation: "simple",
    max: 8,
    concurrency: 8,
    verify: (value) => assert.equal(value, 7),
    verificationInput: 7,
  },
  {
    name: "simple-pipelined",
    operation: "simple",
    max: 8,
    concurrency: 32,
    postgresPipeline: true,
    verify: (value) => assert.equal(value, 7),
    verificationInput: 7,
  },
  {
    name: "rows-100",
    operation: "rows100",
    max: 8,
    concurrency: 16,
    verify: (value) => assert.equal(value, 100),
    verificationInput: 0,
  },
  {
    name: "transaction-two-selects",
    operation: "transaction",
    max: 8,
    concurrency: 16,
    verify: (value) => assert.deepEqual(value, [7, 8]),
    verificationInput: 7,
  },
];
const drivers = [
  { name: "sqlx-js-managed", create: internalAdapter },
  { name: "sqlx-js-raw", create: rawAdapter },
];
const postgresJsSerial = {
  name: "postgres.js-serial",
  create: (databaseUrl, max, name) => postgresJsAdapter(databaseUrl, max, name, 1),
};
const postgresJsPipelined = {
  name: "postgres.js-pipelined",
  create: (databaseUrl, max, name) => postgresJsAdapter(databaseUrl, max, name, 100),
};

function scenarioDrivers(scenario) {
  return [
    ...drivers,
    scenario.postgresPipeline ? postgresJsPipelined : postgresJsSerial,
  ].filter((driver) => !driverFilter || driver.name === driverFilter);
}

async function runBenchmark(databaseUrl) {
  for (let round = 0; round < rounds; round++) {
    for (const scenario of scenarios.filter(
      (candidate) => !scenarioFilter || candidate.name === scenarioFilter,
    )) {
      const comparisonDrivers = scenarioDrivers(scenario);
      const orderedDrivers = round % 2 === 0
        ? comparisonDrivers
        : [...comparisonDrivers].reverse();
      for (const driver of orderedDrivers) {
        const adapter = await driver.create(
          databaseUrl,
          scenario.max,
          `sqlx-js-benchmark-${driver.name}-${scenario.name}-${round}`,
        );
        try {
          const operation = adapter[scenario.operation];
          scenario.verify(await operation(scenario.verificationInput));
          await runWindow(operation, scenario.concurrency, warmupMs, false);
          const measurement = await runWindow(operation, scenario.concurrency, durationMs, true);
          const result = {
            round: round + 1,
            scenario: scenario.name,
            driver: driver.name,
            maxConnections: scenario.max,
            concurrency: scenario.concurrency,
            ...measurement,
          };
          results.push(result);
          process.stdout.write(
            `${scenario.name} ${driver.name} round=${round + 1} ops/s=${measurement.operationsPerSecond.toFixed(0)} `
            + `p50=${measurement.p50Ms.toFixed(3)}ms p95=${measurement.p95Ms.toFixed(3)}ms `
            + `p99=${measurement.p99Ms.toFixed(3)}ms\n`,
          );
        } finally {
          await adapter.close();
        }
      }
    }
  }
}

function summarize() {
  return scenarios
    .filter((scenario) => !scenarioFilter || scenario.name === scenarioFilter)
    .flatMap((scenario) => scenarioDrivers(scenario).map((driver) => {
      const samples = results.filter(
        (result) => result.scenario === scenario.name && result.driver === driver.name,
      );
      return {
        scenario: scenario.name,
        driver: driver.name,
        maxConnections: scenario.max,
        concurrency: scenario.concurrency,
        rounds: samples.length,
        medianOperationsPerSecond: median(samples.map((sample) => sample.operationsPerSecond)),
        medianP50Ms: median(samples.map((sample) => sample.p50Ms)),
        medianP95Ms: median(samples.map((sample) => sample.p95Ms)),
        medianP99Ms: median(samples.map((sample) => sample.p99Ms)),
      };
    }));
}

let databaseUrl = providedDatabaseUrl;
try {
  if (!databaseUrl) {
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_PASSWORD=postgres",
      "--env",
      "POSTGRES_DB=sqlx_js_benchmark",
      "--publish",
      "127.0.0.1::5432",
      postgresImage,
    ]);
    await waitForPostgres();
    const port = mappedPort((await docker(["port", container, "5432/tcp"])).stdout);
    databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/sqlx_js_benchmark`;
  }
  await runBenchmark(databaseUrl);
  process.stdout.write(`${JSON.stringify({
    postgresImage: providedDatabaseUrl ? null : postgresImage,
    warmupMs,
    durationMs,
    rounds,
    preparedStatements: false,
    postgresJsSerialMaxPipeline: 1,
    postgresJsDefaultMaxPipeline: 100,
    results,
    summary: summarize(),
  })}\n`);
} catch (error) {
  if (!providedDatabaseUrl) {
    const logs = await execFileAsync("docker", ["logs", container], {
      encoding: "utf8",
    }).catch(() => ({ stdout: "", stderr: "" }));
    process.stderr.write(logs.stdout ?? "");
    process.stderr.write(logs.stderr ?? "");
  }
  throw error;
} finally {
  if (!providedDatabaseUrl) {
    await execFileAsync("docker", ["rm", "--force", container]).catch(() => {});
  }
}
