import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientClosingError,
  createClient,
  createSqlClient,
  GenerationRecycledError,
  QueryAbortedError,
  QueryTimeoutError,
  TransactionTimeoutError,
  type CreateSqlClientOptions,
  type PostgresClient,
} from "../src/index";
import { _internal, normalizeRuntimeDatabaseUrl } from "../src/postgres-runtime";
import { defineQuery } from "../src/query";

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
  unsafe: (query: string, params: unknown[], options: { prepare?: boolean }) => unknown,
  overrides: Record<string, unknown> = {},
): PostgresClient {
  return {
    options: { prepare: true },
    unsafe,
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
    typed: (value: unknown, oid: number) => ({ kind: "typed", value, oid }),
    end: async () => {},
    ...overrides,
  } as unknown as PostgresClient;
}

test("Prisma schema parameters remain compatible with the Postgres.js runtime", () => {
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
  const connection = { application_name: "sqlx-js-test" };
  const raw = createClient("postgres://app:secret@127.0.0.1:1/app", {
    connection,
    statementTimeoutMs: 1_234,
  });
  expect(raw.options.connection).toEqual(expect.objectContaining({
    application_name: "sqlx-js-test",
    statement_timeout: 1_234,
  }));
  expect(connection).toEqual({ application_name: "sqlx-js-test" });
  await raw.end({ timeout: 0 });
});

test("managed client respects prepare false and preserves result metadata", async () => {
  const calls: { query: string; params: unknown[]; options: { prepare?: boolean } }[] = [];
  const fake = {
    options: { prepare: true },
    unsafe: async (query: string, params: unknown[], options: { prepare?: boolean }) => {
      calls.push({ query, params, options });
      return Object.assign([], { count: 4, command: "UPDATE" });
    },
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
    typed: (value: unknown, oid: number) => ({ kind: "typed", value, oid }),
    end: async () => {},
  } as unknown as PostgresClient;

  const db = managed(fake, { prepare: false });
  expect(await db.sql.execute("UPDATE users SET active = false")).toEqual({
    rowCount: 4,
    command: "UPDATE",
  });
  expect(calls[0]!.options.prepare).toBe(false);
});

test("prepare false and query hooks are preserved inside transactions", async () => {
  const calls: { query: string; prepare?: boolean }[] = [];
  const tx = {
    unsafe: async (query: string, _params: unknown[], options: { prepare?: boolean }) => {
      calls.push({ query, prepare: options.prepare });
      return Object.assign([], { count: 1, command: "UPDATE" });
    },
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
  };
  const fake = {
    options: { prepare: true },
    unsafe: tx.unsafe,
    array: tx.array,
    json: tx.json,
    begin: async (fn: (value: typeof tx) => Promise<unknown>) => await fn(tx),
    end: async () => {},
  } as unknown as PostgresClient;
  const events: string[] = [];

  const db = managed(fake, { prepare: false, onQuery: ({ query }) => events.push(query) });
  await db.sql.transaction(async (transaction) => {
    await transaction.execute("UPDATE jobs SET active = false");
  });

  expect(calls).toEqual([{ query: "UPDATE jobs SET active = false", prepare: false }]);
  expect(events).toEqual(["UPDATE jobs SET active = false"]);
});

test("Postgres.js receives explicit JSON and array parameters", async () => {
  const calls: unknown[][] = [];
  const fake = {
    options: { prepare: true },
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
  await db.unsafe(
    "SELECT $1::jsonb, $2::text[], $3::bytea[], $4::jsonb[], $5::timestamptz[], $6::text[], $7::int4[]",
    db.sql.json([1, 2]),
    db.sql.array(["a", "b"]),
    db.sql.array([new Uint8Array([1, 2])]),
    jsonArray,
    db.sql.array([new Date("2026-01-02T03:04:05.000Z")]),
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
    { kind: "typed", value: [new Date("2026-01-02T03:04:05.000Z")], oid: 0 },
    { kind: "typed", value: [], oid: 0 },
    { kind: "typed", value: [null], oid: 0 },
  ]);
});

test("managed client applies fileRoot to sql.file.execute", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-file-root-"));
  writeFileSync(join(root, "update.sql"), "UPDATE jobs SET active = false");
  const calls: string[] = [];
  const fake = {
    options: { prepare: true },
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
    options: { prepare: true },
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
  const first = createSqlClient("postgres://postgres:postgres@127.0.0.1:1/first", { connect_timeout: 1 });
  const second = createSqlClient("postgres://postgres:postgres@127.0.0.1:1/second", { connect_timeout: 1 });
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
          options: { parsers: {}, serializers: {}, fetch_types: true, types: {} },
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
      options: { parsers: {}, serializers: {}, fetch_types: true, types: {} },
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
          options: { parsers: {}, serializers: {}, fetch_types: true, types: {} },
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
