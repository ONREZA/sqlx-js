# sqlx-js

Compile-time-checked raw SQL for TypeScript and PostgreSQL, inspired by
Rust's [sqlx](https://github.com/launchbadge/sqlx).

[![CI](https://github.com/ONREZA/sqlx-js/actions/workflows/ci.yml/badge.svg)](https://github.com/ONREZA/sqlx-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@onreza/sqlx-js.svg)](https://www.npmjs.com/package/@onreza/sqlx-js)
[![license](https://img.shields.io/npm/l/@onreza/sqlx-js.svg)](./LICENSE)

Write ordinary SQL strings. A `prepare` step validates them against PostgreSQL
and generates TypeScript declarations. Invalid SQL and schema drift fail before
deployment; parameter and row types are checked by TypeScript.

> Strict at prepare. Fast and safe at runtime.

```ts
import { db } from "./db.js";

const users = await db.sql(
  `SELECT id, name, role FROM users WHERE id = $id`,
  { id: 1n },
);

// users: Array<{
//   id: bigint;
//   name: string;
//   role: "admin" | "editor" | "viewer";
// }>
```

sqlx-js is PostgreSQL-only, ESM-only, and runs on Node.js, Bun, and Deno. The
CLI, migrations, prepare pipeline, and application runtime share an integrated
PostgreSQL wire implementation.

## Why sqlx-js?

- Keep SQL visible and owned by the application.
- Catch invalid columns, stale queries, and incompatible parameters before
  runtime.
- Infer precise row types, PostgreSQL enums, joins, expressions, and
  nullability without an ORM schema.
- Commit generated artifacts so ordinary type-checks and CI can run offline.
- Use one narrow PostgreSQL runtime with managed deadlines, recovery, codecs,
  transactions, and role-aware pools.

sqlx-js does not parse SQL at application runtime, validate result objects at
runtime, generate an ORM layer, or support MySQL and SQLite.

## Features

| Area | What is included | Details |
| --- | --- | --- |
| Typed queries | Positional and named parameters, request-scoped query options, reusable `defineQuery`, external SQL files, one/optional/execute cardinality helpers | [Query API](./docs/query-api.md) |
| Inference | PostgreSQL metadata, joins, CTEs, set operations, DML targets, expression nullability, WHERE narrowing, enums, arrays, JSON | [Type and nullability inference](./docs/type-inference.md) |
| Runtime | Descriptor-backed managed clients, transactions and savepoints, deadlines, TCP keepalive, lifecycle recovery, observers, migrations, custom codecs | [Runtime and clients](./docs/runtime.md) |
| Roles and RLS | Profile-scoped query registries, planning under the effective role, required transaction-local settings, RLS diagnostics | [Connection profiles and RLS](./docs/profiles-and-rls.md) |
| Schema workflows | Built-in linear migrations or declarative pgschema, disposable shadow databases, snapshots, squash baselines | [CLI and workflows](./docs/cli.md) |
| Reproducible artifacts | Versioned offline cache, `prepare --check`, live `prepare --verify`, generated declarations, enum and function catalogs | [CI and deployment checks](./docs/ci.md) |
| PostgreSQL types | Built-ins, arrays, ranges, domains, composites, pgvector, hstore, citext, ltree, application codecs | [Configuration and custom types](./docs/configuration.md) |
| Extended JSON | Branded immutable documents, exact native numbers, bigint/Temporal round-trips, reader-first collision audit | [Extended JSON protocol](./docs/extended-json-protocol.md) |
| Tooling | Incremental watch mode, project doctor, JSON diagnostics, query inventory, advisory reuse/similarity audits, Extended JSON audit, embedded SQL generation | [Query reuse and similarity audits](./docs/query-audits.md) |
| Agent workflows | Installable skills for CLI, schema, queries, inference, runtime, RLS, types, upgrades, and releases | [Agent skills](./docs/agent-skills.md) |

See the [documentation index](./docs/README.md) for the complete guide set.

## Requirements

- PostgreSQL 16 or newer
- Node.js 24 or newer, Bun 1.3 or newer, or Deno 2.9 or newer
- TypeScript 6.x for source-scanning commands
- ES2025 or newer runtime semantics
- Optional `temporal-polyfill` 1.x adaptive fallback when native Temporal is unavailable

The package is ESM-only. TypeScript and the Temporal polyfill are optional peer
dependencies, so native production runtimes do not install either one merely
for sqlx-js. The application owns the provider and sqlx-js never mutates
`globalThis`.

## Quick start

Install the package and TypeScript:

```bash
npm install @onreza/sqlx-js temporal-polyfill
npm install --save-dev "typescript@>=6 <7"

# or
bun add @onreza/sqlx-js temporal-polyfill
bun add --dev "typescript@>=6 <7"
```

Omit `temporal-polyfill` when every target runtime exposes native Temporal. Its
root import uses native Temporal when available and falls back without mutating
`globalThis`. `sqlx-js init` scaffolds that adaptive fallback by default.
Native-only projects pass `--temporal-provider native`; the generated `db.ts`
references `ESNext.Temporal` directly without narrowing the project's implicit
TypeScript libraries.

Scaffold a project using built-in migrations:

```bash
sqlx-js init
sqlx-js migrate add init
```

For a native-only Temporal runtime, initialize with
`sqlx-js init --temporal-provider native` instead.

Add a PostgreSQL connection:

```dotenv
DATABASE_URL=postgres://user:password@localhost:5432/app
```

Define the schema in the generated migration, then build the development
database and query artifacts:

```bash
sqlx-js dev --strict-inference
```

Write a literal query and run `dev` again whenever the schema or queries
change:

```ts
import { db } from "./db.js";

const user = await db.sql.optional(
  `SELECT id, email FROM users WHERE email = $email`,
  { email: "alice@example.com" },
);
```

Before merge:

```bash
sqlx-js verify --strict-inference
tsc --noEmit
```

For installation details, TLS, pgschema, shadow database options, and the
query-only workflow, read [Getting started](./docs/getting-started.md).

## How it works

The generated contract is derived from PostgreSQL rather than from a second
application schema:

```text
TypeScript source
  -> scan literal query sites
  -> PostgreSQL Parse + Describe + generic plan
  -> schema and AST inference
  -> versioned cache + runtime descriptor + sqlx-js-env.d.ts
  -> TypeScript checks application calls
```

`prepare` never executes application queries. Supported statements are planned
with a parameter-independent generic plan; statements outside PostgreSQL's
server-side `PREPARE` surface remain parse-only. Runtime calls use the exact SQL
literal as the generated registry key.

The generated cache, `.sqlx-js/runtime-descriptors.json`, and declarations are intended to be committed. This keeps
editor type-checking and `prepare --check` database-free while
`prepare --verify` can compare them with a live database without modifying the
worktree.

## Choose a schema workflow

Both workflows use the same query preparation and runtime:

| Schema owner | Scaffold | Development | PR verification | Deployment |
| --- | --- | --- | --- | --- |
| Built-in linear migrations | `sqlx-js init` | `sqlx-js dev` | `sqlx-js verify` | `sqlx-js migrate run` |
| Declarative pgschema | `sqlx-js init --schema-provider pgschema` | `sqlx-js dev` | `sqlx-js verify` | `sqlx-js pgschema plan/apply` |

`dev` and `verify` build the proposed schema in a disposable shadow database.
They do not apply DDL to the target database. Deployment remains an explicit,
provider-specific step.

## Runtime boundary

`createSqlClient(...)` is the managed application client. It owns pool
generations, end-to-end operation deadlines, runtime type discovery, poisoned
generation replacement, lifecycle state, and bounded shutdown. Dispatched SQL
is never replayed after a connection loss because its outcome may be unknown.
`init` creates a user-owned `db.ts` that binds the generated registry and
runtime descriptor explicitly. This scoped client is the only typed managed
query surface; generated declarations never augment process-global types.

PostgreSQL temporal values never cross this boundary as JavaScript `Date`.
`date`, `time`, `timestamp`, and `timestamptz` map to
`Temporal.PlainDate`, `Temporal.PlainTime`, `Temporal.PlainDateTime`, and
`Temporal.Instant`. Pass the application-owned provider once at client
construction; `init` scaffolds this explicitly:

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import { Temporal } from "temporal-polyfill";
import type { SqlxJsGeneratedRegistry as GeneratedRegistry } from "./sqlx-js-env.js";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };

type SqlxJsRegistry = GeneratedRegistry<typeof Temporal>;

const db = createSqlClient<SqlxJsRegistry>(databaseUrl, {
  queryDescriptors,
  temporalApi: Temporal,
});
```

For native Temporal, bind the same generated registry to `typeof Temporal` and
pass the global `Temporal` object as `temporalApi`. Requiring the object keeps
runtime constructor identity aligned with the generated provider types. The SQL
parameter and row types then use that provider's exact `Temporal.*` instances.
PostgreSQL sessions are pinned to UTC; infinity, `time` 24:00, and
sub-microsecond inputs are rejected; and the codec preserves microseconds
returned by PostgreSQL. Attempts to change
`TimeZone` away from UTC or `DateStyle` away from ISO fail closed and discard
the affected connection.

PostgreSQL `json` and `jsonb` values cross the runtime boundary only as
`SqlxJson<T>` documents created by `sql.json(...)`. The document owns a deeply
frozen snapshot and protocol version. Nested `bigint` and supported Temporal
values round-trip automatically; `JsonNumber` preserves exact native JSON
numeric tokens without changing their JSONB operator/index shape. Existing
untagged JSON remains readable. Run `sqlx-js json audit` before enabling tagged
writes in an existing database; see the [Extended JSON protocol](./docs/extended-json-protocol.md).

`createClient(...)` is the lower-level wire client for callers that explicitly
own pool access and lifecycle. The two APIs are separate reliability
boundaries; see [Runtime and clients](./docs/runtime.md) and the
[Postgres.js compatibility matrix](./docs/postgres-js-feature-matrix.md).

## Benchmarks

The repository includes a reproducible runtime benchmark rather than a fixed
machine-independent performance claim:

```bash
bun run benchmark:postgres
```

By default it starts an isolated PostgreSQL container and compares the managed
client, raw client, and Postgres.js with prepared statements disabled. It
measures sequential and concurrent scalar queries, a pipelined comparison,
100-row scalar and mixed-payload results, and two-statement transactions. Each
run prints throughput plus p50, p95, and p99 latency and ends with
machine-readable JSON.

Results depend on CPU, operating system, PostgreSQL, container networking, and
benchmark duration. Use them to detect regressions on controlled hardware, not
as a universal driver ranking. The methodology, environment variables, and
interpretation rules are documented in [Benchmarks](./docs/benchmarks.md).

## Documentation

- [Getting started](./docs/getting-started.md)
- [Query API](./docs/query-api.md)
- [Runtime and clients](./docs/runtime.md)
- [Connection profiles and RLS](./docs/profiles-and-rls.md)
- [CLI and workflows](./docs/cli.md)
- [Configuration and custom types](./docs/configuration.md)
- [Type and nullability inference](./docs/type-inference.md)
- [CI and deployment checks](./docs/ci.md)
- [Benchmarks](./docs/benchmarks.md)
- [Agent skills](./docs/agent-skills.md)
- [Limitations and non-goals](./docs/limitations.md)
- [Upgrade guides](./docs/upgrades/README.md)
- [Roadmap](./ROADMAP.md)

## Project status

sqlx-js is pre-1.0 and used as an evolving PostgreSQL contract tool. Generated
artifacts are versioned; incompatible cache or generator changes fail with
regeneration guidance. Review the [changelog](./CHANGELOG.md), relevant
[upgrade guide](./docs/upgrades/README.md), and
[known limitations](./docs/limitations.md) before upgrading.

The supported baseline and public contracts are tested against PostgreSQL 17
in CI, with package smoke tests under Node.js, Bun, and Deno. PostgreSQL 16 and
newer are supported.

## Contributing and security

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md) for development commands, test scope, and
commit conventions.

Please report vulnerabilities privately according to
[SECURITY.md](./SECURITY.md), not through a public issue.

## License

[MIT](./LICENSE)
