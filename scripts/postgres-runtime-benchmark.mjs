import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { connect as netConnect, createServer } from "node:net";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";

const execFileAsync = promisify(execFile);
const runtimeEntry = process.env.SQLX_JS_BENCHMARK_RUNTIME_ENTRY;
const runtimeEntryUrl = runtimeEntry
  ? pathToFileURL(resolve(runtimeEntry))
  : new URL("../dist/src/index.js", import.meta.url);
const {
  createClient,
  createSqlClient,
} = await import(runtimeEntryUrl.href);
const descriptorMvp = process.env.SQLX_JS_BENCHMARK_DESCRIPTOR_MVP === "1";
const simulatedRttMs = Number(process.env.SQLX_JS_BENCHMARK_RTT_MS ?? 0);
const wire = descriptorMvp
  ? await import(new URL("./pg/wire.js", runtimeEntryUrl).href)
  : undefined;
const artifactVersions = descriptorMvp
  ? await import(new URL("./artifact-versions.js", runtimeEntryUrl).href)
  : undefined;
const queryIds = descriptorMvp
  ? await import(new URL("./query-id.js", runtimeEntryUrl).href)
  : undefined;
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
const descriptorQuery = "SELECT $1::int4 AS value";
const descriptorParameterOids = Object.freeze([23]);
const runtimeDescriptors = descriptorMvp
  ? {
    formatVersion: artifactVersions.RUNTIME_DESCRIPTOR_FORMAT_VERSION,
    cacheFormat: artifactVersions.CACHE_FORMAT_VERSION,
    generatorRevision: artifactVersions.GENERATOR_REVISION,
    configHash: "benchmark",
    types: {},
    queries: {
      [queryIds.queryId(descriptorQuery)]: {
        params: descriptorParameterOids,
      },
    },
    profiles: {},
  }
  : undefined;
const mixedText = "sqlx-js-mixed-";
const mixedBigint = 9_007_199_254_740_993n;
const mixedRowsQuery = `
SELECT
  repeat('${mixedText}', 16)::text AS text_value,
  '{"kind":"benchmark","nested":{"enabled":true,"labels":["sqlx","postgres","runtime"]}}'::jsonb AS json_value,
  decode(repeat('ab', 128), 'hex') AS bytes_value,
  ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]::int4[] AS array_value,
  ${mixedBigint}::int8 AS bigint_value
FROM generate_series(1, 100)
`;

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

function relayWithDelay(source, target, delayMs) {
  source.on("data", (chunk) => {
    source.pause();
    setTimeout(() => {
      if (!target.destroyed) target.write(chunk);
      source.resume();
    }, delayMs);
  });
  source.on("end", () => target.end());
  source.on("error", (error) => target.destroy(error));
}

async function startDelayProxy(databaseUrl, roundTripMs) {
  const targetUrl = new URL(databaseUrl);
  const targetHost = decodeURIComponent(targetUrl.hostname).replace(/^\[|\]$/g, "");
  const targetPort = Number(targetUrl.port || 5432);
  const oneWayDelayMs = roundTripMs / 2;
  const sockets = new Set();
  const server = createServer((downstream) => {
    const upstream = netConnect({ host: targetHost, port: targetPort });
    sockets.add(downstream);
    sockets.add(upstream);
    const forget = () => {
      sockets.delete(downstream);
      sockets.delete(upstream);
    };
    downstream.once("close", forget);
    upstream.once("close", forget);
    relayWithDelay(downstream, upstream, oneWayDelayMs);
    relayWithDelay(upstream, downstream, oneWayDelayMs);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("benchmark delay proxy did not expose a TCP port");
  }
  const proxyUrl = new URL(databaseUrl);
  proxyUrl.hostname = "127.0.0.1";
  proxyUrl.port = String(address.port);
  return {
    databaseUrl: proxyUrl.toString(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor((sorted.length - 1) * value)];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return percentile(sorted, 0.5);
}

function mixedRowsSummary(rows) {
  const first = rows[0];
  return {
    rows: rows.length,
    textLength: first.text_value.length,
    jsonKind: first.json_value.kind,
    bytesLength: first.bytes_value.length,
    arrayLength: first.array_value.length,
    bigint: String(first.bigint_value),
  };
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

async function internalAdapter(databaseUrl, max, name, options = {}) {
  const client = createSqlClient(databaseUrl, {
    max,
    applicationName: name,
    connectTimeoutMs: 5_000,
    ...options,
  });
  await client.ready({ timeoutMs: 5_000 });
  return {
    simple: async (value) => (await client.unsafe("SELECT $1::int4 AS value", value))[0].value,
    rows100: async () => (await client.unsafe(
      "SELECT generate_series(1, 100)::int4 AS value",
    )).length,
    mixedRows: async () => mixedRowsSummary(await client.unsafe(mixedRowsQuery)),
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
    mixedRows: async () => mixedRowsSummary(await client.unsafe(mixedRowsQuery)),
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
    mixedRows: async () => mixedRowsSummary(await sql.unsafe(mixedRowsQuery)),
    transaction: async (value) => await sql.begin(async (tx) => {
      const first = await tx.unsafe("SELECT $1::int4 AS value", [value]);
      const second = await tx.unsafe("SELECT $1::int4 AS value", [value + 1]);
      return [first[0].value, second[0].value];
    }),
    close: async () => await sql.end({ timeout: 5 }),
  };
}

async function descriptorAdapter(create, databaseUrl, max, name) {
  const prototype = wire.PgClient.prototype;
  const adaptive = prototype.execParamsTextWithSerializer;
  prototype.execParamsTextWithSerializer = function (
    query,
    serialize,
    materializeRow,
  ) {
    if (query !== descriptorQuery) {
      return adaptive.call(this, query, serialize, materializeRow);
    }
    return this.execKnownParamsText(
      query,
      descriptorParameterOids,
      serialize(descriptorParameterOids),
      materializeRow,
    );
  };
  try {
    const adapter = await create(databaseUrl, max, name);
    return {
      ...adapter,
      close: async () => {
        try {
          await adapter.close();
        } finally {
          prototype.execParamsTextWithSerializer = adaptive;
        }
      },
    };
  } catch (error) {
    prototype.execParamsTextWithSerializer = adaptive;
    throw error;
  }
}

function frontendMessageTags(chunk) {
  const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags = [];
  let offset = 0;
  while (offset < bytes.length) {
    tags.push(String.fromCharCode(bytes[offset]));
    const length = view.getInt32(offset + 1);
    offset += length + 1;
  }
  return tags;
}

async function captureDescriptorProtocol(databaseUrl) {
  const client = new wire.PgClient(wire.parseDatabaseUrl(databaseUrl));
  await client.connect();
  const socket = client.sock;
  const originalWrite = socket.write;
  let writes = [];
  socket.write = function (chunk, encoding, callback) {
    writes.push(frontendMessageTags(chunk));
    return originalWrite.call(this, chunk, encoding, callback);
  };
  try {
    const adaptive = await client.execParamsTextWithSerializer(
      descriptorQuery,
      () => ["7"],
    );
    assert.equal(new TextDecoder().decode(adaptive.rows[0][0]), "7");
    const adaptiveWrites = writes;
    writes = [];
    const prepared = await client.execKnownParamsText(
      descriptorQuery,
      descriptorParameterOids,
      ["7"],
    );
    assert.equal(new TextDecoder().decode(prepared.rows[0][0]), "7");
    const descriptorWrites = writes;
    assert.deepEqual(adaptiveWrites, [["P", "D", "H"], ["B", "E", "S"]]);
    assert.deepEqual(descriptorWrites, [["P", "B", "D", "E", "S"]]);
    return { adaptiveWrites, descriptorWrites };
  } finally {
    socket.write = originalWrite;
    await client.end();
  }
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
    name: "mixed-rows-100",
    operation: "mixedRows",
    max: 8,
    concurrency: 16,
    verify: (value) => assert.deepEqual(value, {
      rows: 100,
      textLength: mixedText.length * 16,
      jsonKind: "benchmark",
      bytesLength: 128,
      arrayLength: 16,
      bigint: String(mixedBigint),
    }),
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
const drivers = descriptorMvp
  ? [
    { name: "sqlx-js-managed", create: internalAdapter },
    {
      name: "sqlx-js-managed-descriptor",
      create: (...args) => internalAdapter(...args, { queryDescriptors: runtimeDescriptors }),
    },
    { name: "sqlx-js-raw", create: rawAdapter },
    {
      name: "sqlx-js-raw-descriptor",
      create: (...args) => descriptorAdapter(rawAdapter, ...args),
    },
  ]
  : [
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
    ...(descriptorMvp
      ? []
      : [scenario.postgresPipeline ? postgresJsPipelined : postgresJsSerial]),
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
let delayProxy;
let descriptorProtocol;
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
  if (simulatedRttMs > 0) {
    delayProxy = await startDelayProxy(databaseUrl, simulatedRttMs);
    databaseUrl = delayProxy.databaseUrl;
  }
  if (descriptorMvp) {
    descriptorProtocol = await captureDescriptorProtocol(databaseUrl);
  }
  await runBenchmark(databaseUrl);
  process.stdout.write(`${JSON.stringify({
    postgresImage: providedDatabaseUrl ? null : postgresImage,
    warmupMs,
    durationMs,
    rounds,
    preparedStatements: false,
    runtimeEntry: runtimeEntry ?? null,
    descriptorMvp,
    descriptorProtocol: descriptorProtocol ?? null,
    simulatedRttMs,
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
  await delayProxy?.close();
  if (!providedDatabaseUrl) {
    await execFileAsync("docker", ["rm", "--force", container]).catch(() => {});
  }
}
