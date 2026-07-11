import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, createSqlClient, setClient, sql, unsafe, type PostgresClient } from "../src/index";

afterEach(async () => {
  await close();
});

test("setClient respects prepare false and preserves result metadata", async () => {
  const calls: { query: string; params: unknown[]; options: { prepare?: boolean } }[] = [];
  const fake = {
    options: { prepare: true },
    unsafe: async (query: string, params: unknown[], options: { prepare?: boolean }) => {
      calls.push({ query, params, options });
      return Object.assign([], { count: 4, command: "UPDATE" });
    },
    array: (value: unknown[], oid?: number) => ({ kind: "array", value, oid }),
    json: (value: unknown) => ({ kind: "json", value }),
    end: async () => {},
  } as unknown as PostgresClient;

  setClient(fake, { prepare: false });
  expect(await sql.execute("UPDATE users SET active = false")).toEqual({
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

  setClient(fake, { prepare: false, onQuery: ({ query }) => events.push(query) });
  await sql.transaction(async (transaction) => {
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
    end: async () => {},
  } as unknown as PostgresClient;

  setClient(fake);
  const jsonArray = sql.array([sql.json({ kind: "object" }), null]);
  await unsafe(
    "SELECT $1::jsonb, $2::text[], $3::bytea[], $4::jsonb[], $5::timestamptz[]",
    sql.json([1, 2]),
    sql.array(["a", "b"]),
    sql.array([new Uint8Array([1, 2])]),
    jsonArray,
    sql.array([new Date("2026-01-02T03:04:05.000Z")]),
  );

  expect(calls[0]).toEqual([
    { kind: "json", value: [1, 2] },
    "{a,b}",
    "{\"\\\\x0102\"}",
    {
      kind: "array",
      value: [...jsonArray.value],
      oid: 3807,
    },
    '{"2026-01-02T03:04:05.000Z"}',
  ]);
});

test("setClient applies fileRoot to sql.file.execute", async () => {
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

  setClient(fake, { fileRoot: root });
  expect(await sql.file.execute("update.sql")).toEqual({ rowCount: 2, command: "UPDATE" });
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

  setClient(fake, { sqlFiles: { "queries/embedded.sql": "SELECT 42 AS answer" } });
  await sql.file("queries/embedded.sql");
  expect(calls).toEqual(["SELECT 42 AS answer"]);
});

test("createSqlClient returns independent scoped runtimes", async () => {
  const first = createSqlClient("postgres://postgres:postgres@127.0.0.1:1/first", { connect_timeout: 1 });
  const second = createSqlClient("postgres://postgres:postgres@127.0.0.1:1/second", { connect_timeout: 1 });
  try {
    expect(first.client).not.toBe(second.client);
    expect(first.sql).not.toBe(second.sql);
    expect(first.unsafe).not.toBe(second.unsafe);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
