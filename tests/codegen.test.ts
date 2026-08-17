import { test, expect, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { emitDts } from "../src/codegen";
import type { CacheEntry } from "../src/cache";
import type { FunctionEntry } from "../src/function-cache";
import type { DatabaseProfiles } from "../src/config";
import type { TemporalPolicy } from "../src/temporal";
import { TEMPORAL_PROVIDER_TYPE_MARKER } from "../src/pg/oids";

const tmp = join(import.meta.dir, ".tmp-codegen");
const GENERATED_PG_TIMESTAMPTZ =
  `import("@onreza/sqlx-js").PgTimestamptz<${TEMPORAL_PROVIDER_TYPE_MARKER}>`;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

type CacheEntryFixture = Omit<
  CacheEntry,
  | "paramTypeIdentities"
  | "paramNullable"
  | "nullableParamOverrides"
  | "resultElementNonNullOverrides"
  | "inference"
> & {
  paramTypeIdentities?: CacheEntry["paramTypeIdentities"];
  paramNullable?: CacheEntry["paramNullable"];
  nullableParamOverrides?: CacheEntry["nullableParamOverrides"];
  resultElementNonNullOverrides?: CacheEntry["resultElementNonNullOverrides"];
  inference?: CacheEntry["inference"];
};

function completeEntries(entries: CacheEntryFixture[]): CacheEntry[] {
  return entries.map((entry) => ({
    ...entry,
    usesTimestampWithoutTimeZone: entry.usesTimestampWithoutTimeZone ?? false,
    paramTypeIdentities: entry.paramTypeIdentities ?? entry.paramOids,
    paramNullable: entry.paramNullable ?? entry.paramTsTypes.map(() => false),
    nullableParamOverrides: entry.nullableParamOverrides ?? [],
    resultElementNonNullOverrides: entry.resultElementNonNullOverrides ?? [],
    inference: entry.inference ?? {
      columns: entry.columns.map(() => ({ sources: null, reason: "test fixture" })),
      params: entry.paramTsTypes.map(() => ({ targets: [], reason: "test fixture" })),
    },
  }));
}

function write(
  entries: CacheEntryFixture[],
  functions: FunctionEntry[] = [],
  runtimeTypes: Record<string, string> = {},
  profiles: DatabaseProfiles = {},
  temporal?: TemporalPolicy,
): string {
  const out = join(tmp, "sqlx-js-env.d.ts");
  emitDts(out, completeEntries(entries), functions, runtimeTypes, profiles, temporal);
  return readFileSync(out, "utf8");
}

test("profile registries contain only queries assigned to that connection profile", () => {
  const dts = write([
    {
      profile: "api",
      query: "SELECT api",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [{ name: "api", typeOid: 23, tsType: "number", nullable: false }],
    },
    {
      profile: "worker",
      query: "SELECT worker",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [{ name: "worker", typeOid: 25, tsType: "string", nullable: false }],
    },
  ], [], {}, {
    api: { name: "api", role: "app_api" },
    worker: { name: "worker", role: "app_worker" },
  });

  expect(dts).toContain('"api": {');
  expect(dts).toContain('"worker": {');
  expect(dts).toContain('readonly role: "app_api"');
  expect(dts).toContain('readonly role: "app_worker"');
  expect(dts).toContain('"SELECT api": { params: []; row: { "api": number } }');
  expect(dts).toContain('"SELECT worker": { params: []; row: { "worker": string } }');
  expect(dts).toContain("type SqlxJsGeneratedProfileRegistry<Name extends keyof SqlxJsGeneratedProfiles, TemporalProvider extends");
});

test("generated registries carry the exact Temporal policy", () => {
  const dts = write([
    {
      query: "SELECT $1::timestamptz AS value",
      paramOids: [1184],
      paramTsTypes: [GENERATED_PG_TIMESTAMPTZ],
      hasResultSet: true,
      columns: [{ name: "value", typeOid: 1184, tsType: GENERATED_PG_TIMESTAMPTZ, nullable: false }],
    },
  ], [], {}, {}, { infinity: "reject" });

  expect(dts).toContain('temporal: { readonly infinity: "reject"; readonly timestampWithoutTimeZone: "reject"; readonly sessionTimeZone: "UTC" };');
  expect(dts).toContain(
    '"SELECT $1::timestamptz AS value": { params: [import("@onreza/sqlx-js").PgTimestamptz<TemporalProvider>]; row: { "value": import("@onreza/sqlx-js").PgTimestamptz<TemporalProvider> } }',
  );
  expect(dts).toContain("export interface SqlxJsGeneratedRegistry");
  expect(dts).not.toContain("declare module");
});

test("generated Temporal generics do not shadow application type expressions", () => {
  const dts = write([{
    query: "SELECT application_value, now() AS at",
    paramOids: [],
    paramTsTypes: [],
    hasResultSet: true,
    columns: [
      { name: "application_value", typeOid: 0, tsType: "TemporalProvider", nullable: false },
      { name: "at", typeOid: 1184, tsType: GENERATED_PG_TIMESTAMPTZ, nullable: false },
    ],
  }]);

  expect(dts).toContain(
    "interface SqlxJsGeneratedQueries<TemporalProvider2 extends",
  );
  expect(dts).toContain(
    'row: { "application_value": TemporalProvider; '
      + '"at": import("@onreza/sqlx-js").PgTimestamptz<TemporalProvider2> }',
  );
});

test("temporal reject registries compile with descriptor and explicit adaptive policies", () => {
  const root = join(tmp, "temporal-reject");
  mkdirSync(root, { recursive: true });
  emitDts(join(root, "generated.d.ts"), completeEntries([
    {
      query: "SELECT $1::timestamptz AS value",
      paramOids: [1184],
      paramTsTypes: [GENERATED_PG_TIMESTAMPTZ],
      hasResultSet: true,
      columns: [{ name: "value", typeOid: 1184, tsType: GENERATED_PG_TIMESTAMPTZ, nullable: false }],
    },
  ]), [], {}, {}, { infinity: "reject" });
  writeFileSync(join(root, "consumer.ts"), `
import { createClient, createSqlClient } from "@onreza/sqlx-js";
import { Temporal } from "temporal-polyfill";
import type { SqlxJsGeneratedRegistry as GeneratedRegistry } from "./generated";

type SqlxJsGeneratedRegistry = GeneratedRegistry<typeof Temporal>;
const rawFactory = createClient<SqlxJsGeneratedRegistry>;
type RawClientArgs = Parameters<typeof rawFactory>;
type RawOptionsAreRequired = RawClientArgs extends [string | undefined, object] ? true : false;
const rawOptionsAreRequired: RawOptionsAreRequired = true;
type ManualRegistry = {
  queries: {};
  fileQueries: {};
  jsonProtocol: 1;
  temporalApi: typeof Temporal;
};
const managedFactory = createSqlClient<ManualRegistry>;
type ManagedClientArgs = Parameters<typeof managedFactory>;
type ManagedOptionsAreRequired = ManagedClientArgs extends [string | undefined, object] ? true : false;
const managedOptionsAreRequired: ManagedOptionsAreRequired = true;

declare const queryDescriptors: import("@onreza/sqlx-js").RuntimeQueryDescriptors;
const unscopedManaged = createSqlClient(undefined, {
  execution: "adaptive",
  temporal: { infinity: "reject", timestampWithoutTimeZone: "reject", sessionTimeZone: "UTC" },
  temporalApi: Temporal,
});
const unscopedRaw = createClient(undefined, {
  temporal: { infinity: "reject", timestampWithoutTimeZone: "reject", sessionTimeZone: "UTC" },
  temporalApi: Temporal,
});
const prepared = createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
  queryDescriptors,
  temporalApi: Temporal,
});
const adaptive = createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
  execution: "adaptive",
  temporal: { infinity: "reject", timestampWithoutTimeZone: "reject", sessionTimeZone: "UTC" },
  temporalApi: Temporal,
});
const raw = createClient<SqlxJsGeneratedRegistry>(undefined, {
  temporal: { infinity: "reject", timestampWithoutTimeZone: "reject", sessionTimeZone: "UTC" },
  temporalApi: Temporal,
});
const instant = Temporal.Instant.from("2026-01-01T00:00:00Z");
const preparedResult: Promise<{ value: Temporal.Instant }[]> = prepared.sql("SELECT $1::timestamptz AS value", instant);
void adaptive.sql("SELECT $1::timestamptz AS value", instant);
void preparedResult;
void unscopedManaged;
void unscopedRaw;
void raw;
void rawOptionsAreRequired;
void managedOptionsAreRequired;
`);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ESNext",
      lib: ["ES2024"],
      types: ["bun-types"],
      paths: { "@onreza/sqlx-js": [resolve(import.meta.dir, "../src/index.ts")] },
    },
    files: ["consumer.ts", "generated.d.ts"],
  }));

  const checked = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});

test("native Temporal registries bind the global provider exactly", () => {
  const root = join(tmp, "temporal-native");
  mkdirSync(root, { recursive: true });
  emitDts(join(root, "generated.d.ts"), completeEntries([
    {
      query: "SELECT $1::timestamptz AS value",
      paramOids: [1184],
      paramTsTypes: [GENERATED_PG_TIMESTAMPTZ],
      hasResultSet: true,
      columns: [{
        name: "value",
        typeOid: 1184,
        tsType: GENERATED_PG_TIMESTAMPTZ,
        nullable: false,
      }],
    },
  ]));
  writeFileSync(join(root, "consumer.ts"), `
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry as GeneratedRegistry } from "./generated";

type Registry = GeneratedRegistry<typeof Temporal>;
declare const queryDescriptors: import("@onreza/sqlx-js").RuntimeQueryDescriptors;
const client = createSqlClient<Registry>(undefined, { queryDescriptors, temporalApi: Temporal });
const instant = Temporal.Instant.from("2026-01-01T00:00:00Z");
const result: Promise<{ value: Temporal.Instant }[]> = client.sql(
  "SELECT $1::timestamptz AS value",
  instant,
);
void result;
`);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ES2024",
      lib: ["ES2024", "ESNext.Temporal"],
      types: ["bun-types"],
      paths: { "@onreza/sqlx-js": [resolve(import.meta.dir, "../src/index.ts")] },
    },
    files: ["consumer.ts", "generated.d.ts"],
  }));

  const checked = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});

test("profiled mapped queries validate their generated wire parameters", () => {
  const root = join(tmp, "profiled-map-params");
  const query = "SELECT id FROM users WHERE id = $id";
  const positionalQuery = "SELECT $1::text AS id";
  mkdirSync(root, { recursive: true });
  emitDts(join(root, "generated.d.ts"), completeEntries([
    {
      profile: "api",
      query,
      paramOids: [2950],
      paramTsTypes: ["string"],
      paramNames: ["id"],
      hasResultSet: true,
      columns: [{ name: "id", typeOid: 2950, tsType: "string", nullable: false }],
    },
    {
      profile: "worker",
      query,
      paramOids: [2950],
      paramTsTypes: ["string"],
      paramNames: ["id"],
      paramNullable: [true],
      hasResultSet: true,
      columns: [{ name: "id", typeOid: 2950, tsType: "string", nullable: false }],
    },
    {
      profile: "api",
      query: positionalQuery,
      paramOids: [25],
      paramTsTypes: ["string"],
      hasResultSet: true,
      columns: [{ name: "id", typeOid: 25, tsType: "string", nullable: true }],
    },
    {
      profile: "worker",
      query: positionalQuery,
      paramOids: [25],
      paramTsTypes: ["string"],
      paramNullable: [true],
      hasResultSet: true,
      columns: [{ name: "id", typeOid: 25, tsType: "string", nullable: true }],
    },
  ]), [], {}, {
    api: { name: "api", role: "app_api" },
    worker: { name: "worker", role: "app_worker" },
  });
  writeFileSync(join(root, "consumer.ts"), `
import { createSqlClient, defineQuery } from "@onreza/sqlx-js";
import type {
  MappedQueryDefinition,
  QueryRegistry,
  SqlExecutor,
} from "@onreza/sqlx-js";
import type { SqlxJsGeneratedProfileRegistry } from "./generated";

function runGenericMapped<
  Query extends string,
  WireParams extends Record<string, unknown>,
  Entry extends { params: WireParams; row: unknown },
  Registry extends QueryRegistry & { queries: Record<Query, Entry> },
>(
  definition: MappedQueryDefinition<Query, "one", { id: string }, WireParams>,
  executor: SqlExecutor<Registry>,
  input: { id: string },
) {
  return definition.run(executor, input);
}

const api = createSqlClient<SqlxJsGeneratedProfileRegistry<"api">>(undefined, { execution: "adaptive", profile: { name: "api", role: "app_api" }, temporalApi: Temporal });
const worker = createSqlClient<SqlxJsGeneratedProfileRegistry<"worker">>(undefined, { execution: "adaptive", profile: { name: "worker", role: "app_worker" }, temporalApi: Temporal });
const valid = defineQuery.for("api").one(${JSON.stringify(query)}).mapParams(
  (input: { id: string }) => ({ id: input.id }),
);
void valid.run(api.sql, { id: "user-1" });
void runGenericMapped(valid, api.sql, { id: "user-1" });
const wrongKey = defineQuery.for("api").one(${JSON.stringify(query)}).mapParams(
  (input: { id: string }) => ({ wrong: input.id }),
);
// @ts-expect-error mapped wire parameters must match the explicit registry
void wrongKey.run(api.sql, { id: "user-1" });
const extraKey = defineQuery.for("api").one(${JSON.stringify(query)}).mapParams(
  (input: { id: string }) => ({ id: input.id, extra: true }),
);
// @ts-expect-error mapped named parameters must have the registry's exact keys
void extraKey.run(api.sql, { id: "user-1" });
const unionExtraKey = defineQuery.for("api").one(${JSON.stringify(query)}).mapParams(
  (input: { id: string; variant: "first" | "second" }) => input.variant === "first"
    ? { id: input.id, first: true }
    : { id: input.id, second: true },
);
// @ts-expect-error every mapped union branch must have the registry's exact keys
void unionExtraKey.run(api.sql, { id: "user-1", variant: "first" });
const shared = defineQuery.for("api", "worker").one(${JSON.stringify(query)}).mapParams(
  (input: { id: string }) => ({ id: input.id }),
);
void shared.run(api.sql, { id: "user-1" });
void shared.run(worker.sql, { id: "user-1" });
const nullable = defineQuery.for("api", "worker").one(${JSON.stringify(query)}).mapParams(
  (input: { id: string | null }) => ({ id: input.id }),
);
// @ts-expect-error the api registry requires a non-null wire value
void nullable.run(api.sql, { id: null });
void nullable.run(worker.sql, { id: null });
const positional = defineQuery.for("api", "worker").one(${JSON.stringify(positionalQuery)}).mapParams(
  (input: { id: string }) => [input.id] as const,
);
void positional.run(api.sql, { id: "user-1" });
void positional.run(worker.sql, { id: "user-1" });
const extraPosition = defineQuery.for("api").one(${JSON.stringify(positionalQuery)}).mapParams(
  (input: { id: string }) => [input.id, "extra"] as const,
);
// @ts-expect-error mapped positional parameters must have the registry's exact length
void extraPosition.run(api.sql, { id: "user-1" });
`);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ESNext",
      types: ["bun-types"],
      paths: { "@onreza/sqlx-js": [resolve(import.meta.dir, "../src/index.ts")] },
    },
    files: ["consumer.ts", "generated.d.ts"],
  }));

  const checked = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});

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

test("entries with filePaths emit generated file queries keyed by path", () => {
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
  expect(dts).toContain("interface SqlxJsGeneratedFileQueries");
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

test("generated queries emit all inline variants for a shared fingerprint", () => {
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

test("generated file queries deduplicate paths across entries", () => {
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

test("generated functions emit pg_proc catalog entries", () => {
  const dts = write([], [
    {
      schema: "public",
      name: "slugify",
      signature: "public.slugify(value text)",
      kind: "function",
      language: "sql",
      params: [{ mode: "in", name: "value", tsType: "string | null" }],
      returns: "string | null",
      returnsSet: false,
      volatility: "immutable",
      strict: false,
      securityDefiner: false,
      leakproof: false,
      parallelSafety: "safe",
      owner: "app_owner",
      ownerSuperuser: false,
      publicExecute: true,
      settings: [],
      searchPath: null,
      extensionOwned: false,
    },
    {
      schema: "public",
      name: "search_posts",
      signature: "public.search_posts(query text)",
      kind: "function",
      language: "plpgsql",
      params: [{ mode: "in", name: "query", tsType: "string | null" }],
      returns: "{ slug: string | null; score: number | null }",
      returnsSet: true,
      volatility: "stable",
      strict: false,
      securityDefiner: true,
      leakproof: false,
      parallelSafety: "restricted",
      owner: "reporting_owner",
      ownerSuperuser: false,
      publicExecute: false,
      settings: ["search_path=reporting, pg_temp", "TimeZone=UTC"],
      searchPath: "reporting, pg_temp",
      extensionOwned: false,
    },
  ]);
  expect(dts).toContain("interface SqlxJsGeneratedFunctions");
  expect(dts).toContain('"public.slugify(value text)": { kind: "function"; language: "sql"; params: [string | null]; returns: string | null; returnsSet: false; volatility: "immutable"; strict: false; securityDefiner: false; leakproof: false; parallelSafety: "safe"; owner: "app_owner"; ownerSuperuser: false; publicExecute: true; settings: readonly []; searchPath: null; extensionOwned: false }');
  expect(dts).toContain('"public.search_posts(query text)": { kind: "function"; language: "plpgsql"; params: [string | null]; returns: { slug: string | null; score: number | null }; returnsSet: true; volatility: "stable"; strict: false; securityDefiner: true; leakproof: false; parallelSafety: "restricted"; owner: "reporting_owner"; ownerSuperuser: false; publicExecute: false; settings: readonly ["search_path=reporting, pg_temp", "TimeZone=UTC"]; searchPath: "reporting, pg_temp"; extensionOwned: false }');
  expect(dts).toContain("export interface SqlxJsGeneratedRegistry");
  expect(dts).not.toContain("interface KnownQueries");
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
  }], [], { shared_type: "number" });
  emitDts(join(root, "replica.d.ts"), [{
    query: "SELECT replica",
    paramOids: [],
    paramTsTypes: [],
    hasResultSet: true,
    columns: [{ name: "replica", typeOid: 25, tsType: "string", nullable: false }],
  }], [], { shared_type: "string" });
  writeFileSync(join(root, "consumer.ts"), `
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry as PrimaryRegistry } from "./primary";
import type { SqlxJsGeneratedRegistry as ReplicaRegistry } from "./replica";

const primaryKey: keyof PrimaryRegistry["queries"] = "SELECT primary";
const replicaKey: keyof ReplicaRegistry["queries"] = "SELECT replica";
const primaryOnly: "SELECT primary" = null as unknown as keyof PrimaryRegistry["queries"];
const replicaOnly: "SELECT replica" = null as unknown as keyof ReplicaRegistry["queries"];

const primary = createSqlClient<PrimaryRegistry>(undefined, {
  execution: "adaptive",
  temporalApi: Temporal,
  typeCodecs: { shared_type: { parse: Number, serialize: String } },
});
const replica = createSqlClient<ReplicaRegistry>(undefined, {
  execution: "adaptive",
  temporalApi: Temporal,
  typeCodecs: { shared_type: { parse: String, serialize: String } },
});
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
      paths: { "@onreza/sqlx-js": [resolve(import.meta.dir, "../src/index.ts")] },
    },
    files: ["consumer.ts", "primary.d.ts", "replica.d.ts"],
  }));

  const checked = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});

test("createSqlClient binds an explicit generated profile registry", () => {
  const root = join(tmp, "profile-registry");
  mkdirSync(root, { recursive: true });
  emitDts(join(root, "generated.d.ts"), completeEntries([
    {
      profile: "api",
      query: "SELECT api",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [{ name: "api", typeOid: 23, tsType: "number", nullable: false }],
    },
    {
      profile: "worker",
      query: "SELECT worker",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [{ name: "worker", typeOid: 25, tsType: "string", nullable: false }],
    },
  ]), [], {}, {
    api: { name: "api", role: "app_api" },
    worker: { name: "worker", role: "app_worker" },
  });
  writeFileSync(join(root, "consumer.ts"), `
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedProfileRegistry } from "./generated";

declare const queryDescriptors: import("@onreza/sqlx-js").RuntimeQueryDescriptors;
const preparedApi = createSqlClient<SqlxJsGeneratedProfileRegistry<"api">>(undefined, {
  queryDescriptors,
  profile: { name: "api", role: "app_api" },
  temporalApi: Temporal,
});
void preparedApi.sql("SELECT api");
void preparedApi.sql.with({ timeoutMs: 1_000 })("SELECT api");
void preparedApi.sql.with({ signal: new AbortController().signal }).with({ timeoutMs: 1_000 })("SELECT api");
// @ts-expect-error descriptor and adaptive execution modes are mutually exclusive
createSqlClient<SqlxJsGeneratedProfileRegistry<"api">>(undefined, { queryDescriptors, execution: "adaptive", profile: { name: "api", role: "app_api" }, temporalApi: Temporal });

const api = createSqlClient<SqlxJsGeneratedProfileRegistry<"api">>(undefined, {
  execution: "adaptive",
  profile: { name: "api", role: "app_api" },
  temporalApi: Temporal,
});
void api.sql("SELECT api");
// @ts-expect-error generated clients require queryDescriptors or an explicit adaptive opt-out
createSqlClient<SqlxJsGeneratedProfileRegistry<"api">>(undefined, { profile: { name: "api", role: "app_api" }, temporalApi: Temporal });
// @ts-expect-error worker queries are not available through the api profile
void api.sql("SELECT worker");
// @ts-expect-error the generated api profile requires the app_api PostgreSQL role
createSqlClient<SqlxJsGeneratedProfileRegistry<"api">>(undefined, { execution: "adaptive", profile: { name: "api", role: "wrong" }, temporalApi: Temporal });
`);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ESNext",
      types: ["bun-types"],
      paths: { "@onreza/sqlx-js": [resolve(import.meta.dir, "../src/index.ts")] },
    },
    files: ["consumer.ts", "generated.d.ts"],
  }));

  const checked = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});

test("profile transaction settings are required and typed", () => {
  const root = join(tmp, "profile-transaction-settings");
  mkdirSync(root, { recursive: true });
  emitDts(join(root, "generated.d.ts"), completeEntries([
    {
      profile: "api",
      query: "SELECT api",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [{ name: "api", typeOid: 23, tsType: "number", nullable: false }],
    },
    {
      profile: "api",
      query: "SELECT $tenant::text AS tenant",
      paramOids: [25],
      paramTsTypes: ["string"],
      paramNames: ["tenant"],
      hasResultSet: true,
      columns: [{ name: "tenant", typeOid: 25, tsType: "string", nullable: false }],
    },
    {
      profile: "worker",
      query: "SELECT api",
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [{ name: "api", typeOid: 23, tsType: "number", nullable: false }],
    },
  ]), [], {}, {
    api: {
      name: "api",
      role: "app_api",
      transactionSettings: ["app.tenant_id", "app.user_id"],
    },
    worker: {
      name: "worker",
      role: "app_worker",
    },
  });
  writeFileSync(join(root, "consumer.ts"), `
import { createSqlClient, defineQuery, type SqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedProfileRegistry, SqlxJsGeneratedProfiles } from "./generated";

const tenantQuery = defineQuery.one("SELECT $tenant::text AS tenant");
const tenantParams = { tenant: "tenant-1" };
const tenantParamsWithExtra = { ...tenantParams, extra: true };

const api = createSqlClient<SqlxJsGeneratedProfileRegistry<"api">>(undefined, {
  execution: "adaptive",
  temporalApi: Temporal,
  profile: {
    name: "api",
    role: "app_api",
    transactionSettings: ["app.tenant_id", "app.user_id"],
  },
});
void api.sql.transaction({
  settings: {
    "app.tenant_id": "tenant-1",
    "app.user_id": "user-1",
  },
}, async (tx) => {
  await tx("SELECT api");
  await tx.one("SELECT $tenant::text AS tenant", tenantParams);
  await tenantQuery.run(tx, tenantParams);
  const boundTenantQuery = tenantQuery.bind(tx);
  await boundTenantQuery(tenantParams);
  await tx.with({ timeoutMs: 1_000 })("SELECT api");
  await tx.with({ timeoutMs: 1_000 }).one("SELECT $tenant::text AS tenant", tenantParams);
  // @ts-expect-error contextual transaction params must have the registry's exact keys
  await tx.one("SELECT $tenant::text AS tenant", tenantParamsWithExtra);
  // @ts-expect-error contextual definitions must have the registry's exact keys
  await tenantQuery.run(tx, tenantParamsWithExtra);
  // @ts-expect-error bound contextual definitions must preserve the exact keys
  await boundTenantQuery(tenantParamsWithExtra);
  await tx.savepoint(async (sp) => {
    await sp("SELECT api");
    await sp.one("SELECT $tenant::text AS tenant", tenantParams);
    // @ts-expect-error savepoint params must have the registry's exact keys
    await sp.one("SELECT $tenant::text AS tenant", tenantParamsWithExtra);
  });
});
// @ts-expect-error contextual profile definitions bind only inside a transaction
void tenantQuery.bind(api.sql);
// @ts-expect-error contextual profiles execute SQL only through a transaction
void api.sql("SELECT api");
// @ts-expect-error profile transaction settings are required
void api.sql.transaction(async () => {});
void api.sql.transaction({
  // @ts-expect-error every declared transaction setting is required
  settings: { "app.tenant_id": "tenant-1" },
}, async () => {});

const worker = createSqlClient<SqlxJsGeneratedProfileRegistry<"worker">>(undefined, {
  execution: "adaptive",
  profile: { name: "worker", role: "app_worker" },
  temporalApi: Temporal,
});
void worker.sql("SELECT api");

declare const maybeContextual: SqlClient<
  SqlxJsGeneratedProfiles["api"] | SqlxJsGeneratedProfiles["worker"]
>;
// @ts-expect-error a registry union containing a contextual profile remains transaction-only
void maybeContextual.sql("SELECT api");
`);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ESNext",
      types: ["bun-types"],
      paths: { "@onreza/sqlx-js": [resolve(import.meta.dir, "../src/index.ts")] },
    },
    files: ["consumer.ts", "generated.d.ts"],
  }));

  const checked = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});

test("generated custom types require matching scoped runtime codecs", () => {
  const root = join(tmp, "runtime-codecs");
  mkdirSync(root, { recursive: true });
  emitDts(join(root, "generated.d.ts"), [], [], {
    geometry: "{ x: number; y: number }",
  });
  writeFileSync(join(root, "consumer.ts"), `
import { createClient, createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./generated";

const client = createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
  execution: "adaptive",
  temporalApi: Temporal,
  typeCodecs: {
    geometry: {
      parse: (value) => ({ x: Number(value), y: Number(value) }),
      serialize: (value) => \`${"${value.x},${value.y}"}\`,
    },
  },
});
void client;

const rawClient = createClient<SqlxJsGeneratedRegistry>(undefined, {
  temporalApi: Temporal,
  types: {
    geometry: {
      to: 50_000,
      from: [50_000],
      parse: (value) => ({ x: Number(value), y: Number(value) }),
      serialize: (value) => \`${"${value.x},${value.y}"}\`,
    },
    application_tag: {
      to: 50_001,
      from: [50_001],
      parse: String,
      serialize: String,
    },
  },
});
void rawClient;

const numericClient = createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
  execution: "adaptive",
  temporalApi: Temporal,
  types: {
    geometry: {
      to: 50_000,
      from: [50_000],
      parse: (value) => ({ x: Number(value), y: Number(value) }),
      serialize: (value) => \`${"${value.x},${value.y}"}\`,
    },
  },
});
void numericClient;

// @ts-expect-error numeric parser output must match the configured customTypes representation
createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
  execution: "adaptive",
  temporalApi: Temporal,
  types: {
    geometry: {
      to: 50_000,
      from: [50_000],
      parse: () => "not geometry",
      serialize: (value) => \`${"${value.x},${value.y}"}\`,
    },
  },
});

createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
  execution: "adaptive",
  temporalApi: Temporal,
  typeCodecs: {
    geometry: {
      // @ts-expect-error parser output must match the configured customTypes representation
      parse: () => "not geometry",
      serialize: (value) => \`${"${value.x},${value.y}"}\`,
    },
  },
});

createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
  execution: "adaptive",
  temporalApi: Temporal,
  typeCodecs: {
    geometry: {
      parse: (value) => ({ x: Number(value), y: Number(value) }),
      // @ts-expect-error serializer input must match the configured customTypes representation
      serialize: (value: string) => value,
    },
  },
});

// @ts-expect-error customTypes require corresponding runtime codecs
createSqlClient<SqlxJsGeneratedRegistry>();
// @ts-expect-error raw clients bound to generated customTypes require numeric driver types
createClient<SqlxJsGeneratedRegistry>();
`);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ESNext",
      types: ["bun-types"],
      paths: { "@onreza/sqlx-js": [resolve(import.meta.dir, "../src/index.ts")] },
    },
    files: ["consumer.ts", "generated.d.ts"],
  }));

  const checked = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  const dts = readFileSync(join(root, "generated.d.ts"), "utf8");
  expect(dts).toContain("export interface SqlxJsGeneratedRuntimeTypes");
  expect(dts).toContain('"geometry": { x: number; y: number };');
});

test("query definitions, executor helpers, and structural JSON compile together", () => {
  const root = join(tmp, "query-definitions");
  mkdirSync(root, { recursive: true });
  const query = "SELECT id, email FROM users WHERE id = $id";
  const jsonQuery = "SELECT $payload::jsonb AS payload";
  const jsonArrayQuery = "SELECT $items::jsonb[] AS items";
  const positionalQuery = "SELECT id, email FROM users WHERE id = $1 AND active IS NOT DISTINCT FROM $2";
  const zeroParamsQuery = "SELECT COUNT(*)::int4 AS count FROM users";
  const executeQuery = "UPDATE users SET active = $active WHERE id = $id";
  const conditionalQuery = "UPDATE users SET email = CASE WHEN NOT $setEmail THEN email WHEN $clearEmail THEN NULL ELSE $email END WHERE id = $id";
  emitDts(join(root, "generated.d.ts"), completeEntries([
    {
      query,
      paramOids: [2950],
      paramTsTypes: ["string"],
      paramNames: ["id"],
      filePaths: ["queries/user-by-id.sql"],
      hasInline: true,
      hasResultSet: true,
      columns: [
        { name: "id", typeOid: 2950, tsType: "string", nullable: false },
        { name: "email", typeOid: 25, tsType: "string", nullable: false },
      ],
    },
    {
      query: jsonQuery,
      paramOids: [3802],
      paramTsTypes: ['import("@onreza/sqlx-js").SqlxJson<unknown>'],
      paramNames: ["payload"],
      hasResultSet: true,
      columns: [{ name: "payload", typeOid: 3802, tsType: 'import("@onreza/sqlx-js").SqlxJson<import("@onreza/sqlx-js").JsonValue>', nullable: false }],
    },
    {
      query: jsonArrayQuery,
      paramOids: [3807],
      paramTsTypes: ['import("@onreza/sqlx-js").PgArrayParameter<import("@onreza/sqlx-js").SqlxJson<unknown>, boolean>'],
      paramNames: ["items"],
      hasResultSet: true,
      columns: [{ name: "items", typeOid: 3807, tsType: '(import("@onreza/sqlx-js").SqlxJson<import("@onreza/sqlx-js").JsonValue> | null)[]', nullable: false }],
    },
    {
      query: positionalQuery,
      paramOids: [2950, 16],
      paramTsTypes: ["string", "boolean"],
      paramNullable: [false, true],
      hasResultSet: true,
      columns: [
        { name: "id", typeOid: 2950, tsType: "string", nullable: false },
        { name: "email", typeOid: 25, tsType: "string", nullable: false },
      ],
    },
    {
      query: zeroParamsQuery,
      paramOids: [],
      paramTsTypes: [],
      hasResultSet: true,
      columns: [{ name: "count", typeOid: 23, tsType: "number", nullable: false }],
    },
    {
      query: executeQuery,
      paramOids: [16, 2950],
      paramTsTypes: ["boolean", "string"],
      paramNames: ["active", "id"],
      hasResultSet: false,
      columns: [],
    },
    {
      query: conditionalQuery,
      paramOids: [16, 16, 25, 2950],
      paramTsTypes: ["boolean", "boolean", "string", "string"],
      paramNullable: [false, false, true, false],
      paramNames: ["setEmail", "clearEmail", "email", "id"],
      hasResultSet: false,
      columns: [],
    },
    {
      query: "SELECT id, email FROM users WHERE id = $1",
      paramOids: [2950],
      paramTsTypes: ["string"],
      hasResultSet: true,
      hasInline: false,
      filePaths: ["queries/user.sql"],
      columns: [
        { name: "id", typeOid: 2950, tsType: "string", nullable: false },
        { name: "email", typeOid: 25, tsType: "string", nullable: false },
      ],
    },
  ]));
  writeFileSync(join(root, "consumer.ts"), `
import {
  array,
  defineQuery,
  json,
  type ExecuteResult,
  type JsonParameter,
  type QueryParams,
  type QueryRegistry,
  type QueryResult,
  type QueryResultAssertions,
  type QueryRow,
  type QueryWireParams,
  type PgArrayParameter,
  type SqlClient,
  type SqlExecutor,
  type SqlxJson,
  type SqlTransactionOptions,
} from "@onreza/sqlx-js";
import { Temporal } from "temporal-polyfill";
import type { SqlxJsGeneratedRegistry as GeneratedRegistry } from "./generated";

type SqlxJsGeneratedRegistry = GeneratedRegistry<typeof Temporal>;

const findUser = defineQuery.optional("users.findById", ${JSON.stringify(query)});
const resultAssertionsShape: QueryResultAssertions = { items: { elements: "non-null" } };
const assertedItems = defineQuery.one(${JSON.stringify(jsonArrayQuery)}, {
  resultAssertions: { items: { elements: "non-null" } },
});
void resultAssertionsShape;
void assertedItems;
type Params = QueryParams<typeof findUser, SqlxJsGeneratedRegistry>;
type Row = QueryRow<typeof findUser, SqlxJsGeneratedRegistry>;
type Result = QueryResult<typeof findUser, SqlxJsGeneratedRegistry>;
interface ParamsDto { id: string }
interface ParamsDtoWithExtra extends ParamsDto { extra: boolean }
interface UserServiceParams extends ParamsDto { visibleProjectIds?: readonly string[] }
const params: Params = { id: "00000000-0000-0000-0000-000000000000" };
declare const paramsDto: ParamsDto;
declare const paramsDtoWithExtra: ParamsDtoWithExtra;
const paramsWithExtra = { ...params, extra: true };
const paramsWithUnionExtra = Math.random() > 0.5
  ? { ...params, first: true }
  : { ...params, second: true };
declare const paramsMetadata: unique symbol;
const paramsWithMetadata = { ...params, [paramsMetadata]: true };
const row: Row = { id: params.id, email: "user@example.com" };
const result: Result = row;
declare const executor: SqlExecutor<SqlxJsGeneratedRegistry>;
const boundFindUser = findUser.bind(executor);
void boundFindUser(params);
void boundFindUser(params, { timeoutMs: 1_000 });
void findUser.run(executor, params);
void findUser.run(executor, params, { timeoutMs: 1_000 });
void findUser.runWith({}, executor, params);
void executor(${JSON.stringify(query)}, params);
void executor.one(${JSON.stringify(query)}, params);
void executor.one(${JSON.stringify(query)}, paramsDto);
void executor.optional(${JSON.stringify(query)}, params);
void executor.execute(${JSON.stringify(query)}, params);
void executor.one(${JSON.stringify(query)}, paramsWithMetadata);
void executor.with({ timeoutMs: 1_000 }).one(${JSON.stringify(query)}, params);
void executor.file("queries/user-by-id.sql", params);
void executor.file.one("queries/user-by-id.sql", params);
void executor.file.optional("queries/user-by-id.sql", params);
void executor.file.execute("queries/user-by-id.sql", params);
// @ts-expect-error named definition parameters must have the registry's exact keys
void findUser.run(executor, paramsWithExtra);
// @ts-expect-error execution options do not weaken the exact named parameter contract
void findUser.run(executor, paramsWithExtra, { timeoutMs: 1_000 });
// @ts-expect-error named definition parameters must have the registry's exact keys
void findUser.runWith({}, executor, paramsWithExtra);
// @ts-expect-error named executor parameters must have the registry's exact keys
void executor.one(${JSON.stringify(query)}, paramsWithExtra);
// @ts-expect-error wider DTO interfaces must be mapped to the exact query shape
void executor.one(${JSON.stringify(query)}, paramsDtoWithExtra);
// @ts-expect-error every named parameter union branch must have the registry's exact keys
void executor.one(${JSON.stringify(query)}, paramsWithUnionExtra);
// @ts-expect-error named parameters through with() must have the registry's exact keys
void executor.with({ timeoutMs: 1_000 }).one(${JSON.stringify(query)}, paramsWithExtra);
// @ts-expect-error named SQL-file parameters must have the registry's exact keys
void executor.file.one("queries/user-by-id.sql", paramsWithExtra);
// @ts-expect-error bound named definitions preserve the exact parameter keys
void boundFindUser(paramsWithExtra);
void result;

export function createUserQueries(boundExecutor: SqlExecutor<SqlxJsGeneratedRegistry>) {
  return { find: findUser.bind(boundExecutor) };
}
type UserQueries = ReturnType<typeof createUserQueries>;
type UserServiceDeps = { databaseQueries: Pick<UserQueries, "find"> };
declare const userServiceDeps: UserServiceDeps;
void userServiceDeps.databaseQueries.find(params);
function loadUserThroughDi(input: UserServiceParams) {
  // @ts-expect-error ReturnType, Pick, and DI must not erase bound exactness
  return userServiceDeps.databaseQueries.find(input);
}
void loadUserThroughDi;

export function runScoped(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: Params) {
  return findUser.run(executor, params);
}

const findUserOne = defineQuery.one("users.findOne", ${JSON.stringify(query)});
export function runOneScoped(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: Params) {
  return findUserOne.run(executor, params);
}

const findUsers = defineQuery(${JSON.stringify(query)});
export function runMany(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: Params) {
  return findUsers.run(executor, params);
}

const positional = defineQuery.one("users.positional", ${JSON.stringify(positionalQuery)});
type PositionalParams = QueryParams<typeof positional, SqlxJsGeneratedRegistry>;
declare const positionalParams: PositionalParams;
const boundPositional = positional.bind(executor);
void boundPositional(...positionalParams);
void executor.one(${JSON.stringify(positionalQuery)}, ...positionalParams);
// @ts-expect-error positional parameters remain separate arguments
void executor.one(${JSON.stringify(positionalQuery)}, positionalParams);
// @ts-expect-error bound positional parameters remain separate arguments
void boundPositional(positionalParams);
export function runPositional(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: PositionalParams) {
  return positional.run(executor, ...params);
}

const countUsers = defineQuery.one("users.count", ${JSON.stringify(zeroParamsQuery)});
const boundCountUsers = countUsers.bind(executor);
void boundCountUsers();
// @ts-expect-error a zero-parameter query does not accept one empty tuple argument
void executor.one(${JSON.stringify(zeroParamsQuery)}, [] as const);
// @ts-expect-error a bound zero-parameter query does not accept one empty tuple argument
void boundCountUsers([] as const);
export function runZeroParams(executor: SqlExecutor<SqlxJsGeneratedRegistry>) {
  return countUsers.run(executor);
}

const updateUser = defineQuery.execute("users.update", ${JSON.stringify(executeQuery)});
type UpdateParams = QueryParams<typeof updateUser, SqlxJsGeneratedRegistry>;
export function runExecute(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: UpdateParams) {
  return updateUser.run(executor, params);
}

export function runClient(client: SqlClient<SqlxJsGeneratedRegistry>, params: Params) {
  return findUserOne.run(client.sql, params);
}

export function runWithSignal(
  client: SqlClient<SqlxJsGeneratedRegistry>,
  params: Params,
  signal: AbortSignal,
) {
  void client.ready({ timeoutMs: 5_000 });
  void client.ping({ timeoutMs: 1_000 });
  void client.snapshot();
  void client.close({ graceMs: 5_000, forceAfterMs: 10_000 });
  return findUserOne.run(client.sql, params, { signal, timeoutMs: 2_000 });
}

export function runTransaction(client: SqlClient<SqlxJsGeneratedRegistry>, params: Params) {
  return client.sql.transaction((tx) => findUserOne.run(tx, params));
}

export function runRaw(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: Params) {
  return executor.one(${JSON.stringify(query)}, params);
}

export function runFile(executor: SqlExecutor<SqlxJsGeneratedRegistry>, id: string) {
  return executor.file.one("queries/user.sql", id);
}

export function runGeneric<Executor extends SqlExecutor<SqlxJsGeneratedRegistry>>(
  executor: Executor,
  params: Params,
) {
  return findUserOne.run(executor, params);
}

type TracedExecutor = SqlExecutor<SqlxJsGeneratedRegistry> & { traceId: string };
export function runIntersection(executor: TracedExecutor, params: Params) {
  return findUserOne.run(executor, params);
}

type FindUserEntry = SqlxJsGeneratedRegistry["queries"][typeof findUserOne.query];
type CompatibleRegistry = QueryRegistry & {
  queries: Record<typeof findUserOne.query, FindUserEntry>;
};
export function runRegistryGeneric<Registry extends CompatibleRegistry>(
  executor: SqlExecutor<Registry>,
  params: QueryParams<typeof findUserOne, Registry>,
) {
  return findUserOne.run(executor, params);
}

export function runRawRegistryGeneric<Registry extends CompatibleRegistry>(
  executor: SqlExecutor<Registry>,
  params: QueryParams<typeof findUserOne, Registry>,
) {
  return executor.one(${JSON.stringify(query)}, params);
}

export function runExtendedRegistry<Registry extends SqlxJsGeneratedRegistry>(
  executor: SqlExecutor<Registry>,
  params: QueryParams<typeof findUserOne, Registry>,
) {
  return findUserOne.run(executor, params);
}

export function runGenericClient<Registry extends CompatibleRegistry>(
  client: SqlClient<Registry> & { sql: SqlExecutor<Registry> },
  params: QueryParams<typeof findUserOne, Registry>,
) {
  return findUserOne.run(client.sql, params);
}

export function runGenericTransaction<Registry extends CompatibleRegistry>(
  client: SqlClient<Registry>,
  params: QueryParams<typeof findUserOne, Registry>,
  options: SqlTransactionOptions<Registry>,
) {
  return client.sql.transaction(options, (tx) => findUserOne.run(tx, params));
}

type PositionalEntry = SqlxJsGeneratedRegistry["queries"][typeof positional.query];
type CompatiblePositionalRegistry = QueryRegistry & {
  queries: Record<typeof positional.query, PositionalEntry>;
};
export function runPositionalRegistryGeneric<Registry extends CompatiblePositionalRegistry>(
  executor: SqlExecutor<Registry>,
  params: QueryParams<typeof positional, Registry>,
) {
  return positional.run(executor, ...params);
}

export function runRawPositionalRegistryGeneric<Registry extends CompatiblePositionalRegistry>(
  executor: SqlExecutor<Registry>,
  params: QueryParams<typeof positional, Registry>,
) {
  return executor.one(${JSON.stringify(positionalQuery)}, ...params);
}

type GeneratedQueryArguments<Entry> = Entry extends { params: infer Params }
  ? Params extends readonly [...infer _Values] ? Params : [Params]
  : never;
export function runGeneratedQuery<Query extends keyof SqlxJsGeneratedRegistry["queries"]>(
  executor: SqlExecutor<SqlxJsGeneratedRegistry>,
  query: Query,
  ...params: GeneratedQueryArguments<SqlxJsGeneratedRegistry["queries"][Query]>
) {
  return executor(query, ...params);
}

export function runPositionalWithSignal(
  executor: SqlExecutor<SqlxJsGeneratedRegistry>,
  params: PositionalParams,
  signal: AbortSignal,
) {
  return positional.runWith({ signal }, executor, ...params);
}

const executeResult: Promise<ExecuteResult> = runExecute(executor, { active: true, id: params.id });
void executeResult;

interface Payload {
  id: string;
  nested: { count: number };
  optional?: string;
}
declare const payload: Payload;
const encoded = json(payload);
const legacyEncoded: JsonParameter<Payload> = encoded;
const currentEncoded: SqlxJson<Payload> = legacyEncoded;
const preserved: Payload = encoded.value;
void executor(${JSON.stringify(jsonQuery)}, { payload: encoded });
// @ts-expect-error SqlxJson documents are already encoded
json(encoded);
// @ts-expect-error SqlxJson documents cannot be nested in another document
json({ payload: encoded });
void currentEncoded;
void preserved;

const mappedPayloadQuery = defineQuery.one("payload.select", ${JSON.stringify(jsonQuery)}).mapParams(
  (input: Payload, { json }) => ({ payload: json(input) }),
);
type MappedPayloadParams = QueryParams<typeof mappedPayloadQuery, SqlxJsGeneratedRegistry>;
type MappedPayloadWireParams = QueryWireParams<typeof mappedPayloadQuery, SqlxJsGeneratedRegistry>;
const mappedPayload: MappedPayloadParams = payload;
const mappedPayloadWire: MappedPayloadWireParams = { payload: encoded };
const boundMappedPayload = mappedPayloadQuery.bind(executor);
void boundMappedPayload(mappedPayload);
void boundMappedPayload(mappedPayload, { timeoutMs: 1_000 });
export function runMappedPayload(
  executor: SqlExecutor<SqlxJsGeneratedRegistry>,
  input: MappedPayloadParams,
) {
  return mappedPayloadQuery.run(executor, input);
}
void mappedPayload;
void mappedPayloadWire;

const mappedJsonArrayQuery = defineQuery.one(
  "payload.selectArray",
  ${JSON.stringify(jsonArrayQuery)},
).mapParams((input: readonly Payload[], { array, json }) => ({
  items: array(input.map((item) => json(item))),
}));
export function runMappedJsonArray(
  executor: SqlExecutor<SqlxJsGeneratedRegistry>,
  input: QueryParams<typeof mappedJsonArrayQuery, SqlxJsGeneratedRegistry>,
) {
  return mappedJsonArrayQuery.run(executor, input);
}

const mappedPositionalQuery = positional.mapParams(
  (input: { id: string; active?: boolean }) => [input.id, input.active ?? null] as const,
);
type MappedPositionalParams = QueryParams<typeof mappedPositionalQuery, SqlxJsGeneratedRegistry>;
export function runMappedPositional(
  executor: SqlExecutor<SqlxJsGeneratedRegistry>,
  input: MappedPositionalParams,
) {
  return mappedPositionalQuery.run(executor, input);
}

type EmailChange =
  | { kind: "preserve" }
  | { kind: "clear" }
  | { kind: "set"; value: string };
const mappedConditionalQuery = defineQuery.execute(
  "users.updateEmail",
  ${JSON.stringify(conditionalQuery)},
).mapParams((input: { id: string; email: EmailChange }) => ({
  setEmail: input.email.kind !== "preserve",
  clearEmail: input.email.kind === "clear",
  email: input.email.kind === "set" ? input.email.value : null,
  id: input.id,
}));
type MappedConditionalParams = QueryParams<typeof mappedConditionalQuery, SqlxJsGeneratedRegistry>;
export function runMappedConditional(
  executor: SqlExecutor<SqlxJsGeneratedRegistry>,
  input: MappedConditionalParams,
) {
  return mappedConditionalQuery.run(executor, input);
}
declare const batch: readonly import("@onreza/sqlx-js").JsonInputObject[];
json(batch);
interface TreeNode {
  value: string;
  children: TreeNode[];
}
declare const tree: TreeNode;
json(tree);
// @ts-expect-error Date is not JSON-safe
json({ createdAt: new Date() });
json({ createdAt: Temporal.Instant.from("2026-01-01T00:00:00Z") });
json({ count: 1n });
// @ts-expect-error functions are not JSON-safe
json({ callback: () => "done" });
// @ts-expect-error undefined array elements are not JSON-safe
json(["ok", undefined]);
const metadata = Symbol("metadata");
// @ts-expect-error symbol-keyed fields are not serialized by JSON.stringify
json({ id: "visible", [metadata]: "hidden" });
// @ts-expect-error a temporal block must choose an explicit local policy
defineQuery("SELECT 1", { temporal: {} });

const nonNullArray: PgArrayParameter<string, false> = array(["one", "two"]);
const nullableArray: PgArrayParameter<string, boolean> = array(["one", null]);
const widenedArray: PgArrayParameter<string, boolean> = nonNullArray;
const typedNonNullArray: PgArrayParameter<string, false> = array(["one"]);
// @ts-expect-error a nullable element cannot satisfy a non-null element contract
const invalidNonNullArray: PgArrayParameter<string, false> = array(["one", null]);
// @ts-expect-error multidimensional arrays need an explicit result-shape contract
const invalidNestedNonNullArray: PgArrayParameter<number, false> = array([[1, null]]);
void nullableArray;
void widenedArray;
void typedNonNullArray;
void invalidNonNullArray;
void invalidNestedNonNullArray;
`);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noUncheckedIndexedAccess: true,
      declaration: true,
      emitDeclarationOnly: true,
      outDir: join(root, "declarations"),
      rootDir: resolve(import.meta.dir, ".."),
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ESNext",
      lib: ["ES2024"],
      types: ["bun-types"],
      paths: { "@onreza/sqlx-js": [resolve(import.meta.dir, "../src/index.ts")] },
    },
    files: ["consumer.ts", "generated.d.ts"],
  }));

  const checked = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  const declaration = readFileSync(
    join(root, "declarations/tests/.tmp-codegen/query-definitions/consumer.d.ts"),
    "utf8",
  );
  expect(declaration).not.toContain("Promise<unknown");
  const emittedFunction = (name: string) => {
    const start = declaration.indexOf(`export declare function ${name}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = declaration.indexOf("export declare function ", start + 1);
    return declaration.slice(start, next === -1 ? undefined : next);
  };
  for (const name of ["runScoped"]) {
    expect(emittedFunction(name)).toContain("email: string;");
    expect(emittedFunction(name)).toContain("} | null>;");
  }
  expect(emittedFunction("createUserQueries")).toContain("id: string;");
  expect(emittedFunction("createUserQueries")).not.toContain("unknown");
  for (const name of ["runOneScoped"]) {
    expect(emittedFunction(name)).toContain("email: string;");
    expect(emittedFunction(name)).toContain("}>;");
    expect(emittedFunction(name)).not.toContain("null");
  }
  for (const name of ["runMany"]) {
    expect(emittedFunction(name)).toContain("email: string;");
    expect(emittedFunction(name)).toContain("}[]>;");
  }
  for (const name of [
    "runPositional",
    "runClient",
    "runTransaction",
    "runRaw",
    "runFile",
    "runGeneric",
    "runIntersection",
  ]) {
    expect(emittedFunction(name)).toContain("email: string;");
    expect(emittedFunction(name)).not.toContain("unknown");
  }
  for (const name of [
    "runRegistryGeneric",
    "runRawRegistryGeneric",
    "runExtendedRegistry",
    "runGenericClient",
    "runGenericTransaction",
    "runPositionalRegistryGeneric",
    "runRawPositionalRegistryGeneric",
    "runGeneratedQuery",
  ]) {
    expect(emittedFunction(name)).toContain("Promise<");
    expect(emittedFunction(name)).not.toContain("unknown");
  }
  expect(emittedFunction("runZeroParams")).toContain("count: number;");
  for (const name of ["runExecute"]) {
    expect(emittedFunction(name)).toContain("ExecuteResult");
  }

  writeFileSync(
    join(root, "declarations/tests/.tmp-codegen/query-definitions/generated.d.ts"),
    readFileSync(join(root, "generated.d.ts")),
  );
  writeFileSync(join(root, "downstream.ts"), `
import { createUserQueries } from "./declarations/tests/.tmp-codegen/query-definitions/consumer";

type UserQueries = ReturnType<typeof createUserQueries>;
type UserServiceDeps = { databaseQueries: Pick<UserQueries, "find"> };
declare const deps: UserServiceDeps;
declare const params: { id: string };
declare const widerParams: { id: string; visibleProjectIds?: readonly string[] };
void deps.databaseQueries.find(params);
// @ts-expect-error emitted bound runners must retain exact named keys for downstream packages
void deps.databaseQueries.find(widerParams);
`);
  writeFileSync(join(root, "tsconfig.downstream.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ESNext",
      lib: ["ES2024"],
      types: ["bun-types"],
      paths: { "@onreza/sqlx-js": [resolve(import.meta.dir, "../src/index.ts")] },
    },
    files: ["downstream.ts"],
  }));
  const downstream = spawnSync("bunx", ["tsc", "-p", join(root, "tsconfig.downstream.json")], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(downstream.status, downstream.stdout + downstream.stderr).toBe(0);
});
