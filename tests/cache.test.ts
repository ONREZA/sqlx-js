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
    usesTimestampWithoutTimeZone: false,
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
      usesTimestampWithoutTimeZone: false,
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
      usesTimestampWithoutTimeZone: false,
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
  const query = "SELECT 1";
  const fp = fingerprint(query);
  c.write(fp, emptyEntry(query));
  expect(c.has(fp)).toBe(true);
  expect(c.read(fp)?.query).toBe(query);
  expect(c.list().length).toBe(1);
  c.remove(fp);
  expect(c.has(fp)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.list ignores files outside the query-cache namespace", () => {
  const dir = join(import.meta.dir, ".tmp-cache-list");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  const left = fingerprint("SELECT left_value");
  const right = fingerprint("SELECT right_value");
  c.write(left, emptyEntry("SELECT left_value"));
  c.write(right, emptyEntry("SELECT right_value"));
  writeFileSync(join(dir, "runtime-descriptors.json"), "{}");
  writeFileSync(join(dir, "provider-state.json"), "{}");
  const fps = c.list().map((e) => e.fp).sort();
  expect(fps).toEqual([left, right].sort());
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.prune keeps requested fps, removes the rest", () => {
  const dir = join(import.meta.dir, ".tmp-cache-prune");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  const keep = ["SELECT keep_one", "SELECT keep_two"].map(fingerprint);
  const drop = ["SELECT drop_one", "SELECT drop_two"].map(fingerprint);
  c.write(keep[0]!, emptyEntry("SELECT keep_one"));
  c.write(keep[1]!, emptyEntry("SELECT keep_two"));
  c.write(drop[0]!, emptyEntry("SELECT drop_one"));
  c.write(drop[1]!, emptyEntry("SELECT drop_two"));
  writeFileSync(join(dir, "provider-state.json"), "{}");

  const removed = c.prune(keep).sort();
  expect(removed).toEqual(drop.sort());
  expect(c.has(keep[0]!)).toBe(true);
  expect(c.has(keep[1]!)).toBe(true);
  expect(c.has(drop[0]!)).toBe(false);
  expect(c.has(drop[1]!)).toBe(false);
  expect(existsSync(join(dir, "provider-state.json"))).toBe(true);

  rmSync(dir, { recursive: true, force: true });
});

test("Cache.prune with empty keep removes everything", () => {
  const dir = join(import.meta.dir, ".tmp-cache-prune-all");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  const queries = ["SELECT remove_one", "SELECT remove_two"];
  const fps = queries.map(fingerprint);
  c.write(fps[0]!, emptyEntry(queries[0]!));
  c.write(fps[1]!, emptyEntry(queries[1]!));
  expect(c.prune([]).sort()).toEqual(fps.sort());
  expect(c.list()).toHaveLength(0);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.prune with full keep removes nothing", () => {
  const dir = join(import.meta.dir, ".tmp-cache-prune-none");
  rmSync(dir, { recursive: true, force: true });
  const c = new Cache(dir);
  const queries = ["SELECT retain_one", "SELECT retain_two"];
  const fps = queries.map(fingerprint);
  c.write(fps[0]!, emptyEntry(queries[0]!));
  c.write(fps[1]!, emptyEntry(queries[1]!));
  expect(c.prune(fps)).toEqual([]);
  expect(c.list()).toHaveLength(2);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.prune removes legacy fingerprint entries without reading them", () => {
  const dir = join(import.meta.dir, ".tmp-cache-prune-legacy");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const keepQuery = "SELECT current_value";
  const keepFp = fingerprint(keepQuery);
  const legacyQuery = "SELECT legacy_value";
  const legacyFp = fingerprint(legacyQuery);
  const cache = new Cache(dir);
  cache.write(keepFp, emptyEntry(keepQuery));
  const legacy = { ...emptyEntry(legacyQuery) } as Partial<CacheEntry>;
  delete legacy.resultElementNonNullOverrides;
  writeFileSync(join(dir, `${legacyFp}.json`), JSON.stringify(legacy));

  expect(cache.prune([keepFp])).toEqual([legacyFp]);
  expect(cache.read(keepFp)?.query).toBe(keepQuery);
  expect(existsSync(join(dir, `${legacyFp}.json`))).toBe(false);
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
      usesTimestampWithoutTimeZone: false,
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
  const query = "SELECT name FROM t";
  const fp = fingerprint(query);
  writeFileSync(
    join(dir, `${fp}.json`),
    JSON.stringify({
      query,
      paramOids: [],
      paramTypeIdentities: [],
      paramTsTypes: [],
      columns: [{ name: "name", typeOid: 25, tsType: "string", nullable: true, forceNullable: true }],
      hasResultSet: true,
      usesTimestampWithoutTimeZone: false,
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
  expect(manifest.jsonProtocol).toBeGreaterThan(0);
  expect(() => assertCacheManifest(dir, "config-b")).toThrow(/different type-affecting config/);
  writeFileSync(join(dir, "cache-manifest.json"), JSON.stringify({
    ...manifest,
    generatorRevision: manifest.generatorRevision - 1,
  }));
  expect(() => readCacheManifest(dir)).toThrow(/cache manifest is stale.*Run `sqlx-js prepare`/);
  rmSync(dir, { recursive: true, force: true });
});

test("focused cache manifests require a later full prepare", () => {
  const dir = join(import.meta.dir, ".tmp-cache-focused-manifest");
  rmSync(dir, { recursive: true, force: true });
  writeCacheManifest(dir, "config-a", false);
  expect(readCacheManifest(dir)).toMatchObject({ configHash: "config-a", complete: false });
  expect(() => assertCacheManifest(dir, "config-a")).toThrow(/incomplete after focused prepare/);
  expect(assertCacheManifest(dir, "config-a", { allowIncomplete: true }).complete).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("Cache.replaceAll stages the complete successful query set before pruning", () => {
  const dir = join(import.meta.dir, ".tmp-cache-replace");
  rmSync(dir, { recursive: true, force: true });
  const cache = new Cache(dir);
  const oldQuery = "SELECT old";
  const oldFp = fingerprint(oldQuery);
  const leftQuery = "SELECT a";
  const leftFp = fingerprint(leftQuery);
  const rightQuery = "SELECT b";
  const rightFp = fingerprint(rightQuery);
  cache.write(oldFp, emptyEntry(oldQuery, true));
  const removed = cache.replaceAll([
    { fp: leftFp, entry: emptyEntry(leftQuery, true) },
    { fp: rightFp, entry: emptyEntry(rightQuery, true) },
  ]);
  expect(removed).toEqual([oldFp]);
  expect(cache.list().map((item) => item.fp).sort()).toEqual([leftFp, rightFp].sort());
  rmSync(dir, { recursive: true, force: true });
});
