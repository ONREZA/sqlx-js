# CLI and workflows

Command reference for prepare, schema development, migrations, snapshots, diagnostics, and deployment-oriented verification.

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
| `queries` | Database-free query inventory, inference explanation, and SQL embedding | With `--embed` | No |
| `json audit` | Extended JSON collision, duplicate-key, schema-dependency, and source-usage inventory | No | No |
| `doctor` | Runtime, descriptor coverage, config, provider, database, RLS, and artifact diagnostics | With `--fix` | No |

Common syntax:

```text
sqlx-js dev [--strict-inference] [--shadow-url <url>]
sqlx-js verify [--strict-inference] [--shadow-url <url>]
sqlx-js ci [--json]
sqlx-js prepare [--watch | --check | --offline | --verify] [--warnings | --verbose]
sqlx-js migrate add|run|info|check|revert|squash|archive
sqlx-js pgschema install|plan|apply
sqlx-js snapshot dump|check
sqlx-js doctor [--fix]
sqlx-js queries [--json] [--embed <path>]
sqlx-js queries explain <query-id> [--json]
sqlx-js json audit [--json]
```

Run `sqlx-js <command> --help` or
`sqlx-js <command> <subcommand> --help` for exact flags, side effects, and
behavior. Subcommand help is intentionally narrower than the root overview.

Regular `prepare` describes and plans queries across a small connection pool (default 8, override with `SQLX_JS_PREPARE_CONCURRENCY`) for faster cold runs on large projects. After `Describe` establishes the server-side parameter contract, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and `MERGE` are SQL-prepared on the same session and planned through `EXPLAIN EXECUTE` under `plan_cache_mode = force_generic_plan`. The resulting plan is independent of placeholder values. `ANALYZE` is never used, so DML is not executed. Statements outside PostgreSQL's generic SQL `PREPARE` surface, such as `SET` and `CALL`, remain valid but are reported and cached as `parse-only`. A reusable definition can record `{ expectedValidation: "parse-only" }`; acknowledged entries stay visible in verbose output and query inventory without producing a permanent warning. Watch mode keeps one session warm, rescans only affected source files, and reuses cached metadata for unchanged fingerprints. Config and tsconfig changes invalidate the incremental state and perform a full prepare.

Live prepare stages the complete generated cache and external TypeScript outputs before publication. It publishes external outputs first and swaps the cache directory last, making the cache manifest the commit marker; a synchronous publication failure restores the previous artifacts. Offline regeneration and snapshot writes under `.sqlx-js/` use the same single-writer boundary. Default pruning identifies obsolete query files by filename without parsing their contents, so an incompatible orphan from an older cache format cannot block live regeneration. `--no-prune` deliberately retains those entries.

| Flag                  | Meaning                                                                              |
|-----------------------|--------------------------------------------------------------------------------------|
| `--check`             | Read-only offline verification of query/function/enum caches, the runtime descriptor, and generated files. |
| `--offline`           | Regenerate declarations, the runtime descriptor, and an enabled enum module from committed cache without a database. |
| `--verify`            | Prepare against `DATABASE_URL` and compare generated artifacts without writing.          |
| `--watch`             | Persistent connection, re-prepare on file change.                                    |
| `--root <dir>`        | Source/cache/migrations root (default: cwd).                                         |
| `--dts <path>`        | Root-relative declarations output (default: `<root>/sqlx-js-env.d.ts`).             |
| `--no-prune`          | Keep orphaned cache entries; they do not invalidate a later `--check`.                |
| `--migrations <dir>`  | Root-relative built-in migrations directory for `migrate`, `dev`, and `verify` (default: `<root>/migrations`). |
| `--dry-run`           | For `migrate run` / `migrate revert`: validate without applying to the target DB.   |
| `--json`              | Machine-readable prepare diagnostics, doctor/audit output, migration inspection and dry-runs. |
| `--warnings`          | Show full warning details while keeping compact prepare output. |
| `--verbose`           | Show per-query prepare progress. Compact human output is the default for prepare/check/offline/verify. |
| `--embed <path>`      | For `queries`: write a deterministic TypeScript map of referenced external SQL files. |
| `--jsonl`             | Versioned streaming events for `prepare --watch`.                                     |
| `--strict-inference`  | Fail prepare/dev/verify when nullability degrades, a generated query type contains unresolved `unknown`, plain `sql()` discards a command result, or a `parse-only` statement is not explicitly acknowledged. Intentional `SqlxJson<unknown>` wrappers remain accepted. |
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
| `--fix`                | For `doctor`: add missing `linguist-generated` rules to `.gitattributes`.    |

Flags that take a value accept both `--flag value` and `--flag=value` forms.

Prepare and doctor JSON use `formatVersion: 1`. Prepare diagnostics include a stable phase plus root-relative file, 1-based line/column, query ID/name, connection profile, PostgreSQL code/position/hint when available, and the query text. Doctor's `rls` check contains per-profile role flags, accessible RLS tables, grants, applicable policies, owner-bypass state, missing permissive-policy commands, and structured issues. Degraded inference and generated `unknown` query types appear as warnings by default; `--strict-inference` promotes them to errors. This is intended for CI annotations and editor integrations; stdout contains one JSON document and human progress is suppressed. `prepare --watch --jsonl` emits one `start`, `diagnostic`, `prepared`, `error`, `watching`, or `stopping` event per line so an editor can consume diagnostics without waiting for the watch process to exit. Fatal `error` events include the same structured `diagnostic` object as CLI preflight failures, preserving the prepare phase and source location when available.

Prepare uses compact human output by default. It omits per-query success/reuse
lines and warning details, while errors remain expanded. Completed runs end
with source-site and unique-query counts, counts grouped by diagnostic phase,
and hints for the available detail levels. Add `--warnings` to print every
warning while retaining compact progress, or `--verbose` to restore the full
per-query stream including warnings. Query diagnostics include their source
location, name/profile when available, and query ID; function and project
diagnostics retain their function signature or artifact subject. Inspect a
reported query with
`sqlx-js queries explain <query-id>`. Compact output preserves normal exit
codes and artifact behavior. `--warnings` and `--verbose` cannot be combined
with each other or with `--json`/`--jsonl`; watch mode is already streaming and
does not accept them.

`queries --json` is database-free and read-only. It emits `formatVersion: 1`
inventory entries with `queryId`, connection profiles, optional definition
names, cardinalities, root-relative call sites, SQL file paths, source-owned
nullable-parameter, result-assertion, expected-validation, and timestamp-policy
contracts (including local allow reasons), `current`/`stale`/`missing` cache
status, and `planned`/`parse-only` validation when cached, plus orphaned cache
IDs. Config, scan, cache, and embed failures use versioned structured
diagnostics with source location when available. Adding `--embed` writes the
external-SQL module only after a successful scan.

After adding a new `defineQuery`, run live `sqlx-js prepare` before the ordinary
TypeScript build. Until then, the generated registry cannot contain that SQL
literal and TypeScript reports an overload/registry mismatch. `sqlx-js queries --json`
distinguishes `missing` from `stale` cache state and points to the exact
source site without connecting to PostgreSQL; `prepare --check` remains the
read-only artifact gate and tells you when a live prepare is required.

`queries explain <query-id>` reads committed cache artifacts and reports result
sources, source constraints, every DML and predicate target for parameters,
nullability decisions, per-profile result assertions, and actionable hints. It
does not connect to PostgreSQL.

`json audit` is the reader-first gate before an existing application writes
Extended JSON tags. It opens `DATABASE_URL` in a read-only transaction and
inspects every physical column on ordinary or materialized user relations whose
type contains a `json`/`jsonb` leaf. Type discovery recursively follows arrays,
domains, and composite fields. Each relation is scanned with PostgreSQL `ONLY`,
so inherited rows belong exclusively to their physical child relation. The audit
counts physical rows containing `$sqlx` at any JSON-leaf nesting depth or
exceeding the cumulative canonical-number limit. For text-preserving `json`
leaves, it also counts rows containing duplicate object keys or individual
numeric tokens outside the frozen reader limits. It also inventories indexes,
constraints, generated columns and views that depend on a containing column, then scans
application query sites for JSON operators and `json_*`/`jsonb_*` functions.
Dependencies and source usages require review but do not by themselves fail;
collisions, duplicate keys, incompatible numeric tokens, missing privileges,
active row-level security for the audit role, or column scan errors make the
audit non-zero and `complete: false` where applicable. The command never
rewrites stored data or application SQL.

Machine-readable output uses `formatVersion: 1` and includes
`protocolVersion`, the physical PostgreSQL column type, `jsonLeaves` paths and
leaf types, per-column collision/duplicate-key/invalid-number counts and errors,
dependency definitions, source locations/query IDs, and summary counters.
Counts are deduplicated by physical row when one containing column has multiple
JSON leaves. Preflight and fatal
failures keep the same top-level shape with `complete: false` and add a
`diagnostics` array, so `--json` never falls back to human stderr. A full audit
can scan each containing column, so run it against a representative read
replica or within the application's normal database workload controls when
tables are large.

`doctor` separately reports descriptor coverage for parameterized runtime call
sites, lists adaptive or statically unclassified locations, and errors when a
descriptor-configured query is missing from the artifact. Its coverage
denominator is the number of unique SQL-fingerprint/connection-profile
contracts. `parameterized` counts source sites before that deduplication,
`definitions` counts reusable definition sites, and `executionSites` counts
direct execution sites, so those values need not equal `queryContracts`.
`descriptor` and `missing` count unique contracts, while
`descriptorConfigured`, `adaptive`, and `unknown` count direct execution
sites. The JSON `countSemantics` object records these units alongside the
values.

Doctor also checks that `.sqlx-js/**`, the effective declaration output, and
an enabled enum catalog output are marked as `linguist-generated` in the
nearest project or repository `.gitattributes`. Missing rules are warnings
with `fixable: true`; `doctor --fix` appends only the missing entries,
preserves existing attributes and honors canonical rules inherited from a
containing monorepo. This lets GitHub collapse generated diffs by default
without hiding them from local Git diffs.

Every project-scoped command compares the running CLI package version and real
package path with `@onreza/sqlx-js` resolved from `--root`. A version mismatch
or malformed nearest installation fails before scanning, artifact writes, or
database changes, including `init`. Read-only `doctor` remains available and
reports both identities; `doctor --fix` refuses to write until the identity is
not known to mismatch or be malformed. `doctor` reports an unresolved target
installation as a warning; other commands can continue so `init` and
dependency-free project setup remain usable. Different real paths with the
same version are accepted, which keeps hoisted and linked workspaces usable.

Schema-provider diagnostics distinguish ownership from command availability.
An explicit `schema.provider: "builtin"` or `"pgschema"` selects the
sqlx-js-managed schema workflow. When the field is absent, doctor reports DDL
ownership as external or unspecified. `dev` and `verify` still default to the
built-in migration workflow, but that operational default is not presented as
declared DDL ownership. Structured details expose the configured provider,
declared ownership, and effective `dev`/`verify` provider separately.

`DATABASE_URL` must be set for any command that touches the application database or auto-creates a shadow database. `SHADOW_ADMIN_DATABASE_URL` can point at a maintenance/admin database when the application user cannot `CREATE DATABASE`; `SHADOW_DATABASE_URL` can point at a pre-created disposable shadow database. The internal wire client understands `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `application_name`, `options` (PostgreSQL startup options such as `-c search_path=app,public`), `connect_timeout` (seconds), and `statement_timeout` (milliseconds). Unqualified relations are resolved using the prepare session's real `search_path`; they are not assumed to live in `public`.

## Development and deployment flows

For complex PostgreSQL schemas with functions, triggers, RLS, grants, partitions, and other schema-level objects, prefer pgschema for DDL ownership and use sqlx-js for application-query typing:

```bash
sqlx-js init --schema-provider pgschema
sqlx-js pgschema install
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
value, so multi-schema configurations fail explicitly. It also has a known
upstream defect that omits function-local `SET` entries other than
`search_path`; see [pgplex/pgschema#526](https://github.com/pgplex/pgschema/issues/526).
Use another DDL workflow for routines that depend on settings such as
`TimeZone` until a fixed provider version is pinned.

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

## Migration squash baselines

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

## Schema snapshot and manifest

`snapshot dump` introspects PostgreSQL and writes two generated files:

- `.sqlx-js/schema/schema.json` — machine-readable contract for runtime identifier whitelisting and CI drift checks.
- `.sqlx-js/schema/schema.md` — compact LLM-facing manifest with tables, columns, constraints, indexes, types, and functions.

`snapshot check` re-introspects the database and fails if the committed
snapshot is stale. Snapshot commands only read `DATABASE_URL`, or the explicit
`--shadow-url` when supplied; they never build, clear, or modify that database.
To snapshot a proposed schema, first build a pre-created disposable database
with `dev --shadow-url`, then run `snapshot dump --shadow-url` against the same
URL.

## Error output

When `prepare` fails, every diagnostic points back to the originating call site:

```
✗ src/users.ts:42:13 — describe failed: relation "userss" does not exist (pos 15, code 42P01)
    query: SELECT * FROM userss WHERE id = $1
```

Phases reported separately: `describe failed`, `analyze failed`, `paramMap failed`. PostgreSQL `position`, `code`, and `hint` are surfaced when present.

## GitHub and editor diagnostics

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

[Documentation index](./README.md)
