
export type HelpScope =
  | "root"
  | "init"
  | "dev"
  | "verify"
  | "doctor"
  | "ci"
  | "json"
  | "pgschema"
  | "prepare"
  | "queries"
  | "migrate"
  | "snapshot";

export function helpText(version: string, scope: HelpScope, args: string[] = []): string {
  const VERSION = version;

  const HELP: Record<HelpScope, string> = {
    root: `sqlx-js — compile-time-checked SQL for TypeScript + Postgres (v${VERSION})

  common workflows:
    sqlx-js init [--root <dir>] [--schema-provider builtin|pgschema] [--temporal-provider polyfill|native]
    sqlx-js dev [--strict-inference] [--shadow-url <url>]
    sqlx-js verify [--strict-inference] [--shadow-url <url>]
    sqlx-js prepare [--watch | --check | --offline | --verify]
    sqlx-js ci [--json]

  schema ownership:
    sqlx-js migrate add|run|info|check|revert|squash|archive
    sqlx-js pgschema install|update|exec|plan|apply

  inspection and generated artifacts:
    sqlx-js doctor [--root <dir>] [--dts <path>] [--json] [--fix]
    sqlx-js queries [--json] [--root <dir>]
    sqlx-js queries audit [--json] [--root <dir>]
    sqlx-js queries similarities [--json] [--functions <path>] [--root <dir>]
    sqlx-js queries explain <query-id> [--json] [--root <dir>]
    sqlx-js json audit [--json] [--root <dir>]
    sqlx-js snapshot dump|check
    sqlx-js --version
    sqlx-js-diagnostics github|unix < prepare-diagnostics.json

  Run \`sqlx-js <command> --help\` or
  \`sqlx-js <command> <subcommand> --help\` for exact behavior and flags.
  `,
    init: `usage: sqlx-js init [--root <dir>] [--schema-provider builtin|pgschema] [--temporal-provider polyfill|native]

  Scaffold config, a descriptor-bound db.ts, generated artifact placeholders,
  package scripts, and the selected schema and Temporal provider boundaries
  without replacing existing files.`,
    dev: `usage: sqlx-js dev [--root <dir>] [--dts <path>] [--migrations <dir>] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] [--strict-inference] [--no-prune]

  Build the configured schema source in a disposable shadow database and
  regenerate query artifacts. Uses built-in migrations by default or schema.sql
  when schema.provider is "pgschema".

  --migrations and --lock-timeout apply only to the built-in provider.

  Writes worktree: yes
  Changes target database: no`,
    verify: `usage: sqlx-js verify [--root <dir>] [--dts <path>] [--migrations <dir>] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] [--strict-inference]

  Build the configured schema source in a disposable shadow database and compare
  fresh query artifacts with the committed files. When the default schema
  snapshot exists, verify it against the same shadow database.

  --migrations and --lock-timeout apply only to the built-in provider.

  Writes worktree: no
  Changes target database: no`,
    doctor: `usage: sqlx-js doctor [--root <dir>] [--dts <path>] [--json] [--fix]

  Inspect runtime, config, environment, generated artifacts, PostgreSQL
  connectivity and shadow permissions, runtime types, and pgschema availability.

  --fix adds missing linguist-generated rules to .gitattributes.

  Writes worktree: only with --fix
  Changes target database: no`,
    ci: `usage: sqlx-js ci [--root <dir>] [--dts <path>] [--json] [--shadow-admin-url <url> | --shadow-url <url>] [--migrations <dir>]

  Run provider-aware \`verify\`, including generated-artifact comparison and the
  default schema snapshot when present. This validates the proposed schema source
  without changing the target database. Run \`pgschema
  plan\` or \`migrate run --dry-run\` separately for target deployment drift.

  --migrations applies only to the built-in provider.`,
    json: `usage: sqlx-js json audit [--json] [--root <dir>]

  Read-only inventory for the Extended JSON reader-first rollout. Scans every
  selectable user-table json/jsonb column for reserved $sqlx keys and duplicate
  json object keys, then reports dependent schema objects and source query usage.

  Writes worktree: no
  Changes target database: no`,
    pgschema: `usage: sqlx-js pgschema install | update --patch | exec -- <args> | plan | apply

  Manage the project-locked pgschema tool and target-database deployment plans.
  Use provider-aware \`sqlx-js dev\` and \`sqlx-js verify\` for shadow validation.`,
    prepare: `usage: sqlx-js prepare [--check | --offline | --verify | --watch] [--include <glob>] [--query <name-or-id>] [--warnings | --verbose | --json | --jsonl] [--strict-inference] [--root <dir>] [--dts <path>] [--no-prune]

  Query-artifact engine:
    prepare             regenerate artifacts against DATABASE_URL
    prepare --watch     regenerate after source changes
    prepare --check     verify committed artifacts offline
    prepare --offline   restore generated files from committed cache
    prepare --verify    compare fresh artifacts against a supplied live database
    prepare --include   live-validate matching source files and mark artifacts incomplete
    prepare --query     live-validate an exact defineQuery name or stable query ID

  Output:
    default             compact counts; errors remain expanded
    --warnings          also show full warning details
    --verbose           show warnings and per-query progress

  For schema-source validation prefer \`sqlx-js dev\` or \`sqlx-js verify\`.`,
    queries: `usage: sqlx-js queries [--json] [--root <dir>]
         sqlx-js queries audit [--json] [--root <dir>]
         sqlx-js queries similarities [--json] [--functions <path>] [--min-nodes <n>] [--limit <n>] [--root <dir>]
         sqlx-js queries explain <query-id> [--json] [--root <dir>]

  Scan source without a database and report query call sites, cache status,
  validation mode, profiles, definitions, and referenced SQL files. Audit reports
  possible exact duplicates and contract divergence. Similarities ranks normalized
  AST fragments across queries and optional SQL function sources. Explain reads
  committed inference provenance without connecting to PostgreSQL.`,
    migrate: `usage: sqlx-js migrate add|run|info|check|revert|squash|archive

  Manage built-in migration files and target history. Use provider-aware
  \`sqlx-js dev\` and \`sqlx-js verify\` for shadow validation.`,
    snapshot: `usage: sqlx-js snapshot dump | check

  Read DATABASE_URL or an explicit --shadow-url to generate or compare the
  schema snapshot used by sql.id() and the optional LLM-facing manifest.`,
  };

  const SUBCOMMAND_HELP: Record<string, string> = {
    "queries:explain": `usage: sqlx-js queries explain <query-id> [--json] [--root <dir>]

  Explain result provenance, parameter targets, nullability decisions, and
  actionable inference hints from committed prepare artifacts.`,
    "queries:audit": `usage: sqlx-js queries audit [--json] [--root <dir>]

  Report possible exact query duplicates, source-contract divergence, query-name
  collisions, reviewed ignores, and stale ignore entries. Findings are advisory.`,
    "queries:similarities": `usage: sqlx-js queries similarities [--json] [--functions <path>] [--min-nodes <n>] [--limit <n>] [--root <dir>]

  Rank normalized PostgreSQL AST fragments across application queries and optional
  SQL-language function bodies. This experimental report is advisory.`,
    "json:audit": `usage: sqlx-js json audit [--json] [--root <dir>]

  Audit stored json/jsonb documents and extension-sensitive schema/source usage
  before Extended JSON writers are enabled. Runs in a read-only transaction.`,
    "pgschema:install": `usage: sqlx-js pgschema install [--frozen] [--root <dir>]

  Install and checksum the pgschema binary locked by pgschema.lock.json. When
  the lock is missing, resolve the latest compatible >=1.12 <1.13 release,
  install it, and create the lock. --frozen requires an existing lock.`,
    "pgschema:update": `usage: sqlx-js pgschema update --patch [--root <dir>]

  Resolve the latest stable >=1.12 <1.13 release, install its binary, and
  atomically update pgschema.lock.json with every supported platform digest.`,
    "pgschema:exec": `usage: sqlx-js pgschema exec [--root <dir>] -- <pgschema args>

  Run the checksum-verified managed binary, or schema.command, directly from the
  project root. Arguments and process environment pass through unchanged. This
  explicit escape hatch bypasses sqlx-js connection and schema safeguards.`,
    "pgschema:plan": `usage: sqlx-js pgschema plan [--root <dir>] [-- <pgschema args>]

  Plan target-database changes from schema.sql without applying them.`,
    "pgschema:apply": `usage: sqlx-js pgschema apply [--root <dir>] [-- <pgschema args>]

  Apply schema.sql or a reviewed --plan to the target database.`,
    "migrate:add": `usage: sqlx-js migrate add <name> [--root <dir>] [--migrations <dir>]

  Create matching .up.sql and .down.sql migration stubs.`,
    "migrate:run": `usage: sqlx-js migrate run [--dry-run] [--json] [--lock-timeout <ms>] [--root <dir>] [--migrations <dir>]

  Apply pending built-in migrations to the target database.`,
    "migrate:info": `usage: sqlx-js migrate info [--json] [--root <dir>] [--migrations <dir>]

  Inspect target migration history without changing it.`,
    "migrate:check": `usage: sqlx-js migrate check [--json] [--root <dir>] [--migrations <dir>]

  Validate migration filenames, versions, down files, and squash metadata
  without a database.`,
    "migrate:revert": `usage: sqlx-js migrate revert [--dry-run] [--json] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] [--root <dir>] [--migrations <dir>]

  Revert the latest target migration, or validate its down migration in a
  shadow transaction with --dry-run.`,
    "migrate:squash": `usage: sqlx-js migrate squash <name> [--shadow-admin-url <url> | --shadow-url <url>] [--replace] [--pg-dump <path>] [--lock-timeout <ms>] [--root <dir>] [--migrations <dir>]

  Build migrations in a shadow database and write one schema-only baseline.`,
    "migrate:archive": `usage: sqlx-js migrate archive list [--root <dir>] [--migrations <dir>]
         sqlx-js migrate archive restore <name> [--force] [--root <dir>] [--migrations <dir>]

  Inspect or restore migration files archived by migrate squash --replace.`,
    "snapshot:dump": `usage: sqlx-js snapshot dump [--schema <path>] [--manifest <path>] [--no-manifest] [--shadow-url <url>] [--root <dir>]

  Write the schema snapshot and optional LLM manifest from DATABASE_URL or the
  explicit --shadow-url. The selected database is read-only.`,
    "snapshot:check": `usage: sqlx-js snapshot check [--schema <path>] [--shadow-url <url>] [--root <dir>]

  Compare the committed schema snapshot with DATABASE_URL or the explicit
  --shadow-url. The selected database is read-only.`,
  };
  const subcommand = args[0]?.startsWith("-") ? undefined : args[0];
  return (SUBCOMMAND_HELP[`${scope}:${subcommand}`] ?? HELP[scope]).replace(/^ {2}/gm, "");
}
