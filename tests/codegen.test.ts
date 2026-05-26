import { test, expect, afterAll } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { emitDts } from "../src/codegen";
import type { CacheEntry } from "../src/cache";

const tmp = join(import.meta.dir, ".tmp-codegen");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(entries: CacheEntry[]): string {
  const out = join(tmp, "sqlx-js-env.d.ts");
  emitDts(out, entries);
  return readFileSync(out, "utf8");
}

test("forceNonNull strips null from inferred-nullable column", () => {
  const dts = write([
    {
      query: 'SELECT count(*) AS "n!" FROM users',
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [
        { name: "n", typeOid: 20, tsType: "bigint", nullable: true, override: "non-null" },
      ],
    },
  ]);
  expect(dts).toContain('"n": bigint');
  expect(dts).not.toContain('"n": bigint | null');
});

test("forceNullable adds null to inferred-non-null column", () => {
  const dts = write([
    {
      query: 'SELECT id AS "id?" FROM users',
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [
        { name: "id", typeOid: 23, tsType: "number", nullable: false, override: "nullable" },
      ],
    },
  ]);
  expect(dts).toContain('"id": number | null');
});

test("force suffixes are stripped from emitted column name", () => {
  const dts = write([
    {
      query: 'SELECT id AS "id!" FROM users',
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [
        { name: "id", typeOid: 23, tsType: "number", nullable: true, override: "non-null" },
      ],
    },
  ]);
  expect(dts).toContain('"id": number');
  expect(dts).not.toContain('"id!":');
});

test("hasResultSet=false emits row: never", () => {
  const dts = write([
    {
      query: "DELETE FROM users WHERE id = $1",
      paramOids: [23],
      paramTsTypes: ["number"],
      hasResultSet: false,
      columns: [],
    },
  ]);
  expect(dts).toContain("row: never");
});

test("non-nullable column stays non-null, nullable stays nullable when no overrides", () => {
  const dts = write([
    {
      query: "SELECT id, bio FROM users",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [
        { name: "id", typeOid: 23, tsType: "number", nullable: false },
        { name: "bio", typeOid: 25, tsType: "string", nullable: true },
      ],
    },
  ]);
  expect(dts).toContain('"id": number;');
  expect(dts).toContain('"bio": string | null');
});

test("entries with filePaths emit KnownFileQueries keyed by path", () => {
  const dts = write([
    {
      query: "SELECT 1",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      hasInline: false,
      filePaths: ["queries/one.sql"],
      columns: [
        { name: "?column?", typeOid: 23, tsType: "number", nullable: false },
      ],
    },
  ]);
  expect(dts).toContain("interface KnownFileQueries");
  expect(dts).toContain('"queries/one.sql": { params: []');
  expect(dts).not.toContain('"SELECT 1": { params:');
});

test("entries with both inline and file usage emit into both interfaces", () => {
  const dts = write([
    {
      query: "SELECT id FROM users",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      hasInline: true,
      filePaths: ["queries/users.sql"],
      columns: [
        { name: "id", typeOid: 23, tsType: "number", nullable: false },
      ],
    },
  ]);
  expect(dts).toContain('"SELECT id FROM users":');
  expect(dts).toContain('"queries/users.sql":');
});

test("KnownFileQueries deduplicates paths across entries", () => {
  const dts = write([
    {
      query: "SELECT 1",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      hasInline: false,
      filePaths: ["a.sql"],
      columns: [],
    },
    {
      query: "SELECT 2",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      hasInline: false,
      filePaths: ["a.sql"],
      columns: [],
    },
  ]);
  const rootBlock = dts.slice(
    dts.indexOf('declare module "@onreza/sqlx-js"'),
    dts.indexOf('declare module "@onreza/sqlx-js/bun"'),
  );
  const matches = rootBlock.match(/"a\.sql":/g) ?? [];
  expect(matches).toHaveLength(1);
});

test("paramNullable adds | null to nullable params", () => {
  const dts = write([
    {
      query: "INSERT INTO users (name, age) VALUES ($1, $2)",
      paramOids: [25, 23],
      paramTsTypes: ["string", "number"],
      paramNullable: [false, true],
      hasResultSet: false,
      columns: [],
    },
  ]);
  expect(dts).toContain("params: [string, number | null]");
});

test("force flags take precedence over schema-derived nullability", () => {
  const dts = write([
    {
      query: 'SELECT bio AS "bio!" FROM users',
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [
        { name: "bio", typeOid: 25, tsType: "string", nullable: true, override: "non-null" },
      ],
    },
  ]);
  expect(dts).toContain('"bio": string }');
  expect(dts).not.toContain("string | null");
});
