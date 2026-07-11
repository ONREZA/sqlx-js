# AGENTS.md

Operational handbook for any agent (human or AI) working on this repository. Read this once before making changes.

## What this project is

`sqlx-js` is a TypeScript library published as `@onreza/sqlx-js` that ports the developer experience of Rust's `sqlx` to TypeScript + PostgreSQL: you write raw SQL, a `prepare` step validates it against a live database and emits typed declarations. The library has both a CLI (`bin/sqlx-js.ts`) and a runtime (`src/index.ts`).

The library is **PostgreSQL-only** and **compile-time-only by design** — no runtime SQL parsing, no runtime validation, no ORM layer. The runtime is backed by Postgres.js through a single adapter instead of a Bun-specific client. The supported baseline is Node ≥ 24 or Bun ≥ 1.3.

## Repository layout

```
.
├── bin/
│   ├── sqlx-js.ts           CLI entry point (init, prepare, migrate, schema, watch)
│   └── sqlx-js-diagnostics.ts JSON diagnostic adapter for GitHub and editors
├── src/
│   ├── index.ts              Public package entry (sql, migrate, types)
│   ├── runtime.ts            Shared runtime core + key renaming + migrate()
│   ├── migration-core.ts     Lightweight migration apply/lock path shared by runtime + CLI
│   ├── postgres-runtime.ts   Postgres.js runtime adapter
│   ├── artifacts.ts          Generated-artifact comparison for prepare --verify
│   ├── cache.ts              .sqlx-js/<fingerprint>.json reader/writer
│   ├── codegen.ts            Emits sqlx-js-env.d.ts from CacheEntry[]
│   ├── config.ts             Loads and validates sqlx-js.config.*
│   ├── schema-snapshot.ts    Schema dump/check snapshot + manifest rendering
│   ├── typed.ts              Public typed overload helpers
│   ├── commands/
│   │   ├── doctor.ts         Runtime/config/DB/cache/tsconfig diagnostics
│   │   ├── prepare.ts        runPrepare + openSession + prepareOnce + describeAll pool
│   │   ├── migrate.ts        CLI migrateRun + shared applyPending
│   │   ├── schema.ts         schema dump/check + shadow migration helper
│   │   ├── init.ts           sqlx-js init scaffolding
│   │   └── watch.ts          fs.watch loop with debounced re-prepare
│   ├── scan/
│   │   └── scanner.ts        TypeScript AST walk for sql() call sites
│   └── pg/
│       ├── wire.ts           Raw PG wire protocol client (SCRAM-SHA-256)
│       ├── oids.ts           Built-in OID → TS type table
│       ├── schema.ts         query-time pg_class / pg_attribute / pg_type / pg_enum loaders
│       ├── extensions.ts     Built-in extension type registry
│       ├── analyze.ts        libpg-query-based nullability inference
│       ├── narrow.ts         WHERE-clause non-null narrowing
│       └── param-map.ts      Maps $N → (table, column) for INSERT/UPDATE/WHERE
├── tests/                    Bun-test unit + integration tests
├── example/                  End-to-end fixture project used by CI integration
├── .github/workflows/        CI + npm publish
├── README.md                 User-facing documentation
├── ROADMAP.md                Future work, ordered by ROI
└── package.json
```

## Architectural overview

A `prepare` run executes the following pipeline:

1. **Scan** (`src/scan/scanner.ts`) — TypeScript AST walk over files selected by the root `tsconfig.json` and its project references, with optional `scan.include` / `scan.exclude` overrides. Finds direct named imports and namespace imports from `@onreza/sqlx-js`, including `sql(...)`, `sql.one(...)`, `sql.optional(...)`, `sql.execute(...)`, `sql.file(...)`, direct bindings returned by imported `createSqlClient(...)`, and the same surface inside recognized transaction callbacks. Refuses non-literal query/file arguments.
2. **Describe** (`src/pg/wire.ts`) — for each unique query, sends `Parse` + `Describe Statement` + `Sync` to PostgreSQL. Returns parameter OIDs and `RowDescription` (column name, type OID, source table OID, source column attno).
3. **Schema introspection** (`src/pg/schema.ts`) — batch-loads `pg_class`, `pg_attribute`, `pg_type`, `pg_enum` for everything touched by the queries. Cached per-session.
4. **AST analysis** (`src/pg/analyze.ts`) — parses each query via `libpg-query`, builds a scope of aliases with their join-nullability, walks each target to determine per-column nullability. Calls into `src/pg/narrow.ts` for WHERE-clause forced-non-null tracking.
5. **Param mapping** (`src/pg/param-map.ts`) — maps `$N` to a `(table, column)` target for supported INSERT VALUES / INSERT SELECT, ON CONFLICT UPDATE, UPDATE SET, WHERE/JOIN equality, and IN-list positions.
6. **Type resolution** — combines OID, custom enum/array info, schema's `jsonbTypes` config, and analysis output into the final TS type strings for every column and parameter.
7. **Persistence** — after every query validates successfully, publishes the complete query set through atomic per-file replacement, writes the version/config manifest, and emits `sqlx-js-env.d.ts` with `KnownQueries` / `KnownFileQueries` declarations for `@onreza/sqlx-js`.

`prepare --check` skips steps 2–6 and read-only verifies cache/generator versions, the type-affecting config hash, every scanned fingerprint, the function cache, and the generated declaration. `prepare --offline` deliberately regenerates the declaration from committed cache. `prepare --verify` performs a fresh live prepare in a temporary directory and compares all generated artifacts without modifying the worktree.

`prepare --watch` keeps the `PgClient` + `SchemaCache` warm and re-runs steps 1–7 on every debounced filesystem event.

The runtime (`src/index.ts` + `src/runtime.ts` + `src/postgres-runtime.ts`) is a thin layer over `client.unsafe(query, params)` using Postgres.js with prepared `unsafe` calls. Strict typing comes from an overload keyed on the active query registry — the global convenience API uses `KnownQueries`, while `createSqlClient<SqlxJsGeneratedRegistry>()` can bind an independent pool to one generated project contract.

## Common development tasks

### Prerequisites

- Node ≥ 24 for the published CLI and default runtime. Bun ≥ 1.3 is required
  for the test suite (`bun test --timeout 120000`) and can run the package through npm tooling.
  The runtime uses Postgres.js; CI currently smoke-tests Node and Bun entrypoints.
- A reachable PostgreSQL 14+ (15+ recommended for full SCRAM-SHA-256 coverage)
- `DATABASE_URL` exported in your shell

### Running tests

```bash
bun test --timeout 120000 # unit + integration tests
bunx tsc -p example     # type-check the example fixture
bun run test:corpus     # production-query inference gate
bun run test:runtime-boundary # build + production import allowlist
bun run test:node-package     # packed Node runtime/CLI smoke; requires DATABASE_URL
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

`src/pg/param-map.ts`. Statement walkers (`walkInsert`, `walkUpdate`, `walkDelete`, `walkSelect`) delegate expression traversal through `walkExpr`. New column/parameter equality-like patterns should reuse `tryBind(...)` or `bindParam(...)` so DML-bound nullability precedence stays intact.

### Working on the wire protocol

`src/pg/wire.ts` is a from-scratch implementation. Encoding/decoding is straightforward — the only subtle area is SCRAM-SHA-256 authentication, which requires PBKDF2 + HMAC + XOR steps in a fixed order. Don't tweak it unless you have a regression test that hits the auth path against PG 14+.

### Releasing a version

Releases are automated. The flow:

1. **Commit using conventional-commits** (`feat:`, `fix:`, `chore:`, `docs:`, etc.). `lefthook` enforces this locally via `cog verify` on every commit.
2. **Push to `main`.** `release-please.yml` reads conventional commits since the last release and opens (or updates) a release PR titled `chore(main): release X.Y.Z`. The PR contains the `package.json` version bump and the generated `CHANGELOG.md` entry.
3. **Review and merge the release PR.** release-please tags the merge commit `vX.Y.Z`.
4. **The same `release.yml` run triggers the publish job**, which type-checks, tests, builds JS + declarations into `dist/`, smoke-tests package entrypoints, verifies version parity, and publishes to npm with provenance through Trusted Publishing.

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
- `pre-push` → `bun test tests --timeout 120000`.
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
- **Backward compatibility**: cache artifacts are committed by users. Pre-1.0 changes must bump the cache/generator revision and fail with actionable regeneration guidance; after 1.0 they require a major version or graceful migration.
- **TypeScript strict mode**. No `any` in public API. Internal helpers can use `any` only when walking the libpg-query AST, which is genuinely loose-typed.
- **English everywhere** — source, docs, tests, commit messages.

## Things to be careful about

- Postgres.js returns `int8` as a string by default. The adapter registers `postgres.BigInt` so types and runtime agree. Don't change it without re-checking every `bigint` site.
- The codegen writes literal SQL strings as keys in `KnownQueries`. Whitespace in the source must match exactly when the query is rewritten — the runtime sees the user's literal, then `KnownQueries` is looked up by that literal. The fingerprint normalization is only for cache deduplication, not type lookup.
- JSON and PostgreSQL arrays are explicit parameter representations. Generated parameter types require `sql.json(...)` and `sql.array(...)`; do not reintroduce runtime array guessing.
- `bun install` runs `prepare` lifecycle scripts. Don't name a script `prepare` in `package.json`; it'll loop. We use `sqlx:prepare`.
- Watch mode depends on recursive `fs.watch` support from the active runtime. It incrementally rescans affected files and reuses unchanged cache fingerprints; config/tsconfig/schema resets must keep forcing a full prepare. Don't use chokidar; it adds dependencies for no real gain here.
- `sql.file(path)` is root-relative. Prepare resolves against `--root`; runtime resolves against `fileRoot` (default: `process.cwd()`). Runtime file contents are immutable-cached by default; `reloadSqlFiles: true` restores development mtime checks. Keep roots aligned in embedded/package layouts.

## Where to start if you're new

Read in this order:

1. `README.md` — what the library does for users.
2. `example/` — a complete working setup. Run `prepare`, look at the generated `sqlx-js-env.d.ts`.
3. `src/index.ts` and `src/runtime.ts` — public API.
4. `src/commands/prepare.ts` — the orchestration that ties everything together.
5. `src/pg/wire.ts` and `src/pg/analyze.ts` — the heaviest pieces.
