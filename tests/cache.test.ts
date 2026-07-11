import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCacheManifest,
  Cache,
  fingerprint,
  portableCacheOid,
  readCacheManifest,
  writeCacheManifest,
} from "../src/cache";

test("portable cache OIDs keep built-ins and normalize database-local types", () => {
  expect(portableCacheOid(20)).toBe(20);
  expect(portableCacheOid(17458)).toBe(0);
});

test("fingerprint is whitespace-invariant", () => {
  expect(fingerprint("SELECT 1")).toBe(fingerprint("SELECT  1"));
  expect(fingerprint("SELECT 1")).toBe(fingerprint(" SELECT 1 "));
});

test("fingerprint keeps whitespace significant inside quoted SQL tokens", () => {
  expect(fingerprint('SELECT "a b" FROM t')).not.toBe(fingerprint('SELECT "a  b" FROM t'));
  expect(fingerprint("SELECT 'a b'")).not.toBe(fingerprint("SELECT 'a  b'"));
  expect(fingerprint("SELECT $$a b$$")).not.toBe(fingerprint("SELECT $$a  b$$"));
});

test("fingerprint still ignores formatting around quoted SQL tokens", () => {
  expect(fingerprint(' SELECT  "a  b"  FROM   t ')).toBe(fingerprint('SELECT "a  b" FROM t'));
  expect(fingerprint("SELECT  'a  b'")).toBe(fingerprint("SELECT 'a  b'"));
  expect(fingerprint("SELECT  $tag$a  b$tag$")).toBe(fingerprint("SELECT $tag$a  b$tag$"));
});

test("fingerprint does not treat dollars inside identifiers as quote delimiters", () => {
  expect(fingerprint("SELECT foo$bar  FROM t")).toBe(fingerprint("SELECT foo$bar FROM t"));
});

test("fingerprint treats SQL comments as whitespace", () => {
  expect(fingerprint("SELECT 1 -- comment\nFROM t")).toBe(fingerprint("SELECT 1 FROM t"));
  expect(fingerprint("SELECT 1 /* comment */ FROM t")).toBe(fingerprint("SELECT 1 FROM t"));
});

test("different queries have different fingerprints", () => {
  expect(fingerprint("SELECT 1")).not.toBe(fingerprint("SELECT 2"));
});

test("named and positional parameter contracts have different fingerprints", () => {
  expect(fingerprint("SELECT $id")).not.toBe(fingerprint("SELECT $1"));
  expect(fingerprint("SELECT $id")).not.toBe(fingerprint("SELECT $user_id"));
});

test("Cache rejects malformed named parameter metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlx-js-cache-named-"));
  try {
    writeFileSync(join(dir, "bad.json"), JSON.stringify({
      query: "SELECT $1",
      paramOids: [23],
      paramTsTypes: ["number"],
      paramNames: ["id", "extra"],
      columns: [],
      hasResultSet: true,
    }));
    expect(() => new Cache(dir).read("bad")).toThrow(/malformed named parameter metadata/);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({
      query: "SELECT $user_id",
      paramOids: [23],
      paramTsTypes: ["number"],
      paramNames: ["id"],
      columns: [],
      hasResultSet: true,
    }));
    expect(() => new Cache(dir).read("bad")).toThrow(/malformed named parameter metadata/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("cache manifest binds generated artifacts to type-affecting config", () => {
  const dir = join(import.meta.dir, ".tmp-cache-manifest");
  rmSync(dir, { recursive: true, force: true });
  writeCacheManifest(dir, "config-a");
  expect(readCacheManifest(dir)?.configHash).toBe("config-a");
  expect(assertCacheManifest(dir, "config-a").generatorRevision).toBeGreaterThan(0);
  expect(() => assertCacheManifest(dir, "config-b")).toThrow(/different jsonbTypes\/customTypes config/);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.replaceAll stages the complete successful query set before pruning", () => {
  const dir = join(import.meta.dir, ".tmp-cache-replace");
  rmSync(dir, { recursive: true, force: true });
  const cache = new Cache(dir);
  cache.write("old", { query: "SELECT old", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: true });
  const removed = cache.replaceAll([
    { fp: "new-a", entry: { query: "SELECT a", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: true } },
    { fp: "new-b", entry: { query: "SELECT b", paramOids: [], paramTsTypes: [], columns: [], hasResultSet: true } },
  ]);
  expect(removed).toEqual(["old"]);
  expect(cache.list().map((item) => item.fp).sort()).toEqual(["new-a", "new-b"]);
  rmSync(dir, { recursive: true, force: true });
});
