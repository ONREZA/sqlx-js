# AGENTS.md

Operational handbook for any agent (human or AI) working on this repository. Read this once before making changes.

## What this project is

`sqlx-js` is a TypeScript library published as `@onreza/sqlx-js` that ports the developer experience of Rust's `sqlx` to TypeScript + PostgreSQL: you write raw SQL, a `prepare` step validates it against a live database and emits typed declarations. The library has both a CLI (`bin/sqlx-js.ts`) and a runtime (`src/index.ts`).

The library is **PostgreSQL-only** and **compile-time-only by design** — no runtime SQL parsing, no runtime validation, no ORM layer. The default runtime adapter uses Postgres.js; `@onreza/sqlx-js/bun` keeps `Bun.SQL` compatibility as an explicit opt-in adapter.

## Repository layout

```
.
├── bin/
│   └── sqlx-js.ts           CLI entry point (prepare, migrate, watch)
├── src/
│   ├── index.ts              Public Postgres.js-backed package entry (sql, migrate, types)
│   ├── bun.ts                Bun.SQL compatibility entry
│   ├── runtime.ts            Shared runtime core + key renaming + migrate()
│   ├── postgres-runtime.ts   Postgres.js adapter
│   ├── bun-runtime.ts        Bun.SQL adapter
│   ├── cache.ts              .sqlx-js/<fingerprint>.json reader/writer
│   ├── codegen.ts            Emits sqlx-js-env.d.ts from CacheEntry[]
│   ├── config.ts             Loads sqlx-js.config.ts (jsonbTypes map)
│   ├── commands/
│   │   ├── prepare.ts        runPrepare + openSession + prepareOnce
│   │   ├── migrate.ts        CLI migrateRun + shared applyPending
│   │   └── watch.ts          fs.watch loop with debounced re-prepare
│   ├── scan/
│   │   └── scanner.ts        TypeScript AST walk for sql() call sites
│   └── pg/
│       ├── wire.ts           Raw PG wire protocol client (SCRAM-SHA-256)
│       ├── oids.ts           Built-in OID → TS type table
│       ├── schema.ts         pg_class / pg_attribute / pg_type / pg_enum loaders
│       ├── analyze.ts        libpg-query-based nullability inference
│       ├── narrow.ts         WHERE-clause non-null narrowing
│       └── param-map.ts      Maps $N → (table, column) for INSERT/UPDATE/WHERE
├── tests/                    Bun-test unit tests for pure modules
├── example/                  End-to-end fixture project used by CI integration
├── .github/workflows/        CI + npm publish
├── README.md                 User-facing documentation
├── ROADMAP.md                Future work, ordered by ROI
└── package.json
```

## Architectural overview

A `prepare` run executes the following pipeline:

1. **Scan** (`src/scan/scanner.ts`) — TypeScript AST walk over `.ts` / `.tsx` files. Finds every `sql("literal", ...args)` call where `sql` is imported from `@onreza/sqlx-js` or `@onreza/sqlx-js/bun`. Refuses non-literal first arguments.
2. **Describe** (`src/pg/wire.ts`) — for each unique query, sends `Parse` + `Describe Statement` + `Sync` to PostgreSQL. Returns parameter OIDs and `RowDescription` (column name, type OID, source table OID, source column attno).
3. **Schema introspection** (`src/pg/schema.ts`) — batch-loads `pg_class`, `pg_attribute`, `pg_type`, `pg_enum` for everything touched by the queries. Cached per-session.
4. **AST analysis** (`src/pg/analyze.ts`) — parses each query via `libpg-query`, builds a scope of aliases with their join-nullability, walks each target to determine per-column nullability. Calls into `src/pg/narrow.ts` for WHERE-clause forced-non-null tracking.
5. **Param mapping** (`src/pg/param-map.ts`) — maps every `$N` to a `(table, column)` target for INSERT VALUES, UPDATE SET, and WHERE-equality positions.
6. **Type resolution** — combines OID, custom enum/array info, schema's `jsonbTypes` config, and analysis output into the final TS type strings for every column and parameter.
7. **Persistence** — writes `.sqlx-js/<fingerprint>.json` per query and emits `sqlx-js-env.d.ts` with `KnownQueries` / `KnownFileQueries` declarations for `@onreza/sqlx-js` and `@onreza/sqlx-js/bun`.

`prepare --check` skips steps 2–6 and only verifies that every scanned fingerprint is present in the on-disk cache.

`prepare --watch` keeps the `PgClient` + `SchemaCache` warm and re-runs steps 1–7 on every debounced filesystem event.

The runtime (`src/index.ts` + `src/runtime.ts` + adapter files) is a thin layer over `client.unsafe(query, params)`. Root imports use Postgres.js with prepared `unsafe` calls; `@onreza/sqlx-js/bun` uses `Bun.SQL.unsafe`. Strict typing comes from a single overload keyed on `keyof KnownQueries` — TypeScript narrows the first string literal argument to a known query, then resolves `params` and the result row type from the registered entry.

## Common development tasks

### Prerequisites

- Bun ≥ 1.3 for the CLI/test suite and the optional `@onreza/sqlx-js/bun` adapter
- A reachable PostgreSQL 14+ (15+ recommended for full SCRAM-SHA-256 coverage)
- `DATABASE_URL` exported in your shell

### Running tests

```bash
bun test                # unit + integration tests
bunx tsc -p example     # type-check the example fixture
```

The integration suite (`tests/prepare.integration.test.ts`) spins up an
isolated PostgreSQL container via `@testcontainers/postgresql` using the
`pgvector/pgvector:pg17` image (so `vector`, `hstore`, `citext`, `ltree`
are available out of the box). It auto-skips when Docker is unreachable.
Override the image with `SQLX_JS_PG_IMAGE` if needed.

The example fixture in `example/` is a separate end-to-end harness:

```bash
bun bin/sqlx-js.ts migrate run --root example
bun bin/sqlx-js.ts prepare    --root example
bunx tsc -p example
bun run build
```

This is what CI runs.

### Adding a new built-in OID

Edit `src/pg/oids.ts`. Add to `SCALAR` (single types) or `ARRAY` (where the value is the inner type's OID). Cover it with a test in `tests/oids.test.ts`.

### Adding a new expression nullability rule

`src/pg/analyze.ts` → `expressionNullable`. Cases live on `val.<NodeType>` where `NodeType` follows libpg-query's PostgreSQL AST shape (`A_Const`, `FuncCall`, `CoalesceExpr`, `CaseExpr`, etc.). Run `bun -e 'console.log(JSON.stringify((await (await import("libpg-query")).parse("SELECT ...")).stmts[0].stmt.SelectStmt.targetList[0].ResTarget.val, null, 2))'` to dump shapes for unfamiliar nodes.

### Adding a new narrowing predicate

`src/pg/narrow.ts` → the `walk` function. The walker returns a `Set<string>` of `alias|col` keys. Honor AND/OR semantics: union for AND, intersection for OR.

### Adding a new param-mapping case

`src/pg/param-map.ts`. Each statement type has its own walker (`walkInsert`, `walkUpdate`, `walkWhere`). New patterns should call `tryBind(colSide, valSide, defaultRel, map)` to record the mapping.

### Working on the wire protocol

`src/pg/wire.ts` is a from-scratch implementation. Encoding/decoding is straightforward — the only subtle area is SCRAM-SHA-256 authentication, which requires PBKDF2 + HMAC + XOR steps in a fixed order. Don't tweak it unless you have a regression test that hits the auth path against PG 14+.

### Releasing a version

Releases are automated. The flow:

1. **Commit using conventional-commits** (`feat:`, `fix:`, `chore:`, `docs:`, etc.). `lefthook` enforces this locally via `cog verify` on every commit.
2. **Push to `main`.** `release-please.yml` reads conventional commits since the last release and opens (or updates) a release PR titled `chore(main): release X.Y.Z`. The PR contains the `package.json` version bump and the generated `CHANGELOG.md` entry.
3. **Review and merge the release PR.** release-please tags the merge commit `vX.Y.Z`.
4. **Tag push triggers the publish job in `release.yml`**, which type-checks, tests, builds JS + declarations into `dist/`, smoke-tests package entrypoints, verifies version parity, and publishes to npm with provenance using the `NPM_TOKEN` repository secret.

Version bumps follow **Rust-crate-style** pre-1.0 semver. While `version < 1.0.0`:

| Commit type                 | Version impact         |
|-----------------------------|------------------------|
| `feat:`                     | minor (`0.x.y` → `0.(x+1).0`) |
| `fix:`                      | patch (`0.x.y` → `0.x.(y+1)`) |
| `feat!:` / `BREAKING CHANGE:` | minor (**not** major) |

Major (`1.0.0`) is never reached implicitly. To cut a `1.0.0`, add an explicit `Release-As: 1.0.0` trailer to a commit body:

```
feat: stabilize public API

Release-As: 1.0.0
```

The same trailer works at any version to pin a release manually. `release-please-config.json` sets `bump-minor-pre-major: true` and `bump-patch-for-minor-pre-major: false` to encode this policy.

### Local git hooks

`lefthook` is installed as a dev-dependency and wires hooks via the `prepare` lifecycle script on `bun install`. The configuration lives in `lefthook.yml`:

- `pre-commit` → `tsc --noEmit` (parallel, glob-filtered to `*.ts`/`*.tsx`).
- `pre-push` → `bun test tests`.
- `commit-msg` → `cog verify` for conventional-commit compliance.

The `commit-msg` hook degrades gracefully if `cog` isn't installed (prints a hint, allows the commit). To enforce locally, install cocogitto:

```bash
cargo install cocogitto    # or: brew install cocogitto
```

Skipping hooks for a single commit: `LEFTHOOK=0 git commit ...`. Don't make a habit of it.

## Conventions

- **No comments** unless they explain a non-obvious "why". Code should be self-explanatory.
- **No emojis** in source files, commits, or docs.
- **Runtime dependencies are intentional and small.** `libpg-query` powers analysis; Postgres.js is the default runtime adapter. Keep any new dependency out unless it is directly required.
- **Backward compatibility**: the cache schema (`src/cache.ts CacheEntry`) is committed by users. Changes require a bumped major version or a graceful migration.
- **TypeScript strict mode**. No `any` in public API. Internal helpers can use `any` only when walking the libpg-query AST, which is genuinely loose-typed.
- **English everywhere** — source, docs, tests, commit messages.

## Things to be careful about

- Postgres.js returns `int8` as a string by default. The default adapter registers `postgres.BigInt` so types and runtime agree. The Bun adapter explicitly sets `{ bigint: true }`. Don't change either without re-checking every `bigint` site.
- The codegen writes literal SQL strings as keys in `KnownQueries`. Whitespace in the source must match exactly when the query is rewritten — the runtime sees the user's literal, then `KnownQueries` is looked up by that literal. The fingerprint normalization is only for cache deduplication, not type lookup.
- `bun install` runs `prepare` lifecycle scripts. Don't name a script `prepare` in `package.json`; it'll loop. We use `sqlx:prepare`.
- `fs.watch` on Linux requires Bun's recursive support. Don't use chokidar; it adds dependencies for no real gain here.

## Where to start if you're new

Read in this order:

1. `README.md` — what the library does for users.
2. `example/` — a complete working setup. Run `prepare`, look at the generated `sqlx-js-env.d.ts`.
3. `src/index.ts` and `src/runtime.ts` — public API.
4. `src/commands/prepare.ts` — the orchestration that ties everything together.
5. `src/pg/wire.ts` and `src/pg/analyze.ts` — the heaviest pieces.
