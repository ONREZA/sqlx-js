# Getting started

Install sqlx-js, choose a schema workflow, connect PostgreSQL, and generate the first typed query contract.

## Install

```bash
npm install @onreza/sqlx-js temporal-polyfill
npm install --save-dev "typescript@>=6 <7"
# or
bun add @onreza/sqlx-js temporal-polyfill
bun add --dev "typescript@>=6 <7"
```

The adaptive fallback is optional when every target runtime exposes native
Temporal. The `temporal-polyfill` root import uses native Temporal when present
and otherwise supplies the polyfill without mutating `globalThis`. Fallback
projects should use an explicit base such as `lib: ["ES2025"]`. Native
TypeScript projects can add `ESNext.Temporal` to that list. The default
`sqlx-js init` scaffold uses the polyfill fallback. Pass
`--temporal-provider native` to generate a native-only `db.ts` with a targeted
Temporal lib reference that preserves the project's implicit libraries.

Node.js 24, Bun 1.3, or Deno 2.9 and PostgreSQL 16 or newer are required. The
package ships ESM only, targets ES2025, and does not support CommonJS consumers.
TypeScript 6.x is an optional peer so production-only installs do not pull the
compiler into the application image; source scanning commands (`prepare`,
`queries`, `doctor`, `ci`, `dev`, and `verify`) require it in development
dependencies.

The package installs `sqlx-js` and `sqlx-js-diagnostics` binaries. Examples
below use the local `sqlx-js` binary; invoke it through a package script,
`npx @onreza/sqlx-js ...`, or `bunx @onreza/sqlx-js ...`.

## Setup

### 1. Choose the schema owner

sqlx-js supports two complete schema workflows. Pick one source of truth:

| Schema owner | Scaffold | Daily development | PR verification | Target deployment |
| --- | --- | --- | --- | --- |
| Built-in linear migrations | `sqlx-js init` | `sqlx-js dev` | `sqlx-js verify` | `sqlx-js migrate run` |
| Declarative pgschema | `sqlx-js init --schema-provider pgschema` | `sqlx-js dev` | `sqlx-js verify` | `sqlx-js pgschema plan/apply` |

The schema and Temporal choices are independent, so they can be combined, for
example `sqlx-js init --schema-provider pgschema --temporal-provider native`.

`dev` and `verify` read `sqlx-js.config.*` and dispatch to the configured
provider. Both build the proposed schema in a disposable shadow database, so
they do not apply DDL to the target database. `dev` regenerates committed query
artifacts; `verify` compares fresh artifacts without writing.

`init` creates `sqlx-js.config.ts`, `sqlx-js-env.d.ts`, a user-owned `db.ts`,
an initial `.sqlx-js/runtime-descriptors.json`, `.env.example`, generated-file
rules in `.gitattributes`, and either
`migrations/` or `schema.sql`. For strict JSON it also adds the
provider-independent `sqlx:dev`, `sqlx:verify`, `sqlx:check`, and `sqlx:ci`
scripts to `package.json` and includes the declaration and client files in `tsconfig.json`.
Existing values are never replaced.

### 2. Configure PostgreSQL

```bash
# .env
DATABASE_URL=postgres://user:password@localhost:5432/your_db
# Managed PostgreSQL with TLS:
# DATABASE_URL=postgres://user:password@db.example.com:5432/your_db?sslmode=require
```

CLI commands load `<root>/.env`; variables already present in the process
environment take precedence over the file. Within the database connection,
non-empty URL values take precedence over supported `PG*` environment
fallbacks. Supported `sslmode` values are `disable`, `prefer`, `require`,
`verify-ca`, and `verify-full`. Certificate paths, `application_name`,
`options`, `connect_timeout`, and `statement_timeout` can also be supplied in
the URL.

For a TLS connection through an SSH tunnel, keep the certificate identity in
the URL and route TCP separately. The password does not need to be embedded in
either the URL or `PGPASSWORD`:

```bash
export DATABASE_URL='postgresql://app@db.internal/app?sslmode=verify-full'
export PGHOSTADDR=127.0.0.1
export PGPASSFILE=/run/secrets/app.pgpass
sqlx-js prepare
```

The resolver uses `PGHOSTADDR` for TCP and cancellation, while `db.internal`
remains the TLS and password-file matching identity. See
[Unified connection resolution](./connection-resolution.md) for the exact
precedence, supported environment settings, password-file permissions, and
provider boundaries.

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

`doctor` is a full-project diagnostic rather than an install-only probe. It
checks generated artifacts and the target database as well as the configured
provider, so before the first `dev` or target deployment it may correctly
report incomplete state.

### 4. Write queries

```ts
import { db } from "./db.js";

const users = await db.sql(
  `SELECT id, name FROM users WHERE id = $1`,
  1n,
);
```

For queries with several values, named parameters keep SQL and arguments
aligned:

```ts
const rows = await db.sql(
  `SELECT id, name
   FROM users
   WHERE email = $email OR recovery_email = $email
   LIMIT $limit::int`,
  { email: "user@example.com", limit: 10 },
);
```

Named parameters use ASCII identifier names, are numbered by first appearance,
and reuse repeated names. Named and positional parameters cannot be mixed.
`__proto__` is reserved because JavaScript object literals do not create it as
an own data property; choose a domain-specific parameter name instead.
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

The generated registry makes descriptor and Temporal-provider ownership
explicit. The scaffold exports a provider-bound `SqlxJsRegistry`; a scoped
`createSqlClient<SqlxJsRegistry>(...)` must receive the exact `temporalApi` and
`queryDescriptors`, or opt out of descriptors deliberately with
`execution: "adaptive"`.
There is no runtime artifact discovery.

[Documentation index](./README.md)
