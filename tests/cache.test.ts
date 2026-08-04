import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCacheManifest,
  Cache,
  fingerprint,
  portableCacheOid,
  readCacheManifest,
  type CacheEntry,
  writeCacheManifest,
} from "../src/cache";

function emptyEntry(query: string, hasResultSet = false): CacheEntry {
  return {
    query,
    paramOids: [],
    paramTypeIdentities: [],
    paramTsTypes: [],
    paramNullable: [],
    nullableParamOverrides: [],
    resultElementNonNullOverrides: [],
    columns: [],
    hasResultSet,
    inference: { columns: [], params: [] },
  };
}

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
      paramTypeIdentities: [23],
      paramTsTypes: ["number"],
      paramNames: ["id", "extra"],
      columns: [],
      hasResultSet: true,
    }));
    expect(() => new Cache(dir).read("bad")).toThrow(/malformed named parameter metadata/);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({
      query: "SELECT $user_id",
      paramOids: [23],
      paramTypeIdentities: [23],
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

test("Cache rejects missing or incomplete inference explanations", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlx-js-cache-inference-"));
  try {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({
      ...emptyEntry("SELECT 1"),
      inference: undefined,
    }));
    expect(() => new Cache(dir).read("bad")).toThrow(/has no inference explanations.*sqlx-js prepare/);

    writeFileSync(path, JSON.stringify({
      ...emptyEntry("SELECT 1"),
      columns: [{ name: "value", typeOid: 23, tsType: "number", nullable: false }],
    }));
    expect(() => new Cache(dir).read("bad")).toThrow(/invalid inference explanations.*sqlx-js prepare/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cache rejects invalid result assertion metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlx-js-cache-result-assertions-"));
  try {
    writeFileSync(join(dir, "bad.json"), JSON.stringify({
      ...emptyEntry("SELECT 1 AS value", true),
      resultElementNonNullOverrides: ["missing"],
      columns: [{ name: "value", typeOid: 23, tsType: "number", nullable: false }],
      inference: { columns: [{ sources: null, reason: "test fixture" }], params: [] },
    }));
    expect(() => new Cache(dir).read("bad")).toThrow(/invalid result assertion metadata/);

    writeFileSync(join(dir, "bad.json"), JSON.stringify({
      ...emptyEntry("SELECT 1 AS value", true),
      resultElementNonNullOverrides: ["value"],
      columns: [{ name: "value", typeOid: 23, tsType: "number", nullable: false }],
      inference: { columns: [{ sources: null, reason: "test fixture" }], params: [] },
    }));
    expect(() => new Cache(dir).read("bad")).toThrow(/invalid result assertion metadata/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cache validates result assertion order without locale-dependent sorting", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlx-js-cache-result-assertion-order-"));
  try {
    const entry: CacheEntry = {
      ...emptyEntry("SELECT ARRAY['x']::text[] AS \"Z\", ARRAY['y']::text[] AS a", true),
      resultElementNonNullOverrides: ["Z", "a"],
      columns: [
        { name: "Z", typeOid: 1009, tsType: "(string)[]", nullable: false },
        { name: "a", typeOid: 1009, tsType: "(string)[]", nullable: false },
      ],
      inference: {
        columns: [
          { sources: null, reason: "test fixture" },
          { sources: null, reason: "test fixture" },
        ],
        params: [],
      },
    };
    expect(() => new Cache(dir).write("ordered", entry)).not.toThrow();
    expect(() => new Cache(dir).write("reversed", {
      ...entry,
      resultElementNonNullOverrides: ["a", "Z"],
    })).toThrow(/invalid result assertion metadata/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cache validates inference explanations before publishing an entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlx-js-cache-write-inference-"));
  try {
    const cache = new Cache(dir);
    expect(() => cache.write("bad", {
      ...emptyEntry("SELECT $1"),
      paramOids: [23],
      paramTypeIdentities: [23],
      paramTsTypes: ["number"],
      paramNullable: [false],
    })).toThrow(/invalid inference explanations.*sqlx-js prepare/);
    expect(existsSync(join(dir, "bad.json"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cache rejects a production entry whose query does not match its fingerprint", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlx-js-cache-identity-"));
  try {
    expect(() => new Cache(dir).write(
      "0000000000000000",
      emptyEntry("SELECT 1"),
    )).toThrow(/does not match its query\/profile fingerprint.*sqlx-js prepare/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cache round-trips entries to disk", () => {
  const dir = join(import.meta.dir, ".tmp-cache");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  c.write("abc", emptyEntry("SELECT 1"));
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
  c.write("a1", emptyEntry("x"));
  c.write("b2", emptyEntry("y"));
  writeFileSync(join(dir, "runtime-descriptors.json"), "{}");
  const fps = c.list().map((e) => e.fp).sort();
  expect(fps).toEqual(["a1", "b2"]);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.prune keeps requested fps, removes the rest", () => {
  const dir = join(import.meta.dir, ".tmp-cache-prune");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  c.write("keep1", emptyEntry("a"));
  c.write("keep2", emptyEntry("b"));
  c.write("drop1", emptyEntry("c"));
  c.write("drop2", emptyEntry("d"));

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
  c.write("x", emptyEntry("x"));
  c.write("y", emptyEntry("y"));
  expect(c.prune([]).sort()).toEqual(["x", "y"]);
  expect(c.list()).toHaveLength(0);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.prune with full keep removes nothing", () => {
  const dir = join(import.meta.dir, ".tmp-cache-prune-none");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  c.write("x", emptyEntry("x"));
  c.write("y", emptyEntry("y"));
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
      paramTypeIdentities: [],
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
      paramTypeIdentities: [],
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
  c.write("present", emptyEntry("x"));
  c.remove("absent");
  expect(c.has("present")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("cache manifest binds generated artifacts to type-affecting config", () => {
  const dir = join(import.meta.dir, ".tmp-cache-manifest");
  rmSync(dir, { recursive: true, force: true });
  writeCacheManifest(dir, "config-a");
  expect(readCacheManifest(dir)?.configHash).toBe("config-a");
  const manifest = assertCacheManifest(dir, "config-a");
  expect(manifest.generatorRevision).toBeGreaterThan(0);
  expect(() => assertCacheManifest(dir, "config-b")).toThrow(/different type-affecting config/);
  writeFileSync(join(dir, "cache-manifest.json"), JSON.stringify({
    ...manifest,
    generatorRevision: manifest.generatorRevision - 1,
  }));
  expect(() => readCacheManifest(dir)).toThrow(/cache manifest is stale.*Run `sqlx-js prepare`/);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.replaceAll stages the complete successful query set before pruning", () => {
  const dir = join(import.meta.dir, ".tmp-cache-replace");
  rmSync(dir, { recursive: true, force: true });
  const cache = new Cache(dir);
  cache.write("old", emptyEntry("SELECT old", true));
  const removed = cache.replaceAll([
    { fp: "new-a", entry: emptyEntry("SELECT a", true) },
    { fp: "new-b", entry: emptyEntry("SELECT b", true) },
  ]);
  expect(removed).toEqual(["old"]);
  expect(cache.list().map((item) => item.fp).sort()).toEqual(["new-a", "new-b"]);
  rmSync(dir, { recursive: true, force: true });
});
