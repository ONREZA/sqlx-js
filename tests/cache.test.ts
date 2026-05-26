import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cache, fingerprint } from "../src/cache";

test("fingerprint is whitespace-invariant", () => {
  expect(fingerprint("SELECT 1")).toBe(fingerprint("SELECT  1"));
  expect(fingerprint("SELECT 1")).toBe(fingerprint(" SELECT 1 "));
});

test("different queries have different fingerprints", () => {
  expect(fingerprint("SELECT 1")).not.toBe(fingerprint("SELECT 2"));
});

test("Cache round-trips entries to disk", () => {
  const dir = join(import.meta.dir, ".tmp-cache");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  c.write("abc", {
    query: "SELECT 1",
    paramOids: [],
    paramTsTypes: [],
    columns: [],
    hasResultSet: false,
  });
  expect(c.has("abc")).toBe(true);
  expect(c.read("abc")?.query).toBe("SELECT 1");
  expect(c.list().length).toBe(1);
  c.remove("abc");
  expect(c.has("abc")).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.list ignores files outside .json", () => {
  const dir = join(import.meta.dir, ".tmp-cache-list");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  c.write("a1", { query: "x", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  c.write("b2", { query: "y", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  const fps = c.list().map((e) => e.fp).sort();
  expect(fps).toEqual(["a1", "b2"]);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.prune keeps requested fps, removes the rest", () => {
  const dir = join(import.meta.dir, ".tmp-cache-prune");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  c.write("keep1", { query: "a", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  c.write("keep2", { query: "b", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  c.write("drop1", { query: "c", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  c.write("drop2", { query: "d", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });

  const removed = c.prune(["keep1", "keep2"]).sort();
  expect(removed).toEqual(["drop1", "drop2"]);
  expect(c.has("keep1")).toBe(true);
  expect(c.has("keep2")).toBe(true);
  expect(c.has("drop1")).toBe(false);
  expect(c.has("drop2")).toBe(false);

  rmSync(dir, { recursive: true, force: true });
});

test("Cache.prune with empty keep removes everything", () => {
  const dir = join(import.meta.dir, ".tmp-cache-prune-all");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  c.write("x", { query: "x", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  c.write("y", { query: "y", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  expect(c.prune([]).sort()).toEqual(["x", "y"]);
  expect(c.list()).toHaveLength(0);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.prune with full keep removes nothing", () => {
  const dir = join(import.meta.dir, ".tmp-cache-prune-none");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  c.write("x", { query: "x", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  c.write("y", { query: "y", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  expect(c.prune(["x", "y"])).toEqual([]);
  expect(c.list()).toHaveLength(2);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.read rejects legacy schema (forceNonNull) with actionable message", () => {
  const dir = join(import.meta.dir, ".tmp-cache-legacy-read");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const fp = "legacy1";
  writeFileSync(
    join(dir, `${fp}.json`),
    JSON.stringify({
      query: "SELECT id FROM users",
      paramOids: [],
      paramTsTypes: [],
      columns: [{ name: "id", typeOid: 20, tsType: "bigint", nullable: false, forceNonNull: true }],
      hasResultSet: true,
    }),
  );
  const c = new Cache(dir);
  expect(() => c.read(fp)).toThrow(/older schema/);
  expect(() => c.read(fp)).toThrow(/sqlx-js prepare/);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.list rejects legacy schema (forceNullable) with actionable message", () => {
  const dir = join(import.meta.dir, ".tmp-cache-legacy-list");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `legacy2.json`),
    JSON.stringify({
      query: "SELECT name FROM t",
      paramOids: [],
      paramTsTypes: [],
      columns: [{ name: "name", typeOid: 25, tsType: "string", nullable: true, forceNullable: true }],
      hasResultSet: true,
    }),
  );
  const c = new Cache(dir);
  expect(() => c.list()).toThrow(/older schema/);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.read includes file path when JSON is malformed", () => {
  const dir = join(import.meta.dir, ".tmp-cache-bad-json");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const fp = "corrupt1";
  writeFileSync(join(dir, `${fp}.json`), "{not json");
  const c = new Cache(dir);
  expect(() => c.read(fp)).toThrow(new RegExp(`${fp}\\.json`));
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.remove on missing fp is a no-op", () => {
  const dir = join(import.meta.dir, ".tmp-cache-rm");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  c.write("present", { query: "x", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: false });
  c.remove("absent");
  expect(c.has("present")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
