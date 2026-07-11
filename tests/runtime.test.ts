import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _internal,
  array,
  clearSqlFileCache,
  createSqlRuntime,
  encodePgArrayLiteral,
  id,
  json,
  NoRowsError,
  type OnQueryEvent,
  type RuntimeClient,
  TooManyRowsError,
} from "../src/runtime";
import { PgError } from "../src/pg/wire";
import { defineQuery } from "../src/query";
import { SQLSTATE, isPgError } from "../src/runtime";

describe("renameRows", () => {
  test("returns same array when no rows", () => {
    const out = _internal.renameRows([]);
    expect(out).toEqual([]);
  });

  test("returns same array when no override keys", () => {
    const rows = [{ id: 1, name: "a" }];
    const out = _internal.renameRows(rows);
    expect(out).toBe(rows);
    expect(rows[0]).toEqual({ id: 1, name: "a" });
  });

  test("does not mutate source rows", () => {
    const rows = [{ "id!": 1, name: "a" }, { "id!": 2, name: "b" }];
    const out = _internal.renameRows(rows);
    expect(rows[0]).toEqual({ "id!": 1, name: "a" });
    expect(rows[1]).toEqual({ "id!": 2, name: "b" });
    expect(out[0]).toEqual({ id: 1, name: "a" });
    expect(out[1]).toEqual({ id: 2, name: "b" });
  });

  test("supports both `!` and `?` suffixes", () => {
    const rows = [{ "id!": 1, "bio?": null, name: "a" }];
    const out = _internal.renameRows(rows) as { id: number; bio: null; name: string }[];
    expect(out[0]!.id).toBe(1);
    expect(out[0]!.bio).toBeNull();
    expect(out[0]!.name).toBe("a");
  });
});

describe("encodeParam", () => {
  test("non-array passes through", () => {
    expect(_internal.encodeParam(42)).toBe(42);
    expect(_internal.encodeParam("hello")).toBe("hello");
    expect(_internal.encodeParam(null)).toBe(null);
  });

  test("plain arrays pass through without type guessing", () => {
    const arr: unknown[] = [];
    expect(_internal.encodeParam(arr)).toBe(arr);
    const values = [1, 2, 3];
    expect(_internal.encodeParam(values)).toBe(values);
  });

  test("explicit array and JSON parameters serialize independently", () => {
    expect(_internal.encodeParam(array([1, 2, 3]))).toBe("{1,2,3}");
    expect(_internal.encodeParam(json([1, 2, 3]))).toBe("[1,2,3]");
    expect(_internal.encodeParam(json(null))).toBe("null");
    expect(_internal.encodeParam(array([json({ kind: "object" }), null])))
      .toBe('{"{\\"kind\\":\\"object\\"}",NULL}');
    expect(_internal.encodeParam(array([new Date("2026-01-02T03:04:05.000Z")])))
      .toBe('{"2026-01-02T03:04:05.000Z"}');
    expect(_internal.encodeParam(array([new Uint8Array([0xde, 0xad])])))
      .toBe('{"\\\\xdead"}');
  });

  test("array containing comma/quote/brace is escaped", () => {
    const out = encodePgArrayLiteral(["a,b", 'c"d', "e{f"]);
    expect(out).toBe('{"a,b","c\\"d","e{f"}');
  });

  test("null elements become NULL", () => {
    expect(encodePgArrayLiteral([1, null, 2])).toBe("{1,NULL,2}");
  });
});

test("runtime rewrites and binds named parameters", async () => {
  let received: { query: string; params: unknown[] } | undefined;
  const client: RuntimeClient = {
    query: async (query, params) => {
      received = { query, params };
      return [];
    },
    transaction: async (fn) => fn(client),
    close: async () => {},
  };
  const runtime = createSqlRuntime(() => client);
  await runtime.sql("SELECT $email, $id, $email", { id: 7, email: "a@b" });
  expect(received).toEqual({ query: "SELECT $1, $2, $1", params: ["a@b", 7] });
});

test("named parameters preserve the source query and object for observers", async () => {
  let event: OnQueryEvent | undefined;
  const client: RuntimeClient = {
    query: async () => [],
    transaction: async (fn) => fn(client),
    close: async () => {},
    onQuery: (value) => { event = value; },
  };
  const runtime = createSqlRuntime(() => client);
  const params = { id: 7 };
  await runtime.sql("SELECT $id", params);
  expect(event).toMatchObject({ queryId: expect.any(String), query: "SELECT $id", params: [params] });
});

test("query definitions execute through root and transaction executors with stable metadata", async () => {
  const events: OnQueryEvent[] = [];
  const client: RuntimeClient = {
    query: async () => [{ id: 7 }],
    transaction: async (fn) => fn(client),
    close: async () => {},
    onQuery: (event) => events.push(event),
  };
  const runtime = createSqlRuntime(() => client);
  const findUser = defineQuery.optional("users.findById", "SELECT id FROM users WHERE id = $id");
  expect(await findUser.run(runtime.sql as never, { id: 7 })).toEqual({ id: 7 });
  await runtime.sql.transaction(async (tx) => {
    expect(await findUser.run(tx as never, { id: 7 })).toEqual({ id: 7 });
  });
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ queryId: findUser.queryId, queryName: "users.findById" });
  expect(events[1]).toMatchObject({ queryId: findUser.queryId, queryName: "users.findById" });
});

test("named parameters preserve explicit JSON and array encoding", async () => {
  let received: unknown[] | undefined;
  const client: RuntimeClient = {
    query: async (_query, params) => { received = params; return []; },
    transaction: async (fn) => fn(client),
    close: async () => {},
  };
  const runtime = createSqlRuntime(() => client);
  await runtime.sql("SELECT $payload, $values", {
    payload: json({ ok: true }),
    values: array([1, 2]),
  });
  expect(received).toEqual(['{"ok":true}', "{1,2}"]);
});

describe("isPrimitiveArrayElement", () => {
  test("primitives + null/undefined are primitive", () => {
    expect(_internal.isPrimitiveArrayElement(1)).toBe(true);
    expect(_internal.isPrimitiveArrayElement("a")).toBe(true);
    expect(_internal.isPrimitiveArrayElement(1n)).toBe(true);
    expect(_internal.isPrimitiveArrayElement(true)).toBe(true);
    expect(_internal.isPrimitiveArrayElement(null)).toBe(true);
    expect(_internal.isPrimitiveArrayElement(undefined)).toBe(true);
  });

  test("objects and arrays are not primitive", () => {
    expect(_internal.isPrimitiveArrayElement({})).toBe(false);
    expect(_internal.isPrimitiveArrayElement([])).toBe(false);
    expect(_internal.isPrimitiveArrayElement(new Date())).toBe(true);
    expect(_internal.isPrimitiveArrayElement(new Uint8Array())).toBe(true);
  });
});

describe("typed errors", () => {
  test("NoRowsError is an Error", () => {
    const e = new NoRowsError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("NoRowsError");
  });

  test("TooManyRowsError carries actual count", () => {
    const e = new TooManyRowsError(5, "1");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("TooManyRowsError");
    expect(e.actual).toBe(5);
    expect(e.message).toContain("5");
  });

  test("isPgError narrows normalized errors by SQLSTATE", () => {
    const error = new PgError({ C: SQLSTATE.uniqueViolation, M: "duplicate" });
    expect(isPgError(error)).toBe(true);
    expect(isPgError(error, SQLSTATE.uniqueViolation)).toBe(true);
    expect(isPgError(error, SQLSTATE.foreignKeyViolation)).toBe(false);
    expect(isPgError(new Error("duplicate"), SQLSTATE.uniqueViolation)).toBe(false);
  });
});

describe("toPgError", () => {
  test("maps a postgres.js-style driver error to PgError", () => {
    const driver = Object.assign(new Error("duplicate key value"), {
      name: "PostgresError",
      code: "23505",
      detail: "Key (email)=(a@b) already exists.",
      hint: "use a different email",
      position: "42",
      severity: "ERROR",
      table_name: "users",
      column_name: "email",
      constraint_name: "users_email_key",
      schema_name: "public",
    });
    const pg = _internal.toPgError(driver)!;
    expect(pg).toBeInstanceOf(PgError);
    expect(pg.code).toBe("23505");
    expect(pg.position).toBe(42);
    expect(pg.detail).toContain("already exists");
    expect(pg.hint).toBe("use a different email");
    expect(pg.severity).toBe("ERROR");
    expect(pg.table).toBe("users");
    expect(pg.column).toBe("email");
    expect(pg.constraint).toBe("users_email_key");
    expect(pg.schema).toBe("public");
    expect(pg.cause).toBe(driver);
  });

  test("recognizes a node-postgres-style error (SQLSTATE + severity, no PostgresError name)", () => {
    const pg = _internal.toPgError({ code: "42P01", severity: "ERROR", message: "relation does not exist" });
    expect(pg).toBeInstanceOf(PgError);
    expect(pg!.code).toBe("42P01");
    expect(pg!.severity).toBe("ERROR");
  });

  test("does not treat transport/system errors as database errors", () => {
    // 5-char uppercase codes that are NOT SQLSTATE and carry no severity.
    expect(_internal.toPgError(Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).toBeNull();
    expect(_internal.toPgError(Object.assign(new Error("cross-device"), { code: "EXDEV" }))).toBeNull();
    expect(_internal.toPgError({ code: "CONNECTION_ENDED" })).toBeNull();
    // SQLSTATE shape but no severity → not enough to claim it's a database error.
    expect(_internal.toPgError({ code: "42P01" })).toBeNull();
  });

  test("returns the same instance when already a PgError", () => {
    const existing = new PgError({ C: "23505", M: "dup" });
    expect(_internal.toPgError(existing)).toBe(existing);
  });

  test("returns null for non-pg errors", () => {
    expect(_internal.toPgError(new Error("ECONNRESET"))).toBeNull();
    expect(_internal.toPgError({ code: "ECONNRESET" })).toBeNull();
    expect(_internal.toPgError("nope")).toBeNull();
    expect(_internal.toPgError(null)).toBeNull();
  });
});

describe("onQuery hook", () => {
  function harness(client: Partial<RuntimeClient>) {
    const events: OnQueryEvent[] = [];
    const base: RuntimeClient = {
      query: async () => [],
      transaction: async (fn) => fn(base),
      close: async () => {},
      onQuery: (e) => events.push(e),
      ...client,
    };
    return { events, api: createSqlRuntime(() => base) };
  }

  test("fires once per query with timing and row count", async () => {
    const { events, api } = harness({ query: async () => [{ id: 1 }, { id: 2 }] });
    const rows = await api.sql("SELECT id FROM users");
    expect(rows.length).toBe(2);
    expect(events.length).toBe(1);
    expect(events[0]!.query).toBe("SELECT id FROM users");
    expect(events[0]!.rowCount).toBe(2);
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0]!.error).toBeUndefined();
  });

  test("observer failures do not replace successful query results", async () => {
    const observerError = new Error("observer failed");
    const hookErrors: unknown[] = [];
    let calls = 0;
    const base: RuntimeClient = {
      query: async () => [{ id: 1 }],
      transaction: async (fn) => fn(base),
      close: async () => {},
      onQuery: () => {
        calls++;
        throw observerError;
      },
      onQueryHookError: (error) => hookErrors.push(error),
    };
    const api = createSqlRuntime(() => base);
    expect(await api.sql("SELECT 1")).toEqual([{ id: 1 }]);
    expect(calls).toBe(1);
    expect(hookErrors).toEqual([observerError]);
  });

  test("async observer rejections are isolated and reported", async () => {
    const observerError = new Error("async observer failed");
    const hookErrors: unknown[] = [];
    const base: RuntimeClient = {
      query: async () => [{ id: 1 }],
      transaction: async (fn) => fn(base),
      close: async () => {},
      onQuery: async () => {
        throw observerError;
      },
      onQueryHookError: async (error) => {
        hookErrors.push(error);
      },
    };
    const api = createSqlRuntime(() => base);
    expect(await api.sql("SELECT 1")).toEqual([{ id: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hookErrors).toEqual([observerError]);
  });

  test("uses driver affected-row count and exposes sql.execute metadata", async () => {
    const result = Object.assign([], { count: 3, command: "UPDATE" });
    const { events, api } = harness({ query: async () => result });
    expect(await api.sql.execute("UPDATE users SET active = false")).toEqual({
      rowCount: 3,
      command: "UPDATE",
    });
    expect(events[0]!.rowCount).toBe(3);
  });

  test("fires with normalized PgError on failure and rethrows it", async () => {
    const driver = Object.assign(new Error("dup"), { name: "PostgresError", code: "23505" });
    const { events, api } = harness({ query: async () => { throw driver; } });
    await expect(api.sql("INSERT INTO users DEFAULT VALUES")).rejects.toBeInstanceOf(PgError);
    expect(events.length).toBe(1);
    expect(events[0]!.error).toBeInstanceOf(PgError);
    expect((events[0]!.error as PgError).code).toBe("23505");
    expect(events[0]!.rowCount).toBeUndefined();
  });

  test("normalizes errors even without an onQuery hook", async () => {
    const api = createSqlRuntime((): RuntimeClient => ({
      query: async () => { throw Object.assign(new Error("x"), { code: "42P01", severity: "ERROR" }); },
      transaction: async (fn) => fn({} as RuntimeClient),
      close: async () => {},
    }));
    await expect(api.sql("SELECT 1")).rejects.toBeInstanceOf(PgError);
  });

  test("rethrows transport errors unchanged (not wrapped in PgError)", async () => {
    const transport = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const api = createSqlRuntime((): RuntimeClient => ({
      query: async () => { throw transport; },
      transaction: async (fn) => fn({} as RuntimeClient),
      close: async () => {},
    }));
    await expect(api.sql("SELECT 1")).rejects.toBe(transport);
  });
});

describe("loadSqlFile cache", () => {
  test("embedded SQL cannot bypass fileRoot path validation", () => {
    expect(() => _internal.loadSqlFile("../secret.sql", "/tmp/app", false, {
      "../secret.sql": "SELECT 'secret'",
    })).toThrow(/path escapes fileRoot/);
  });

  test("keeps the hot path immutable until explicitly cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlx-js-runtime-"));
    const path = join(dir, "q.sql");
    writeFileSync(path, "SELECT 1");
    clearSqlFileCache();
    const a = _internal.loadSqlFile("q.sql", dir);
    expect(a).toBe("SELECT 1");

    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(path, "SELECT 2");
    const b = _internal.loadSqlFile("q.sql", dir);
    expect(b).toBe("SELECT 1");

    clearSqlFileCache();
    expect(_internal.loadSqlFile("q.sql", dir)).toBe("SELECT 2");
  });

  test("reload mode re-reads a changed SQL file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlx-js-runtime-"));
    const path = join(dir, "q.sql");
    writeFileSync(path, "SELECT 1");
    clearSqlFileCache();
    expect(_internal.loadSqlFile("q.sql", dir, true)).toBe("SELECT 1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(path, "SELECT 2");
    expect(_internal.loadSqlFile("q.sql", dir, true)).toBe("SELECT 2");
  });

  test("missing file throws with path context", () => {
    expect(() => _internal.loadSqlFile("sqlx-js-does-not-exist.sql", "/tmp"))
      .toThrow(/sqlx-js\.sql\.file: cannot read sqlx-js-does-not-exist\.sql/);
  });
});

describe("id", () => {
  test("quotes only identifiers present in the schema snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlx-js-id-"));
    const path = join(dir, "schema.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      schemas: ["app", "public"],
      relations: [
        {
          schema: "public",
          name: "users",
          kind: "table",
          columns: [
            { name: "id", ordinal: 1, type: "bigint", typeOid: 20, nullable: false, writable: false, identity: "always" },
            { name: "email", ordinal: 2, type: "text", typeOid: 25, nullable: false, writable: true },
          ],
          constraints: [],
          indexes: [],
        },
        {
          schema: "app",
          name: "posts",
          kind: "table",
          columns: [
            { name: "id", ordinal: 1, type: "bigint", typeOid: 20, nullable: false, writable: false, identity: "always" },
          ],
          constraints: [{ name: "posts_pkey", kind: "primary_key", columns: ["id"], definition: "PRIMARY KEY (id)" }],
          indexes: [{ name: "posts_user_id_idx", unique: false, primary: false, method: "btree", columns: ["id"], definition: "" }],
        },
      ],
      types: [],
      functions: [],
    }));
    const prev = process.env.SQLX_JS_SCHEMA_PATH;
    process.env.SQLX_JS_SCHEMA_PATH = path;
    _internal.clearIdentifierCache();
    try {
      expect(id("users")).toBe('"users"');
      expect(id("public", "users")).toBe('"public"."users"');
      expect(id("users", "email")).toBe('"users"."email"');
      expect(id("public", "users", "email")).toBe('"public"."users"."email"');
      expect(id("app", "posts_user_id_idx")).toBe('"app"."posts_user_id_idx"');
      expect(id("app", "posts", "posts_pkey")).toBe('"app"."posts"."posts_pkey"');
      expect(() => id("users; DROP TABLE users")).toThrow(/not present/);
      expect(() => id("public", "users", "missing")).toThrow(/not present/);
    } finally {
      if (prev === undefined) delete process.env.SQLX_JS_SCHEMA_PATH;
      else process.env.SQLX_JS_SCHEMA_PATH = prev;
      _internal.clearIdentifierCache();
    }
  });
});
