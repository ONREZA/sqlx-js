import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ClientClosingError,
  ConnectionLostError,
  createClient,
  createSqlClient,
  GenerationRecycledError,
  PgError,
  QueryAbortedError,
  QueryTimeoutError,
  TransactionTimeoutError,
  type CreateSqlClientOptions,
  type PostgresClient,
} from "../src/index";
import { _internal, normalizeRuntimeDatabaseUrl } from "../src/postgres-runtime";
import { EXECUTE_KNOWN_PARAMS } from "../src/pg/driver";
import { defineQuery } from "../src/query";
import {
  CACHE_FORMAT_VERSION,
  GENERATOR_REVISION,
  RUNTIME_DESCRIPTOR_FORMAT_VERSION,
} from "../src/artifact-versions";
import { queryId } from "../src/query-id";
import { Temporal } from "@js-temporal/polyfill";

function managed(client: PostgresClient, options: CreateSqlClientOptions = {}) {
  return _internal.createManagedClient(() => client, options);
}

function pendingQuery<T>(promise: Promise<T>, cancel: () => void = () => {}) {
  return Object.assign(promise, {
    execute() { return this; },
    cancel,
  });
}

function fakePool(
  unsafe: (query: string, params: unknown[]) => unknown,
  overrides: Record<string, unknown> = {},
): PostgresClient {
  return {
    options: {},
    unsafe,
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
    typed: (value: unknown, oid: number) => ({ kind: "typed", value, oid }),
    end: async () => {},
    ...overrides,
  } as unknown as PostgresClient;
}

test("Prisma schema parameters remain compatible with the internal runtime", () => {
  expect(normalizeRuntimeDatabaseUrl(
    "postgresql://app:secret@db.example.com/app?schema=public",
  )).toBe(
    "postgresql://app:secret@db.example.com/app",
  );
  expect(normalizeRuntimeDatabaseUrl(
    "postgresql://app:secret@db.example.com/app?schema=tenant&sslmode=require&application_name=api",
  )).toBe(
    "postgresql://app:secret@db.example.com/app?sslmode=require&application_name=api",
  );
  expect(normalizeRuntimeDatabaseUrl(
    "postgres://app:secret@db.example.com/app?statement_timeout=5000",
  )).toBe(
    "postgres://app:secret@db.example.com/app?statement_timeout=5000",
  );
});

test("statementTimeoutMs configures only the PostgreSQL session parameter", async () => {
  const raw = createClient("postgres://app:secret@127.0.0.1:1/app", {
    applicationName: "sqlx-js-test",
    statementTimeoutMs: 1_234,
  });
  const parsed = (raw as unknown as {
    options: { applicationName?: string; statementTimeoutMs?: number };
  }).options;
  expect(parsed).toEqual(expect.objectContaining({
    applicationName: "sqlx-js-test",
    statementTimeoutMs: 1_234,
  }));
  await raw.end();
});

test("keepAliveMs configures the TCP keepalive initial delay", async () => {
  const raw = createClient("postgres://app:secret@127.0.0.1:1/app", {
    keepAliveMs: 0,
  });
  const parsed = (raw as unknown as {
    options: { keepAliveMs?: number };
  }).options;
  expect(parsed.keepAliveMs).toBe(0);
  await raw.end();
});

test("raw temporal reject policy fails closed for scalar and array infinity", async () => {
  const raw = createClient("postgres://app:secret@127.0.0.1:1/app", {
    temporal: { infinity: "reject" },
  });
  const options = (raw as unknown as {
    options: {
      parsers: Record<number, (value: string) => unknown>;
      serializers: Record<number, (value: unknown) => unknown>;
    };
  }).options;

  expect(() => options.parsers[1184]!("infinity")).toThrow(
    "PostgreSQL timestamptz infinity is rejected",
  );
  expect(() => options.parsers[1185]!('{"-infinity"}')).toThrow(
    "PostgreSQL timestamptz infinity is rejected",
  );
  expect(() => options.serializers[1082]!("-infinity")).toThrow(
    "PostgreSQL date requires Temporal.PlainDate",
  );
  expect(() => options.serializers[1182]!(["infinity"])).toThrow(
    "PostgreSQL date requires Temporal.PlainDate",
  );
  expect(options.parsers[1184]!("2026-07-29 00:00:00+00").toString()).toBe("2026-07-29T00:00:00Z");
  await raw.end();
});

test("raw numeric codecs cannot override Temporal or JSON safety contracts", async () => {
  const raw = createClient("postgres://app:secret@127.0.0.1:1/app", {
    types: {
      unsafeJson: {
        to: 3802,
        from: [114, 3802],
        parse: () => ({ id: Number.MAX_SAFE_INTEGER + 1 }),
        serialize: () => "null",
      },
      unsafeTimestamp: {
        to: 1184,
        from: 1184,
        parse: () => new Date(),
        serialize: () => "2000-01-01T00:00:00Z",
      },
    },
  });
  const options = (raw as unknown as {
    options: {
      parsers: Record<number, (value: string) => unknown>;
      serializers: Record<number, (value: unknown) => unknown>;
    };
  }).options;

  expect(() => options.parsers[3802]!("{\"id\":9007199254740993}"))
    .toThrow("JSON integers must be within JavaScript's safe integer range");
  expect(() => options.serializers[3802]!({ id: Number.MAX_SAFE_INTEGER + 1 }))
    .toThrow("JSON integers must be within JavaScript's safe integer range");
  expect(options.parsers[1184]!("2000-01-01 00:00:00+00")).toBeInstanceOf(Temporal.Instant);
  expect(() => options.serializers[1184]!(new Date())).toThrow("does not accept JavaScript Date");
  await raw.end();
});

test("raw temporal codecs preserve PostgreSQL microseconds and reject Date", async () => {
  const raw = createClient("postgres://app:secret@127.0.0.1:1/app", { temporalApi: Temporal });
  const options = (raw as unknown as {
    options: {
      parsers: Record<number, (value: string) => unknown>;
      serializers: Record<number, (value: unknown) => unknown>;
    };
  }).options;

  const date = options.parsers[1082]!("0001-02-03 BC") as Temporal.PlainDate;
  const time = options.parsers[1083]!("12:34:56.123456") as Temporal.PlainTime;
  const timestamp = options.parsers[1114]!("2026-02-03 12:34:56.123456") as Temporal.PlainDateTime;
  const instant = options.parsers[1184]!("2026-02-03 12:34:56.123456+00") as Temporal.Instant;

  expect(date.toString()).toBe("0000-02-03");
  expect(options.serializers[1082]!(date)).toBe("0001-02-03 BC");
  expect(options.serializers[1083]!(time)).toBe("12:34:56.123456");
  expect(options.serializers[1114]!(timestamp)).toBe("2026-02-03T12:34:56.123456");
  expect(options.serializers[1184]!(instant)).toBe("2026-02-03T12:34:56.123456Z");
  expect(() => options.serializers[1184]!(new Date())).toThrow("does not accept JavaScript Date");
  expect(() => options.serializers[1083]!(Temporal.PlainTime.from("12:34:56.123456789")))
    .toThrow("sub-microsecond precision");
  expect(() => options.serializers[1184]!(Temporal.Instant.from("2026-02-03T12:34:56.123456789Z")))
    .toThrow("sub-microsecond precision");
  expect(() => options.parsers[1083]!("23:59:60")).toThrow("leap second has no lossless");
  expect(() => options.parsers[1083]!("24:00:00")).toThrow("24:00 has no lossless");
  expect(() => options.parsers[1114]!("2026-02-03 23:59:60")).toThrow("leap second has no lossless");
  expect(() => options.parsers[1184]!("2026-02-03 23:59:60+00")).toThrow("leap second has no lossless");
  await raw.end();
});

test("raw client requires an explicit Temporal provider when the runtime has none", () => {
  const target = globalThis as typeof globalThis & { Temporal?: unknown };
  const descriptor = Object.getOwnPropertyDescriptor(target, "Temporal");
  Reflect.deleteProperty(target, "Temporal");
  try {
    expect(() => createClient("postgres://app:secret@127.0.0.1:1/app")).toThrow(
      "install @js-temporal/polyfill and pass { temporalApi: Temporal }",
    );
  } finally {
    if (descriptor) Object.defineProperty(target, "Temporal", descriptor);
  }
});

test("raw client validates the complete Temporal provider boundary eagerly", () => {
  const invalid = {
    Instant: { prototype: Temporal.Instant.prototype, from: Temporal.Instant.from },
    PlainDate: Temporal.PlainDate,
    PlainDateTime: Temporal.PlainDateTime,
    PlainTime: Temporal.PlainTime,
  };
  expect(() => createClient(
    "postgres://app:secret@127.0.0.1:1/app",
    { temporalApi: invalid as never },
  )).toThrow("temporalApi.Instant must be a Temporal constructor");

  class BrokenInstant {
    static from(): unknown {
      return "not-an-instant";
    }
  }
  expect(() => createClient("postgres://app:secret@127.0.0.1:1/app", {
    temporalApi: { ...Temporal, Instant: BrokenInstant } as never,
  }))
    .toThrow("temporalApi.Instant.from returned an incompatible value");

  class ThrowingPlainTime {
    static from(): never {
      throw new Error("broken provider");
    }
  }
  expect(() => createClient("postgres://app:secret@127.0.0.1:1/app", {
    temporalApi: { ...Temporal, PlainTime: ThrowingPlainTime } as never,
  })).toThrow("temporalApi.PlainTime.from failed its compatibility check");
});

test("deprecated global client accepts an application-owned Temporal provider", () => {
  const checked = spawnSync("bun", ["-e", `
process.env.DATABASE_URL = "postgres://app:secret@127.0.0.1:1/app";
const { Temporal } = await import("@js-temporal/polyfill");
const { close, configureDefaultTemporalApi, snapshot } = await import("./src/index.ts");
configureDefaultTemporalApi(Temporal);
if (snapshot().state !== "healthy") throw new Error("default client did not initialize");
await close();
`], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});

test("raw client rejects millisecond options outside the supported range", () => {
  const url = "postgres://app:secret@127.0.0.1:1/app";
  expect(() => createClient(url, { connectTimeoutMs: 0 })).toThrow("connectTimeoutMs must be an integer");
  expect(() => createClient(url, { keepAliveMs: -1 })).toThrow("keepAliveMs must be an integer");
  expect(() => createClient(url, { idleTimeoutMs: -1 })).toThrow("idleTimeoutMs must be an integer");
  expect(() => createClient(url, { maxLifetimeMs: 2_147_483_648 })).toThrow(
    "maxLifetimeMs must be an integer",
  );
  expect(() => createClient(url, { statementTimeoutMs: 1.5 })).toThrow(
    "statementTimeoutMs must be an integer",
  );
});

test("raw client shutdown interrupts an in-flight startup", async () => {
  let accept!: () => void;
  let confirmClosed!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    confirmClosed = resolve;
  });
  const server = createServer((socket) => {
    socket.once("close", confirmClosed);
    accept();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");

  const raw = createClient(`postgres://postgres:postgres@127.0.0.1:${address.port}/postgres`, {
    connectTimeoutMs: 10_000,
  });
  const query = Promise.resolve(raw.unsafe("SELECT 1"));
  await accepted;
  await raw.end();
  await expect(query).rejects.toThrow("PostgreSQL pool is closed");
  await Promise.race([
    closed,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("startup socket remained open after shutdown")), 500);
    }),
  ]);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("raw connect timeout includes a stalled password provider", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const raw = createClient("postgres://postgres@127.0.0.1:1/postgres", {
    connectTimeoutMs: 20,
    password: () => {
      resolveStarted();
      return new Promise<string>(() => {});
    },
  });
  const query = Promise.resolve(raw.unsafe("SELECT 1"));
  await started;
  await expect(query).rejects.toThrow(
    "includes password + TCP + TLS + authentication",
  );
  await raw.end();
});

test("raw client shutdown interrupts a stalled password provider", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const raw = createClient("postgres://postgres@127.0.0.1:1/postgres", {
    password: () => {
      resolveStarted();
      return new Promise<string>(() => {});
    },
  });
  const query = Promise.resolve(raw.unsafe("SELECT 1"));
  await started;
  await raw.end();
  await expect(query).rejects.toThrow("PostgreSQL pool is closed");
});

test("raw query cancellation interrupts a stalled password provider", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const raw = createClient("postgres://postgres@127.0.0.1:1/postgres", {
    password: () => {
      resolveStarted();
      return new Promise<string>(() => {});
    },
  });
  const query = raw.unsafe("SELECT 1").execute();
  await started;
  query.cancel();
  await expect(Promise.resolve(query)).rejects.toThrow("query cancelled before dispatch");
  await raw.end();
});

test("managed client preserves result metadata", async () => {
  const calls: { query: string; params: unknown[] }[] = [];
  const fake = {
    options: {},
    unsafe: async (query: string, params: unknown[]) => {
      calls.push({ query, params });
      return Object.assign([], { count: 4, command: "UPDATE" });
    },
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
    typed: (value: unknown, oid: number) => ({ kind: "typed", value, oid }),
    end: async () => {},
  } as unknown as PostgresClient;

  const db = managed(fake);
  expect(await db.sql.execute("UPDATE users SET active = false")).toEqual({
    rowCount: 4,
    command: "UPDATE",
  });
  expect(calls).toEqual([{ query: "UPDATE users SET active = false", params: [] }]);
});

test("managed client dispatches matching runtime descriptors and keeps adaptive fallback", async () => {
  const adaptive: string[] = [];
  const known: Array<{ query: string; parameterOids: readonly number[]; params: unknown[] }> = [];
  const executionPaths: Array<{ query: string; executionPath: string | undefined }> = [];
  const query = "SELECT $1::int4 AS value";
  const fake = fakePool(
    async (sql) => {
      adaptive.push(sql);
      return Object.assign([{ value: "adaptive" }], { count: 1, command: "SELECT" });
    },
    {
      [EXECUTE_KNOWN_PARAMS]: (
        sql: string,
        parameterOids: readonly number[],
        params: unknown[],
      ) => {
        known.push({ query: sql, parameterOids, params });
        return pendingQuery(Promise.resolve(
          Object.assign([{ value: 42 }], { count: 1, command: "SELECT" }),
        ));
      },
    },
  );
  const db = managed(fake, {
    queryDescriptors: {
      formatVersion: RUNTIME_DESCRIPTOR_FORMAT_VERSION,
      cacheFormat: CACHE_FORMAT_VERSION,
      generatorRevision: GENERATOR_REVISION,
      configHash: "test",
      temporal: { infinity: "reject", timestampWithoutTimeZone: "reject", sessionTimeZone: "UTC" },
      types: {},
      queries: {
        [queryId(query)]: { params: [23] },
      },
      profiles: {},
    },
    onQuery: ({ query: observedQuery, executionPath }) => {
      executionPaths.push({ query: observedQuery, executionPath });
    },
  });

  expect(await db.unsafe(query, 42)).toEqual([{ value: 42 }]);
  expect(await db.unsafe("SELECT $1::text AS value", "fallback")).toEqual([
    { value: "adaptive" },
  ]);
  expect(known).toEqual([{ query, parameterOids: [23], params: [42] }]);
  expect(adaptive).toEqual(["SELECT $1::text AS value"]);
  expect(executionPaths).toEqual([
    { query, executionPath: "descriptor" },
    { query: "SELECT $1::text AS value", executionPath: "adaptive" },
  ]);
});

test("managed client adopts and enforces the descriptor temporal policy", async () => {
  let observed: unknown;
  const db = _internal.createManagedClient(
    (temporal) => {
      observed = temporal;
      return fakePool(async () => []);
    },
    {
      queryDescriptors: {
        formatVersion: RUNTIME_DESCRIPTOR_FORMAT_VERSION,
        cacheFormat: CACHE_FORMAT_VERSION,
        generatorRevision: GENERATOR_REVISION,
        configHash: "test",
        temporal: { infinity: "reject", timestampWithoutTimeZone: "reject", sessionTimeZone: "UTC" },
        types: {},
        queries: {},
        profiles: {},
      },
    },
  );

  expect(observed).toEqual({
    infinity: "reject",
    timestampWithoutTimeZone: "reject",
    sessionTimeZone: "UTC",
  });
  await db.close();
  expect(() => managed(fakePool(async () => []), {
    temporal: { infinity: "reject", timestampWithoutTimeZone: "allow", sessionTimeZone: "UTC" },
    queryDescriptors: {
      formatVersion: RUNTIME_DESCRIPTOR_FORMAT_VERSION,
      cacheFormat: CACHE_FORMAT_VERSION,
      generatorRevision: GENERATOR_REVISION,
      configHash: "test",
      temporal: { infinity: "reject", timestampWithoutTimeZone: "reject", sessionTimeZone: "UTC" },
      types: {},
      queries: {},
      profiles: {},
    },
  })).toThrow("temporal policy does not match the generated query descriptor");
});

test("managed client rejects conflicting descriptor and adaptive execution modes", () => {
  expect(() => managed(fakePool(async () => []), {
    execution: "adaptive",
    queryDescriptors: {
      formatVersion: RUNTIME_DESCRIPTOR_FORMAT_VERSION,
      cacheFormat: CACHE_FORMAT_VERSION,
      generatorRevision: GENERATOR_REVISION,
      configHash: "test",
      temporal: { infinity: "reject", timestampWithoutTimeZone: "reject", sessionTimeZone: "UTC" },
      types: {},
      queries: {},
      profiles: {},
    },
  })).toThrow('execution: "adaptive" cannot be combined with queryDescriptors');
});

test("managed client rejects an explicitly undefined descriptor artifact", () => {
  expect(() => managed(fakePool(async () => []), {
    queryDescriptors: undefined,
  } as never)).toThrow("queryDescriptors must be an object");
});

test("query hooks are preserved inside transactions", async () => {
  const calls: string[] = [];
  const descriptorQuery = "UPDATE jobs SET active = $1";
  const tx = {
    unsafe: async (query: string) => {
      calls.push(`adaptive:${query}`);
      return Object.assign([], { count: 1, command: "UPDATE" });
    },
    [EXECUTE_KNOWN_PARAMS]: (query: string) => {
      calls.push(`descriptor:${query}`);
      return pendingQuery(Promise.resolve(
        Object.assign([], { count: 1, command: "UPDATE" }),
      ));
    },
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
  };
  const fake = {
    options: {},
    unsafe: tx.unsafe,
    array: tx.array,
    json: tx.json,
    begin: async (fn: (value: typeof tx) => Promise<unknown>) => await fn(tx),
    end: async () => {},
  } as unknown as PostgresClient;
  const events: Array<{ query: string; executionPath: string | undefined }> = [];

  const db = managed(fake, {
    queryDescriptors: {
      formatVersion: RUNTIME_DESCRIPTOR_FORMAT_VERSION,
      cacheFormat: CACHE_FORMAT_VERSION,
      generatorRevision: GENERATOR_REVISION,
      configHash: "test",
      temporal: { infinity: "reject", timestampWithoutTimeZone: "reject", sessionTimeZone: "UTC" },
      types: {},
      queries: {
        [queryId(descriptorQuery)]: { params: [16] },
      },
      profiles: {},
    },
    onQuery: ({ query, executionPath }) => events.push({ query, executionPath }),
  });
  await db.sql.transaction(async (transaction) => {
    await transaction.execute(descriptorQuery, false);
    await transaction.execute("DELETE FROM jobs");
  });

  expect(calls).toEqual([
    `descriptor:${descriptorQuery}`,
    "adaptive:DELETE FROM jobs",
  ]);
  expect(events).toEqual([
    { query: descriptorQuery, executionPath: "descriptor" },
    { query: "DELETE FROM jobs", executionPath: undefined },
  ]);
});

test("savepoints release successful work and recover a caught PostgreSQL error", async () => {
  const calls: string[] = [];
  const tx = fakePool(async (query) => {
    calls.push(query);
    if (query === "INSERT duplicate") {
      throw Object.assign(new Error("duplicate key"), {
        name: "PostgresError",
        code: "23505",
        severity: "ERROR",
      });
    }
    return Object.assign([], { count: 1, command: "UPDATE" });
  });
  const pool = fakePool(async () => [], {
    begin: async (fn: (client: PostgresClient) => Promise<unknown>) => await fn(tx),
  });
  const db = managed(pool);

  await db.sql.transaction(async (transaction) => {
    await transaction.savepoint(async (savepoint) => {
      await savepoint.execute("INSERT ok");
    });
    const recovered = await transaction.savepoint(async (savepoint) => {
      try {
        await savepoint.execute("INSERT duplicate");
      } catch {}
      return "recovered";
    });
    expect(recovered).toBe("recovered");
    await transaction.execute("UPDATE after");
  });

  expect(calls).toEqual([
    "SAVEPOINT sqlx_js_1",
    "INSERT ok",
    "RELEASE SAVEPOINT sqlx_js_1",
    "SAVEPOINT sqlx_js_2",
    "INSERT duplicate",
    "ROLLBACK TO SAVEPOINT sqlx_js_2",
    "RELEASE SAVEPOINT sqlx_js_2",
    "UPDATE after",
  ]);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("savepoints wait for dispatched queries before deciding whether to release", async () => {
  const calls: string[] = [];
  const tx = fakePool((query) => {
    calls.push(query);
    if (query === "INSERT delayed duplicate") {
      return new Promise((_, reject) => {
        queueMicrotask(() => reject(Object.assign(new Error("duplicate key"), {
          name: "PostgresError",
          code: "23505",
          severity: "ERROR",
        })));
      });
    }
    return Object.assign([], { count: 1, command: "UPDATE" });
  });
  const pool = fakePool(async () => [], {
    begin: async (fn: (client: PostgresClient) => Promise<unknown>) => await fn(tx),
  });
  const db = managed(pool);

  await db.sql.transaction(async (transaction) => {
    const recovered = await transaction.savepoint(async (savepoint) => {
      const pending = savepoint.execute("INSERT delayed duplicate");
      void pending.catch(() => {});
      return "recovered";
    });
    expect(recovered).toBe("recovered");
    await transaction.execute("UPDATE after");
  });

  expect(calls).toEqual([
    "SAVEPOINT sqlx_js_1",
    "INSERT delayed duplicate",
    "ROLLBACK TO SAVEPOINT sqlx_js_1",
    "RELEASE SAVEPOINT sqlx_js_1",
    "UPDATE after",
  ]);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("savepoint executors expire when their callback completes", async () => {
  const calls: string[] = [];
  const tx = fakePool(async (query) => {
    calls.push(query);
    return Object.assign([], { count: 1, command: "UPDATE" });
  });
  const pool = fakePool(async () => [], {
    begin: async (fn: (client: PostgresClient) => Promise<unknown>) => await fn(tx),
  });
  const db = managed(pool);
  let executeAfterRelease: (() => Promise<unknown>) | undefined;

  await db.sql.transaction(async (transaction) => {
    await transaction.savepoint(async (savepoint) => {
      executeAfterRelease = () => savepoint.execute("INSERT too late");
      await savepoint.execute("INSERT in scope");
    });
    await expect(executeAfterRelease!()).rejects.toThrow("savepoint executor is no longer active");
    await transaction.execute("UPDATE after");
  });

  expect(calls).toEqual([
    "SAVEPOINT sqlx_js_1",
    "INSERT in scope",
    "RELEASE SAVEPOINT sqlx_js_1",
    "UPDATE after",
  ]);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("transaction executors expire before the driver commits", async () => {
  const calls: string[] = [];
  const tx = fakePool(async (query) => {
    calls.push(query);
    return [];
  });
  let executeAfterCallback: (() => Promise<unknown>) | undefined;
  const pool = fakePool(async () => [], {
    begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
      const value = await fn(tx);
      await expect(executeAfterCallback!()).rejects.toThrow("scoped executor is no longer active");
      calls.push("COMMIT");
      return value;
    },
  });
  const db = managed(pool);

  await db.sql.transaction(async (transaction) => {
    executeAfterCallback = () => transaction.execute("INSERT too late");
    await transaction.execute("INSERT in scope");
  });

  expect(calls).toEqual(["INSERT in scope", "COMMIT"]);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("transactions settle a dispatched savepoint before committing", async () => {
  const calls: string[] = [];
  const tx = fakePool(async (query) => {
    calls.push(query);
    return [];
  });
  const pool = fakePool(async () => [], {
    begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
      const value = await fn(tx);
      calls.push("COMMIT");
      return value;
    },
  });
  const db = managed(pool);

  await db.sql.transaction(async (transaction) => {
    void transaction.savepoint(async (savepoint) => {
      await Promise.resolve();
      await savepoint.execute("INSERT before commit");
    });
  });

  expect(calls).toEqual([
    "SAVEPOINT sqlx_js_1",
    "INSERT before commit",
    "RELEASE SAVEPOINT sqlx_js_1",
    "COMMIT",
  ]);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("savepoints require queries to use the active callback executor", async () => {
  const calls: string[] = [];
  const tx = fakePool(async (query) => {
    calls.push(query);
    return [];
  });
  const pool = fakePool(async () => [], {
    begin: async (fn: (client: PostgresClient) => Promise<unknown>) => await fn(tx),
  });
  const db = managed(pool);

  await db.sql.transaction(async (transaction) => {
    await transaction.savepoint(async (savepoint) => {
      await expect(transaction.execute("INSERT wrong scope")).rejects.toThrow(
        "use the savepoint callback executor",
      );
      await savepoint.execute("INSERT correct scope");
      await savepoint.savepoint(async (nested) => {
        await nested.execute("INSERT nested");
      });
    });
  });

  expect(calls).toEqual([
    "SAVEPOINT sqlx_js_1",
    "INSERT correct scope",
    "SAVEPOINT sqlx_js_2",
    "INSERT nested",
    "RELEASE SAVEPOINT sqlx_js_2",
    "RELEASE SAVEPOINT sqlx_js_1",
  ]);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("connection loss remains terminal across a savepoint", async () => {
  const calls: string[] = [];
  let rollbacks = 0;
  const lost = new ConnectionLostError(new Error("socket closed"));
  const tx = fakePool(async (query) => {
    calls.push(query);
    if (query === "SELECT lost") throw lost;
    return [];
  });
  const pool = fakePool(async () => [], {
    begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
      try {
        return await fn(tx);
      } catch (error) {
        rollbacks++;
        throw error;
      }
    },
  });
  const db = managed(pool);

  await expect(db.sql.transaction(async (transaction) => {
    await transaction.savepoint(async (savepoint) => {
      try {
        await savepoint("SELECT lost");
      } catch {}
    });
  })).rejects.toBe(lost);

  expect(calls).toEqual(["SAVEPOINT sqlx_js_1", "SELECT lost"]);
  expect(rollbacks).toBe(1);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("a query timeout skips savepoint recovery and aborts the outer transaction", async () => {
  const calls: string[] = [];
  let cancelled = 0;
  let rollbacks = 0;
  const tx = fakePool((query) => {
    calls.push(query);
    if (query === "SELECT stalled") {
      return pendingQuery(new Promise(() => {}), () => { cancelled++; });
    }
    return pendingQuery(Promise.resolve([]));
  });
  const pool = fakePool(async () => [], {
    begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
      try {
        return await fn(tx);
      } catch (error) {
        rollbacks++;
        throw error;
      }
    },
  });
  const db = managed(pool, { cancelGraceMs: 20 });

  await expect(db.sql.transaction(async (transaction) => {
    await transaction.savepoint(async (savepoint) => {
      await defineQuery("SELECT stalled").runWith(
        { timeoutMs: 5 },
        savepoint as never,
      );
    });
  })).rejects.toBeInstanceOf(QueryTimeoutError);

  expect(calls).toEqual(["SAVEPOINT sqlx_js_1", "SELECT stalled"]);
  expect(cancelled).toBe(1);
  expect(rollbacks).toBe(1);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("the internal runtime receives explicit JSON and array parameters", async () => {
  const calls: unknown[][] = [];
  const fake = {
    options: {},
    unsafe: async (_query: string, params: unknown[]) => {
      calls.push(params);
      return Object.assign([], { count: 0, command: "SELECT" });
    },
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
    typed: (value: unknown, oid: number) => ({ kind: "typed", value, oid }),
    end: async () => {},
  } as unknown as PostgresClient;

  const db = managed(fake);
  const jsonArray = db.sql.array([db.sql.json({ kind: "object" }), null]);
  const instant = Temporal.Instant.from("2026-01-02T03:04:05Z");
  await db.unsafe(
    "SELECT $1::jsonb, $2::text[], $3::bytea[], $4::jsonb[], $5::timestamptz[], $6::text[], $7::int4[]",
    db.sql.json([1, 2]),
    db.sql.array(["a", "b"]),
    db.sql.array([new Uint8Array([1, 2])]),
    jsonArray,
    db.sql.array([instant]),
    db.sql.array([]),
    db.sql.array([null]),
  );

  expect(calls[0]).toEqual([
    { kind: "json", value: [1, 2] },
    { kind: "typed", value: ["a", "b"], oid: 0 },
    { kind: "typed", value: [new Uint8Array([1, 2])], oid: 0 },
    {
      kind: "array",
      value: [...jsonArray.value],
      oid: 3807,
    },
    { kind: "typed", value: [instant], oid: 0 },
    { kind: "typed", value: [], oid: 0 },
    { kind: "typed", value: [null], oid: 0 },
  ]);
});

test("managed client applies fileRoot to sql.file.execute", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-file-root-"));
  writeFileSync(join(root, "update.sql"), "UPDATE jobs SET active = false");
  const calls: string[] = [];
  const fake = {
    options: {},
    unsafe: async (query: string) => {
      calls.push(query);
      return Object.assign([], { count: 2, command: "UPDATE" });
    },
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
    end: async () => {},
  } as unknown as PostgresClient;

  const db = managed(fake, { fileRoot: root });
  expect(await db.sql.file.execute("update.sql")).toEqual({ rowCount: 2, command: "UPDATE" });
  expect(calls).toEqual(["UPDATE jobs SET active = false"]);
});

test("embedded SQL files execute without a filesystem asset", async () => {
  const calls: string[] = [];
  const fake = {
    options: {},
    unsafe: async (query: string) => {
      calls.push(query);
      return Object.assign([], { count: 1, command: "SELECT" });
    },
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
    end: async () => {},
  } as unknown as PostgresClient;

  const db = managed(fake, { sqlFiles: { "queries/embedded.sql": "SELECT 42 AS answer" } });
  await db.sql.file("queries/embedded.sql");
  expect(calls).toEqual(["SELECT 42 AS answer"]);
});

test("createSqlClient returns independent scoped runtimes", async () => {
  const first = createSqlClient("postgres://postgres:postgres@127.0.0.1:1/first", { connectTimeoutMs: 1_000 });
  const second = createSqlClient("postgres://postgres:postgres@127.0.0.1:1/second", { connectTimeoutMs: 1_000 });
  try {
    expect(first.sql).not.toBe(second.sql);
    expect(first.unsafe).not.toBe(second.unsafe);
    expect(first.snapshot()).toEqual(expect.objectContaining({ generation: 1, state: "healthy" }));
    expect(second.snapshot()).toEqual(expect.objectContaining({ generation: 1, state: "healthy" }));
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("lifecycle observer failures are isolated from successful queries", async () => {
  const observerError = new Error("observer failed");
  const reported: { error: unknown; generation?: number }[] = [];
  const db = managed(fakePool(async () => [{ value: 1 }]), {
    onQueryStart: () => { throw observerError; },
    onLifecycleHookError: (error, event) => {
      reported.push({ error, generation: "generation" in event ? event.generation : undefined });
    },
  });

  expect(await db.sql("SELECT 1")).toEqual([{ value: 1 }]);
  expect(reported).toEqual([{ error: observerError, generation: 1 }]);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("query-error observer failures preserve the database error", async () => {
  const databaseError = new Error("database unavailable");
  const observerError = new Error("observer failed");
  const reported: unknown[] = [];
  const db = managed(fakePool(async () => {
    throw databaseError;
  }), {
    onQueryError: () => {
      throw observerError;
    },
    onLifecycleHookError: (error) => reported.push(error),
  });

  await expect(db.sql("SELECT 1")).rejects.toBe(databaseError);
  expect(reported).toEqual([observerError]);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("bootstrap failures emit safe not_sent lifecycle details", async () => {
  const tlsError = Object.assign(new Error("certificate for db.internal included a secret"), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
    cert: { raw: "private certificate bytes" },
  });
  const lost = new ConnectionLostError(tlsError);
  const errors: unknown[] = [];
  const db = managed(fakePool(() => ({
    values: () => Promise.reject(lost),
  }), {
    options: { parsers: {}, serializers: {}, types: {} },
  }), {
    onQueryError: (event) => errors.push(event),
  });

  await expect(db.ready()).rejects.toBe(lost);
  expect(errors).toEqual([expect.objectContaining({
    queryName: "sqlx-js.ready",
    generation: 1,
    phase: "bootstrap",
    outcome: "not_sent",
    errorName: "ConnectionLostError",
    errorCode: "ERR_TLS_CERT_ALTNAME_INVALID",
  })]);
  expect(JSON.stringify(errors)).not.toContain("db.internal");
  expect(JSON.stringify(errors)).not.toContain("private certificate bytes");
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("lifecycle failures discard unsafe user-controlled names and codes", async () => {
  const unsafe = Object.assign(new Error("transport detail"), {
    name: "postgres://user:secret@db.internal/app",
    code: "password=secret",
  });
  const errors: unknown[] = [];
  const db = managed(fakePool(async () => {
    throw unsafe;
  }), {
    onQueryError: (event) => errors.push(event),
  });

  await expect(db.sql("SELECT 1")).rejects.toBe(unsafe);
  expect(errors).toEqual([expect.objectContaining({
    errorName: "Error",
  })]);
  expect(errors[0]).not.toHaveProperty("errorCode");
  expect(JSON.stringify(errors)).not.toContain("secret");
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("database lifecycle failures preserve safe metadata without the server message", async () => {
  const databaseError = new PgError({
    C: "22P02",
    M: "invalid input syntax for type integer: \"customer-token=secret\"",
    S: "ERROR",
  });
  const errors: unknown[] = [];
  const db = managed(fakePool(async () => {
    throw databaseError;
  }), {
    onQueryError: (event) => errors.push(event),
  });

  await expect(db.sql("SELECT * FROM accounts")).rejects.toBe(databaseError);
  expect(errors).toEqual([expect.objectContaining({
    phase: "execution",
    outcome: "unknown",
    errorName: "PgError",
    errorCode: "22P02",
    databaseError: {
      sqlstate: "22P02",
      severity: "ERROR",
    },
  })]);
  expect(JSON.stringify(errors)).not.toContain("customer-token=secret");
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

test("profiled clients annotate query and lifecycle events with a stable role", async () => {
  const profile = { name: "api", role: "app_api" };
  const queries: Array<{ profile?: string; role?: string }> = [];
  const starts: Array<{ profile?: string; role?: string }> = [];
  const db = managed(fakePool(async () => [{ value: 1 }]), {
    profile,
    onQuery: (event) => queries.push(event),
    onQueryStart: (event) => starts.push(event),
  });
  profile.role = "changed_after_creation";

  await db.sql("SELECT 1");

  expect(queries).toEqual([expect.objectContaining({ profile: "api", role: "app_api" })]);
  expect(starts).toEqual([expect.objectContaining({ profile: "api", role: "app_api" })]);
  await db.close({ graceMs: 0, forceAfterMs: 0 });
});

describe("managed generations", () => {
  test("checks the operation deadline after constructing the driver query", async () => {
    let created = 0;
    let executed = 0;
    const db = _internal.createManagedClient(() => {
      created++;
      if (created > 1) return fakePool(async () => []);
      return fakePool(() => {
        const until = performance.now() + 20;
        while (performance.now() < until) {}
        return Object.assign(Promise.resolve([]), {
          execute() {
            executed++;
            return this;
          },
          cancel() {},
        });
      });
    }, { operationTimeoutMs: 5, cancelGraceMs: 0 });

    await expect(db.sql("SELECT 1")).rejects.toMatchObject({
      name: "QueryTimeoutError",
      phase: "execution",
      outcome: "not_sent",
      generation: 1,
    });
    expect(executed).toBe(0);
    expect(created).toBe(2);
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("classifies parameter encoding as execution", async () => {
    let created = 0;
    const db = _internal.createManagedClient(() => {
      created++;
      if (created > 1) return fakePool(async () => []);
      return fakePool(async () => [], {
        typed: (value: unknown, oid: number) => {
          const until = performance.now() + 20;
          while (performance.now() < until) {}
          return { kind: "typed", value, oid };
        },
      });
    }, { operationTimeoutMs: 5, cancelGraceMs: 0 });

    await expect(db.sql("SELECT $1::int4[]", db.sql.array([1]))).rejects.toMatchObject({
      name: "QueryTimeoutError",
      phase: "execution",
      outcome: "not_sent",
      generation: 1,
    });
    expect(created).toBe(2);
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("a late driver rejection cannot overtake the operation deadline", async () => {
    let created = 0;
    let cancelled = 0;
    const db = _internal.createManagedClient(() => {
      created++;
      if (created > 1) return fakePool(async () => []);
      return fakePool(() => ({
        execute() { return this; },
        cancel() { cancelled++; },
        then(_resolve: (value: unknown[]) => void, reject: (error: Error) => void) {
          const until = performance.now() + 20;
          while (performance.now() < until) {}
          reject(new Error("driver failed"));
        },
      }));
    }, { operationTimeoutMs: 5, cancelGraceMs: 0 });

    await expect(db.sql("SELECT 1")).rejects.toMatchObject({
      name: "QueryTimeoutError",
      phase: "execution",
      outcome: "unknown",
      generation: 1,
    });
    expect(cancelled).toBe(1);
    expect(created).toBe(2);
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("times out a dispatched query, cancels it, and replaces the generation", async () => {
    let created = 0;
    let cancelled = 0;
    let ended = 0;
    const states: string[] = [];
    const starts: number[] = [];
    const timeouts: string[] = [];
    const db = _internal.createManagedClient(() => {
      created++;
      if (created === 1) {
        return fakePool(() => pendingQuery(new Promise(() => {}), () => { cancelled++; }), {
          end: async () => { ended++; },
        });
      }
      return fakePool(async () => Object.assign([{ value: 1 }], { count: 1, command: "SELECT" }));
    }, {
      operationTimeoutMs: 10,
      cancelGraceMs: 0,
      onQueryStart: (event) => starts.push(event.generation),
      onQueryTimeout: (event) => timeouts.push(`${event.phase}:${event.outcome}`),
      onClientStateChange: (event) => states.push(`${event.from}->${event.to}`),
    });

    let timeout: unknown;
    try {
      await db.sql("SELECT pg_sleep(10)");
    } catch (error) {
      timeout = error;
    }
    expect(timeout).toBeInstanceOf(QueryTimeoutError);
    expect(timeout).toMatchObject({
      timeoutMs: 10,
      phase: "execution",
      outcome: "unknown",
      generation: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cancelled).toBe(1);
    expect(ended).toBe(1);
    expect(created).toBe(2);
    expect(starts).toEqual([1]);
    expect(timeouts).toEqual(["execution:unknown"]);
    expect(states).toEqual([
      "healthy->poisoned",
      "poisoned->recycling",
      "recycling->healthy",
    ]);
    expect(db.snapshot()).toEqual(expect.objectContaining({
      generation: 2,
      state: "healthy",
      recycleCount: 1,
      activeOperations: 0,
    }));
    expect(await db.sql("SELECT 1")).toEqual([{ value: 1 }]);
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("one timeout recycles a generation once for concurrent stalled queries", async () => {
    let created = 0;
    let cancelled = 0;
    let ended = 0;
    const db = _internal.createManagedClient(() => {
      created++;
      if (created === 1) {
        return fakePool(() => pendingQuery(new Promise(() => {}), () => { cancelled++; }), {
          end: async () => { ended++; },
        });
      }
      return fakePool(async () => []);
    }, { operationTimeoutMs: 10, cancelGraceMs: 0 });

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) => db.sql(`SELECT ${index}`)),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(created).toBe(2);
    expect(cancelled).toBe(100);
    expect(ended).toBe(1);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(results.filter((result) =>
      result.status === "rejected" && result.reason instanceof QueryTimeoutError
    )).toHaveLength(1);
    expect(results.filter((result) =>
      result.status === "rejected" && result.reason instanceof GenerationRecycledError
    )).toHaveLength(99);
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("generation recovery cancels and expires a collateral transaction", async () => {
    let created = 0;
    let transactionCancelled = 0;
    let rollbacks = 0;
    let transactionQueryStarted!: () => void;
    const started = new Promise<void>((resolve) => { transactionQueryStarted = resolve; });
    const tx = fakePool(() => {
      transactionQueryStarted();
      return pendingQuery(new Promise(() => {}), () => { transactionCancelled++; });
    });
    const db = _internal.createManagedClient(() => {
      created++;
      if (created === 1) {
        return fakePool(() => pendingQuery(new Promise(() => {})), {
          begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
            try {
              return await fn(tx);
            } catch (error) {
              rollbacks++;
              throw error;
            }
          },
        });
      }
      return fakePool(async () => []);
    }, { cancelGraceMs: 0 });

    const transaction = db.sql.transaction(async (transactionSql) => {
      await transactionSql("SELECT pg_sleep(10)");
    });
    await started;
    const blocker = defineQuery("SELECT pg_sleep(10)").runWith(
      { timeoutMs: 10 },
      db.sql as never,
    );

    const [blockerResult, transactionResult] = await Promise.allSettled([blocker, transaction]);
    expect(blockerResult).toMatchObject({ status: "rejected", reason: expect.any(QueryTimeoutError) });
    expect(transactionResult).toMatchObject({ status: "rejected", reason: expect.any(GenerationRecycledError) });
    expect(transactionCancelled).toBe(1);
    expect(rollbacks).toBe(1);
    expect(created).toBe(2);
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("a bootstrap deadline reports not_sent and never dispatches user SQL", async () => {
    let created = 0;
    let userQueries = 0;
    const db = _internal.createManagedClient(() => {
      created++;
      if (created === 1) {
        return fakePool((query) => {
          if (query.includes("pg_catalog.pg_type")) {
            return { values: () => new Promise(() => {}) };
          }
          userQueries++;
          return [];
        }, {
          options: { parsers: {}, serializers: {}, types: {} },
        });
      }
      return fakePool(async () => []);
    }, { operationTimeoutMs: 10, cancelGraceMs: 0 });

    await expect(db.sql("SELECT 1")).rejects.toMatchObject({
      phase: "bootstrap",
      outcome: "not_sent",
      generation: 1,
    });
    expect(userQueries).toBe(0);
    expect(created).toBe(2);
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("a confirmed query abort keeps the generation healthy", async () => {
    let rejectDriver!: (error: unknown) => void;
    let cancelled = 0;
    const driver = new Promise<never>((_, reject) => { rejectDriver = reject; });
    const db = managed(fakePool(() => pendingQuery(driver, () => {
      cancelled++;
      rejectDriver(new Error("cancelled"));
    })), { cancelGraceMs: 20 });
    const controller = new AbortController();
    const pending = defineQuery("SELECT 1").runWith(
      { signal: controller.signal },
      db.sql as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort("request closed");

    await expect(pending).rejects.toBeInstanceOf(QueryAbortedError);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cancelled).toBe(1);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 1, recycleCount: 0 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("an already-aborted query never starts bootstrap or dispatches SQL", async () => {
    let calls = 0;
    const db = managed(fakePool(() => {
      calls++;
      return [];
    }, {
      options: { parsers: {}, serializers: {}, types: {} },
    }));
    const controller = new AbortController();
    controller.abort("request closed");

    await expect(defineQuery("SELECT 1").runWith(
      { signal: controller.signal },
      db.sql as never,
    )).rejects.toMatchObject({
      name: "QueryAbortedError",
      phase: "bootstrap",
      outcome: "not_sent",
      generation: 1,
      reason: "request closed",
    });
    expect(calls).toBe(0);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 1, recycleCount: 0 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("an abort during bootstrap recycles the generation instead of leaving shared bootstrap stuck", async () => {
    let created = 0;
    let ended = 0;
    const db = _internal.createManagedClient(() => {
      created++;
      if (created === 1) {
        return fakePool(() => ({ values: () => new Promise(() => {}) }), {
          options: { parsers: {}, serializers: {}, types: {} },
          end: async () => { ended++; },
        });
      }
      return fakePool(async () => []);
    }, { cancelGraceMs: 0 });
    const controller = new AbortController();
    const query = defineQuery("SELECT 1").runWith(
      { signal: controller.signal },
      db.sql as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort("request closed");

    await expect(query).rejects.toMatchObject({
      name: "QueryAbortedError",
      phase: "bootstrap",
      outcome: "not_sent",
      generation: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(created).toBe(2);
    expect(ended).toBe(1);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 2, recycleCount: 1 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("bounded close stops admission and settles active operations", async () => {
    let ended = 0;
    const db = managed(fakePool(() => pendingQuery(new Promise(() => {})), {
      end: async () => { ended++; },
    }));
    const active = db.sql("SELECT pg_sleep(10)");
    const closing = db.close({ graceMs: 5, forceAfterMs: 10 });
    await expect(active).rejects.toMatchObject({
      name: "ClientClosingError",
      phase: "execution",
      outcome: "unknown",
      generation: 1,
    });
    await expect(db.sql("SELECT 1")).rejects.toBeInstanceOf(ClientClosingError);
    await closing;
    expect(ended).toBe(1);
    expect(db.snapshot()).toEqual(expect.objectContaining({ state: "closed", activeOperations: 0 }));
  });

  test("close proceeds as soon as active work drains within the grace period", async () => {
    let resolveQuery!: (value: unknown[]) => void;
    let resolveStarted!: () => void;
    const query = new Promise<unknown[]>((resolve) => {
      resolveQuery = resolve;
    });
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let ended = 0;
    const db = managed(fakePool(() => {
      resolveStarted();
      return pendingQuery(query);
    }, {
      end: async () => { ended++; },
    }));
    const active = db.sql("SELECT 1");
    await started;
    const closing = db.close({ graceMs: 1_000, forceAfterMs: 1_000 });
    await Promise.resolve();
    resolveQuery([]);
    await active;

    let timer!: ReturnType<typeof setTimeout>;
    const settled = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 100);
      }),
    ]);
    clearTimeout(timer);
    if (!settled) await closing;
    expect(settled).toBe(true);
    expect(ended).toBe(1);
  });

  test("a timeout during close cannot reopen admission or create a replacement pool", async () => {
    let created = 0;
    let ended = 0;
    const states: string[] = [];
    const db = _internal.createManagedClient(() => {
      created++;
      return fakePool(() => pendingQuery(new Promise(() => {})), {
        end: async () => { ended++; },
      });
    }, {
      operationTimeoutMs: 10,
      cancelGraceMs: 0,
      onClientStateChange: ({ from, to }) => states.push(`${from}->${to}`),
    });
    const active = db.sql("SELECT pg_sleep(10)");
    const closing = db.close({ graceMs: 50, forceAfterMs: 100 });

    await expect(db.sql("SELECT 1")).rejects.toBeInstanceOf(ClientClosingError);
    await expect(active).rejects.toBeInstanceOf(QueryTimeoutError);
    await expect(db.sql("SELECT 1")).rejects.toBeInstanceOf(ClientClosingError);
    await closing;
    expect(created).toBe(1);
    expect(ended).toBe(1);
    expect(states).toEqual(["healthy->closing", "closing->closed"]);
  });

  test("a close triggered by the poisoned transition prevents replacement creation", async () => {
    let created = 0;
    let closing: Promise<void> | undefined;
    const states: string[] = [];
    const db = _internal.createManagedClient(() => {
      created++;
      return fakePool(() => pendingQuery(new Promise(() => {})));
    }, {
      operationTimeoutMs: 10,
      cancelGraceMs: 0,
      onClientStateChange: ({ from, to }) => {
        states.push(`${from}->${to}`);
        if (to === "poisoned") closing = db.close({ graceMs: 0, forceAfterMs: 10 });
      },
    });

    await expect(db.sql("SELECT pg_sleep(10)")).rejects.toBeInstanceOf(QueryTimeoutError);
    await closing;
    expect(created).toBe(1);
    expect(states).toEqual([
      "healthy->poisoned",
      "poisoned->closing",
      "closing->closed",
    ]);
  });

  test("close reaches closed state when a pool end call throws synchronously", async () => {
    const db = managed(fakePool(async () => [], {
      end: () => { throw new Error("end failed"); },
    }));

    await db.close({ graceMs: 0, forceAfterMs: 10 });
    expect(db.snapshot().state).toBe("closed");
  });

  test("close remains bounded when pool shutdown never settles", async () => {
    const db = managed(fakePool(async () => [], {
      end: () => new Promise(() => {}),
    }));
    const startedAt = performance.now();

    await db.close({ graceMs: 0, forceAfterMs: 10 });
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(db.snapshot().state).toBe("closed");
  });

  test("a reentrant close from a lifecycle observer shares one shutdown", async () => {
    let ended = 0;
    let nestedClose: Promise<void> | undefined;
    const db = managed(fakePool(async () => [], {
      end: async () => { ended++; },
    }), {
      onClientStateChange: ({ to }) => {
        if (to === "closing") nestedClose = db.close();
      },
    });

    const close = db.close({ graceMs: 0, forceAfterMs: 10 });
    expect(nestedClose).toBe(close);
    await close;
    expect(ended).toBe(1);
  });

  test("enters failed state and retires the old pool when replacement creation fails", async () => {
    let created = 0;
    let ended = 0;
    const db = _internal.createManagedClient(() => {
      created++;
      if (created > 1) throw new Error("replacement failed");
      return fakePool(() => pendingQuery(new Promise(() => {})), {
        end: async () => { ended++; },
      });
    }, { operationTimeoutMs: 10, cancelGraceMs: 0 });

    await expect(db.sql("SELECT pg_sleep(10)")).rejects.toBeInstanceOf(QueryTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ended).toBe(1);
    expect(db.snapshot()).toEqual(expect.objectContaining({
      generation: 1,
      state: "failed",
      recycleCount: 0,
      activeOperations: 0,
    }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });
});

describe("managed transaction deadline", () => {
  test("rejects malformed abort signals without retaining managed operations", async () => {
    const transactionPool = fakePool(async () => []);
    const db = managed(fakePool(async () => [], {
      begin: async (fn: (client: PostgresClient) => Promise<unknown>) => await fn(transactionPool),
    }));
    const signals = [
      {} as AbortSignal,
      {
        aborted: false,
        addEventListener: () => { throw new Error("listener failed"); },
        removeEventListener: () => {},
      } as unknown as AbortSignal,
    ];

    for (const signal of signals) {
      await expect(defineQuery("SELECT 1").runWith({ timeoutMs: 10, signal }, db.sql)).rejects.toThrow();
      await expect(db.sql.transaction({ timeoutMs: 10, signal }, async () => {})).rejects.toThrow();
      await expect(db.sql.transaction(async (transaction) => {
        await defineQuery("SELECT 1").runWith({ timeoutMs: 10, signal }, transaction);
      })).rejects.toThrow();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(db.snapshot()).toEqual(expect.objectContaining({
      generation: 1,
      state: "healthy",
      activeOperations: 0,
      recycleCount: 0,
    }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("settles operations when abort listener cleanup throws", async () => {
    const transactionPool = fakePool(async () => []);
    const db = managed(fakePool(async () => [], {
      begin: async (fn: (client: PostgresClient) => Promise<unknown>) => await fn(transactionPool),
    }));
    const throwingDetachSignal = () => {
      let listener: (() => void) | undefined;
      let detaches = 0;
      return {
        signal: {
          aborted: false,
          reason: "late abort",
          addEventListener: (_event: string, next: () => void) => { listener = next; },
          removeEventListener: () => {
            detaches++;
            throw new Error("detach failed");
          },
        } as unknown as AbortSignal,
        abort: () => listener?.(),
        detaches: () => detaches,
      };
    };

    const root = throwingDetachSignal();
    await expect(defineQuery("SELECT 1").runWith({ signal: root.signal }, db.sql)).resolves.toEqual([]);
    expect(root.detaches()).toBe(1);
    root.abort();

    const outer = throwingDetachSignal();
    await expect(db.sql.transaction({ signal: outer.signal }, async () => {})).resolves.toBeUndefined();
    expect(outer.detaches()).toBe(1);
    outer.abort();

    const scoped = throwingDetachSignal();
    await expect(db.sql.transaction(async (transaction) => {
      await defineQuery("SELECT 1").runWith({ signal: scoped.signal }, transaction);
      expect(scoped.detaches()).toBe(1);
      scoped.abort();
      await transaction("SELECT 2");
    })).resolves.toBeUndefined();
    expect(db.snapshot()).toEqual(expect.objectContaining({
      generation: 1,
      state: "healthy",
      activeOperations: 0,
      recycleCount: 0,
    }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("does not dispatch a query after synchronous callback work crosses the transaction deadline", async () => {
    let dispatched = 0;
    let rollbacks = 0;
    const tx = fakePool(async () => {
      dispatched++;
      return [];
    });
    const pool = fakePool(async () => [], {
      begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (error) {
          rollbacks++;
          throw error;
        }
      },
    });
    const db = managed(pool, { cancelGraceMs: 20 });

    await expect(db.sql.transaction({ timeoutMs: 5 }, async (transaction) => {
      const until = performance.now() + 20;
      while (performance.now() < until) {}
      await transaction("SELECT 1");
    })).rejects.toMatchObject({
      name: "TransactionTimeoutError",
      outcome: "rolled_back",
      generation: 1,
    });
    expect(dispatched).toBe(0);
    expect(rollbacks).toBe(1);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 1, recycleCount: 0 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("a scoped transaction executor cannot be used after commit", async () => {
    let dispatched = 0;
    const tx = fakePool(async () => {
      dispatched++;
      return [];
    });
    const pool = fakePool(async () => [], {
      begin: async (fn: (client: PostgresClient) => Promise<unknown>) => await fn(tx),
    });
    const db = managed(pool);
    let captured: ((query: string, ...params: unknown[]) => Promise<unknown[]>) | undefined;

    await db.sql.transaction(async (transaction) => {
      captured = transaction;
    });
    await expect(captured!("SELECT 1")).rejects.toThrow(
      "scoped executor is no longer active",
    );
    expect(dispatched).toBe(0);
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("does not report success when BEGIN returns after the transaction deadline", async () => {
    let created = 0;
    const tx = fakePool(async () => []);
    const db = _internal.createManagedClient(() => {
      created++;
      if (created > 1) return fakePool(async () => []);
      return fakePool(async () => [], {
        begin: (fn: (client: PostgresClient) => Promise<unknown>) => {
          const until = performance.now() + 20;
          while (performance.now() < until) {}
          return fn(tx);
        },
      });
    }, { cancelGraceMs: 0 });

    await expect(db.sql.transaction({ timeoutMs: 5 }, async () => "committed")).rejects.toMatchObject({
      name: "TransactionTimeoutError",
      outcome: "unknown",
      generation: 1,
    });
    expect(created).toBe(2);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 2, recycleCount: 1 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("checks a transaction query deadline after the driver result", async () => {
    let cancelled = 0;
    let rollbacks = 0;
    const pending = {
      execute() { return this; },
      cancel() { cancelled++; },
      then(resolve: (value: unknown[]) => void) {
        const until = performance.now() + 20;
        while (performance.now() < until) {}
        resolve([]);
      },
    };
    const tx = fakePool(() => pending);
    const pool = fakePool(async () => [], {
      begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (error) {
          rollbacks++;
          throw error;
        }
      },
    });
    const db = managed(pool, { cancelGraceMs: 20 });

    await expect(db.sql.transaction(async (transaction) => {
      await defineQuery("SELECT 1").runWith({ timeoutMs: 5 }, transaction as never);
    })).rejects.toMatchObject({
      name: "QueryTimeoutError",
      phase: "execution",
      outcome: "unknown",
      generation: 1,
    });
    expect(cancelled).toBe(1);
    expect(rollbacks).toBe(1);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 1, recycleCount: 0 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("counts synchronous lifecycle work in the transaction deadline", async () => {
    let begins = 0;
    const pool = fakePool(async () => [], {
      begin: async () => {
        begins++;
        return undefined;
      },
    });
    const db = managed(pool, {
      onQueryStart: ({ queryName }) => {
        if (queryName !== "sqlx-js.transaction") return;
        const until = performance.now() + 15;
        while (performance.now() < until) {}
      },
    });

    await expect(db.sql.transaction({ timeoutMs: 5 }, async () => {})).rejects.toMatchObject({
      name: "TransactionTimeoutError",
      timeoutMs: 5,
      outcome: "rolled_back",
      generation: 1,
    });
    expect(begins).toBe(0);
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("reports rolled_back after the driver confirms rollback", async () => {
    let rollbacks = 0;
    const tx = fakePool(async () => []);
    const pool = fakePool(async () => [], {
      begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (error) {
          rollbacks++;
          throw error;
        }
      },
    });
    const db = managed(pool, { cancelGraceMs: 20 });

    let timeout: unknown;
    try {
      await db.sql.transaction({ timeoutMs: 10 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    } catch (error) {
      timeout = error;
    }
    expect(timeout).toBeInstanceOf(TransactionTimeoutError);
    expect(timeout).toMatchObject({ outcome: "rolled_back", generation: 1 });
    expect(rollbacks).toBe(1);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 1, recycleCount: 0 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("reports unknown and recycles when commit never settles", async () => {
    let created = 0;
    const tx = fakePool(async () => []);
    const db = _internal.createManagedClient(() => {
      created++;
      if (created === 1) {
        return fakePool(async () => [], {
          begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
            await fn(tx);
            return await new Promise(() => {});
          },
        });
      }
      return fakePool(async () => []);
    }, { cancelGraceMs: 0 });

    await expect(db.sql.transaction({ timeoutMs: 10 }, async () => {})).rejects.toMatchObject({
      outcome: "unknown",
      generation: 1,
    });
    expect(created).toBe(2);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 2, recycleCount: 1 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("aborts the whole transaction without recycling after confirmed rollback", async () => {
    let rollbacks = 0;
    const tx = fakePool(async () => []);
    const pool = fakePool(async () => [], {
      begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (error) {
          rollbacks++;
          throw error;
        }
      },
    });
    const db = managed(pool, { cancelGraceMs: 20 });
    const controller = new AbortController();
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    const transaction = db.sql.transaction({ signal: controller.signal }, async () => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await callbackEntered;
    controller.abort("request closed");

    await expect(transaction).rejects.toMatchObject({
      name: "QueryAbortedError",
      phase: "execution",
      outcome: "unknown",
      generation: 1,
      reason: "request closed",
    });
    expect(rollbacks).toBe(1);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 1, recycleCount: 0 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("an abort cannot emit a later transaction timeout while rollback is pending", async () => {
    const timeouts: string[] = [];
    const tx = fakePool(async () => []);
    const pool = fakePool(async () => [], {
      begin: async (fn: (client: PostgresClient) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (error) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw error;
        }
      },
    });
    const db = managed(pool, {
      cancelGraceMs: 100,
      onQueryTimeout: ({ queryName }) => timeouts.push(queryName ?? "query"),
    });
    const controller = new AbortController();
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    const transaction = db.sql.transaction({ timeoutMs: 10, signal: controller.signal }, async () => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await callbackEntered;
    controller.abort("request closed");

    await expect(transaction).rejects.toBeInstanceOf(QueryAbortedError);
    expect(timeouts).toEqual([]);
    expect(db.snapshot().lastTimeoutAt).toBeNull();
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });

  test("an already-aborted transaction query is never dispatched", async () => {
    let dispatched = 0;
    const tx = fakePool(async () => {
      dispatched++;
      return [];
    });
    const pool = fakePool(async () => [], {
      begin: async (fn: (client: PostgresClient) => Promise<unknown>) => await fn(tx),
    });
    const db = managed(pool, { cancelGraceMs: 20 });
    const controller = new AbortController();
    controller.abort("request closed");

    await expect(db.sql.transaction(async (transaction) => {
      await defineQuery("SELECT 1").runWith(
        { signal: controller.signal },
        transaction as never,
      );
    })).rejects.toMatchObject({
      name: "QueryAbortedError",
      phase: "execution",
      outcome: "not_sent",
      generation: 1,
      reason: "request closed",
    });
    expect(dispatched).toBe(0);
    expect(db.snapshot()).toEqual(expect.objectContaining({ generation: 1, recycleCount: 0 }));
    await db.close({ graceMs: 0, forceAfterMs: 0 });
  });
});
