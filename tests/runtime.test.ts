import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _internal,
  clearSqlFileCache,
  encodePgArrayLiteral,
  NoRowsError,
  TooManyRowsError,
} from "../src/runtime";

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

  test("empty array passes through as-is (no magic)", () => {
    const arr: unknown[] = [];
    expect(_internal.encodeParam(arr)).toBe(arr);
  });

  test("primitive array becomes PG array literal", () => {
    expect(_internal.encodeParam([1, 2, 3])).toBe("{1,2,3}");
    expect(_internal.encodeParam(["a", "b"])).toBe("{a,b}");
  });

  test("array of objects (jsonb path) passes through as-is", () => {
    const arr = [{ x: 1 }, { y: 2 }];
    expect(_internal.encodeParam(arr)).toBe(arr);
  });

  test("array containing comma/quote/brace is escaped", () => {
    const out = encodePgArrayLiteral(["a,b", 'c"d', "e{f"]);
    expect(out).toBe('{"a,b","c\\"d","e{f"}');
  });

  test("null elements become NULL", () => {
    expect(encodePgArrayLiteral([1, null, 2])).toBe("{1,NULL,2}");
  });
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
});

describe("loadSqlFile + mtime cache", () => {
  test("reads file and re-reads on mtime change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-sqlx-runtime-"));
    const path = join(dir, "q.sql");
    writeFileSync(path, "SELECT 1");
    clearSqlFileCache();
    const a = _internal.loadSqlFile(path);
    expect(a).toBe("SELECT 1");

    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(path, "SELECT 2");
    const b = _internal.loadSqlFile(path);
    expect(b).toBe("SELECT 2");
  });

  test("missing file throws with path context", () => {
    expect(() => _internal.loadSqlFile("/tmp/bun-sqlx-does-not-exist.sql"))
      .toThrow(/bun-sqlx\.sql\.file: cannot read \/tmp\/bun-sqlx-does-not-exist\.sql/);
  });
});
