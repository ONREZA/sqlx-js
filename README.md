# sqlx-js

Compile-time-checked raw SQL for TypeScript + PostgreSQL. Inspired by Rust's [sqlx](https://github.com/launchbadge/sqlx).

You write plain SQL strings. A `prepare` step validates them against your database via the PostgreSQL wire protocol and generates a TypeScript declaration file. Wrong column names and stale queries fail during `prepare`; mismatched parameter types and row usage become TypeScript errors.

The runtime uses [Postgres.js](https://github.com/porsager/postgres) through a single adapter instead of a Bun-specific client. The published CLI is a **Node ≥ 18** binary (`#!/usr/bin/env node`) and can also be run through Bun's npm tooling.

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
- **Array params** for `text[]`, `int[]`, etc. are auto-serialised to PostgreSQL array literals (`{a,b,c}`) at runtime — no more `string_to_array` workaround.
- **Typed transactions** via `sql.transaction(async tx => …)` — the `tx` callback parameter is recognized by the scanner, so queries inside the block keep full type checking.
- **Sourcemap-accurate error reporting**: every prepare failure points to `file:line:column` of the originating `sql(...)` call site, with PG error code, position, and hint.
- **Linear migrations** with hash tampering detection.
- **Migration squash baselines** via `migrate squash`: generate a schema-only baseline from a shadow database, then hash-adopt it on already-migrated databases.
- **Runtime `migrate()`** with PostgreSQL advisory lock, safe for multi-replica startup.
- **Offline cache** committed to your repo. CI verifies via `prepare --check` without a database.
- **Schema snapshot + LLM manifest** via `schema dump` / `schema check`: tables, columns, constraints, indexes, types, and function/procedure metadata are introspected from PostgreSQL.
- **Shadow database validation** via `migrate dev` / `migrate verify`: auto-create a disposable shadow DB, apply migrations, validate SQL, and drop it afterwards.
- **Safe identifier quoting** via `sql.id(...)`, backed by the committed schema snapshot whitelist.
- **Single runtime adapter**: Postgres.js backs the runtime on Node/Bun-compatible environments — no Bun.SQL-specific adapter to choose.
- **Watch mode**: debounced re-prepare with a warm `PgClient` + `SchemaCache` on `.ts` / `.tsx` / `.mts` / `.cts` / `.sql` changes.
- **Cache pruning** removes orphaned entries automatically (toggleable with `--no-prune`).

## Install

```bash
npm install @onreza/sqlx-js
# or
bun add @onreza/sqlx-js
```

The package installs a `sqlx-js` binary. The CLI examples below use `npx @onreza/sqlx-js`; `bunx @onreza/sqlx-js ...` works the same if your project uses Bun.

## Setup

### 0. Scaffold a project (optional)

```bash
npx @onreza/sqlx-js init
```

Creates `sqlx-js.config.ts`, a `migrations/` directory, and `.env.example` if they don't already exist (it never overwrites existing files), then prints the next steps. Skip it if you prefer to wire things up manually.

### 1. Configure the database URL

```bash
# .env
DATABASE_URL=postgres://user:password@localhost:5432/your_db
# Or with TLS against managed Postgres:
# DATABASE_URL=postgres://user:password@db.example.com:5432/your_db?sslmode=require
```

Supported `sslmode` values: `disable`, `prefer` (default — try TLS, fall back to plaintext), `require` (TLS or fail), `verify-ca`, `verify-full`. For a private/self-signed CA, point `sslrootcert` (and optionally `sslcert` / `sslkey` for client certs) at PEM files: `?sslmode=verify-full&sslrootcert=/etc/ssl/ca.pem`. `application_name`, `connect_timeout` (seconds), and `statement_timeout` (milliseconds) are also honored when provided as URL parameters.

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

This generates `sqlx-js-env.d.ts` next to your code. Add it to your `tsconfig.json` `include` if it isn't picked up automatically. Use `--dts <path>` to override the destination.

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

Load SQL from an external file. At prepare time the scanner reads the path relative to the source file. The generated `KnownFileQueries` key is the resolved SQL file path relative to `--root`; at runtime `sql.file(...)` reads the string argument relative to `process.cwd()`.

```ts
// queries/top_admins.sql
// SELECT id AS "id!", name AS "name!" FROM users WHERE role = $1 ORDER BY id LIMIT $2::int

import { sql } from "@onreza/sqlx-js";

const admins = await sql.file("queries/top_admins.sql", "admin", 5);
//                                                       ^ string  ^ number
// admins: { id: bigint; name: string }[]
```

File-backed queries are emitted into a separate `KnownFileQueries` interface. Because the type key is the root-relative resolved SQL file path, keep file-backed call sites under a convention where that key matches the runtime string literal; the example keeps those call sites at the project root. Nested source-relative file paths are a current limitation.

### `sql.one(query, ...params)` and `sql.optional(query, ...params)`

Convenience wrappers for single-row queries. `one` throws if the row count is not exactly 1; `optional` returns `null` for 0 rows and throws on more than 1. They keep working under `noUncheckedIndexedAccess: true` without `rows[0]!` patterns.

```ts
const user = await sql.one(`SELECT id, name FROM users WHERE id = $1`, 1n);
// user: { id: bigint; name: string }

const maybe = await sql.optional(`SELECT id FROM users WHERE email = $1`, "x@y");
// maybe: { id: bigint } | null
```

Both forms also exist on `sql.file` (`sql.file.one("queries/by_id.sql", ...)`) and inside transactions (`tx.one(...)`, `tx.optional(...)`, `tx.file.one(...)`, `tx.file.optional(...)`). The scanner recognizes every chain — these call sites are added to `KnownQueries` / `KnownFileQueries` just like a plain `sql(...)`.

### Array parameters

JavaScript arrays passed to `text[]`, `int[]`, `uuid[]`, etc. are auto-encoded as PostgreSQL array literals before being sent. Strings containing commas, braces, quotes, or backslashes are escaped; `null` elements emit SQL `NULL`.

```ts
await sql("SELECT $1::text[] AS tags", ["alpha", "beta,gamma", "with \"quote\""]);
// → $1 sent as {alpha,"beta,gamma","with \"quote\""}
```

Encoding only kicks in when every element is a primitive (`string` / `number` / `bigint` / `boolean` / `null`). Arrays containing objects pass through unchanged — that's the path for `jsonb` columns whose value is a JSON array (`attachments: SqlxJsJson.Attachment[]`). If you need to store a primitive JS array as `jsonb` (rare), pass `JSON.stringify(arr)` explicitly. `encodePgArrayLiteral(arr)` is exported if you need the literal yourself for `unsafe(...)`.

Empty arrays (`[]`) are passed straight through to the active driver. If you need the literal `"{}"` instead (e.g. when concatenating into raw SQL), call `encodePgArrayLiteral([])`.

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

`createClient(url, options)` accepts every Postgres.js option plus two sqlx-js extras for observability and reliability:

```ts
setClient(createClient(process.env.DATABASE_URL, {
  // Server-side per-connection statement timeout (ms). Also settable via
  // ?statement_timeout=5000 in DATABASE_URL.
  statementTimeoutMs: 5000,
  // Fires after every query/transaction statement, success or failure.
  onQuery: ({ query, params, durationMs, rowCount, error }) => {
    if (error) logger.error({ query, error });        // database errors are PgError
    else if (durationMs > 200) logger.warn({ slow: query, durationMs, rowCount });
  },
}));
```

The `onQuery` hook is the integration point for metrics, tracing, and slow-query logging — sqlx-js does not log queries itself. The event carries the raw `params`, which may contain personal or sensitive data — don't log them blindly; redact or omit `params` in shared sinks. Database errors are normalized to `PgError`; transport and non-database errors pass through unchanged.

### `clearSqlFileCache()`

Drops the in-memory cache used by `sql.file(...)`. The cache invalidates automatically on file mtime change, so this is rarely needed manually.

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
sqlx-js init [--root <dir>]
sqlx-js prepare [--check | --watch] [--root <dir>] [--dts <path>] [--no-prune] [--shadow-url <url>]
sqlx-js migrate dev [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] | verify [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] | run [--dry-run] [--json] [--lock-timeout <ms>] | info [--json] | check [--json] | revert [--dry-run] [--json] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] | add <name> | squash <name> [--shadow-admin-url <url> | --shadow-url <url>] [--replace] [--pg-dump <path>] [--lock-timeout <ms>] | archive list | archive restore <name> [--force]
sqlx-js schema dump | check [--schema <path>] [--manifest <path>] [--no-manifest] [--shadow-url <url>]
sqlx-js --version | --help
```

Regular `prepare` describes queries across a small connection pool (default 8, override with `SQLX_JS_PREPARE_CONCURRENCY`) for faster cold runs on large projects. Watch mode keeps one session warm and reuses it between debounced changes.

| Flag                  | Meaning                                                                              |
|-----------------------|--------------------------------------------------------------------------------------|
| `--check`             | Offline: verify every scanned query is present in cache, no database required.       |
| `--watch`             | Persistent connection, re-prepare on file change.                                    |
| `--root <dir>`        | Source/cache/migrations root (default: cwd).                                         |
| `--dts <path>`        | Declarations output (default: `<root>/sqlx-js-env.d.ts`).                           |
| `--no-prune`          | Keep orphaned cache entries instead of removing them.                                |
| `--migrations <dir>`  | Migrations directory (default: `<root>/migrations`).                                 |
| `--dry-run`           | For `migrate run` / `migrate revert`: validate without applying to the target DB.   |
| `--json`              | Machine-readable output for `migrate info/check` and migration dry-runs.            |
| `--force`             | For `migrate archive restore`: allow overwriting existing migration files.           |
| `--lock-timeout <ms>` | Advisory-lock acquisition timeout for `migrate run` / `revert` / `dev` / `verify` / `squash`. |
| `--shadow-url <url>`  | Use an existing disposable shadow DB instead of auto-creating one.                   |
| `--shadow-admin-url <url>` | Admin/maintenance DB URL used to auto-create shadow DBs.                       |
| `--replace`           | For `migrate squash`: archive replaced migration files after writing the baseline.   |
| `--pg-dump <path>`    | For `migrate squash`: `pg_dump` executable path (default: `pg_dump`).                |
| `--schema <path>`     | Schema snapshot path (default: `<root>/.sqlx-js/schema/schema.json`).               |
| `--manifest <path>`   | LLM schema manifest path (default: `<root>/.sqlx-js/schema/schema.md`).             |
| `--no-manifest`       | Skip writing the LLM schema manifest during `schema dump`.                           |

Flags that take a value accept both `--flag value` and `--flag=value` forms.

`DATABASE_URL` must be set for any command that touches the application database or auto-creates a shadow database. `SHADOW_ADMIN_DATABASE_URL` can point at a maintenance/admin database when the application user cannot `CREATE DATABASE`; `SHADOW_DATABASE_URL` can point at a pre-created disposable shadow database. The internal wire client understands `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `application_name`, `connect_timeout` (seconds), and `statement_timeout` (milliseconds).

### Development and deployment flows

Use `migrate dev` while developing migrations and SQL:

```bash
sqlx-js migrate add add_users
# edit migrations/000N_add_users.up.sql and .down.sql
sqlx-js migrate dev
```

`migrate dev` creates a disposable shadow database, applies all migrations from scratch, validates that the latest migration's `.down.sql` restores the previous schema (squash baselines may omit `.down.sql`), prepares project SQL against the shadow schema, writes `.sqlx-js/` plus `sqlx-js-env.d.ts`, and drops the shadow database. This means you can keep editing a local WIP migration before it is merged. You do not need to drop your application database or create a new migration for every local edit.

Use `migrate verify` in PR/CI before merge:

```bash
sqlx-js migrate verify
sqlx-js prepare --check
tsc --noEmit
```

`migrate verify` runs the same shadow-database migration/down/SQL validation as `migrate dev`, but writes prepare output to temporary files instead of modifying `.sqlx-js/` or `sqlx-js-env.d.ts`.

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

## Configuration

`sqlx-js.config.ts` at the project root is optional.

```ts
import type { SqlxJsConfig } from "@onreza/sqlx-js";

const config: SqlxJsConfig = {
  jsonbTypes: {
    "users.settings":     "SqlxJsJson.UserSettings",
    "posts.meta":         "SqlxJsJson.PostMeta",
    "posts.attachments":  "SqlxJsJson.Attachment",
  },
};

export default config;
```

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

After re-running `prepare`, every `jsonb` column or parameter declared in `jsonbTypes` is checked against the corresponding TypeScript type. Columns without a custom mapping use `JsonValue` for result rows and `JsonInput` for parameters, both exported by `@onreza/sqlx-js`, so non-JSON inputs such as `Date`, functions, and `bigint` are rejected by TypeScript while plain JSON objects, arrays, strings, numbers, booleans, and nested JSON `null` values are accepted. Top-level SQL `null` is added separately as `| null` only when the mapped database parameter is nullable.

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
import type { SqlxJsConfig } from "@onreza/sqlx-js";

const config: SqlxJsConfig = {
  customTypes: {
    vector: "Float32Array",         // override pgvector default
    geometry: "GeoJSON.Geometry",   // postgis (not built-in by design)
    myapp_color: "`#${string}`",    // your own CREATE TYPE base/domain
  },
};
export default config;
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

Commit the generated `sqlx-js-env.d.ts` and the `.sqlx-js/` cache directory to your repo. In CI:

```yaml
- run: bun install
- run: sqlx-js migrate verify    # builds schema from migrations in a disposable shadow DB
- run: sqlx-js prepare --check   # fails if any query is missing from the committed cache
- run: sqlx-js schema check      # fails if the committed schema snapshot is stale
- run: tsc --noEmit               # fails if types are stale
- run: bun test
- run: bun run build              # emits publishable JS + declarations under dist/
```

The `migrate verify` step needs `DATABASE_URL` credentials that can either create a temporary database or use `--shadow-admin-url` / `--shadow-url`. It does not write `.sqlx-js/` or `sqlx-js-env.d.ts`. The `prepare --check` step then runs without a database; your committed offline cache is the source of truth. `schema check` intentionally uses a live database because it verifies the committed schema contract against PostgreSQL.

## Contributing

The project uses [conventional commits](https://www.conventionalcommits.org/), validated locally by `cocogitto` through `lefthook` hooks. Install both before contributing:

```bash
bun install                  # installs lefthook + wires git hooks
cargo install cocogitto      # or: brew install cocogitto
```

Releases are automated via `release-please`: pushes to `main` accumulate into a release PR that bumps `package.json`, writes `CHANGELOG.md`, and on merge tags the commit. The tag push fires the npm publish workflow, which builds `dist/`, smoke-tests the package entrypoints, checks the tarball contents, and publishes to npm.

## Limitations

`sqlx-js` is a young library. Known gaps:

- PostgreSQL only (no MySQL or SQLite).
- The scanner only follows direct named imports and namespace imports from `@onreza/sqlx-js`; it does not follow re-exports, dynamic aliases, or tagged-template calls.
- `INSERT INTO t VALUES (...)` without an explicit column list isn't parameter-mapped.
- `SELECT *` falls back to conservative nullability.
- Statements without a row description, such as `UPDATE ...` without `RETURNING`, are emitted with `row: never`, so the public return type is `Promise<never[]>`.
- Nested CTE references (CTE-`b` referencing CTE-`a` in the same `WITH`) and `WITH RECURSIVE` are not analysed transitively — at worst this produces extra `T | null`. Use `AS "id!"` overrides if needed.
- Column names whose **real** name (not an alias) ends with `!` or `?` are not supported — the runtime strips those suffixes assuming an override. Use `AS "alias"` if you have such a column.
- Migrations run inside `BEGIN/COMMIT`. DDL that disallows transactions (`CREATE INDEX CONCURRENTLY`, `VACUUM`, `REINDEX CONCURRENTLY`, …) will fail; split such operations into separate migrations executed outside the runner.
- The **internal** wire client (used by `migrate run`, `prepare`, and the runtime `migrate()` helper) reads `sslmode`, `sslrootcert`/`sslcert`/`sslkey`, `application_name`, `connect_timeout`, and `statement_timeout` from `DATABASE_URL`. The default runtime `sql()` path delegates connection handling to Postgres.js; configure TLS, pooling, and timeouts through the `DATABASE_URL` and `createClient(...)` options it understands (`statementTimeoutMs` is a convenience that maps to a per-connection `statement_timeout`).
- `connect_timeout` bounds the entire internal-client connect, including the TLS handshake and SCRAM authentication.
- `sql.file(path)` has a path-key mismatch to be aware of: prepare resolves the file relative to the source file, codegen keys it by root-relative resolved path, and runtime reads the literal path relative to `process.cwd()`. Keep a project convention and verify with `tsc` after `prepare`.

See [ROADMAP.md](./ROADMAP.md) for what's planned.

## Upgrading

### Cache schema change (pre-1.0)

The `.sqlx-js/<fingerprint>.json` entries dropped `forceNonNull`/`forceNullable` in favour of a single `override?: "non-null" | "nullable"` field. Cache files from the previous schema are rejected with a clear error pointing at the offending file. Delete `.sqlx-js/` and re-run `sqlx-js prepare` against your database — there's no data loss, the cache is regenerated.

CI (`prepare --check`) will also fail loudly until the cache is regenerated; this is intentional so a stale schema can't silently emit incorrect `.d.ts`.

## License

MIT.
