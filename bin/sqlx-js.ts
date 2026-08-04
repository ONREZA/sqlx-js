#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { JsonAuditReport } from "../src/commands/json-audit";
import type { PgschemaSubcommand } from "../src/commands/pgschema";
import type { PrepareDiagnosticPhase } from "../src/commands/prepare";
import { JSON_PROTOCOL_VERSION } from "../src/artifact-versions";
import { assertSupportedRuntime, loadConfig, loadRootEnv } from "../src/config";
import { inspectPackageIdentity, runningPackageIdentity } from "../src/package-identity";

const CLI_IDENTITY = runningPackageIdentity(import.meta.url);
const VERSION = CLI_IDENTITY.version;

type HelpScope =
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

const HELP: Record<HelpScope, string> = {
  root: `sqlx-js — compile-time-checked SQL for TypeScript + Postgres (v${VERSION})

common workflows:
  sqlx-js init [--root <dir>] [--schema-provider builtin|pgschema]
  sqlx-js dev [--strict-inference] [--shadow-url <url>]
  sqlx-js verify [--strict-inference] [--shadow-url <url>]
  sqlx-js prepare [--watch | --check | --offline | --verify]
  sqlx-js ci [--json]

schema ownership:
  sqlx-js migrate add|run|info|check|revert|squash|archive
  sqlx-js pgschema install|plan|apply

inspection and generated artifacts:
  sqlx-js doctor [--root <dir>] [--dts <path>] [--json] [--fix]
  sqlx-js queries [--json] [--embed <path>] [--root <dir>]
  sqlx-js queries explain <query-id> [--json] [--root <dir>]
  sqlx-js json audit [--json] [--root <dir>]
  sqlx-js snapshot dump|check
  sqlx-js --version
  sqlx-js-diagnostics github|unix < prepare-diagnostics.json

Run \`sqlx-js <command> --help\` or
\`sqlx-js <command> <subcommand> --help\` for exact behavior and flags.
`,
  init: `usage: sqlx-js init [--root <dir>] [--schema-provider builtin|pgschema]

Scaffold config, a descriptor-bound db.ts, generated artifact placeholders,
package scripts, and the selected schema source without replacing existing files.`,
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

Run provider-aware \`verify\`, including the default schema snapshot when
present, then the database-free artifact consistency check. This validates the
proposed schema source without changing the target database. Run \`pgschema
plan\` or \`migrate run --dry-run\` separately for target deployment drift.

--migrations applies only to the built-in provider.`,
  json: `usage: sqlx-js json audit [--json] [--root <dir>]

Read-only inventory for the Extended JSON reader-first rollout. Scans every
selectable user-table json/jsonb column for reserved $sqlx keys and duplicate
json object keys, then reports dependent schema objects and source query usage.

Writes worktree: no
Changes target database: no`,
  pgschema: `usage: sqlx-js pgschema install | plan | apply

Manage the pinned pgschema tool and target-database deployment plans.
Use provider-aware \`sqlx-js dev\` and \`sqlx-js verify\` for shadow validation.`,
  prepare: `usage: sqlx-js prepare [--check | --offline | --verify | --watch] [--warnings | --verbose | --json | --jsonl] [--strict-inference] [--root <dir>] [--dts <path>] [--no-prune]

Query-artifact engine:
  prepare             regenerate artifacts against DATABASE_URL
  prepare --watch     regenerate after source changes
  prepare --check     verify committed artifacts offline
  prepare --offline   restore generated files from committed cache
  prepare --verify    compare fresh artifacts against a supplied live database

Output:
  default             compact counts; errors remain expanded
  --warnings          also show full warning details
  --verbose           show warnings and per-query progress

For schema-source validation prefer \`sqlx-js dev\` or \`sqlx-js verify\`.`,
  queries: `usage: sqlx-js queries [--json] [--embed <path>] [--root <dir>]
       sqlx-js queries explain <query-id> [--json] [--root <dir>]

Scan source without a database and report query call sites, cache status,
validation mode, profiles, definitions, and referenced SQL files. Explain reads
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
  "json:audit": `usage: sqlx-js json audit [--json] [--root <dir>]

Audit stored json/jsonb documents and extension-sensitive schema/source usage
before Extended JSON writers are enabled. Runs in a read-only transaction.`,
  "pgschema:install": `usage: sqlx-js pgschema install [--root <dir>]

Download and checksum the pinned pgschema binary. \`sqlx-js doctor\` reports
its availability as part of full-project diagnostics.`,
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

function helpText(scope: HelpScope, args: string[] = []): string {
  const subcommand = args[0]?.startsWith("-") ? undefined : args[0];
  return SUBCOMMAND_HELP[`${scope}:${subcommand}`] ?? HELP[scope];
}

function printHelp(scope: HelpScope, error = false, args: string[] = []): void {
  (error ? console.error : console.log)(helpText(scope, args));
}

function exitHelp(scope: HelpScope, args: string[] = []): never {
  printHelp(scope, false, args);
  process.exit(0);
}

const rawArgv = process.argv.slice(2);
const passthroughIndex = rawArgv.indexOf("--");
const cliArgv = passthroughIndex >= 0 ? rawArgv.slice(0, passthroughIndex) : rawArgv;
const passthroughArgs = passthroughIndex >= 0 ? rawArgv.slice(passthroughIndex + 1) : [];
const cmd = cliArgv[0];
const commandArgv = cliArgv.slice(1);

function usageError(message: string, scope: HelpScope = "root", args: string[] = []): never {
  if (cmd === "json" && cliArgv.includes("--json")) {
    printJsonAuditFailure(`sqlx-js: ${message}`);
    process.exit(2);
  }
  console.error(`sqlx-js: ${message}`);
  printHelp(scope, true, args);
  process.exit(2);
}

const scopes = new Set<HelpScope>([
  "init",
  "dev",
  "verify",
  "doctor",
  "ci",
  "json",
  "pgschema",
  "prepare",
  "queries",
  "migrate",
  "snapshot",
]);

if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (!cmd || cmd === "--help" || cmd === "-h") exitHelp("root");
if (!scopes.has(cmd as HelpScope)) usageError(`unknown command ${JSON.stringify(cmd)}`);
const scope = cmd as Exclude<HelpScope, "root">;
if (cliArgv.includes("--help") || cliArgv.includes("-h")) exitHelp(scope, commandArgv);
if (passthroughIndex >= 0 && cmd !== "pgschema") {
  usageError("arguments after -- are only supported by sqlx-js pgschema", scope, commandArgv);
}

const ROOT_OPTIONS: ParseArgsOptionsConfig = {
  root: { type: "string" },
  help: { type: "boolean", short: "h" },
};

function optionsFor(command: string, subcommand?: string): ParseArgsOptionsConfig {
  if (command === "init") return { ...ROOT_OPTIONS, "schema-provider": { type: "string" } };
  if (command === "dev" || command === "verify") {
    return {
      ...ROOT_OPTIONS,
      dts: { type: "string" },
      migrations: { type: "string" },
      "shadow-admin-url": { type: "string" },
      "shadow-url": { type: "string" },
      "lock-timeout": { type: "string" },
      "strict-inference": { type: "boolean" },
      ...(command === "dev" ? { "no-prune": { type: "boolean" } } : {}),
    };
  }
  if (command === "doctor") {
    return {
      ...ROOT_OPTIONS,
      dts: { type: "string" },
      json: { type: "boolean" },
      fix: { type: "boolean" },
    };
  }
  if (command === "ci") return {
    ...ROOT_OPTIONS,
    json: { type: "boolean" },
    dts: { type: "string" },
    migrations: { type: "string" },
    "shadow-url": { type: "string" },
    "shadow-admin-url": { type: "string" },
  };
  if (command === "json") return { ...ROOT_OPTIONS, json: { type: "boolean" } };
  if (command === "pgschema") return ROOT_OPTIONS;
  if (command === "prepare") {
    return {
      ...ROOT_OPTIONS,
      dts: { type: "string" },
      check: { type: "boolean" },
      offline: { type: "boolean" },
      verify: { type: "boolean" },
      watch: { type: "boolean" },
      json: { type: "boolean" },
      jsonl: { type: "boolean" },
      warnings: { type: "boolean" },
      verbose: { type: "boolean" },
      "no-prune": { type: "boolean" },
      "strict-inference": { type: "boolean" },
    };
  }
  if (command === "queries") return { ...ROOT_OPTIONS, json: { type: "boolean" }, embed: { type: "string" } };
  if (command === "snapshot") {
    const common = {
      ...ROOT_OPTIONS,
      schema: { type: "string" },
      "shadow-url": { type: "string" },
    } satisfies ParseArgsOptionsConfig;
    return subcommand === "dump"
      ? { ...common, manifest: { type: "string" }, "no-manifest": { type: "boolean" } }
      : common;
  }
  const common = { ...ROOT_OPTIONS, migrations: { type: "string" } } satisfies ParseArgsOptionsConfig;
  if (subcommand === "run") {
    return { ...common, "dry-run": { type: "boolean" }, json: { type: "boolean" }, "lock-timeout": { type: "string" } };
  }
  if (subcommand === "info" || subcommand === "check") return { ...common, json: { type: "boolean" } };
  if (subcommand === "revert") {
    return {
      ...common,
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      "shadow-admin-url": { type: "string" },
      "shadow-url": { type: "string" },
      "lock-timeout": { type: "string" },
    };
  }
  if (subcommand === "squash") {
    return {
      ...common,
      "shadow-admin-url": { type: "string" },
      "shadow-url": { type: "string" },
      "lock-timeout": { type: "string" },
      replace: { type: "boolean" },
      "pg-dump": { type: "string" },
    };
  }
  if (subcommand === "archive") return { ...common, force: { type: "boolean" } };
  return common;
}

const subcommand = commandArgv[0]?.startsWith("-") ? undefined : commandArgv[0];
let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    args: commandArgv,
    options: optionsFor(cmd, subcommand),
    strict: true,
    allowPositionals: true,
  });
} catch (error) {
  usageError((error as Error).message, scope, commandArgv);
}
const values = parsed.values;
const positionals = parsed.positionals;

function arg(name: string, def?: string): string | undefined {
  const value = values[name.replace(/^--/, "")];
  return typeof value === "string" ? value : def;
}

function flag(name: string): boolean {
  return values[name.replace(/^--/, "")] === true;
}

function requirePositionals(min: number, max: number, label: string): void {
  if (positionals.length < min || positionals.length > max) {
    usageError(
      `${label}: expected ${min === max ? min : `${min} to ${max}`} positional argument(s)`,
      scope,
      commandArgv,
    );
  }
}

function validateInvocation(): void {
  if (
    cmd === "init" ||
    cmd === "dev" ||
    cmd === "verify" ||
    cmd === "doctor" ||
    cmd === "ci" ||
    cmd === "prepare" ||
    cmd === "queries"
  ) {
    if (cmd === "queries" && positionals[0] === "explain") {
      requirePositionals(2, 2, "queries explain");
      return;
    }
    requirePositionals(0, 0, cmd);
    return;
  }
  if (cmd === "json") {
    requirePositionals(1, 1, "json");
    if (positionals[0] !== "audit") {
      usageError(`unknown json command ${JSON.stringify(positionals[0])}`, "json", commandArgv);
    }
    return;
  }
  if (cmd === "pgschema") {
    requirePositionals(1, 1, "pgschema");
    const sub = positionals[0];
    if (sub !== "install" && sub !== "plan" && sub !== "apply") {
      usageError(`unknown pgschema command ${JSON.stringify(sub)}`, "pgschema", commandArgv);
    }
    if (passthroughArgs.length > 0 && sub !== "plan" && sub !== "apply") {
      usageError(`pgschema ${sub} does not accept arguments after --`, "pgschema", commandArgv);
    }
    return;
  }
  if (cmd === "snapshot") {
    requirePositionals(1, 1, "snapshot");
    const sub = positionals[0];
    if (sub !== "dump" && sub !== "check") {
      usageError(`unknown snapshot command ${JSON.stringify(sub)}`, "snapshot", commandArgv);
    }
    return;
  }
  const sub = positionals[0];
  if (!sub) usageError("migrate command is required", "migrate");
  if (["run", "info", "check", "revert"].includes(sub)) {
    requirePositionals(1, 1, `migrate ${sub}`);
    return;
  }
  if (sub === "add" || sub === "squash") {
    requirePositionals(2, 2, `migrate ${sub}`);
    return;
  }
  if (sub === "archive") {
    const action = positionals[1];
    if (action === "list") {
      requirePositionals(2, 2, "migrate archive list");
      if (flag("--force")) {
        usageError("--force is only supported by migrate archive restore", "migrate", commandArgv);
      }
    } else if (action === "restore") requirePositionals(3, 3, "migrate archive restore");
    else usageError(`unknown migrate archive command ${JSON.stringify(action)}`, "migrate", commandArgv);
    return;
  }
  usageError(`unknown migrate command ${JSON.stringify(sub)}`, "migrate", commandArgv);
}

validateInvocation();

const root = resolve(arg("--root", process.cwd())!);
function prepareMode(): "prepare" | "check" | "offline" | "verify" {
  return flag("--verify") ? "verify" : flag("--check") ? "check" : flag("--offline") ? "offline" : "prepare";
}

function printPrepareFailure(
  message: string,
  phase: PrepareDiagnosticPhase,
  location: { file?: string; line?: number; column?: number } = {},
): void {
  if (flag("--jsonl")) {
    console.log(JSON.stringify({
      formatVersion: 1,
      event: "error",
      timestamp: new Date().toISOString(),
      diagnostic: { severity: "error", phase, message, ...location },
    }));
  } else if (flag("--json")) {
    console.log(JSON.stringify({
      formatVersion: 1,
      ok: false,
      mode: prepareMode(),
      sites: 0,
      entries: 0,
      failures: 1,
      pruned: 0,
      functions: 0,
      enums: 0,
      diagnostics: [{ severity: "error", phase, message, ...location }],
    }, null, 2));
  } else if (!flag("--verbose")) {
    const locationText = location.file
      ? `${location.file}${location.line ? `:${location.line}:${location.column ?? 1}` : ""}`
      : "";
    const embeddedLocation = locationText ? `sqlx-js: ${locationText} — ` : "";
    const detail = embeddedLocation && message.startsWith(embeddedLocation)
      ? message.slice(embeddedLocation.length)
      : message;
    console.error(`${phase} failed: ${locationText ? `${locationText} — ` : ""}${detail}`);
    console.error(`summary: 0 warnings, 1 error (${phase}: 1)`);
  } else {
    console.error(message);
  }
}

function printJsonAuditFailure(message: string): void {
  const report = {
    formatVersion: 1,
    protocolVersion: JSON_PROTOCOL_VERSION,
    ok: false,
    complete: false,
    columns: [],
    dependencies: [],
    sourceUsages: [],
    summary: {
      columns: 0,
      scannedColumns: 0,
      collisionRows: 0,
      duplicateKeyRows: 0,
      invalidNumberRows: 0,
      errors: 1,
      dependencies: 0,
      sourceUsages: 0,
      reviewRequired: true,
    },
    diagnostics: [{ severity: "error", message }],
  } satisfies JsonAuditReport & {
    diagnostics: Array<{ severity: "error"; message: string }>;
  };
  console.log(JSON.stringify(report, null, 2));
}

function failPreflight(message: string, phase: PrepareDiagnosticPhase = "config"): never {
  if (cmd === "ci" && flag("--json")) {
    console.log(JSON.stringify({
      formatVersion: 1,
      ok: false,
      results: [{ name: "preflight", ok: false, durationMs: 0, exitCode: 2, stderr: message }],
    }, null, 2));
  } else if (cmd === "queries" && flag("--json")) {
    console.log(JSON.stringify({
      formatVersion: 1,
      ok: false,
      diagnostics: [{ severity: "error", phase, message }],
    }, null, 2));
  } else if (cmd === "json" && flag("--json")) {
    printJsonAuditFailure(message);
  } else if (cmd === "prepare") {
    printPrepareFailure(message, phase);
  } else {
    console.error(message);
  }
  process.exit(2);
}
const packageIdentityCheck = inspectPackageIdentity(root, CLI_IDENTITY);
if (
  (packageIdentityCheck.status === "mismatch" || packageIdentityCheck.status === "invalid")
  && cmd !== "doctor"
) {
  failPreflight(packageIdentityCheck.message);
}
if (cmd !== "doctor") {
  try {
    assertSupportedRuntime();
  } catch (e) {
    failPreflight((e as Error).message);
  }
}
const needsTypeScript =
  cmd === "doctor" ||
  cmd === "ci" ||
  cmd === "prepare" ||
  cmd === "queries" ||
  cmd === "json" ||
  cmd === "dev" ||
  cmd === "verify";
if (needsTypeScript) {
  let typescriptError: string | undefined;
  try {
    const typescript = (await import("typescript")).default;
    if (typeof typescript.createSourceFile !== "function") {
      typescriptError =
        "sqlx-js: TypeScript 7 does not expose the compiler API used for source scanning. " +
        "Install TypeScript 5.4–6.x with `npm install --save-dev \"typescript@>=5.4 <7\"` " +
        "or `bun add --dev \"typescript@>=5.4 <7\"`.";
    }
  } catch {
    typescriptError =
      "sqlx-js: TypeScript is required for source scanning. Install it with " +
      "`npm install --save-dev \"typescript@>=5.4 <7\"` or `bun add --dev \"typescript@>=5.4 <7\"`.";
  }
  if (typescriptError) {
    if (cmd === "doctor" && flag("--json")) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: false,
        checks: [{ name: "typescript", status: "error", message: typescriptError }],
      }, null, 2));
    } else {
      if (cmd === "ci" || cmd === "json") failPreflight(typescriptError);
      console.error(typescriptError);
    }
    process.exit(2);
  }
}
let envError: string | undefined;
const needsEnvironment =
  cmd === "doctor" ||
  cmd === "ci" ||
  cmd === "snapshot" ||
  cmd === "json" ||
  cmd === "dev" ||
  cmd === "verify" ||
  (cmd === "pgschema" && (positionals[0] === "plan" || positionals[0] === "apply")) ||
  (cmd === "prepare" && !flag("--check") && !flag("--offline")) ||
  (cmd === "migrate" && !["add", "check", "archive"].includes(positionals[0]!));
if (needsEnvironment) {
  try {
    loadRootEnv(root);
  } catch (e) {
    envError = (e as Error).message;
    if (cmd !== "doctor") {
      failPreflight(envError);
    }
  }
}
const databaseUrl = process.env.DATABASE_URL ?? "";
const shadowUrlArg = arg("--shadow-url");
const shadowAdminUrlArg = arg("--shadow-admin-url");
if (shadowUrlArg !== undefined && shadowAdminUrlArg !== undefined) {
  usageError("--shadow-url and --shadow-admin-url are mutually exclusive", scope, commandArgv);
}
const shadowUrl = shadowUrlArg ?? (shadowAdminUrlArg === undefined ? process.env.SHADOW_DATABASE_URL : undefined);
const shadowAdminUrl = shadowUrl === undefined
  ? shadowAdminUrlArg ?? process.env.SHADOW_ADMIN_DATABASE_URL
  : undefined;
const cacheDir = join(root, ".sqlx-js");
const dtsArg = arg("--dts");
const dtsPath = dtsArg ? resolve(root, dtsArg) : join(root, "sqlx-js-env.d.ts");
const migrationsDir = join(root, arg("--migrations", "migrations")!);
const schemaArg = arg("--schema");
const schemaPath = schemaArg ? resolve(root, schemaArg) : join(root, ".sqlx-js/schema/schema.json");
const manifestArg = arg("--manifest");
const manifestPath = manifestArg ? resolve(root, manifestArg) : join(root, ".sqlx-js/schema/schema.md");

function parseLockTimeout(): number | undefined {
  const raw = arg("--lock-timeout");
  const timeout = raw ? Number(raw) : undefined;
  if (timeout !== undefined && !Number.isFinite(timeout)) {
    usageError("--lock-timeout must be a finite number of milliseconds", scope, commandArgv);
  }
  return timeout;
}

function failCommand(error: unknown, exitCode = 1): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(exitCode);
}

function failJsonAudit(error: unknown, exitCode = 1): never {
  const message = error instanceof Error ? error.message : String(error);
  if (flag("--json")) printJsonAuditFailure(message);
  else console.error(message);
  process.exit(exitCode);
}

if (cmd === "init") {
  const { runInit } = await import("../src/commands/init");
  const provider = arg("--schema-provider", "builtin");
  if (provider !== "builtin" && provider !== "pgschema") {
    console.error("--schema-provider must be builtin or pgschema");
    process.exit(2);
  }
  try {
    runInit({ root, schemaProvider: provider });
  } catch (error) {
    failCommand(error);
  }
} else if (cmd === "dev" || cmd === "verify") {
  if (!databaseUrl && !shadowUrl) {
    console.error(`DATABASE_URL is required for ${cmd} (or pass --shadow-url)`);
    process.exit(2);
  }
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(root);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const lockTimeoutMs = parseLockTimeout();
  if (config.schema?.provider === "pgschema") {
    if (arg("--migrations") !== undefined || arg("--lock-timeout") !== undefined) {
      usageError("--migrations and --lock-timeout require schema.provider \"builtin\"", scope, commandArgv);
    }
    const {
      PgschemaCommandError,
      runPgschemaDev,
      runPgschemaVerify,
    } = await import("../src/commands/pgschema");
    try {
      const opts = {
        root,
        databaseUrl,
        config,
        cacheDir,
        dtsPath,
        snapshotPath: schemaPath,
        shadowUrl,
        shadowAdminUrl,
        strictInference: flag("--strict-inference"),
      };
      const ok = cmd === "dev"
        ? await runPgschemaDev({ ...opts, prune: !flag("--no-prune") })
        : await runPgschemaVerify(opts);
      if (!ok) process.exit(1);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(error instanceof PgschemaCommandError ? error.exitCode : 2);
    }
  } else {
    const { migrateDev, migrateVerify } = await import("../src/commands/migrate");
    const opts = {
      root,
      databaseUrl,
      migrationsDir,
      cacheDir,
      dtsPath,
      snapshotPath: schemaPath,
      shadowUrl,
      shadowAdminUrl,
      lockTimeoutMs,
      strictInference: flag("--strict-inference"),
    };
    try {
      if (cmd === "dev") await migrateDev({ ...opts, prune: !flag("--no-prune") });
      else await migrateVerify(opts);
    } catch (error) {
      failCommand(error);
    }
  }
} else if (cmd === "doctor") {
  const { runDoctor } = await import("../src/commands/doctor");
  try {
    await runDoctor({
      root,
      databaseUrl,
      cacheDir,
      dtsPath,
      json: flag("--json"),
      fix: flag("--fix"),
      envError,
      packageIdentityCheck,
    });
  } catch (error) {
    failCommand(error);
  }
} else if (cmd === "ci") {
  const { runCi } = await import("../src/commands/ci");
  runCi({
    executable: process.execPath,
    cliPath: fileURLToPath(import.meta.url),
    root,
    json: flag("--json"),
    shadowUrl,
    shadowAdminUrl,
    migrationsDir: arg("--migrations"),
    dtsPath: dtsArg ? dtsPath : undefined,
  });
} else if (cmd === "json") {
  if (!databaseUrl) {
    failJsonAudit("DATABASE_URL is required for json audit", 2);
  }
  const { runJsonAudit } = await import("../src/commands/json-audit");
  try {
    await runJsonAudit({
      root,
      databaseUrl,
      config: await loadConfig(root),
      json: flag("--json"),
    });
  } catch (error) {
    failJsonAudit(error);
  }
} else if (cmd === "pgschema") {
  const {
    PgschemaCommandError,
    runPgschemaCommand,
    runPgschemaInstall,
  } = await import("../src/commands/pgschema");
  const sub = positionals[0];
  const failPgschema = (error: unknown): never => {
    failCommand(error, error instanceof PgschemaCommandError ? error.exitCode : 2);
  };
  if (sub === "install") {
    try {
      await runPgschemaInstall({ root });
    } catch (e) {
      failPgschema(e);
    }
  } else {
    try {
      runPgschemaCommand({
        root,
        databaseUrl,
        config: await loadConfig(root),
        subcommand: sub as PgschemaSubcommand,
        passthrough: passthroughArgs,
      });
    } catch (e) {
      failPgschema(e);
    }
  }
} else if (cmd === "prepare") {
  const { PrepareFatalError, runPrepare } = await import("../src/commands/prepare");
  const prepareCheck = flag("--check");
  const prepareOffline = flag("--offline");
  const prepareVerify = flag("--verify");
  const prepareWatch = flag("--watch");
  const prepareJson = flag("--json");
  const prepareJsonl = flag("--jsonl");
  const prepareWarnings = flag("--warnings");
  const prepareVerbose = flag("--verbose");
  const failPrepare = (
    message: string,
    phase: PrepareDiagnosticPhase,
    exitCode = 2,
    location: { file?: string; line?: number; column?: number } = {},
  ): never => {
    printPrepareFailure(message, phase, location);
    process.exit(exitCode);
  };
  if ([prepareCheck, prepareOffline, prepareVerify, prepareWatch].filter(Boolean).length > 1) {
    failPrepare("--check, --offline, --verify, and --watch are mutually exclusive", "config");
  }
  if (prepareWatch && prepareJson) {
    failPrepare("--watch and --json are mutually exclusive", "config");
  }
  if (prepareJson && prepareJsonl) {
    failPrepare("--json and --jsonl are mutually exclusive", "config");
  }
  if ([prepareWarnings, prepareVerbose, prepareJson, prepareJsonl].filter(Boolean).length > 1) {
    failPrepare("--warnings, --verbose, --json, and --jsonl are mutually exclusive", "config");
  }
  if ((prepareWarnings || prepareVerbose) && prepareWatch) {
    failPrepare(`${prepareWarnings ? "--warnings" : "--verbose"} is unnecessary with prepare --watch`, "config");
  }
  if (prepareJsonl && !prepareWatch) {
    failPrepare("--jsonl is only supported by prepare --watch", "config");
  }
  if ((prepareCheck || prepareOffline || prepareVerify) && flag("--no-prune")) {
    failPrepare("--no-prune is only supported by live prepare and prepare --watch", "config");
  }
  if (!prepareCheck && !prepareOffline && !databaseUrl) {
    failPrepare("DATABASE_URL is required for prepare (use --check or --offline without a database)", "connect");
  }
  const opts = {
    root,
    databaseUrl,
    cacheDir,
    dtsPath,
    check: prepareCheck,
    offline: prepareOffline,
    verify: prepareVerify,
    json: prepareJson,
    warnings: prepareWarnings,
    verbose: prepareVerbose,
    prune: !flag("--no-prune"),
    strictInference: flag("--strict-inference"),
  };
  if (prepareWatch) {
    const { runWatch } = await import("../src/commands/watch");
    await runWatch({
      ...opts,
      jsonl: prepareJsonl,
    });
  } else {
    try {
      await runPrepare(opts);
    } catch (e) {
      const message = (e as Error).message;
      const phase = e instanceof PrepareFatalError
        ? e.phase
        : prepareVerify
          ? "verify"
          : "scan";
      failPrepare(
        message,
        phase,
        1,
        e instanceof PrepareFatalError
          ? { file: e.file, line: e.line, column: e.column }
          : {},
      );
    }
  }
} else if (cmd === "queries") {
  const { QueriesError, runQueries } = await import("../src/commands/queries");
  const embed = arg("--embed");
  const explainQueryId = positionals[0] === "explain" ? positionals[1] : undefined;
  if (explainQueryId && embed) usageError("--embed cannot be combined with queries explain", "queries", commandArgv);
  try {
    await runQueries({
      root,
      cacheDir,
      json: flag("--json"),
      embedPath: embed ? resolve(root, embed) : undefined,
      explainQueryId,
    });
  } catch (error) {
    if (flag("--json")) {
      const diagnostic = error instanceof QueriesError
        ? {
            severity: "error",
            phase: error.phase,
            message: error.message,
            ...(error.file === undefined ? {} : { file: error.file }),
            ...(error.line === undefined ? {} : { line: error.line }),
            ...(error.column === undefined ? {} : { column: error.column }),
          }
        : { severity: "error", phase: "scan", message: (error as Error).message };
      console.log(JSON.stringify({ formatVersion: 1, ok: false, diagnostics: [diagnostic] }, null, 2));
    } else {
      console.error((error as Error).message);
    }
    process.exit(2);
  }
} else if (cmd === "snapshot") {
  const { runSchemaCheck, runSchemaDump } = await import("../src/commands/schema");
  const sub = positionals[0];
  const schemaDatabaseUrl = shadowUrlArg ?? databaseUrl;
  if (!schemaDatabaseUrl) {
    console.error("DATABASE_URL is required for snapshot commands (or pass --shadow-url)");
    process.exit(2);
  }
  const opts = {
    databaseUrl: schemaDatabaseUrl,
    cacheDir,
    snapshotPath: schemaPath,
    manifestPath,
    writeManifest: !flag("--no-manifest"),
  };
  try {
    if (sub === "dump") await runSchemaDump(opts);
    else if (sub === "check") await runSchemaCheck(opts);
  } catch (error) {
    failCommand(error);
  }
} else if (cmd === "migrate") {
  const {
    migrateArchiveList,
    migrateArchiveRestore,
    migrateCheck,
    migrateRun,
    migrateInfo,
    migrateRevert,
    migrateAdd,
    migrateSquash,
  } = await import("../src/commands/migrate");
  const sub = positionals[0];
  const revertDryRun = sub === "revert" && flag("--dry-run");
  const workflowShadowOnly = (sub === "squash" && !!shadowUrl) || (revertDryRun && !!shadowUrl);
  if (!databaseUrl && sub !== "add" && sub !== "check" && sub !== "archive" && !workflowShadowOnly) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const lockTimeoutMs = parseLockTimeout();
  try {
    if (sub === "run") {
      await migrateRun({ databaseUrl, migrationsDir, lockTimeoutMs, dryRun: flag("--dry-run"), json: flag("--json") });
    } else if (sub === "info") {
      await migrateInfo({ databaseUrl, migrationsDir, json: flag("--json") });
    } else if (sub === "check") {
      migrateCheck({ migrationsDir, json: flag("--json") });
    } else if (sub === "revert") {
      await migrateRevert({
        databaseUrl,
        migrationsDir,
        lockTimeoutMs,
        dryRun: flag("--dry-run"),
        shadowUrl,
        shadowAdminUrl,
        json: flag("--json"),
      });
    } else if (sub === "add") {
      const name = positionals[1]!;
      migrateAdd({ databaseUrl, migrationsDir, name });
    } else if (sub === "squash") {
      const name = positionals[1]!;
      await migrateSquash({
        databaseUrl,
        migrationsDir,
        name,
        shadowUrl,
        shadowAdminUrl,
        replace: flag("--replace"),
        pgDumpPath: arg("--pg-dump"),
        lockTimeoutMs,
      });
    } else if (sub === "archive") {
      const action = positionals[1];
      if (action === "list") {
        migrateArchiveList({ migrationsDir });
      } else if (action === "restore") {
        const name = positionals[2]!;
        migrateArchiveRestore({ migrationsDir, name, force: flag("--force") });
      }
    }
  } catch (error) {
    failCommand(error);
  }
} else {
  usageError(`unknown command ${JSON.stringify(cmd)}`);
}
