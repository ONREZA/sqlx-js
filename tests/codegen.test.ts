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

function write(
  entries: CacheEntry[],
  functions: FunctionEntry[] = [],
  runtimeTypes: Record<string, string> = {},
): string {
  const out = join(tmp, "sqlx-js-env.d.ts");
  emitDts(out, entries, functions, runtimeTypes);
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
  typeCodecs: { shared_type: { parse: Number, serialize: String } },
});
const replica = createSqlClient<ReplicaRegistry>(undefined, {
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
  typeCodecs: {
    geometry: {
      parse: (value) => ({ x: Number(value), y: Number(value) }),
      serialize: (value) => \`${"${value.x},${value.y}"}\`,
    },
  },
});
void client;

const rawClient = createClient<SqlxJsGeneratedRegistry>(undefined, {
  typeCodecs: {
    geometry: {
      parse: (value) => ({ x: Number(value), y: Number(value) }),
      serialize: (value) => \`${"${value.x},${value.y}"}\`,
    },
  },
});
void rawClient;

const numericClient = createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
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
  typeCodecs: {
    geometry: {
      // @ts-expect-error parser output must match the configured customTypes representation
      parse: () => "not geometry",
      serialize: (value) => \`${"${value.x},${value.y}"}\`,
    },
  },
});

createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
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
// @ts-expect-error raw clients bound to generated customTypes require codecs too
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
      baseUrl: resolve(import.meta.dir, ".."),
      paths: { "@onreza/sqlx-js": ["src/index.ts"] },
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
  emitDts(join(root, "generated.d.ts"), [
    {
      query,
      paramOids: [2950],
      paramTsTypes: ["string"],
      paramNames: ["id"],
      hasResultSet: true,
      columns: [
        { name: "id", typeOid: 2950, tsType: "string", nullable: false },
        { name: "email", typeOid: 25, tsType: "string", nullable: false },
      ],
    },
    {
      query: jsonQuery,
      paramOids: [3802],
      paramTsTypes: ['import("@onreza/sqlx-js").JsonParameter<unknown>'],
      paramNames: ["payload"],
      hasResultSet: true,
      columns: [{ name: "payload", typeOid: 3802, tsType: 'import("@onreza/sqlx-js").JsonValue', nullable: false }],
    },
    {
      query: jsonArrayQuery,
      paramOids: [3807],
      paramTsTypes: ['import("@onreza/sqlx-js").PgArrayParameter<import("@onreza/sqlx-js").JsonParameter<unknown>, boolean>'],
      paramNames: ["items"],
      hasResultSet: true,
      columns: [{ name: "items", typeOid: 3807, tsType: 'import("@onreza/sqlx-js").JsonValue[]', nullable: false }],
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
  ]);
  writeFileSync(join(root, "consumer.ts"), `
import {
  array,
  defineQuery,
  json,
  sql,
  type ExecuteResult,
  type QueryParams,
  type QueryRegistry,
  type QueryResult,
  type QueryRow,
  type QueryWireParams,
  type PgArrayParameter,
  type SqlClient,
  type SqlExecutor,
} from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./generated";

const findUser = defineQuery.optional("users.findById", ${JSON.stringify(query)});
type Params = QueryParams<typeof findUser, SqlxJsGeneratedRegistry>;
type AmbientParams = QueryParams<typeof findUser>;
type Row = QueryRow<typeof findUser, SqlxJsGeneratedRegistry>;
type Result = QueryResult<typeof findUser, SqlxJsGeneratedRegistry>;
const params: Params = { id: "00000000-0000-0000-0000-000000000000" };
const ambientParams: AmbientParams = params;
const row: Row = { id: params.id, email: "user@example.com" };
const result: Result = row;
declare const executor: SqlExecutor<SqlxJsGeneratedRegistry>;
void findUser.run(executor, params);
void ambientParams;
void result;

export function runScoped(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: Params) {
  return findUser.run(executor, params);
}

export function runAmbient(executor: SqlExecutor, params: AmbientParams) {
  return findUser.run(executor, params);
}

const findUserOne = defineQuery.one("users.findOne", ${JSON.stringify(query)});
export function runOneScoped(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: Params) {
  return findUserOne.run(executor, params);
}

export function runOneAmbient(executor: SqlExecutor, params: AmbientParams) {
  return findUserOne.run(executor, params);
}

const findUsers = defineQuery(${JSON.stringify(query)});
export function runMany(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: Params) {
  return findUsers.run(executor, params);
}

export function runManyAmbient(executor: SqlExecutor, params: AmbientParams) {
  return findUsers.run(executor, params);
}

const positional = defineQuery.one("users.positional", ${JSON.stringify(positionalQuery)});
type PositionalParams = QueryParams<typeof positional, SqlxJsGeneratedRegistry>;
export function runPositional(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: PositionalParams) {
  return positional.run(executor, ...params);
}

const countUsers = defineQuery.one("users.count", ${JSON.stringify(zeroParamsQuery)});
export function runZeroParams(executor: SqlExecutor<SqlxJsGeneratedRegistry>) {
  return countUsers.run(executor);
}

const updateUser = defineQuery.execute("users.update", ${JSON.stringify(executeQuery)});
type UpdateParams = QueryParams<typeof updateUser, SqlxJsGeneratedRegistry>;
export function runExecute(executor: SqlExecutor<SqlxJsGeneratedRegistry>, params: UpdateParams) {
  return updateUser.run(executor, params);
}

type AmbientUpdateParams = QueryParams<typeof updateUser>;
export function runExecuteAmbient(executor: SqlExecutor, params: AmbientUpdateParams) {
  return updateUser.run(executor, params);
}

export function runClient(client: SqlClient<SqlxJsGeneratedRegistry>, params: Params) {
  return findUserOne.run(client.sql, params);
}

export function runTransaction(params: AmbientParams) {
  return sql.transaction((tx) => findUserOne.run(tx, params));
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

export function runExtendedRegistry<Registry extends SqlxJsGeneratedRegistry>(
  executor: SqlExecutor<Registry>,
  params: QueryParams<typeof findUserOne, Registry>,
) {
  return findUserOne.run(executor, params);
}

export function runGenericClient<Registry extends CompatibleRegistry>(
  client: SqlClient<Registry>,
  params: QueryParams<typeof findUserOne, Registry>,
) {
  return findUserOne.run(client.sql, params);
}

export function runGenericTransaction<Registry extends CompatibleRegistry>(
  client: SqlClient<Registry>,
  params: QueryParams<typeof findUserOne, Registry>,
) {
  return client.sql.transaction((tx) => findUserOne.run(tx, params));
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

const executeResult: Promise<ExecuteResult> = runExecute(executor, { active: true, id: params.id });
void executeResult;

interface Payload {
  id: string;
  nested: { count: number };
  optional?: string;
}
declare const payload: Payload;
const encoded = json(payload);
const preserved: Payload = encoded.value;
void executor(${JSON.stringify(jsonQuery)}, { payload: encoded });
void preserved;

const mappedPayloadQuery = defineQuery.one("payload.select", ${JSON.stringify(jsonQuery)}).mapParams(
  (input: Payload, { json }) => ({ payload: json(input) }),
);
type MappedPayloadParams = QueryParams<typeof mappedPayloadQuery, SqlxJsGeneratedRegistry>;
type MappedPayloadWireParams = QueryWireParams<typeof mappedPayloadQuery, SqlxJsGeneratedRegistry>;
const mappedPayload: MappedPayloadParams = payload;
const mappedPayloadWire: MappedPayloadWireParams = { payload: encoded };
export function runMappedPayload(
  executor: SqlExecutor<SqlxJsGeneratedRegistry>,
  input: MappedPayloadParams,
) {
  return mappedPayloadQuery.run(executor, input);
}
void mappedPayload;
void mappedPayloadWire;

type MappedPayloadEntry = SqlxJsGeneratedRegistry["queries"][typeof mappedPayloadQuery.query];
type CompatibleMappedRegistry = QueryRegistry & {
  queries: Record<typeof mappedPayloadQuery.query, MappedPayloadEntry>;
};
export function runMappedRegistryGeneric<Registry extends CompatibleMappedRegistry>(
  executor: SqlExecutor<Registry>,
  input: QueryParams<typeof mappedPayloadQuery, Registry>,
) {
  return mappedPayloadQuery.run(executor, input);
}

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
// @ts-expect-error bigint is not JSON-safe
json({ count: 1n });
// @ts-expect-error functions are not JSON-safe
json({ callback: () => "done" });
// @ts-expect-error undefined array elements are not JSON-safe
json(["ok", undefined]);
const metadata = Symbol("metadata");
// @ts-expect-error symbol-keyed fields are not serialized by JSON.stringify
json({ id: "visible", [metadata]: "hidden" });

const nonNullArray: PgArrayParameter<string, false> = array(["one", "two"]);
const nullableArray: PgArrayParameter<string, boolean> = array(["one", null]);
const widenedArray: PgArrayParameter<string, boolean> = nonNullArray;
const typedNonNullArray: PgArrayParameter<string, false> = sql.array(["one"]);
// @ts-expect-error a nullable element cannot satisfy a non-null element contract
const invalidNonNullArray: PgArrayParameter<string, false> = sql.array(["one", null]);
// @ts-expect-error multidimensional arrays need an explicit result-shape contract
const invalidNestedNonNullArray: PgArrayParameter<number, false> = sql.array([[1, null]]);
void nullableArray;
void widenedArray;
void typedNonNullArray;
void invalidNonNullArray;
void invalidNestedNonNullArray;
`);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      declaration: true,
      emitDeclarationOnly: true,
      outDir: join(root, "declarations"),
      rootDir: resolve(import.meta.dir, ".."),
      module: "Preserve",
      moduleResolution: "Bundler",
      target: "ESNext",
      types: ["bun-types"],
      baseUrl: resolve(import.meta.dir, ".."),
      paths: { "@onreza/sqlx-js": ["src/index.ts"] },
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
  for (const name of ["runScoped", "runAmbient"]) {
    expect(emittedFunction(name)).toContain("email: string;");
    expect(emittedFunction(name)).toContain("} | null>;");
  }
  for (const name of ["runOneScoped", "runOneAmbient"]) {
    expect(emittedFunction(name)).toContain("email: string;");
    expect(emittedFunction(name)).toContain("}>;");
    expect(emittedFunction(name)).not.toContain("null");
  }
  for (const name of ["runMany", "runManyAmbient"]) {
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
    "runExtendedRegistry",
    "runGenericClient",
    "runGenericTransaction",
    "runPositionalRegistryGeneric",
  ]) {
    expect(emittedFunction(name)).toContain("Promise<");
    expect(emittedFunction(name)).not.toContain("unknown");
  }
  expect(emittedFunction("runZeroParams")).toContain("count: number;");
  for (const name of ["runExecute", "runExecuteAmbient"]) {
    expect(emittedFunction(name)).toContain("ExecuteResult");
  }
});
