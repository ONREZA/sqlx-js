import { test, expect, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { emitDts } from "../src/codegen";
import type { CacheEntry } from "../src/cache";
import type { FunctionEntry } from "../src/function-cache";

const tmp = join(import.meta.dir, ".tmp-codegen");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(entries: CacheEntry[], functions: FunctionEntry[] = []): string {
  const out = join(tmp, "sqlx-js-env.d.ts");
  emitDts(out, entries, functions);
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

test("named parameters emit a strictly typed object", () => {
  const dts = write([{
    query: "SELECT * FROM users WHERE email = $1 AND age = $2",
    inlineQueries: ["SELECT * FROM users WHERE email = $email AND age = $age"],
    paramOids: [25, 23],
    paramTsTypes: ["string", "number"],
    paramNullable: [false, true],
    paramNames: ["email", "age"],
    hasResultSet: true,
    columns: [],
  }]);
  expect(dts).toContain('params: { "email": string; "age": number | null }');
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
      inlineQueries: ["SELECT id FROM users", "SELECT  id  FROM users"],
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
  expect(dts).toContain('"SELECT  id  FROM users":');
  expect(dts).toContain('"queries/users.sql":');
});

test("KnownQueries emits all inline query variants for a shared fingerprint", () => {
  const dts = write([
    {
      query: "SELECT id FROM users WHERE id = $1",
      inlineQueries: [
        "SELECT id FROM users WHERE id = $1",
        "SELECT  id  FROM users WHERE id = $1",
      ],
      paramOids: [20],
      paramTsTypes: ["bigint"],
      hasResultSet: true,
      hasInline: true,
      columns: [
        { name: "id", typeOid: 20, tsType: "bigint", nullable: false },
      ],
    },
  ]);
  expect(dts).toContain('"SELECT id FROM users WHERE id = $1": { params: [bigint]');
  expect(dts).toContain('"SELECT  id  FROM users WHERE id = $1": { params: [bigint]');
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
    dts.indexOf("export interface SqlxJsGeneratedFileQueries"),
    dts.indexOf("export interface SqlxJsGeneratedFunctions"),
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

test("KnownFunctions emits pg_proc catalog entries", () => {
  const dts = write([], [
    {
      schema: "public",
      name: "slugify",
      signature: "public.slugify(value text)",
      kind: "function",
      params: [{ mode: "in", name: "value", tsType: "string" }],
      returns: "string | null",
      returnsSet: false,
    },
    {
      schema: "public",
      name: "search_posts",
      signature: "public.search_posts(query text)",
      kind: "function",
      params: [{ mode: "in", name: "query", tsType: "string" }],
      returns: "{ slug: string | null; score: number | null }",
      returnsSet: true,
    },
  ]);
  expect(dts).toContain("interface KnownFunctions");
  expect(dts).toContain('"public.slugify(value text)": { kind: "function"; params: [string]; returns: string | null; returnsSet: false }');
  expect(dts).toContain('"public.search_posts(query text)": { kind: "function"; params: [string]; returns: { slug: string | null; score: number | null }; returnsSet: true }');
  expect(dts).toContain("export interface SqlxJsGeneratedRegistry");
  expect(dts).toContain("interface KnownQueries extends SqlxJsGeneratedQueries");
});

test("two generated registries remain independently usable in one TypeScript program", () => {
  const root = join(tmp, "isolated-registries");
  mkdirSync(root, { recursive: true });
  emitDts(join(root, "primary.d.ts"), [{
    query: "SELECT primary",
    paramOids: [],
    paramTsTypes: [],
    hasResultSet: true,
    columns: [{ name: "primary", typeOid: 23, tsType: "number", nullable: false }],
  }]);
  emitDts(join(root, "replica.d.ts"), [{
    query: "SELECT replica",
    paramOids: [],
    paramTsTypes: [],
    hasResultSet: true,
    columns: [{ name: "replica", typeOid: 25, tsType: "string", nullable: false }],
  }]);
  writeFileSync(join(root, "consumer.ts"), `
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry as PrimaryRegistry } from "./primary";
import type { SqlxJsGeneratedRegistry as ReplicaRegistry } from "./replica";

const primaryKey: keyof PrimaryRegistry["queries"] = "SELECT primary";
const replicaKey: keyof ReplicaRegistry["queries"] = "SELECT replica";
const primaryOnly: "SELECT primary" = null as unknown as keyof PrimaryRegistry["queries"];
const replicaOnly: "SELECT replica" = null as unknown as keyof ReplicaRegistry["queries"];

const primary = createSqlClient<PrimaryRegistry>();
const replica = createSqlClient<ReplicaRegistry>();
void primary.sql(primaryKey);
void replica.sql(replicaKey);
void primaryOnly;
void replicaOnly;
`);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ESNext",
      types: ["bun-types"],
      baseUrl: resolve(import.meta.dir, ".."),
      paths: { "@onreza/sqlx-js": ["src/index.ts"] },
    },
    files: ["consumer.ts", "primary.d.ts", "replica.d.ts"],
  }));

  const checked = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});
