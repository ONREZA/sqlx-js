# sqlx-js

Compile-time-checked raw SQL for TypeScript + PostgreSQL. Inspired by Rust's [sqlx](https://github.com/launchbadge/sqlx).

You write plain SQL strings. A `prepare` step validates them against your database via the PostgreSQL wire protocol and generates a TypeScript declaration file. Wrong column names and stale queries fail during `prepare`; mismatched parameter types and row usage become TypeScript errors.

The runtime uses [Postgres.js](https://github.com/porsager/postgres) through a single adapter instead of a Bun-specific client. The published CLI requires **Node ≥ 24** (`#!/usr/bin/env node`) and can also run through **Bun ≥ 1.3**.

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

- **Compile-time validation** against a live PostgreSQL via `Parse` + `Describe Statement` (no query execution).
- **Precise nullability inference** through `libpg-query`: `JOIN` direction (LEFT/RIGHT/FULL), inner `JOIN ... ON` predicates, DML `RETURNING`, `COALESCE`, `CASE`, `COUNT`, expression propagation. Parameters become `T | null` when wrapped in `COALESCE`/`NULLIF`/`IS [NOT] NULL`/`IS [NOT] DISTINCT FROM`, or when bound to a nullable column in `INSERT`/`UPDATE`.
- **WHERE narrowing**: `IS NOT NULL`, equality chains, `IN`, `LIKE`, `BETWEEN` make columns non-null. Tracks `AND`/`OR` semantics.
- **PostgreSQL enums** generated as TypeScript literal unions (read + write side).
- **Schema-aware `jsonb`** via a `SqlxJsJson` global namespace and a config-driven column → type mapping. Works for both result columns and `INSERT`/`UPDATE`/`WHERE` parameters. Unmapped `json`/`jsonb` falls back to `JsonValue` for rows and `JsonInput` for parameters instead of `unknown`.
- **Extension types out of the box**: `pgvector` (`vector`, `halfvec`, `sparsevec`), `hstore`, `citext`, `ltree`/`lquery`/`ltxtquery`. Add your own through `customTypes` config.
- **Domains** resolve to their base TypeScript type (`CREATE DOMAIN email AS text` → `string`), including domains over extension types or other domains.
- **Wide built-in type coverage**: numeric, text, date/time, UUID, json/jsonb, network (inet/cidr/macaddr/macaddr8), bit strings, ranges/multiranges, geometric, money, tsvector/tsquery, xml — and the matching array variants.
- **External SQL files** via `sql.file("queries/foo.sql", ...)` — prepared and typed through `KnownFileQueries`. Watch mode re-prepares on `.sql` edits too.
- **One-row helpers**: `sql.one(...)`, `sql.optional(...)`, `sql.file.one(...)`, `sql.file.optional(...)`, and the same chain on the `tx` callback — friendly with `noUncheckedIndexedAccess: true`. The scanner walks all of them.
- **Unambiguous JSON and PostgreSQL array params** through `sql.json(...)` and `sql.array(...)`. Primitive JSON arrays cannot be silently encoded as PostgreSQL array literals.
- **Typed transactions** via `sql.transaction(async tx => …)` — the `tx` callback parameter is recognized by the scanner, so queries inside the block keep full type checking.
- **Sourcemap-accurate error reporting**: every prepare failure points to `file:line:column` of the originating `sql(...)` call site, with PG error code, position, and hint.
- **Linear migrations** with hash tampering detection.
- **Migration squash baselines** via `migrate squash`: generate a schema-only baseline from a shadow database, then hash-adopt it on already-migrated databases.
- **Runtime `migrate()`** with PostgreSQL advisory lock, safe for multi-replica startup.
- **Optional pgschema workflow** via `init --schema-provider pgschema` and `sqlx-js db install|check|plan|apply` for PostgreSQL schema-as-code projects.
- **Versioned offline cache** committed to your repo. `prepare --check` validates fingerprints, generator revision, and type-affecting config without a database; `prepare --verify` compares fresh live/shadow artifacts without writing.
- **Schema snapshot + LLM manifest** via `schema dump` / `schema check`: tables, columns, constraints, indexes, types, and function/procedure metadata are introspected from PostgreSQL.
- **Generated function catalog** via `KnownFunctions`: `prepare` records user-schema PostgreSQL functions/procedures from `pg_proc` with approximate parameter and return TypeScript types.
- **Shadow database validation** via `migrate dev` / `migrate verify`: auto-create a disposable shadow DB, apply migrations, validate SQL, and drop it afterwards.
- **Safe identifier quoting** via `sql.id(...)`, backed by the committed schema snapshot whitelist.
- **Single runtime adapter**: Postgres.js backs the runtime on Node/Bun-compatible environments — no Bun.SQL-specific adapter to choose.
- **Incremental watch mode**: debounced re-prepare with a warm `PgClient` + `SchemaCache`; source/SQL edits only rescan affected files and re-describe changed fingerprints, while config/tsconfig/schema changes trigger a full rebuild.
- **Cache pruning** removes orphaned entries automatically (toggleable with `--no-prune`).
- **Environment doctor** checks runtime versions, config loading, `.env`, database connectivity/permissions, cache metadata, tsconfig inclusion, and pgschema availability.
- **Strict inference gate** promotes degraded nullability analysis and generated `unknown` query types to CI errors.
- **GitHub/editor diagnostics adapter** converts versioned prepare JSON into workflow annotations or Unix problem-matcher output.

## Install

```bash
npm install @onreza/sqlx-js
npm install --save-dev typescript
# or
bun add @onreza/sqlx-js
bun add --dev typescript
```

Node.js 24 or newer is required. Bun users need Bun 1.3 or newer. TypeScript is an optional peer so production-only installs do not pull the compiler and its platform package into the application image; source scanning commands (`prepare`, `doctor`, `ci`, and migration development/verification) require it in development dependencies.

The package installs `sqlx-js` and `sqlx-js-diagnostics` binaries. The CLI examples below use `npx @onreza/sqlx-js`; `bunx @onreza/sqlx-js ...` works the same if your project uses Bun.

## Setup

### 0. Scaffold a project (optional)

```bash
npx @onreza/sqlx-js init
```

Creates `sqlx-js.config.ts`, `sqlx-js-env.d.ts`, a `migrations/` directory, and `.env.example` if they don't already exist. For strict-JSON files it adds missing `sqlx:*` scripts to `package.json` and appends the declaration to an existing `files` or `include` array in `tsconfig.json`, without replacing existing values; JSONC files are left unchanged with a manual-update hint. Skip it if you prefer to wire things up manually.

For declarative PostgreSQL schema management, scaffold the pgschema workflow instead:

```bash
npx @onreza/sqlx-js init --schema-provider pgschema
```

This creates `schema.sql` and configures `schema.provider = "pgschema"` in `sqlx-js.config.ts`. The npm package does not bundle pgschema, but `sqlx-js db install` downloads the pinned pgschema binary into `node_modules/.cache/sqlx-js/pgschema/`; then `sqlx-js db check` verifies it.

The managed pgschema workflow supports Linux and macOS. On Windows, run sqlx-js under WSL/Linux/macOS or use the built-in `sqlx-js migrate` workflow.

### 1. Configure the database URL

```bash
# .env
DATABASE_URL=postgres://user:password@localhost:5432/your_db
# Or with TLS against managed Postgres:
# DATABASE_URL=postgres://user:password@db.example.com:5432/your_db?sslmode=require
```

Supported `sslmode` values: `disable`, `prefer` (default — try TLS, fall back to plaintext), `require` (TLS or fail), `verify-ca`, `verify-full`. For a private/self-signed CA, point `sslrootcert` (and optionally `sslcert` / `sslkey` for client certs) at PEM files: `?sslmode=verify-full&sslrootcert=/etc/ssl/ca.pem`. `application_name`, `connect_timeout` (seconds), and `statement_timeout` (milliseconds) are also honored when provided as URL parameters.

CLI commands load `<root>/.env` before reading connection settings. Variables already present in the process environment take precedence. Application runtime configuration remains owned by your application/framework.

### 2. Create a migration

```bash
npx @onreza/sqlx-js migrate add init
```

The command creates matching `.up.sql` and `.down.sql` stubs. Edit the `.up.sql` file (`migrations/0001_init.up.sql`):

```sql
CREATE TABLE users (
  id    BIGSERIAL PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  age   INT,
  bio   TEXT
);
```

For queries with several values, named parameters keep the SQL and arguments aligned:

```ts
const rows = await sql(
  `SELECT id, name
   FROM users
   WHERE email = $email OR recovery_email = $email
   LIMIT $limit`,
  { email: "user@example.com", limit: 10 },
);
```

Named parameters use ASCII identifier names (`$user_id`), are numbered by first appearance before PostgreSQL sees the query, and repeated names reuse the same positional parameter. The generated object contract rejects missing, extra, and incorrectly typed properties. Named `$name` and positional `$1` parameters cannot be mixed in one query. Quoted strings, comments, dollar-quoted bodies, and `$` inside PostgreSQL identifiers are left unchanged. Positional parameters remain supported and are still the shortest form for simple queries.

During local development, validate the migration and regenerate query artifacts against a disposable shadow database:

```bash
npx @onreza/sqlx-js migrate dev
```

`migrate dev` does not touch your application database. It creates a temporary shadow database using `DATABASE_URL` credentials, applies migrations from scratch, validates that the latest migration's `.down.sql` restores the previous schema (squash baselines may omit `.down.sql`), prepares SQL queries against the resulting schema, writes `.sqlx-js/` and `sqlx-js-env.d.ts`, then drops the shadow database.

When you want to update your local application database, run:

```bash
npx @onreza/sqlx-js migrate run
```

If you need to change the latest migration after applying it locally, run `migrate revert`, edit the migration, then run `migrate run` again. Once a migration has been shared or merged, treat it as immutable and add a new migration instead.

### 3. Write your first query

```ts
// app.ts
import { sql } from "@onreza/sqlx-js";

const users = await sql(
  `SELECT id, name FROM users WHERE id = $1`,
  1n,
);
```

### 4. Prepare types

```bash
npx @onreza/sqlx-js prepare
```

This generates `sqlx-js-env.d.ts` next to your code. Add it to your `tsconfig.json` `include` if it isn't picked up automatically. Use `--dts <path>` to override the destination relative to `--root`.

### 5. Dev loop with watch

```bash
npx @onreza/sqlx-js prepare --watch
```

Save a `.ts` file, types regenerate in milliseconds, your editor picks up changes.

## API

### `sql(query, ...params)`

The typed query function. The first argument must be a string literal that exists in `KnownQueries` (populated by `prepare`).

```ts
const rows = await sql(`SELECT id FROM users WHERE name = $1`, "alice");
//                      ^ literal — checked at compile time
```

Unknown queries, wrong parameter types, and dynamic strings are compile errors. For genuinely dynamic SQL, use `unsafe`.

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

Generated parameter types require `PgArrayParameter<T>` or `JsonParameter<T>`, so mixing the two representations is a TypeScript error. A PostgreSQL `json[]` / `jsonb[]` composes both wrappers: the outer `sql.array(...)` selects the PostgreSQL array representation and each non-SQL-NULL element uses `sql.json(...)`. `sql.json(null)` represents JSON `null`; a bare `null` remains SQL `NULL` when the database parameter is nullable.

Both helpers also work with `unsafe(...)`. `encodePgArrayLiteral(arr)` remains exported for code that explicitly needs a PostgreSQL array literal string.

### Parameter nullability

`prepare` infers param types as `T | null` when:

- `$N` appears inside `COALESCE($N, …)`, `NULLIF($N, …)`, `IS [NOT] NULL`, or `IS [NOT] DISTINCT FROM` — these patterns are only meaningful when the parameter can be `null`.
- `$N` is positionally bound in `INSERT … VALUES (…, $N, …)` or `UPDATE … SET col = $N` and the target column is nullable.

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

### `getClient()` / `setClient()` / `close()`

Low-level access to the underlying Postgres.js client, in case you need to manage the connection directly.
Use `createClient(...)` when replacing the default client; it preserves the built-in `bigint` and PostgreSQL array parsers expected by generated types.

```ts
import { createClient, setClient } from "@onreza/sqlx-js";

setClient(createClient(process.env.DATABASE_URL));
```

For dependency injection, read replicas, tests, or several independent pools in one process, create a scoped runtime instead of replacing the global client:

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";

const primary = createSqlClient<SqlxJsGeneratedRegistry>(process.env.DATABASE_URL);
const replica = createSqlClient<SqlxJsGeneratedRegistry>(process.env.REPLICA_DATABASE_URL);

await primary.sql(`INSERT INTO audit_log (message) VALUES ($1)`, "created");
const rows = await replica.sql(`SELECT id, message FROM audit_log ORDER BY id DESC`);

await Promise.all([primary.close(), replica.close()]);
```

Each generated `sqlx-js-env.d.ts` exports its own `SqlxJsGeneratedRegistry`. Passing it to `createSqlClient<...>()` keeps a scoped client on that project's query contract even when a monorepo TypeScript program includes declarations for several databases. The global `sql` export remains available for the single-client convenience path.

The scanner recognizes clients assigned directly from an imported `createSqlClient(...)` (including aliased and namespace imports), so `client.sql(...)`, its cardinality helpers, file queries, and transactions participate in `prepare` exactly like the global `sql` surface.

`createClient(url, options)` accepts every Postgres.js option plus sqlx-js runtime options:

```ts
setClient(createClient(process.env.DATABASE_URL, {
  // Server-side per-connection statement timeout (ms). Also settable via
  // ?statement_timeout=5000 in DATABASE_URL.
  statementTimeoutMs: 5000,
  // Base directory for root-relative sql.file(...) calls.
  fileRoot: import.meta.dirname,
  // Development-only: re-stat sql.file() files on every call. The default
  // immutable cache avoids synchronous filesystem work in the query hot path.
  reloadSqlFiles: true,
  // Honored for every unsafe call. Set false for PgBouncer transaction mode
  // unless protocol-level prepared statements are configured there.
  prepare: false,
  // Fires after every query/transaction statement, success or failure.
  onQuery: ({ query, params, durationMs, rowCount, error }) => {
    if (error) logger.error({ query, error });        // database errors are PgError
    else if (durationMs > 200) logger.warn({ slow: query, durationMs, rowCount });
  },
  onQueryHookError: (error) => logger.error({ error }, "query observer failed"),
}));
```

The `onQuery` hook is the integration point for metrics, tracing, and slow-query logging — sqlx-js does not log queries itself. It is a non-blocking observer: synchronous throws and asynchronous rejections preserve the database result/error and are passed to `onQueryHookError` when configured. The event carries the raw `params`, which may contain personal or sensitive data — don't log them blindly; redact or omit `params` in shared sinks. Database errors are normalized to `PgError`; transport and non-database errors pass through unchanged.

### `clearSqlFileCache()`

Drops the in-memory cache used by `sql.file(...)`. Files are immutable after their first read by default, avoiding a synchronous `stat` call for every query. Call this after a development-time file change or set `reloadSqlFiles: true` on the client to restore mtime-based reloading.

### Typed errors

```ts
import { NoRowsError, TooManyRowsError, PgError } from "@onreza/sqlx-js";

try {
  const u = await sql.one(`SELECT id FROM users WHERE id = $1`, 99);
} catch (e) {
  if (e instanceof NoRowsError) return null;
  if (e instanceof TooManyRowsError) console.error("ambiguous query, got", e.actual);
  if (e instanceof PgError) console.error("pg code:", e.code, "position:", e.position);
  throw e;
}
```

`sql.one` throws `NoRowsError` on 0 rows and `TooManyRowsError` (with `.actual`) on >1. Any database error raised by the default runtime is normalized into a `PgError`, so `e instanceof PgError` works the same in `prepare`, `migrate`, and ordinary `sql(...)` calls. `PgError` exposes `.code`, `.position`, `.hint`, `.detail`, `.severity`, `.schema`, `.table`, `.column`, `.constraint`, and the original driver error on `.cause`. Non-database failures (e.g. a dropped connection) are rethrown unchanged.

### Transactions with options

`sql.transaction(fn)` and `sql.transaction(opts, fn)`:

```ts
await sql.transaction({ isolation: "serializable", readOnly: true }, async (tx) => {
  return await tx(`SELECT id FROM accounts WHERE owner = $1`, ownerId);
});
```

Options: `{ isolation?: "read uncommitted" | "read committed" | "repeatable read" | "serializable"; readOnly?: boolean; deferrable?: boolean }`. Applied via `SET TRANSACTION` immediately after `BEGIN`.

### Namespace imports

In addition to `import { sql } from "@onreza/sqlx-js"`, the scanner recognises `import * as ns from "@onreza/sqlx-js"`. It validates `ns.sql(...)`, `ns.sql.one(...)`, `ns.sql.file(...)`, and `ns.sql.transaction(...)` exactly like the named-import form. Local re-declarations (`const sql = ...`, `const { sql } = ...`) correctly shadow the alias inside their scope.

## CLI

```
sqlx-js init [--root <dir>] [--schema-provider builtin|pgschema]
sqlx-js doctor [--root <dir>] [--dts <path>] [--json]
sqlx-js ci [--root <dir>] [--dts <path>] [--schema <path>] [--json] [--shadow-url <url>] [--shadow-admin-url <url>]
sqlx-js db install | check [--root <dir>]
sqlx-js db plan | apply [--root <dir>] [-- <pgschema args>]
sqlx-js prepare [--check | --offline | --verify | --watch] [--json | --jsonl] [--strict-inference] [--root <dir>] [--dts <path>] [--no-prune] [--shadow-url <url>]
sqlx-js migrate dev [--dts <path>] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] [--strict-inference] | verify [--dts <path>] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] [--strict-inference] | run [--dry-run] [--json] [--lock-timeout <ms>] | info [--json] | check [--json] | revert [--dry-run] [--json] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] | add <name> | squash <name> [--shadow-admin-url <url> | --shadow-url <url>] [--replace] [--pg-dump <path>] [--lock-timeout <ms>] | archive list | archive restore <name> [--force]
sqlx-js schema dump [--schema <path>] [--manifest <path>] [--no-manifest] [--shadow-url <url>]
sqlx-js schema check [--schema <path>] [--shadow-url <url>]
sqlx-js --version | --help
```

Regular `prepare` describes queries across a small connection pool (default 8, override with `SQLX_JS_PREPARE_CONCURRENCY`) for faster cold runs on large projects. Watch mode keeps one session warm, rescans only affected source files, and reuses cached metadata for unchanged fingerprints. Config, tsconfig, and applied shadow-migration changes invalidate the incremental state and perform a full prepare.

| Flag                  | Meaning                                                                              |
|-----------------------|--------------------------------------------------------------------------------------|
| `--check`             | Read-only offline verification of the active query cache, function catalog, and generated declaration. |
| `--offline`           | Regenerate `sqlx-js-env.d.ts` from committed cache without a database.                |
| `--verify`            | Prepare against the live/shadow schema and compare generated artifacts without writing. |
| `--watch`             | Persistent connection, re-prepare on file change.                                    |
| `--root <dir>`        | Source/cache/migrations root (default: cwd).                                         |
| `--dts <path>`        | Root-relative declarations output (default: `<root>/sqlx-js-env.d.ts`).             |
| `--no-prune`          | Keep orphaned cache entries; they do not invalidate a later `--check`.                |
| `--migrations <dir>`  | Root-relative migrations directory (default: `<root>/migrations`).                   |
| `--dry-run`           | For `migrate run` / `migrate revert`: validate without applying to the target DB.   |
| `--json`              | Machine-readable prepare diagnostics, doctor output, migration inspection and dry-runs. |
| `--jsonl`             | Versioned streaming events for `prepare --watch`.                                     |
| `--strict-inference`  | Fail prepare/dev/verify when nullability degrades or a generated query type contains `unknown`. |
| `--force`             | For `migrate archive restore`: allow overwriting existing migration files.           |
| `--lock-timeout <ms>` | Advisory-lock acquisition timeout for `migrate run` / `revert` / `dev` / `verify` / `squash`. |
| `--shadow-url <url>`  | Use an existing disposable shadow DB instead of auto-creating one.                   |
| `--shadow-admin-url <url>` | Admin/maintenance DB URL used to auto-create shadow DBs.                       |
| `--replace`           | For `migrate squash`: archive replaced migration files after writing the baseline.   |
| `--pg-dump <path>`    | For `migrate squash`: `pg_dump` executable path (default: `pg_dump`).                |
| `--schema <path>`     | Root-relative schema snapshot path (default: `<root>/.sqlx-js/schema/schema.json`). |
| `--manifest <path>`   | Root-relative LLM schema manifest path (default: `<root>/.sqlx-js/schema/schema.md`). |
| `--no-manifest`       | Skip writing the LLM schema manifest during `schema dump`.                           |
| `--schema-provider <name>` | For `init`: `builtin` (default) or `pgschema`.                                |

Flags that take a value accept both `--flag value` and `--flag=value` forms.

Prepare and doctor JSON use `formatVersion: 1`. Prepare diagnostics include a stable phase plus root-relative file, 1-based line/column, PostgreSQL code/position/hint when available, and the query text. Degraded inference and generated `unknown` types appear as warnings by default; `--strict-inference` promotes them to errors. This is intended for CI annotations and editor integrations; stdout contains one JSON document and human progress is suppressed. `prepare --watch --jsonl` emits one `start`, `diagnostic`, `prepared`, `error`, `watching`, or `stopping` event per line so an editor can consume diagnostics without waiting for the watch process to exit. Fatal `error` events include the same structured `diagnostic` object as CLI preflight failures, preserving the prepare phase and source location when available.

`DATABASE_URL` must be set for any command that touches the application database or auto-creates a shadow database. `SHADOW_ADMIN_DATABASE_URL` can point at a maintenance/admin database when the application user cannot `CREATE DATABASE`; `SHADOW_DATABASE_URL` can point at a pre-created disposable shadow database. The internal wire client understands `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `application_name`, `options` (PostgreSQL startup options such as `-c search_path=app,public`), `connect_timeout` (seconds), and `statement_timeout` (milliseconds). Unqualified relations are resolved using the prepare session's real `search_path`; they are not assumed to live in `public`.

### Development and deployment flows

For complex PostgreSQL schemas with functions, triggers, RLS, grants, partitions, and other schema-level objects, prefer pgschema for DDL ownership and use sqlx-js for application-query typing:

```bash
sqlx-js init --schema-provider pgschema
sqlx-js db install
sqlx-js db check
# edit schema.sql
sqlx-js db plan -- --output-json plan.json
sqlx-js db apply -- --auto-approve
sqlx-js prepare
```

`sqlx-js db install` installs the pinned pgschema version used by this sqlx-js release. `sqlx-js db check`, `plan`, and `apply` use `schema.command` when configured; otherwise they prefer the managed binary under `node_modules/.cache/sqlx-js/pgschema/` and fall back to `pgschema` on `PATH`. `plan` and file-backed `apply` translate `DATABASE_URL` into `--host`, `--port`, `--db`, `--user`, `--file`, and `--schema` arguments, pass the password through `PGPASSWORD`, pass TLS settings through `PGSSLMODE` / `PGSSLROOTCERT` / `PGSSLCERT` / `PGSSLKEY`, and forward any arguments after `--` directly to pgschema. `sqlx-js db apply -- --plan plan.json` applies a reviewed pgschema plan without requiring the local `schema.sql` file. The schema provider is configured in `sqlx-js.config.ts`; by default the schema file is `schema.sql` and the schema is `public`. The pinned pgschema 1.12.0 CLI accepts a single `--schema` value, so sqlx-js rejects pgschema configs with more than one schema instead of silently applying only one.

Use `migrate dev` while developing migrations and SQL:

```bash
sqlx-js migrate add add_users
# edit migrations/000N_add_users.up.sql and .down.sql
sqlx-js migrate dev
```

`migrate dev` creates a disposable shadow database, applies all migrations from scratch, validates that the latest migration's `.down.sql` restores the previous schema (squash baselines may omit `.down.sql`), prepares project SQL against the shadow schema, writes `.sqlx-js/` plus `sqlx-js-env.d.ts`, and drops the shadow database. This means you can keep editing a local WIP migration before it is merged. You do not need to drop your application database or create a new migration for every local edit.

The built-in `migrate` workflow is kept for simple projects and embedded application startup. PostgreSQL-heavy schema lifecycle features belong in pgschema rather than in sqlx-js.

Use `migrate verify` in PR/CI before merge:

```bash
sqlx-js migrate verify --strict-inference
sqlx-js prepare --check
sqlx-js doctor --json
tsc --noEmit
```

`migrate verify` runs the same shadow-database migration/down/SQL validation as `migrate dev`, generates prepare output in a temporary directory, and fails when the committed `.sqlx-js/` or `sqlx-js-env.d.ts` differs. It never modifies those artifacts.

Use `migrate run` in production/staging:

```bash
sqlx-js migrate run --dry-run --json
sqlx-js migrate run --lock-timeout 30000
sqlx-js migrate info --json
```

Production migration users do not need `CREATEDB`; they only need permissions to apply migrations to the target database. Shadow databases are for development and CI validation before deployment.

By default, `migrate dev`, `migrate verify`, `migrate revert --dry-run`, and `migrate squash` derive a temporary database name from `DATABASE_URL`, connect to the `postgres` maintenance database with the same credentials, run `CREATE DATABASE ... OWNER <database-url-user>`, then `DROP DATABASE` after validation. If the application user cannot create databases, pass `--shadow-admin-url postgres://admin:.../postgres`; the generated shadow database is still owned by the application user from `DATABASE_URL`. In managed environments where databases must be pre-created, pass `--shadow-url` or set `SHADOW_DATABASE_URL`; that database is treated as disposable and its user schemas are cleared before development/verify/squash validation.

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

`schema dump` introspects PostgreSQL and writes two generated files:

- `.sqlx-js/schema/schema.json` — machine-readable contract for runtime identifier whitelisting and CI drift checks.
- `.sqlx-js/schema/schema.md` — compact LLM-facing manifest with tables, columns, constraints, indexes, types, and functions.

`schema check` re-introspects the database and fails if the committed snapshot is stale. With `--shadow-url`, both `prepare` and `schema dump/check` first apply pending migrations to the shadow database, then use that database as the source of truth. Unlike `migrate dev` / `verify` / `squash`, these commands do not clear an explicit shadow database first. In watch mode, pending shadow migrations are checked before every re-prepare; when a migration is applied, the prepare session is reopened so schema metadata is not reused across DDL changes.

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
    "users.settings":     "SqlxJsJson.UserSettings",
    "posts.meta":         "SqlxJsJson.PostMeta",
    "posts.attachments":  "SqlxJsJson.Attachment",
  },
});
```

By default the scanner uses the root `tsconfig.json` file list and follows TypeScript project references, so a referenced monorepo is scanned without walking unrelated folders. `scan.include` replaces that source-file universe with TypeScript glob patterns; `scan.exclude` is added to the built-in dependency/build exclusions. `scan.modules` replaces the default `@onreza/sqlx-js` import source list, which lets an application re-export `sql` through a shared database module without requiring arbitrary re-export graph analysis. Include `@onreza/sqlx-js` explicitly when direct imports and application-module imports are both used. If there is no root `tsconfig.json`, the fallback is a recursive TypeScript scan.

The `schema` block is optional. Use `provider: "pgschema"` when sqlx-js should delegate schema planning/apply commands to pgschema. `command` can override the managed binary lookup and point at another executable. With the pinned pgschema 1.12.0 CLI, `schemas` must contain exactly one schema name.

Declare the referenced types anywhere in your project (`.d.ts` file is conventional):

```ts
// json-types.d.ts
declare global {
  namespace SqlxJsJson {
    type UserSettings = {
      theme: "light" | "dark";
      lang: string;
      notifications?: { email: boolean; push: boolean };
    };
    type PostMeta = { tags?: string[]; pinned?: boolean };
    type Attachment = { url: string; kind: "image" | "video" | "file"; sizeBytes: number };
  }
}
export {};
```

After re-running `prepare`, every `jsonb` column or parameter declared in `jsonbTypes` is checked against the corresponding TypeScript type. Columns without a custom mapping use `JsonValue` for result rows and `JsonInput` inside `JsonParameter` for parameters, both exported by `@onreza/sqlx-js`. Pass JSON parameters through `sql.json(value)`: non-JSON inputs such as `Date`, functions, and `bigint` are rejected by TypeScript while plain JSON objects, arrays, strings, numbers, booleans, and nested JSON `null` values are accepted. A bare top-level `null` remains SQL `NULL` and is allowed only when the mapped database parameter is nullable; use `sql.json(null)` for JSON `null`.

### Extension types and `customTypes`

sqlx-js ships with a built-in registry that resolves popular PostgreSQL extension types automatically:

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

Add or override mappings via `customTypes` in `sqlx-js.config.ts`. Keys are `pg_type.typname` values (the bare type name). The registry is global by type name, so two schemas with the same `typname` cannot be mapped differently:

```ts
import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  customTypes: {
    vector: "Float32Array",         // override pgvector default
    geometry: "GeoJSON.Geometry",   // postgis (not built-in by design)
    myapp_color: "`#${string}`",    // your own CREATE TYPE base/domain
  },
});
```

Domains resolve to their base type through `pg_type.typbasetype`. `CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0)` → `number`, `CREATE DOMAIN tagged AS hstore` → `Record<string, string | null>`. Array variants of any registered scalar are also wired up automatically — `vector[]` → `(number[])[]`.

Composite types (`CREATE TYPE foo AS (a int, b text)`) resolve to a struct literal — `{ a: number | null; b: string | null }` — with each attribute typed (enums, domains, and nested composites included) and nullable unless the attribute is `NOT NULL`. Array variants (`foo[]`) resolve too.

## How nullability is inferred

A result column is non-null if **all** of the following hold:

1. The source column has a `NOT NULL` constraint (looked up via `pg_attribute`).
2. The source table isn't on the nullable side of an outer join.
3. Any wrapping expression is null-preserving — `COALESCE` with a non-null fallback, `CASE` with `ELSE`, `COUNT(*)`, `length(non_null)`, etc.

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

For the built-in migration provider it runs shadow migration verification with strict inference, followed by the read-only offline artifact check. For pgschema it checks the configured provider, fails when the desired schema produces an unapplied plan, performs live `prepare --verify --strict-inference`, and then verifies committed artifacts offline. If a committed schema snapshot exists, both flows also run `schema check`. `--json` returns a versioned per-step report suitable for CI systems.

Commit the generated `sqlx-js-env.d.ts` and the `.sqlx-js/` cache directory to your repo. In CI:

```yaml
- run: bun install
- run: sqlx-js migrate verify --strict-inference # built-in migration workflow
# or, when schema.provider is "pgschema":
- run: sqlx-js db install
- run: sqlx-js db plan -- --output-json plan.json
- run: sqlx-js prepare --verify --strict-inference # live/shadow comparison with complete inference
- run: sqlx-js prepare --check   # read-only offline cache/declaration consistency
- run: sqlx-js doctor --json     # runtime/config/DB/cache/tsconfig preflight
- run: sqlx-js schema check      # fails if the committed schema snapshot is stale
- run: tsc --noEmit               # fails if types are stale
- run: bun test --timeout 120000
- run: bun run build              # emits publishable JS + declarations under dist/
```

The `migrate verify` step needs `DATABASE_URL` credentials that can either create a temporary database or use `--shadow-admin-url` / `--shadow-url`. It does not write `.sqlx-js/` or `sqlx-js-env.d.ts`. For pgschema projects, `sqlx-js db plan` checks the desired `schema.sql` against the target database and leaves application query typing to `prepare`. `prepare --check` is read-only and fails when either the committed cache or declaration is stale. Use `prepare --offline` when a developer intentionally needs to restore the declaration from a valid committed cache. Add `prepare --verify` when CI has a canonical database/shadow schema and must prove byte-for-byte artifact freshness. `schema check` intentionally uses a live database because it verifies the committed schema contract against PostgreSQL.

The managed pgschema binary is installed under `node_modules/.cache/sqlx-js/pgschema/`, not `.sqlx-js/`, so it is not part of the committed offline cache.

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
- `SELECT *` falls back to conservative nullability.
- Plain `sql(...)` keeps returning rows, so statements without `RETURNING` produce an empty typed array. Use `sql.execute(...)` when affected-row count and command metadata matter.
- Nested CTE references (CTE-`b` referencing CTE-`a` in the same `WITH`) and `WITH RECURSIVE` are not analysed transitively — at worst this produces extra `T | null`. Use `AS "id!"` overrides if needed.
- Column names whose **real** name (not an alias) ends with `!` or `?` are not supported — the runtime strips those suffixes assuming an override. Use `AS "alias"` if you have such a column.
- Result columns must have unique names because Postgres.js returns object rows. Alias join projections such as `users.id AS user_id, posts.id AS post_id`; `prepare` rejects duplicate output names before generating declarations.
- Migrations run inside `BEGIN/COMMIT`. DDL that disallows transactions (`CREATE INDEX CONCURRENTLY`, `VACUUM`, `REINDEX CONCURRENTLY`, …) will fail; split such operations into separate migrations executed outside the runner.
- The **internal** wire client (used by `migrate run`, `prepare`, and the runtime `migrate()` helper) reads `sslmode`, `sslrootcert`/`sslcert`/`sslkey`, `application_name`, `options`, `connect_timeout`, and `statement_timeout` from `DATABASE_URL`. The default runtime `sql()` path delegates connection handling to Postgres.js; configure TLS, pooling, and timeouts through the `DATABASE_URL` and `createClient(...)` options it understands (`statementTimeoutMs` is a convenience that maps to a per-connection `statement_timeout`).
- `connect_timeout` bounds the entire internal-client connect, including the TLS handshake and SCRAM authentication.
- Runtime `sql.file(path)` resolves against `fileRoot` while prepare resolves against `--root`. They are both root-relative, but applications started outside the project root must set `fileRoot` explicitly.

See [ROADMAP.md](./ROADMAP.md) for what's planned.

## Upgrading

### Cache, codegen, and parameter contract changes (pre-1.0)

Generated cache now includes `.sqlx-js/cache-manifest.json` with an explicit cache format, generator revision, and hash of `jsonbTypes` / `customTypes`. Cache without this manifest is rejected. Delete `.sqlx-js/` and re-run `sqlx-js prepare` against your database — there is no data loss because the cache is generated.

Generated JSON and PostgreSQL array parameters now require `sql.json(...)` and `sql.array(...)`. This removes the ambiguous runtime guess where a JavaScript array could mean either a PostgreSQL array or a JSON array. Replace raw array JSON params with `sql.json(value)` and PostgreSQL arrays with `sql.array(value)` before regenerating declarations.

CI (`prepare --check`) will also fail loudly until the cache is regenerated; this is intentional so a stale schema can't silently emit incorrect `.d.ts`.

Generator revision 4 changes the declaration layout so it exports `SqlxJsGeneratedRegistry` for scoped clients while continuing to augment the global `KnownQueries` convenience API. Re-run live `sqlx-js prepare` after upgrading. `prepare --check` is now strictly read-only; use `prepare --offline` when deliberate cache-to-declaration regeneration is required.

Runtime observers and SQL-file caching are also stricter production boundaries. An exception from `onQuery` no longer replaces a successful query result; handle it through `onQueryHookError`. `sql.file()` no longer performs an mtime check on every call—use `reloadSqlFiles: true` during development or call `clearSqlFileCache()` explicitly after changing a file.

## License

MIT.
