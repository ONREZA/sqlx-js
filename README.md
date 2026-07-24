# sqlx-js

Compile-time-checked raw SQL for TypeScript + PostgreSQL. Inspired by Rust's [sqlx](https://github.com/launchbadge/sqlx).

You write plain SQL strings. A `prepare` step validates them against your database via the PostgreSQL wire protocol and generates a TypeScript declaration file. Wrong column names and stale queries fail during `prepare`; mismatched parameter types and row usage become TypeScript errors.

The runtime uses [Postgres.js](https://github.com/porsager/postgres) through a single adapter instead of a Bun-specific client. The published CLI requires **Node ≥ 24** (`#!/usr/bin/env node`) and can also run through **Bun ≥ 1.3**. PostgreSQL 16 or newer is required.

```ts
import { sql } from "@onreza/sqlx-js";

const rows = await sql(
  `SELECT id, name, role FROM users WHERE id = $1`,
  1n,
);
//      ^ bigint
//
// rows: { id: bigint; name: string; role: "admin" | "editor" | "viewer" }[]
```

## Features

- **Compile-time validation** against a live PostgreSQL via `Parse` + `Describe Statement` followed by non-executing, parameter-independent generic planning for supported query statements.
- **Precise nullability inference** through `libpg-query`: `JOIN` direction (LEFT/RIGHT/FULL), inner `JOIN ... ON` predicates, `UNION`/`INTERSECT`/`EXCEPT`, DML `RETURNING`, `COALESCE`, `CASE`, `COUNT`, expression propagation. Null-aware predicates and expressions accept nullable parameters when their SQL semantics allow it; parameters propagated into stored values must satisfy every direct `INSERT`, `UPDATE`, `ON CONFLICT DO UPDATE`, and data-modifying CTE target.
- **WHERE narrowing**: `IS NOT NULL`, equality chains, `IN`, `LIKE`, `BETWEEN` make columns non-null. Tracks `AND`/`OR` semantics.
- **PostgreSQL enums** generated as TypeScript literal unions (read + write side), with an optional schema-owned `as const` object catalog for reusable runtime values.
- **Schema-aware `jsonb`** via config-driven column → application type mappings. Works for both result columns and `INSERT`/`UPDATE`/`WHERE` parameters. Unmapped `json`/`jsonb` falls back to `JsonValue` for rows and an explicitly wrapped, structurally checked JSON parameter.
- **End-to-end extension types**: `pgvector` (`vector`, `halfvec`, `sparsevec`), `hstore`, `citext`, `ltree`/`lquery`/`ltxtquery`. Prepare infers their TypeScript types; the runtime discovers database-local OIDs and installs matching scalar/array codecs before the first query. Add your own through `customTypes` and `typeCodecs`.
- **Domains** resolve to their base TypeScript type (`CREATE DOMAIN email AS text` → `string`), including domains over extension types or other domains.
- **Wide built-in type coverage**: numeric, text, date/time, UUID, json/jsonb, network (inet/cidr/macaddr/macaddr8), bit strings, ranges/multiranges, geometric, money, tsvector/tsquery, xml — and the matching array variants.
- **External SQL files** via `sql.file("queries/foo.sql", ...)` — prepared and typed through `KnownFileQueries`. Watch mode re-prepares on `.sql` edits too.
- **One-row helpers**: `sql.one(...)`, `sql.optional(...)`, `sql.file.one(...)`, `sql.file.optional(...)`, and the same chain on the `tx` callback — friendly with `noUncheckedIndexedAccess: true`. The scanner walks all of them.
- **Reusable query definitions** via `defineQuery`: declare one typed SQL contract and execute it through either a root client or transaction-scoped executor. Optional `mapParams` adapters bind application-owned inputs to the generated PostgreSQL wire contract. `QueryParams`, `QueryWireParams`, `QueryRow`, and `QueryResult` expose both layers without indexing a registry by SQL text.
- **Role-aware connection profiles** bind every scanned query to a named client profile and PostgreSQL role. `prepare` describes and plans each query after `SET ROLE`; generated clients expose only the queries validated for their exact profile.
- **Sound PostgreSQL array contracts** keep array-value nullability separate from element nullability. SQL constructors, subqueries, aggregates, CTEs, set operations, `NOT NULL` element domains, and explicit column assertions narrow `(T | null)[]` to `T[]` only when proven. Array params remain unambiguous through `sql.array(...)`.
- **Typed transactions** via `sql.transaction(async tx => …)` — the `tx` callback parameter is recognized by the scanner, so queries inside the block keep full type checking.
- **Sourcemap-accurate error reporting**: every prepare failure points to `file:line:column` of the originating `sql(...)` call site, with PG error code, position, and hint.
- **Linear migrations** with hash tampering detection.
- **Migration squash baselines** via `migrate squash`: generate a schema-only baseline from a shadow database, then hash-adopt it on already-migrated databases.
- **Runtime `migrate()`** with PostgreSQL advisory lock, safe for multi-replica startup.
- **Optional pgschema workflow** via `init --schema-provider pgschema`, provider-aware `dev` / `verify`, and explicit `pgschema install|plan|apply` deployment commands.
- **Versioned offline cache** committed to your repo. `prepare --check` validates fingerprints, generator revision, type/function contracts, enum schema selection, and generated files without a database; `prepare --verify` compares fresh live/shadow artifacts without writing.
- **Schema snapshot + LLM manifest** via `snapshot dump` / `snapshot check`: tables, columns, constraints, indexes, types, and function/procedure metadata are introspected from PostgreSQL.
- **Generated function catalog** via `KnownFunctions`: `prepare` records application-owned PostgreSQL functions/procedures from `pg_proc` with approximate parameter and return TypeScript types while excluding extension-owned internals by default.
- **Provider-aware shadow validation** via `dev` / `verify`: build either migrations or `schema.sql`, validate SQL, and drop the disposable database afterwards.
- **Safe identifier quoting** via `sql.id(...)`, backed by the committed schema snapshot whitelist.
- **Single runtime adapter**: Postgres.js backs the runtime on Node/Bun-compatible environments — no Bun.SQL-specific adapter to choose.
- **Incremental watch mode**: debounced re-prepare with a warm `PgClient` + `SchemaCache`; source/SQL edits only rescan affected files and re-describe changed fingerprints, while config/tsconfig/schema changes trigger a full rebuild.
- **Cache pruning** removes orphaned entries automatically (toggleable with `--no-prune`).
- **Environment doctor** checks runtime versions, config loading, `.env`, database connectivity/permissions, runtime-addressable `customTypes`, cache metadata, generated enum output presence, tsconfig inclusion, and pgschema availability.
- **Strict inference gate** promotes degraded nullability analysis and generated `unknown` query types to CI errors.
- **GitHub/editor diagnostics adapter** converts versioned prepare JSON into workflow annotations or Unix problem-matcher output.
- **Versioned query inventory** via `queries --json`, including stable query IDs, connection profiles, definition names, cardinality, call sites, SQL files, and cache state. The same command can emit a deterministic embedded-SQL module for bundled applications.

## Install

```bash
npm install @onreza/sqlx-js
npm install --save-dev typescript
# or
bun add @onreza/sqlx-js
bun add --dev typescript
```

Node.js 24 or newer and PostgreSQL 16 or newer are required. Bun users need Bun 1.3 or newer. TypeScript is an optional peer so production-only installs do not pull the compiler and its platform package into the application image; source scanning commands (`prepare`, `queries`, `doctor`, `ci`, `dev`, and `verify`) require it in development dependencies.

The package installs `sqlx-js` and `sqlx-js-diagnostics` binaries. The CLI examples below use `npx @onreza/sqlx-js`; `bunx @onreza/sqlx-js ...` works the same if your project uses Bun.

## Setup

### 1. Choose the schema owner

sqlx-js supports two complete schema workflows. Pick one source of truth:

| Schema owner | Scaffold | Daily development | PR verification | Target deployment |
| --- | --- | --- | --- | --- |
| Built-in linear migrations | `sqlx-js init` | `sqlx-js dev` | `sqlx-js verify` | `sqlx-js migrate run` |
| Declarative pgschema | `sqlx-js init --schema-provider pgschema` | `sqlx-js dev` | `sqlx-js verify` | `sqlx-js pgschema plan/apply` |

`dev` and `verify` read `sqlx-js.config.*` and dispatch to the configured
provider. Both build the proposed schema in a disposable shadow database, so
they do not apply DDL to the target database. `dev` regenerates committed query
artifacts; `verify` compares fresh artifacts without writing.

`init` creates `sqlx-js.config.ts`, `sqlx-js-env.d.ts`, `.env.example`, and
either `migrations/` or `schema.sql`. For strict JSON it also adds the
provider-independent `sqlx:dev`, `sqlx:verify`, `sqlx:check`, and `sqlx:ci`
scripts to `package.json` and includes the declaration file in `tsconfig.json`.
Existing values are never replaced.

### 2. Configure PostgreSQL

```bash
# .env
DATABASE_URL=postgres://user:password@localhost:5432/your_db
# Managed PostgreSQL with TLS:
# DATABASE_URL=postgres://user:password@db.example.com:5432/your_db?sslmode=require
```

CLI commands load `<root>/.env`; variables already present in the process
environment take precedence. Supported `sslmode` values are `disable`,
`prefer`, `require`, `verify-ca`, and `verify-full`. Certificate paths,
`application_name`, `options`, `connect_timeout`, and `statement_timeout` can
also be supplied in the URL.

Automatic shadow databases require `CREATEDB`. Use `--shadow-admin-url` for a
separate admin connection or `--shadow-url` for a pre-created disposable
database.

### 3A. Built-in migration workflow

```bash
sqlx-js migrate add init
# edit migrations/0001_init.up.sql and .down.sql
sqlx-js dev --strict-inference
```

For example:

```sql
CREATE TABLE users (
  id    BIGSERIAL PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);
```

Before merge and deployment:

```bash
sqlx-js verify --strict-inference
sqlx-js migrate run --dry-run
sqlx-js migrate run
```

`migrate add/run/info/check/revert/squash/archive` own migration files and
target history. Shadow development and verification intentionally live at the
provider-aware top level.

### 3B. Declarative pgschema workflow

```bash
sqlx-js pgschema install
sqlx-js doctor
# edit schema.sql
sqlx-js dev --strict-inference
sqlx-js verify --strict-inference
```

Review and apply target changes separately:

```bash
sqlx-js pgschema plan -- --output-json plan.json
sqlx-js pgschema apply -- --plan plan.json --auto-approve
```

The managed pgschema workflow supports Linux and macOS. On Windows, run
sqlx-js under WSL/Linux/macOS or use built-in migrations.

### 4. Write queries

```ts
import { sql } from "@onreza/sqlx-js";

const users = await sql(
  `SELECT id, name FROM users WHERE id = $1`,
  1n,
);
```

For queries with several values, named parameters keep SQL and arguments
aligned:

```ts
const rows = await sql(
  `SELECT id, name
   FROM users
   WHERE email = $email OR recovery_email = $email
   LIMIT $limit::int`,
  { email: "user@example.com", limit: 10 },
);
```

Named parameters use ASCII identifier names, are numbered by first appearance,
and reuse repeated names. Named and positional parameters cannot be mixed.
Quoted strings, comments, dollar-quoted bodies, and `$` inside PostgreSQL
identifiers are left unchanged.

### 5. Query-only loop

Use `prepare` directly when the schema source is already available:

```bash
sqlx-js prepare          # regenerate against DATABASE_URL
sqlx-js prepare --watch  # warm incremental development loop
sqlx-js prepare --check  # database-free committed-artifact check
```

The declaration is written to `sqlx-js-env.d.ts` by default. Add it to
`tsconfig.json` when it is not already included.

## API

### `sql(query, ...params)`

The typed query function. The first argument must be a string literal that exists in `KnownQueries` (populated by `prepare`).

```ts
const rows = await sql(`SELECT id FROM users WHERE name = $1`, "alice");
//                      ^ literal — checked at compile time
```

Unknown queries, wrong parameter types, and dynamic strings are compile errors. For genuinely dynamic SQL, use `unsafe`.

### `defineQuery`

Define a query once without closing over a global client, then run the same generated contract through a root or transaction executor:

```ts
import {
  defineQuery,
  sql,
  type QueryParams,
  type QueryResult,
  type QueryRow,
  type SqlExecutor,
} from "@onreza/sqlx-js";

export const findUser = defineQuery.optional(
  "users.findById",
  `SELECT id, email FROM users WHERE id = $id`,
);

type FindUserParams = QueryParams<typeof findUser>;
type FindUserRow = QueryRow<typeof findUser>;
type FindUserResult = QueryResult<typeof findUser>; // FindUserRow | null

await findUser.run(sql, { id: userId });
await sql.transaction((tx) => findUser.run(tx, { id: userId }));

async function loadUser(executor: SqlExecutor, params: FindUserParams) {
  return findUser.run(executor, params);
}
```

The optional definition name is included in query observer and inventory metadata. The stable `queryId` is derived from the same lexical SQL fingerprint used by prepare/cache. `defineQuery.one`, `.optional`, and `.execute` mirror the cardinality contracts of the corresponding `sql` helpers.

Use `mapParams` when the application input is intentionally narrower or more expressive than PostgreSQL's physical parameters:

```ts
import { defineQuery, type QueryParams, type QueryWireParams } from "@onreza/sqlx-js";

type AnalyticsEvent = { id: string; action: "created" | "deleted" };

export const insertEvents = defineQuery.execute(
  "analytics.insertBatch",
  `INSERT INTO analytics_event (payload)
   SELECT item FROM jsonb_array_elements($events::jsonb) AS item`,
).mapParams((events: readonly AnalyticsEvent[], { json }) => ({
  events: json(events),
}));

type InsertEventsInput = QueryParams<typeof insertEvents>;       // readonly AnalyticsEvent[]
type InsertEventsWire = QueryWireParams<typeof insertEvents>;    // { events: JsonParameter<unknown> }
```

The mapper receives only `json` and `array` parameter helpers. Once `prepare` has emitted `KnownQueries`, its output is checked exactly at the definition against the generated wire contract: missing, extra, and incompatible fields are compile errors. An application input can therefore narrow or reorganize the API without widening PostgreSQL parameters. The mapper executes once per call before named-parameter binding; root, generic scoped, and transaction executors keep the same result, observer, and query-ID behavior. This is the intended boundary for discriminated unions such as `preserve | clear | set`: the application owns the union and maps it to the physical flags and nullable values required by SQL.

### Typed database functions for reusable filtered reads

For a large filtered dataset, keep filtering and pagination in PostgreSQL. Do not fetch `SELECT *` and filter in application code, interpolate clauses through `unsafe`, or copy the same query for parameter-value combinations. When the database owns a stable parameterized read API, call it through one literal `defineQuery` so prepare validates the invocation and emits its exact parameter and row contract:

```ts
export const listFilteredUsers = defineQuery(
  "users.listFiltered",
  `SELECT
     id AS "id!",
     name AS "name!",
     email AS "email!",
     role AS "role!",
     created_at AS "createdAt!"
   FROM public.list_users(
     COALESCE($role, NULL::public.user_role),
     COALESCE($search, NULL::text),
     COALESCE($afterId, NULL::bigint),
     $limit
   )`,
);
```

The example migration owns the function, while application code depends only on the prepared call. The null-aware wrappers make optional filter inputs explicit to sqlx-js without parsing the function body. PostgreSQL does not expose `NOT NULL` metadata for `RETURNS TABLE` fields, so the `!` aliases explicitly assert the non-null contract implemented by this function; keep those assertions aligned with its SQL. `KnownFunctions` remains useful inventory metadata; the executable call contract above comes from PostgreSQL `Describe` of the literal `SELECT`. See [the complete example](./example/v12_database_function.ts) and [its migration](./example/migrations/0004_add_filtered_user_function.up.sql).

This is a sqlx-js usage pattern, not a universal PostgreSQL design. A real workload may need different indexes, keyset pagination, plan inspection, a security model, or a materialized view with an explicit refresh strategy. Choose that database design for the workload rather than hiding it behind dynamic application SQL. Relevant PostgreSQL references: [table functions](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-TABLEFUNCTIONS), [`EXPLAIN`](https://www.postgresql.org/docs/current/sql-explain.html), [materialized views and refresh](https://www.postgresql.org/docs/current/rules-materializedviews.html), and [function security](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).

### `sql.file(path, ...params)`

Load SQL from an external file. The path is root-relative everywhere: prepare resolves it against `--root`, codegen keeps the exact string literal as the `KnownFileQueries` key, and runtime resolves it against `fileRoot` (default: `process.cwd()`). Absolute paths and paths escaping the root are rejected.

```ts
// queries/top_admins.sql
// SELECT id AS "id!", name AS "name!" FROM users WHERE role = $1 ORDER BY id LIMIT $2::int

import { sql } from "@onreza/sqlx-js";

const admins = await sql.file("queries/top_admins.sql", "admin", 5);
//                                                       ^ string  ^ number
// admins: { id: bigint; name: string }[]
```

File-backed queries are emitted into a separate `KnownFileQueries` interface. A call from any nested source directory still uses the same project-root-relative literal.

For a compiled or bundled application, emit a TypeScript asset module and pass it to the client:

```bash
sqlx-js queries --embed src/sqlx-js-files.generated.ts
```

```ts
import { sqlxJsEmbeddedSql } from "./sqlx-js-files.generated";

const db = createSqlClient(databaseUrl, { sqlFiles: sqlxJsEmbeddedSql });
```

Embedded entries take precedence over filesystem reads. The module contains only referenced external SQL files; inline SQL remains in application code.

### `sql.one(query, ...params)` and `sql.optional(query, ...params)`

Convenience wrappers for single-row queries. `one` throws if the row count is not exactly 1; `optional` returns `null` for 0 rows and throws on more than 1. They keep working under `noUncheckedIndexedAccess: true` without `rows[0]!` patterns.

```ts
const user = await sql.one(`SELECT id, name FROM users WHERE id = $1`, 1n);
// user: { id: bigint; name: string }

const maybe = await sql.optional(`SELECT id FROM users WHERE email = $1`, "x@y");
// maybe: { id: bigint } | null
```

Both forms also exist on `sql.file` (`sql.file.one("queries/by_id.sql", ...)`) and inside transactions (`tx.one(...)`, `tx.optional(...)`, `tx.file.one(...)`, `tx.file.optional(...)`). The scanner recognizes every chain — these call sites are added to `KnownQueries` / `KnownFileQueries` just like a plain `sql(...)`.

### `sql.execute(query, ...params)`

Execute a typed statement when rows are not the result contract. It preserves parameter checking and returns Postgres command metadata:

```ts
const result = await sql.execute(
  `UPDATE jobs SET claimed_at = now() WHERE id = $1 AND claimed_at IS NULL`,
  jobId,
);

if (result.rowCount !== 1) throw new Error("job was already claimed");
// result: { rowCount: number; command: string }
```

`sql.file.execute(...)` and `tx.execute(...)` use the same contract. Query hooks receive the affected-row count rather than `0` for DML without `RETURNING`.

### JSON and PostgreSQL array parameters

Parameter wrappers make the wire representation explicit. Use `sql.array(...)` for PostgreSQL arrays and `sql.json(...)` for `json`/`jsonb` values:

```ts
await sql(
  "SELECT $1::text[] AS tags",
  sql.array(["alpha", "beta,gamma", "with \"quote\""]),
);

await sql(
  "INSERT INTO events (payload) VALUES ($1)",
  sql.json([1, 2, 3]),
);

await sql(
  "SELECT $1::jsonb[] AS payloads",
  sql.array([sql.json({ kind: "created" }), sql.json([1, 2, 3]), null]),
);
```

Generated parameter types require `PgArrayParameter<T, NullableElements>` or `JsonParameter<T>`, so mixing the two representations is a TypeScript error. `sql.array(...)` derives whether its input contains SQL `NULL` elements. Ordinary PostgreSQL array targets accept either form; an array whose element type is a `DOMAIN ... NOT NULL`, or whose source column has an `arrayElementNullability` assertion, accepts only a non-null-element wrapper. A PostgreSQL `json[]` / `jsonb[]` composes both wrappers: the outer `sql.array(...)` selects the PostgreSQL array representation and each non-SQL-NULL element uses `sql.json(...)`. `sql.json(null)` represents JSON `null`; a bare `null` inside `sql.array(...)` represents an SQL `NULL` array element.

PostgreSQL column `NOT NULL` constrains the array value, not its elements. Therefore an ordinary `text[] NOT NULL` result is `(string | null)[]`; `prepare` emits `string[]` only after proving non-null elements from the SQL expression, a `NOT NULL` element domain, or an explicit application assertion. Declared array dimensions are not treated as a fixed TypeScript shape because PostgreSQL does not enforce them.

`sql.json()` accepts ordinary structurally JSON-compatible interfaces and preserves their concrete type in `JsonParameter<T>`. It rejects known non-JSON values such as `Date`, `bigint`, functions, and `undefined` array elements. TypeScript is structurally typed, so it cannot identify every user-defined class solely because it was constructed with `new`; runtime JSON semantics still belong to `JSON.stringify`.

Both helpers also work with `unsafe(...)`. `encodePgArrayLiteral(arr)` remains exported for code that explicitly needs a PostgreSQL array literal string.

### Parameter nullability

`prepare` infers param types as `T | null` when:

- `$N` appears inside `COALESCE($N, …)`, `NULLIF($N, …)`, `IS [NOT] NULL`, or `IS [NOT] DISTINCT FROM` — these patterns are only meaningful when the parameter can be `null`.
- `$N` contributes a value to a nullable `INSERT`, `UPDATE`, or `ON CONFLICT DO UPDATE` target, directly or through value-preserving `CASE`, `COALESCE`, `GREATEST`/`LEAST`, or the stored side of `NULLIF`.

`WHERE col = $N` stays non-null even if `col` is nullable: `col = NULL` is always false in SQL, so passing `null` from the caller would be a bug. Use `col IS NOT DISTINCT FROM $N` (or an `OR $N IS NULL` clause) when you want NULL semantics.

### `sql.transaction(fn)`

Wrap a function body in a database transaction. The callback receives a scoped `tx` that has the same typed `()` and `.file()` surface, but routes through the transaction's dedicated connection. The scanner recognises the callback parameter name and validates inner queries against `KnownQueries`.

```ts
import { sql } from "@onreza/sqlx-js";

const { userId, postId } = await sql.transaction(async (tx) => {
  const u = await tx(
    `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id AS "id!"`,
    "Alice", "alice@example.com",
  );
  const p = await tx(
    `INSERT INTO posts (user_id, title) VALUES ($1, $2) RETURNING id AS "id!"`,
    u[0].id, "Hello",
  );
  return { userId: u[0].id, postId: p[0].id };
});
```

If the callback throws, the transaction is rolled back. The return value of the callback becomes the return value of `transaction`.

### `unsafe(query, ...params)`

Same runtime as `sql` but without type-checking. For dynamic SQL where compile-time validation isn't possible.

### `sql.id(...parts)` / `id(...parts)`

Quote a dynamic identifier only if it exists in the generated schema snapshot. This is for the narrow cases where a table, column, function, type, index, or constraint name must be chosen dynamically.

```ts
import { unsafe, sql } from "@onreza/sqlx-js";

const orderBy = sql.id("users", "created_at");
await unsafe(`SELECT id, email FROM ${sql.id("users")} ORDER BY ${orderBy} DESC`);
```

The default snapshot path is `.sqlx-js/schema/schema.json`. Override it at runtime with `SQLX_JS_SCHEMA_PATH`. `sql.id(...)` accepts one to three identifier segments. Pass schema-qualified identifiers as separate segments: `sql.id("public", "users")`, not `sql.id("public.users")`.

### `migrate(options)`

Apply pending migrations from application startup with a PostgreSQL advisory lock. Safe to call from multiple replicas.

```ts
import { migrate } from "@onreza/sqlx-js";

await migrate({ dir: "./migrations" });
```

Options:

```ts
type MigrateOptions = {
  dir?: string;
  databaseUrl?: string;
  log?: (msg: string) => void;
  lockKey?: number | bigint;     // overrides DEFAULT_MIGRATE_LOCK_KEY
  lockTimeoutMs?: number;        // pg_try_advisory_lock + polling; default: block
};
```

When `lockTimeoutMs` is set, acquisition uses `pg_try_advisory_lock` in a polling loop and throws if not obtained within the timeout — useful for CI / multi-replica startup to avoid an indefinitely-blocked pod.

### Managed and raw clients

`createSqlClient(...)` owns its Postgres.js pools. It applies operation deadlines, replaces poisoned pool generations, initializes runtime codecs, exposes lifecycle state, and performs bounded shutdown. It deliberately does not expose its raw pool because a retained raw reference would bypass generation replacement.

`createClient(...)` is the explicit raw Postgres.js escape hatch. It preserves sqlx-js's built-in bigint and PostgreSQL array codecs, but it has no managed deadline, recovery, lifecycle, or name-based `typeCodecs` guarantees. The caller owns its queries and `end()` lifecycle.

Upgrading from `0.14.x` requires application changes. See the detailed [0.15.0 upgrade guide](./docs/upgrades/0.15.0.md) for API migration, timeout semantics, rollout order, and verification.

For dependency injection, read replicas, tests, or several independent pools in one process, create independent managed clients:

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";

const primary = createSqlClient<SqlxJsGeneratedRegistry>(process.env.DATABASE_URL);
const replica = createSqlClient<SqlxJsGeneratedRegistry>(process.env.REPLICA_DATABASE_URL);

await Promise.all([
  primary.ready({ timeoutMs: 5_000 }),
  replica.ready({ timeoutMs: 5_000 }),
]);

await primary.sql(`INSERT INTO audit_log (message) VALUES ($1)`, "created");
const rows = await replica.sql(`SELECT id, message FROM audit_log ORDER BY id DESC`);

await Promise.all([
  primary.close({ graceMs: 5_000, forceAfterMs: 10_000 }),
  replica.close({ graceMs: 5_000, forceAfterMs: 10_000 }),
]);
```

Each generated `sqlx-js-env.d.ts` exports its own `SqlxJsGeneratedRegistry`. Passing it to `createSqlClient<...>()` keeps a scoped client on that project's query contract even when a monorepo TypeScript program includes declarations for several databases. The global `sql` export remains available for the single-client convenience path.

When a workspace package exports database source to other TypeScript programs, bind `SqlxJsGeneratedRegistry` at that package's client boundary. A consumer does not automatically include the database package's ambient `.d.ts`; exporting an unscoped client can therefore collapse its literal parameters to `never` outside the package.

The scanner recognizes clients assigned directly from an imported `createSqlClient(...)` (including aliased and namespace imports), so `client.sql(...)`, its cardinality helpers, file queries, and transactions participate in `prepare` exactly like the global `sql` surface.

### Connection profiles and PostgreSQL roles

Use connection profiles when one application process owns several static pools with different PostgreSQL privileges. Define and export the profile objects directly from the config so the CLI and runtime import the same cache-busted source of truth:

```ts
// sqlx-js.config.ts
import { defineConfig, defineDatabaseProfiles } from "@onreza/sqlx-js";

export const databaseProfiles = defineDatabaseProfiles({
  api: { role: "app_api" },
  worker: { role: "app_worker" },
});

export default defineConfig({
  profiles: databaseProfiles,
});
```

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import { databaseProfiles } from "../sqlx-js.config";

export const apiDb = createSqlClient(process.env.DATABASE_URL, {
  profile: databaseProfiles.api,
});

export const workerDb = createSqlClient(process.env.DATABASE_URL, {
  profile: databaseProfiles.worker,
});

const users = await apiDb.sql("SELECT id, name FROM users");
await workerDb.sql.execute("UPDATE jobs SET claimed_at = now() WHERE id = $1", 1n);
```

Once `profiles` is configured, every scanned query must have an explicit profile. Direct client queries and transaction callbacks inherit it from the client binding. Reusable definitions declare their complete allowlist because the scanner deliberately does not guess dependency-injection dataflow:

```ts
export const findJob = defineQuery
  .for("api", "worker")
  .optional("jobs.find", "SELECT id, state FROM jobs WHERE id = $id");
```

`prepare` opens a session for each configured profile, applies its role, and runs the normal `Parse`/`Describe`/generic-plan pipeline in that session. The cache key includes both the SQL fingerprint and profile, so the same SQL can resolve through different `search_path`, RLS, type, and privilege contexts. Generated `KnownProfiles` registries make `createSqlClient(..., { profile })` infer only that profile's query set and require the exact configured role. The runtime sends the role as a startup parameter on every Postgres.js pool connection, including replacement generations. The login in `DATABASE_URL` must be allowed to `SET ROLE` to every configured role.

The live `prepare` connection must reach PostgreSQL directly or through a session-pooling proxy: role validation requires `SET ROLE`, `Describe`, and planning to stay on the same backend session. Transaction- or statement-pooling proxies cannot preserve that contract. A runtime proxy must likewise accept and preserve the configured startup role on each pooled connection.

Profile names and role names are static generated-contract inputs. Keep them identical across prepare/CI and deployed runtime environments. Shadow-database workflows use cluster roles rather than database-local objects, so every configured role must already exist on the shadow cluster; keep table/schema grants in migrations.

This is a strong preflight for privileges PostgreSQL checks while parsing and generically planning ordinary `SELECT`/DML, including relation, column, and directly referenced function access. It is not proof that every possible execution will succeed: sequence access, trigger or dynamic-SQL effects, value-dependent RLS `WITH CHECK`, and statements reported as `parse-only` can still fail at runtime. Privilege changes also require a new live `prepare` or `prepare --verify`; offline `prepare --check` only verifies committed artifacts.

`createSqlClient(url, options)` accepts every Postgres.js option plus sqlx-js managed-runtime options. `operationTimeoutMs` is opt-in because the library cannot choose one correct wall-clock limit for both interactive queries and long-running jobs.

The `schema` query parameter used by Prisma PostgreSQL URLs is accepted directly: sqlx-js removes it before handing the URL to Postgres.js. Other query parameters remain untouched, including PostgreSQL session parameters intentionally supported by Postgres.js.

```ts
const db = createSqlClient(process.env.DATABASE_URL, {
  // Server-side per-connection statement timeout (ms). Also settable via
  // ?statement_timeout=5000 in DATABASE_URL.
  statementTimeoutMs: 5000,
  // Entire managed path: codec bootstrap, pool/connect wait, execution, and
  // decode. A timeout after driver dispatch has outcome "unknown".
  operationTimeoutMs: 15_000,
  // Best-effort cancellation window before the old generation is destroyed.
  cancelGraceMs: 1_000,
  // Base directory for root-relative sql.file(...) calls.
  fileRoot: import.meta.dirname,
  // Development-only: re-stat sql.file() files on every call. The default
  // immutable cache avoids synchronous filesystem work in the query hot path.
  reloadSqlFiles: true,
  // Optional generated map from `sqlx-js queries --embed ...`. When present,
  // sql.file() needs no runtime filesystem asset for those paths.
  sqlFiles: sqlxJsEmbeddedSql,
  // Name-based runtime codecs. Schema-qualified keys disambiguate duplicate
  // type names; PostgreSQL OIDs are discovered for the active database.
  typeCodecs: {
    geometry: {
      parse: (text) => parseWkt(text),
      serialize: (value) => toWkt(value),
    },
  },
  // Honored for every unsafe call. Set false for PgBouncer transaction mode
  // unless protocol-level prepared statements are configured there.
  prepare: false,
  // Fires after every query/transaction statement, success or failure.
  onQuery: ({ queryId, queryName, query, params, durationMs, rowCount, error }) => {
    if (error) logger.error({ queryId, queryName, query, error });
    else if (durationMs > 200) logger.warn({ queryId, queryName, durationMs, rowCount });
  },
  onQueryStart: ({ queryId, queryName, generation }) => {
    metrics.databaseStarted.add(1, { queryId, queryName, generation });
  },
  onQueryTimeout: ({ queryId, queryName, generation, durationMs, phase, outcome }) => {
    logger.error({ queryId, queryName, generation, durationMs, phase, outcome });
  },
  onClientStateChange: ({ from, to, generation }) => {
    logger.info({ from, to, generation }, "database client state changed");
  },
  onQueryHookError: (error) => logger.error({ error }, "query observer failed"),
  onLifecycleHookError: (error) => logger.error({ error }, "database lifecycle observer failed"),
});
```

The `onQuery` hook is the integration point for metrics, tracing, and slow-query logging — sqlx-js does not log queries itself. `queryId` is the stable prepare/cache fingerprint and is suitable for metric labels; `queryName` is present for named `defineQuery` calls. Profiled managed clients also attach the stable `profile` name and PostgreSQL `role` to query, query-start/timeout, client-state, and lifecycle-hook-error events, including events emitted by replacement pool generations. The hook is a non-blocking observer: synchronous throws and asynchronous rejections preserve the database result/error and are passed to `onQueryHookError` when configured. The event preserves source-level parameters for direct queries (including the named-parameter object); mapped definitions report the mapper output rather than their application input. Parameters may contain personal or sensitive data — don't log them blindly; redact or omit `params` in shared sinks. Database errors are normalized to `PgError`; transport and non-database errors pass through unchanged.

Lifecycle events intentionally omit SQL text and parameters. `onQueryStart` fires before codec bootstrap. `onQueryTimeout` reports the stable ID, generation, phase, and outcome while the managed runtime cancels the query and retires the poisoned generation. `onClientStateChange` reports `healthy`, `poisoned`, `recycling`, `failed`, `closing`, and `closed` transitions.

`db.snapshot()` synchronously returns `{ generation, state, activeOperations, lastSuccessAt, lastTimeoutAt, recycleCount }`. `db.ready({ timeoutMs })` bounds codec discovery. `db.ping({ timeoutMs })` performs `SELECT 1` through the same bootstrap, deadline, pool, and observer path as application SQL.

`db.close({ graceMs, forceAfterMs })` is terminal for that scoped client: admission stops immediately, active operations receive the grace window, and remaining promises plus pools are forcibly terminated within the total `forceAfterMs` bound. Repeated calls share the same close promise.

`query.cancel()` is best-effort. Once a user statement has been handed to Postgres.js, a timeout is always reported as `outcome: "unknown"`: the statement may have completed, so sqlx-js never retries it automatically. All active operations from a poisoned generation are rejected and late driver results are ignored. A hundred concurrent timeouts from one generation still create only one replacement pool.

Name-based and mapped query definitions accept execution options without mixing them into SQL parameters. Positional definitions use `runWith(...)` because a trailing object may itself be a valid PostgreSQL parameter:

```ts
await findUser.run(db.sql, { id }, { signal: request.signal });
await positionalQuery.runWith({ signal: request.signal }, db.sql, id);
```

Execution options fail closed when the supplied executor is not a managed sqlx-js executor; they are never silently ignored by a structural test double or third-party adapter.
Inside a transaction, a query-level timeout or abort expires the whole scoped transaction so Postgres.js can roll it back before the connection is reused.

### `clearSqlFileCache()`

Drops the in-memory cache used by `sql.file(...)`. Files are immutable after their first read by default, avoiding a synchronous `stat` call for every query. Call this after a development-time file change or set `reloadSqlFiles: true` on the client to restore mtime-based reloading.

### Typed errors

```ts
import {
  NoRowsError,
  QueryAbortedError,
  QueryTimeoutError,
  TooManyRowsError,
  TransactionTimeoutError,
  SQLSTATE,
  isPgError,
} from "@onreza/sqlx-js";

try {
  const u = await sql.one(`SELECT id FROM users WHERE id = $1`, 99);
} catch (e) {
  if (e instanceof NoRowsError) return null;
  if (e instanceof TooManyRowsError) console.error("ambiguous query, got", e.actual);
  if (e instanceof QueryTimeoutError) console.error(e.phase, e.outcome, e.generation);
  if (e instanceof QueryAbortedError) console.error(e.outcome, e.reason);
  if (e instanceof TransactionTimeoutError) console.error(e.timeoutMs, e.outcome);
  if (isPgError(e, SQLSTATE.uniqueViolation)) console.error("duplicate:", e.constraint);
  throw e;
}
```

`sql.one` throws `NoRowsError` on 0 rows and `TooManyRowsError` (with `.actual`) on >1. `QueryTimeoutError` and `QueryAbortedError` expose `.phase`, `.outcome`, `.queryId`, and `.generation`. Collateral operations rejected during generation recovery receive `GenerationRecycledError`. `ClientClosingError` carries the same fields when shutdown interrupts an accepted operation; an admission rejected after shutdown begins has no operation fields. An expired transaction throws `TransactionTimeoutError` with `.timeoutMs`, `.generation`, and `.outcome` (`rolled_back` only after a clean rollback is confirmed; otherwise `unknown`). Any database error raised by the default runtime is normalized into a `PgError`; `isPgError(error, code?)` is the concise type guard for SQLSTATE handling. A server-side `statement_timeout` remains PostgreSQL error `57014`, not a managed `QueryTimeoutError`.

### Transactions with options

`sql.transaction(fn)` and `sql.transaction(opts, fn)`:

```ts
await sql.transaction({
  isolation: "serializable",
  readOnly: true,
  timeoutMs: 120_000,
  signal: request.signal,
}, async (tx) => {
  return await tx(`SELECT id FROM accounts WHERE owner = $1`, ownerId);
});
```

Options: `{ isolation?: "read uncommitted" | "read committed" | "repeatable read" | "serializable"; readOnly?: boolean; deferrable?: boolean; timeoutMs?: number; signal?: AbortSignal }`. Transaction characteristics are applied via `SET TRANSACTION` immediately after `BEGIN`. The deadline starts before codec bootstrap and covers pool acquisition, `BEGIN`, the callback, `COMMIT`, and `ROLLBACK`. On expiration the scoped executor is disabled, active statements are cancelled, and Postgres.js is given `cancelGraceMs` to confirm rollback. A clean rollback produces `outcome: "rolled_back"`; an unconfirmed `BEGIN`, `COMMIT`, or `ROLLBACK` produces `unknown` and retires the entire pool generation. Arbitrary non-database work already running inside the callback cannot be forcibly stopped by JavaScript, so external side effects should observe their own signal or be idempotent.

The transaction-scoped executor is valid only while its callback is active. Capturing `tx` and using it after commit or rollback fails locally without dispatching SQL.

### Namespace imports

In addition to `import { sql } from "@onreza/sqlx-js"`, the scanner recognises `import * as ns from "@onreza/sqlx-js"`. It validates `ns.sql(...)`, `ns.sql.one(...)`, `ns.sql.file(...)`, and `ns.sql.transaction(...)` exactly like the named-import form. Local re-declarations (`const sql = ...`, `const { sql } = ...`) correctly shadow the alias inside their scope.

## CLI

The command hierarchy follows ownership rather than implementation details:

| Command | Responsibility | Writes worktree | Changes target DB |
| --- | --- | --- | --- |
| `dev` | Build the configured schema in shadow and regenerate query artifacts | Yes | No |
| `verify` | Build in shadow and compare committed query artifacts | No | No |
| `ci` | Run `verify --strict-inference` plus offline artifact consistency | No | No |
| `prepare` | Generate, watch, restore, or check query artifacts | Depends on mode | Only reads |
| `migrate` | Built-in migration files and target history | `add/squash/archive` | `run/revert` |
| `pgschema` | Managed pgschema tool and target plan/apply | Install cache only | `apply` |
| `snapshot` | Runtime identifier snapshot and LLM manifest | `dump` | No |
| `queries` | Database-free query inventory and SQL embedding | With `--embed` | No |
| `doctor` | Runtime, config, provider, database, and artifact diagnostics | No | No |

Common syntax:

```text
sqlx-js dev [--strict-inference] [--shadow-url <url>]
sqlx-js verify [--strict-inference] [--shadow-url <url>]
sqlx-js ci [--json]
sqlx-js prepare [--watch | --check | --offline | --verify]
sqlx-js migrate add|run|info|check|revert|squash|archive
sqlx-js pgschema install|plan|apply
sqlx-js snapshot dump|check
sqlx-js doctor
sqlx-js queries [--json] [--embed <path>]
```

Run `sqlx-js <command> --help` or
`sqlx-js <command> <subcommand> --help` for exact flags, side effects, and
examples. Subcommand help is intentionally narrower than the root overview.

Regular `prepare` describes and plans queries across a small connection pool (default 8, override with `SQLX_JS_PREPARE_CONCURRENCY`) for faster cold runs on large projects. After `Describe` establishes the server-side parameter contract, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and `MERGE` are SQL-prepared on the same session and planned through `EXPLAIN EXECUTE` under `plan_cache_mode = force_generic_plan`. The resulting plan is independent of placeholder values. `ANALYZE` is never used, so DML is not executed. Statements outside PostgreSQL's generic SQL `PREPARE` surface, such as `SET` and `CALL`, remain valid but are reported and cached as `parse-only`. Watch mode keeps one session warm, rescans only affected source files, and reuses cached metadata for unchanged fingerprints. Config, tsconfig, and applied shadow-migration changes invalidate the incremental state and perform a full prepare.

| Flag                  | Meaning                                                                              |
|-----------------------|--------------------------------------------------------------------------------------|
| `--check`             | Read-only offline verification of query/function/enum caches and generated files.     |
| `--offline`           | Regenerate declarations and an enabled enum module from committed cache without a database. |
| `--verify`            | Prepare against the live/shadow schema and compare generated artifacts without writing. |
| `--watch`             | Persistent connection, re-prepare on file change.                                    |
| `--root <dir>`        | Source/cache/migrations root (default: cwd).                                         |
| `--dts <path>`        | Root-relative declarations output (default: `<root>/sqlx-js-env.d.ts`).             |
| `--no-prune`          | Keep orphaned cache entries; they do not invalidate a later `--check`.                |
| `--migrations <dir>`  | Root-relative migrations directory (default: `<root>/migrations`).                   |
| `--dry-run`           | For `migrate run` / `migrate revert`: validate without applying to the target DB.   |
| `--json`              | Machine-readable prepare diagnostics, doctor output, migration inspection and dry-runs. |
| `--embed <path>`      | For `queries`: write a deterministic TypeScript map of referenced external SQL files. |
| `--jsonl`             | Versioned streaming events for `prepare --watch`.                                     |
| `--strict-inference`  | Fail prepare/dev/verify when nullability degrades or a generated query type contains unresolved `unknown`. Intentional `JsonParameter<unknown>` wrappers remain accepted. |
| `--force`             | For `migrate archive restore`: allow overwriting existing migration files.           |
| `--lock-timeout <ms>` | Advisory-lock acquisition timeout for built-in `dev` / `verify` and applicable `migrate` operations. |
| `--shadow-url <url>`  | Use an existing disposable shadow DB instead of auto-creating one.                   |
| `--shadow-admin-url <url>` | Admin/maintenance DB URL used to auto-create shadow DBs.                       |
| `--replace`           | For `migrate squash`: archive replaced migration files after writing the baseline.   |
| `--pg-dump <path>`    | For `migrate squash`: `pg_dump` executable path (default: `pg_dump`).                |
| `--schema <path>`     | Root-relative schema snapshot path (default: `<root>/.sqlx-js/schema/schema.json`). |
| `--manifest <path>`   | Root-relative LLM schema manifest path (default: `<root>/.sqlx-js/schema/schema.md`). |
| `--no-manifest`       | Skip writing the LLM schema manifest during `snapshot dump`.                         |
| `--schema-provider <name>` | For `init`: `builtin` (default) or `pgschema`.                                |

Flags that take a value accept both `--flag value` and `--flag=value` forms.

Prepare and doctor JSON use `formatVersion: 1`. Prepare diagnostics include a stable phase plus root-relative file, 1-based line/column, query ID/name, connection profile, PostgreSQL code/position/hint when available, and the query text. Degraded inference and generated `unknown` types appear as warnings by default; `--strict-inference` promotes them to errors. This is intended for CI annotations and editor integrations; stdout contains one JSON document and human progress is suppressed. `prepare --watch --jsonl` emits one `start`, `diagnostic`, `prepared`, `error`, `watching`, or `stopping` event per line so an editor can consume diagnostics without waiting for the watch process to exit. Fatal `error` events include the same structured `diagnostic` object as CLI preflight failures, preserving the prepare phase and source location when available.

`queries --json` is database-free and read-only. It emits `formatVersion: 1` inventory entries with `queryId`, connection profiles, optional definition names, cardinalities, root-relative call sites, SQL file paths, `current`/`stale`/`missing` cache status, and `planned`/`parse-only` validation when cached, plus orphaned cache IDs. Config, scan, cache, and embed failures use versioned structured diagnostics with source location when available. Adding `--embed` writes the external-SQL module only after a successful scan.

`DATABASE_URL` must be set for any command that touches the application database or auto-creates a shadow database. `SHADOW_ADMIN_DATABASE_URL` can point at a maintenance/admin database when the application user cannot `CREATE DATABASE`; `SHADOW_DATABASE_URL` can point at a pre-created disposable shadow database. The internal wire client understands `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `application_name`, `options` (PostgreSQL startup options such as `-c search_path=app,public`), `connect_timeout` (seconds), and `statement_timeout` (milliseconds). Unqualified relations are resolved using the prepare session's real `search_path`; they are not assumed to live in `public`.

### Development and deployment flows

For complex PostgreSQL schemas with functions, triggers, RLS, grants, partitions, and other schema-level objects, prefer pgschema for DDL ownership and use sqlx-js for application-query typing:

```bash
sqlx-js init --schema-provider pgschema
sqlx-js pgschema install
sqlx-js doctor
# edit schema.sql
sqlx-js dev --strict-inference
sqlx-js verify --strict-inference
# review and apply the same desired state to the target database
sqlx-js pgschema plan -- --output-json plan.json
sqlx-js pgschema apply -- --plan plan.json --auto-approve
```

With `schema.provider = "pgschema"`, `dev` creates a disposable shadow
database, applies `schema.sql`, prepares project SQL, writes `.sqlx-js/`,
`sqlx-js-env.d.ts`, and any configured enum catalog, then drops the shadow.
`verify` repeats the same build but compares fresh artifacts without modifying
the worktree.

`pgschema install` installs the pinned version used by this sqlx-js release.
`dev`, `verify`, `pgschema plan`, and `pgschema apply` use `schema.command` when
configured; otherwise they prefer the managed binary under
`node_modules/.cache/sqlx-js/pgschema/` and fall back to `pgschema` on `PATH`.
Arguments after `--` are forwarded only by `plan` and `apply`.
`pgschema apply -- --plan plan.json` applies a reviewed plan without requiring
the local `schema.sql`. The pinned pgschema 1.12.0 CLI accepts one `--schema`
value, so multi-schema configurations fail explicitly.

Use provider-aware `dev` while developing built-in migrations and SQL:

```bash
sqlx-js migrate add add_users
# edit migrations/000N_add_users.up.sql and .down.sql
sqlx-js dev
```

For the built-in provider, `dev` applies all migrations from scratch, validates
that the latest `.down.sql` restores the previous schema, prepares project SQL,
writes generated artifacts, and drops the shadow database.

The built-in `migrate` workflow is kept for simple projects and embedded application startup. PostgreSQL-heavy schema lifecycle features belong in pgschema rather than in sqlx-js.

Use `verify` in PR/CI before merge:

```bash
sqlx-js verify --strict-inference
sqlx-js prepare --check
sqlx-js doctor --json
tsc --noEmit
```

`verify` runs the same provider-specific shadow build as `dev`, generates
prepare output in a temporary directory, and fails when committed artifacts
differ. It never modifies those artifacts.

Use `migrate run` in production/staging:

```bash
sqlx-js migrate run --dry-run --json
sqlx-js migrate run --lock-timeout 30000
sqlx-js migrate info --json
```

Production migration users do not need `CREATEDB`; they only need permissions to apply migrations to the target database. Shadow databases are for development and CI validation before deployment.

By default, `dev`, `verify`, `migrate revert --dry-run`, and `migrate squash`
derive a temporary database name from `DATABASE_URL`, connect to the
`postgres` maintenance database, create the shadow database, and drop it after
validation. If the application user cannot create databases, pass
`--shadow-admin-url`. In managed environments, pass `--shadow-url` or set
`SHADOW_DATABASE_URL`; that database is disposable and its user schemas are
cleared before development, verification, or squash validation.

### Migration squash baselines

`migrate squash <name>` applies all migrations to a disposable shadow database, dumps the resulting schema with `pg_dump --schema-only`, and writes one baseline migration containing `sqlx-js` replacement metadata.

```bash
sqlx-js migrate squash baseline --replace
```

On an empty database, the baseline runs as ordinary schema SQL. On an already-migrated database, `migrate run` verifies that every replaced migration row exists in `_sqlx_js_migrations` with the exact recorded hash, then atomically replaces those rows with the baseline row without executing the baseline DDL. Partial or hash-mismatched history fails closed before any pending replaced migration is applied.

`--replace` moves the old `.up.sql` / `.down.sql` files into `migrations/.archive/<version>_<name>/` after the baseline is written. Omit it if you want to review the generated baseline first; while old files remain, a fresh database replays them and then adopts the baseline row. Repeated squash baselines replace the effective history, so migrations already covered by an earlier squash are not listed again. Squash baselines intentionally do not generate a `.down.sql`; automatic reversal of a full schema baseline is not safe enough to guess.

`migrate check` is filesystem-only: it validates migration filenames, duplicate versions, orphan `.down.sql` files, squash metadata, and replacement hashes where the replaced files are still present. It does not need `DATABASE_URL`.

`migrate info` is read-only: it reports the resolved history table, status summary, and per-file state without creating `_sqlx_js_migrations` on databases that have not been migrated yet. Use `migrate check --json`, `migrate info --json`, or `migrate run --dry-run --json` for CI/operator tooling that needs stable structured output.

`migrate revert --dry-run` validates the latest migration's `.down.sql` in a transaction on a shadow database. It applies all earlier `.up.sql` files, snapshots the schema, applies the latest `.up.sql`, applies its `.down.sql`, then fails if the final schema differs from the pre-`up` snapshot. The transaction is rolled back, so an explicit `--shadow-url` database is not changed by a successful or failed dry-run. Add `--json` for structured output.

`migrate archive list` shows archives created by `migrate squash --replace`. `migrate archive restore <name>` moves archived `.up.sql` / `.down.sql` files back into `migrations/` and refuses to overwrite current files unless `--force` is passed.

### Schema snapshot and manifest

`snapshot dump` introspects PostgreSQL and writes two generated files:

- `.sqlx-js/schema/schema.json` — machine-readable contract for runtime identifier whitelisting and CI drift checks.
- `.sqlx-js/schema/schema.md` — compact LLM-facing manifest with tables, columns, constraints, indexes, types, and functions.

`snapshot check` re-introspects the database and fails if the committed
snapshot is stale. With `--shadow-url`, both `prepare` and `snapshot
dump/check` first apply pending migrations to the shadow database, then use it
as the source of truth. Unlike `dev`, `verify`, and `migrate squash`, snapshot
commands do not clear an explicit shadow database first.

### Error output

When `prepare` fails, every diagnostic points back to the originating call site:

```
✗ src/users.ts:42:13 — describe failed: relation "userss" does not exist (pos 15, code 42P01)
    query: SELECT * FROM userss WHERE id = $1
```

Phases reported separately: `describe failed`, `analyze failed`, `paramMap failed`. PostgreSQL `position`, `code`, and `hint` are surfaced when present.

### GitHub and editor diagnostics

`sqlx-js-diagnostics` converts the versioned prepare JSON document into GitHub workflow commands or a standard Unix problem-matcher stream:

```bash
set -o pipefail
sqlx-js prepare --verify --json | sqlx-js-diagnostics github
sqlx-js prepare --check --json | sqlx-js-diagnostics unix
```

The `github` format creates inline workflow annotations. The `unix` format emits `file:line:column: severity: [phase] message`, which can be consumed by VS Code tasks and other editors without a dedicated extension. A minimal VS Code task uses a custom problem matcher:

```json
{
  "label": "sqlx-js: check",
  "type": "shell",
  "command": "sqlx-js prepare --check --json | sqlx-js-diagnostics unix",
  "problemMatcher": {
    "owner": "sqlx-js",
    "fileLocation": ["relative", "${workspaceFolder}"],
    "pattern": {
      "regexp": "^(.+):(\\d+):(\\d+): (error|warning): \\[([^\\]]+)\\] (.*)$",
      "file": 1,
      "line": 2,
      "column": 3,
      "severity": 4,
      "code": 5,
      "message": 6
    }
  }
}
```

## Configuration

`sqlx-js.config.ts` at the project root is optional.

Under Node.js, TypeScript config is loaded through Node 24's native type stripping, so keep it to erasable TypeScript syntax. The generated `defineConfig(...)` form works on both Node and Bun; use `.mjs` if the config needs runtime constructs that Node cannot strip.

```ts
import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  scan: {
    include: ["apps/*/src/**/*", "packages/*/src/**/*"],
    exclude: ["**/*.generated.ts"],
    modules: ["@onreza/sqlx-js", "@app/database"],
  },
  schema: {
    provider: "pgschema",
    file: "schema.sql",
    schemas: ["public"],
  },
  jsonbTypes: {
    "users.settings":     'import("@app/shared/database-json").UserSettings',
    "posts.meta":         'import("@app/shared/database-json").PostMeta',
    "posts.attachments":  'import("@app/shared/database-json").Attachment[]',
  },
  // Explicit application-owned assertions for direct scalar columns only.
  columnTypes: {
    "analytics_event.action": "AnalyticsAction",
  },
  // Assert an application-enforced invariant for a direct array column.
  arrayElementNullability: {
    "analytics_event.tags": "non-null",
  },
  functionCatalog: {
    // Extension-owned functions are excluded by default.
    includeExtensionOwned: false,
  },
  enumCatalog: {
    output: "src/database/db-enums.ts",
    schemas: ["public", "billing"],
    include: ["public.user_role", "public.status", "billing.status"],
    aliases: {
      "public.status": "AccountStatus",
      "billing.status": "BillingStatus",
    },
    registry: true,
  },
});
```

By default the scanner uses the root `tsconfig.json` file list and follows TypeScript project references, so a referenced monorepo is scanned without walking unrelated folders. `scan.include` replaces that source-file universe with TypeScript glob patterns; `scan.exclude` is added to the built-in dependency/build exclusions. `scan.modules` replaces the default `@onreza/sqlx-js` import source list, which lets an application re-export `sql` through a shared database module without requiring arbitrary re-export graph analysis. Include `@onreza/sqlx-js` explicitly when direct imports and application-module imports are both used. If there is no root `tsconfig.json`, the fallback is a recursive TypeScript scan.

The `schema` block is optional. Use `provider: "pgschema"` when sqlx-js should delegate schema planning/apply commands to pgschema. `command` can override the managed binary lookup and point at another executable. With the pinned pgschema 1.12.0 CLI, `schemas` must contain exactly one schema name.

Point mappings directly at the application's canonical exported types. The strings are emitted as TypeScript type expressions, so `import("...").Type` keeps the generated declaration self-contained and avoids a duplicate ambient schema:

```ts
// packages/shared/src/database-json.ts
export type UserSettings = {
  theme: "light" | "dark";
  lang: string;
  notifications?: { email: boolean; push: boolean };
};
export type PostMeta = { tags?: string[]; pinned?: boolean };
export type Attachment = { url: string; kind: "image" | "video" | "file"; sizeBytes: number };
```

After re-running `prepare`, every direct `jsonb` column or mapped parameter uses the corresponding application-owned TypeScript type. Set operations preserve that type through direct or CTE-backed branches when every contributing source resolves to the same configured declaration; incompatible or partially unmapped result branches fall back to the PostgreSQL type instead of guessing. Parameters retain every direct-column target across data-modifying CTEs; conflicting configured declarations for one parameter fail prepare with the affected columns instead of choosing one by traversal order. This is a compile-time assertion, not runtime JSON validation; the application schema remains the source of truth. Columns without a custom mapping use `JsonValue` for result rows and `JsonParameter<unknown>` for parameters: the existential parameter type accepts any wrapper already proven JSON-safe by `sql.json(value)` without requiring domain interfaces to declare a string index signature. `--strict-inference` accepts this intentional wrapper while continuing to reject unresolved `unknown` elsewhere in generated query contracts. Non-JSON inputs such as `Date`, functions, and `bigint` are rejected by TypeScript while plain JSON objects, arrays, strings, numbers, booleans, and nested JSON `null` values are accepted. A bare top-level `null` remains SQL `NULL` and is allowed only when every stored-value target for that parameter accepts it; use `sql.json(null)` for JSON `null`.

### Direct scalar `columnTypes`

`columnTypes` is an explicit application-owned type assertion for a direct scalar table column. It affects result fields that PostgreSQL attributes to that exact column, compatible set-operation branches reconstructed by sqlx-js, and parameters mapped back through `INSERT`, `UPDATE`, data-modifying CTE, `WHERE`, or `JOIN` analysis. For stored values, sqlx-js aggregates every DML target and accepts one unique configured declaration; when no DML target exists, predicate references provide the parameter declaration instead. Conflicting declarations within the effective target set fail prepare rather than depending on traversal order. It never changes arbitrary expressions such as `upper(action)`, and it does not apply to PostgreSQL/JSON array columns. Use a schema-qualified key when table names can collide. Mapping the same logical column through both `jsonbTypes` and `columnTypes` is rejected.

This assertion does not validate stored values at runtime. Prefer a PostgreSQL enum/domain when the database truly owns a closed value set; use `columnTypes` when the database deliberately stores a broader scalar such as `text` and the application accepts responsibility for the narrower TypeScript contract.

### Generated enum catalog

Query parameters and rows use PostgreSQL enum labels as literal unions automatically. Enable `enumCatalog` when application code also needs reusable runtime values for forms, validators, tests, or business logic:

```ts
export default defineConfig({
  enumCatalog: {
    output: "src/database/db-enums.ts",
    schemas: ["public", "billing"],
    include: ["public.user_role", "public.status", "billing.status"],
    aliases: {
      "public.status": "AccountStatus",
      "billing.status": "BillingStatus",
    },
    registry: true,
  },
});
```

`prepare` introspects every enum in the explicitly listed schemas, including types not referenced by a scanned query, and writes a root-relative TypeScript module:

```ts
export const UserRole = {
  ["admin"]: "admin",
  ["editor"]: "editor",
  ["viewer"]: "viewer",
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];
```

The generated object is an ordinary runtime value while its same-named type remains the exact string union, so `UserRole.admin` is directly assignable to an enum-typed SQL parameter. PostgreSQL labels are preserved verbatim as computed string keys, including special JavaScript property names such as `__proto__`; no native TypeScript `enum` or runtime validation is introduced. PostgreSQL type names are converted to PascalCase exports (`user_role` → `UserRole`), with `Pg` prefixed when a name starts with a digit. If selected schemas contain names that normalize to the same export, prepare fails with both schema-qualified types. Resolve intentional collisions with `aliases`, keyed by the exact schema-qualified PostgreSQL name.

Use `include` as an exact schema-qualified allowlist or `exclude` as an exact blocklist; they cannot be combined. With neither option, every enum from `schemas` is generated. Unknown selections fail instead of silently producing an incomplete catalog, aliases must target selected enums, and registry entries follow the same filtered set. The committed cache still keeps every enum from `schemas`, so changing either filter remains an offline generation operation:

```ts
enumCatalog: {
  output: "src/database/db-enums.ts",
  schemas: ["public"],
  exclude: ["public.internal_status", "public.legacy_state"],
}
```

`registry: true` additionally emits an opt-in schema-qualified registry for dynamic access. It is disabled by default:

```ts
export const DbEnums = {
  ["billing.status"]: BillingStatus,
  ["public.status"]: AccountStatus,
  ["public.user_role"]: UserRole,
} as const;

export type DbEnumName = keyof typeof DbEnums;
export type DbEnumValue<Name extends DbEnumName> = /* exact value union */;
```

Use `DbEnums["public.user_role"].admin` when code chooses a database enum dynamically; prefer the direct `UserRole.admin` export for ordinary imports.

The catalog snapshot is committed at `.sqlx-js/enums/enums.json`. `prepare --offline` regenerates the configured module from that snapshot, `prepare --check` verifies both files without writing, and `prepare --verify` compares them against the live/shadow database without touching the worktree. Changing only `output`, `include`, `exclude`, `aliases`, or `registry` can therefore be completed with `prepare --offline`; changing `schemas` requires a live prepare.

The enum module and declaration output must be different files. If `--dts` overrides the declaration destination, prepare and doctor reject a colliding `enumCatalog.output` before writing either artifact.

Moving `output` or disabling the catalog does not delete the previous TypeScript module, because the new configuration no longer identifies that path safely. Update imports and remove the old generated file explicitly; the next live prepare removes a disabled catalog's cache and prints a reminder.

### Array element nullability assertions

`arrayElementNullability` is an application-owned assertion for direct PostgreSQL array columns whose elements are guaranteed non-null outside PostgreSQL's type system. Use `"non-null"` only when writes and existing data enforce that invariant. It follows direct-column provenance through CTEs, derived tables, compatible set-operation branches, and mapped parameters; arbitrary expressions are not narrowed by column name.

Prefer a database-owned element contract when possible:

```sql
CREATE DOMAIN non_null_tag AS text NOT NULL;
CREATE TABLE events (tags non_null_tag[] NOT NULL);
```

Arrays of that domain are inferred as `string[]` without config. Ordinary `text[]` remains `(string | null)[]` when no SQL or configuration proof exists. This uncertainty is a sound result type and does not fail `--strict-inference`.

### Function catalog scope

Application-owned functions and procedures from non-system schemas are generated into `KnownFunctions`. Objects owned by installed extensions are excluded through `pg_depend`, preventing extension internals from dominating committed artifacts. Set `functionCatalog.includeExtensionOwned: true` only when those approximate signatures are needed, or set `functionCatalog: false` to disable catalog generation entirely.

### Extension types, `customTypes`, and `typeCodecs`

sqlx-js ships with built-in compile-time and runtime codecs for popular PostgreSQL extension types:

| `pg_type.typname` | TS type                            | Source extension |
|-------------------|------------------------------------|-------------------|
| `vector`          | `number[]`                         | pgvector          |
| `halfvec`         | `number[]`                         | pgvector          |
| `sparsevec`       | `string`                           | pgvector          |
| `hstore`          | `Record<string, string \| null>`   | hstore            |
| `citext`          | `string`                           | citext            |
| `ltree`           | `string`                           | ltree             |
| `lquery`          | `string`                           | ltree             |
| `ltxtquery`       | `string`                           | ltree             |

Add or override mappings via `customTypes` in `sqlx-js.config.ts`. Keys are non-system `pg_type.typname` values (the bare element type name, not `_typename` array names). Live prepare verifies that every configured type exists and rejects system, array, and domain targets before publishing artifacts. The registry is global by type name, so two schemas with the same `typname` cannot be mapped differently:

```ts
import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  customTypes: {
    vector: "Float32Array",         // override pgvector default
    geometry: "GeoJSON.Geometry",   // postgis (not built-in by design)
    myapp_color: "`#${string}`",    // application representation of an enum
  },
});
```

Domains resolve to their base type through `pg_type.typbasetype`. `CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0)` → `number`, `CREATE DOMAIN tagged AS hstore` → `Record<string, string | null>`. PostgreSQL reports domain result columns with the base type OID, so domain-specific `customTypes` / `typeCodecs` overrides are rejected rather than producing a read/write contract that only works for parameters. Use `columnTypes` for a runtime-compatible branded assertion on a direct domain column. Array variants of any registered scalar are wired up automatically — `vector[]` → `(number[])[]`.

Composite types (`CREATE TYPE foo AS (a int, b text)`) resolve to a struct literal — `{ a: number | null; b: string | null }` — with each attribute typed (enums, domains, and nested composites included) and nullable unless the attribute is `NOT NULL`. Array variants (`foo[]`) resolve too.

PostgreSQL assigns database-local OIDs to enums, domains, composites, and extension types. The runtime resolves those OIDs once per pool before the first application query, then installs both scalar and array parsers/serializers in the shared Postgres.js registry. Enums use their string labels, domains delegate to their base type, composites become objects keyed by attribute name, and built-in `vector`/`halfvec`/`hstore` mappings match the TypeScript table above. Existing numeric Postgres.js `types` entries remain authoritative. Apply migrations before creating the application pool; recreate the client after adding or replacing database types so discovery sees the new catalog.

For an application-defined `customTypes` representation, provide the matching name-based runtime codec. Explicit mappings can override non-system base/extension, enum, range, and composite representations. Every configured `customTypes` entry is emitted into `SqlxJsGeneratedRegistry["runtimeTypes"]`; binding that registry to `createSqlClient<SqlxJsGeneratedRegistry>(...)` makes missing codecs and incompatible parser/serializer values TypeScript errors:

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";
import { parseGeometry, serializeGeometry } from "./geometry-codec";

const db = createSqlClient<SqlxJsGeneratedRegistry>(process.env.DATABASE_URL, {
  typeCodecs: {
    vector: {
      parse: (value) => new Float32Array(
        value === "[]" ? [] : value.slice(1, -1).split(",").map(Number),
      ),
      serialize: (value) => `[${Array.from(value).join(",")}]`,
    },
    geometry: {
      parse: parseGeometry,
      serialize: serializeGeometry,
    },
    myapp_color: {
      parse: (value) => value as `#${string}`,
      serialize: String,
    },
  },
});
```

Raw clients do not perform name-to-OID discovery. Bind generated custom types to explicit numeric Postgres.js `types` when raw access is required:

```ts
import { createClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";

const raw = createClient<SqlxJsGeneratedRegistry>(process.env.DATABASE_URL, {
  types: {
    geometry: {
      to: 50_000,
      from: [50_000],
      parse: parseGeometry,
      serialize: serializeGeometry,
    },
  },
});
```

The contract is scoped rather than ambient, so separate database packages can use the same PostgreSQL type name with different application representations. Prefer the registry-bound managed client for strict end-to-end discovery, deadline, and recovery guarantees.

Generated `customTypes` contracts use bare keys matching `pg_type.typname`. Bare codec keys apply to every matching type name; schema-qualified keys such as `postgis.geometry` are available for additional manually configured codecs but do not replace a generated bare-key requirement. A configured key that does not exist fails during bootstrap instead of silently leaving a mismatched runtime value. Codecs receive the scalar PostgreSQL text representation; their parser and serializer are composed automatically for composite attributes and arrays.

Database-specific numeric Postgres.js codecs remain a fully typed alternative. Pass `types` keyed by the generated `customTypes` names; each value is checked as `postgres.PostgresType<T>` for that application type. The numeric OIDs remain application-owned and take runtime precedence. If both mechanisms are needed, satisfy the generated contract with `typeCodecs` and add unrelated numeric `types` alongside it.

## How nullability is inferred

A result column is non-null if **all** of the following hold:

1. The source column has a `NOT NULL` constraint (looked up via `pg_attribute`).
2. The source table isn't on the nullable side of an outer join.
3. Any wrapping expression is null-preserving — `COALESCE` with a non-null fallback, `CASE` with `ELSE`, `COUNT(*)`, `EXISTS`, PostgreSQL array constructors, `length(non_null)`, etc.

A column that doesn't satisfy the above is `T | null`. You can override:

- `SELECT id AS "id!"` → force non-null.
- `SELECT id AS "id?"` → force nullable.
- `WHERE col IS NOT NULL` / `WHERE col = …` / `WHERE col IN (…)` → narrows `col` to non-null in the result.

The runtime strips the `!`/`?` suffix from column keys so the row shape stays clean: `{ id: bigint }`, not `{ "id!": bigint }`.

## CI workflow

The shortest production gate is provider-aware:

```bash
sqlx-js ci
```

For both providers, `ci` runs provider-aware `verify --strict-inference`
against a disposable shadow database and then the database-free
`prepare --check --strict-inference`. It validates the proposed schema source,
not target deployment drift, and never writes generated artifacts or changes
the target database. `--json` returns a versioned per-step report.

Commit the generated `sqlx-js-env.d.ts`, `.sqlx-js/` cache directory, and configured enum catalog output to your repo. In CI:

```yaml
- run: bun install
- run: sqlx-js pgschema install # only when schema.provider is "pgschema"
- run: sqlx-js ci
- run: sqlx-js doctor --json
- run: tsc --noEmit
- run: bun test --timeout 120000
- run: bun run build
```

Keep target-specific deployment checks explicit:

```bash
sqlx-js migrate run --dry-run --json               # built-in migrations
sqlx-js pgschema plan -- --output-json plan.json   # pgschema
sqlx-js snapshot check                             # when a snapshot is committed
```

`verify` needs credentials that can create a temporary database or an explicit
`--shadow-admin-url` / `--shadow-url`. `prepare --check` remains the fast
database-free consistency check. `prepare --verify` remains available for the
narrower advanced case of comparing query artifacts against a specifically
supplied live database.

The managed pgschema binary is installed under `node_modules/.cache/sqlx-js/pgschema/`, not `.sqlx-js/`, so it is not part of the committed offline cache.

Generated declarations, enum modules, and cache files should be excluded from formatters and linters. TypeScript artifacts remain included in `tsconfig.json` for type checking, but rules such as Biome's empty-interface or confusing-void checks are not meaningful for generated contracts.

## Contributing

The project uses [conventional commits](https://www.conventionalcommits.org/), validated locally by `cocogitto` through `lefthook` hooks. Install both before contributing:

```bash
bun install                  # installs lefthook + wires git hooks
cargo install cocogitto      # or: brew install cocogitto
```

Releases are automated via `release-please`: pushes to `main` accumulate into a release PR that bumps `package.json` and writes `CHANGELOG.md`. Merging that PR creates the tag and release, then the same workflow builds `dist/`, smoke-tests the package entrypoints, checks the tarball contents, and publishes to npm through Trusted Publishing.

## Limitations

`sqlx-js` is a young library. Known gaps:

- PostgreSQL only (no MySQL or SQLite).
- The scanner only follows direct named imports and namespace imports from configured `scan.modules` (default: `@onreza/sqlx-js`); it does not discover re-export graphs, dynamic aliases, or tagged-template calls automatically.
- Profile inference follows direct `const client = createSqlClient(..., { profile: profiles.name })` bindings and their transaction callbacks. Factories, returned clients, mutable aliases, and dependency-injection graphs require a direct profiled binding at the scanned query site; reusable definitions use `defineQuery.for(...)`.
- Star projections fall back to conservative nullability when their relation shape is ambiguous. Single-relation CTE and derived-table stars are expanded from the live schema, including `MATERIALIZED` CTEs used with lateral joins; multi-relation unqualified stars and recursive stars may still need explicit columns.
- Plain `sql(...)` keeps returning rows, so statements without `RETURNING` produce an empty typed array. Use `sql.execute(...)` when affected-row count and command metadata matter.
- Self-references inside `WITH RECURSIVE` are not analysed transitively — at worst this produces extra `T | null`. Ordinary later CTEs can reference earlier CTEs in the same `WITH`. Use `AS "id!"` overrides if recursive output needs an explicit contract.
- Column names whose **real** name (not an alias) ends with `!` or `?` are not supported — the runtime strips those suffixes assuming an override. Use `AS "alias"` if you have such a column.
- Result columns must have unique names because Postgres.js returns object rows. Alias join projections such as `users.id AS user_id, posts.id AS post_id`; `prepare` rejects duplicate output names before generating declarations.
- Migrations run inside `BEGIN/COMMIT`. DDL that disallows transactions (`CREATE INDEX CONCURRENTLY`, `VACUUM`, `REINDEX CONCURRENTLY`, …) will fail; split such operations into separate migrations executed outside the runner.
- The **internal** wire client (used by `migrate run`, `prepare`, and the runtime `migrate()` helper) reads `sslmode`, `sslrootcert`/`sslcert`/`sslkey`, `application_name`, `options`, `connect_timeout`, and `statement_timeout` from `DATABASE_URL`. The default runtime `sql()` path delegates connection handling to Postgres.js; configure TLS and pooling through the `DATABASE_URL` and `createSqlClient(...)` options (`statementTimeoutMs` maps to a per-connection server timeout, while `operationTimeoutMs` bounds the managed end-to-end path).
- `connect_timeout` bounds the entire internal-client connect, including the TLS handshake and SCRAM authentication.
- JavaScript timers cannot preempt synchronous application code or a synchronous custom codec that blocks the event loop. Managed deadlines are checked again after bootstrap and driver completion, but their wall-clock delivery still requires the event loop to make progress.
- Runtime `sql.file(path)` resolves against `fileRoot` while prepare resolves against `--root`. They are both root-relative, but applications started outside the project root must set `fileRoot` explicitly or provide the generated `sqlFiles` map.

See [ROADMAP.md](./ROADMAP.md) for what's planned.

## Upgrading

Breaking changes and migration instructions are maintained as versioned
[upgrade guides](./docs/upgrades/README.md). For the next release, see
[upgrading from 0.16.x to 0.17.0](./docs/upgrades/0.17.0.md). Earlier cache and
generator migrations are archived in the
[pre-0.15 guide](./docs/upgrades/pre-0.15.0.md).

## License

MIT.
