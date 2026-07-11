#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { PrepareDiagnosticPhase } from "../src/commands/prepare";
import type { PgschemaSubcommand } from "../src/commands/pgschema";
import { assertSupportedRuntime, loadConfig, loadRootEnv } from "../src/config";

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(here, "../package.json"), join(here, "../../package.json")]) {
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  }
  throw new Error("sqlx-js: cannot locate package.json for version");
}

const VERSION = packageVersion();

type HelpScope = "root" | "init" | "doctor" | "ci" | "db" | "prepare" | "migrate" | "schema";

const HELP: Record<HelpScope, string> = {
  root: `sqlx-js — compile-time-checked SQL for TypeScript + Postgres (v${VERSION})

usage:
  sqlx-js init [--root <dir>] [--schema-provider builtin|pgschema]
  sqlx-js doctor [--root <dir>] [--dts <path>] [--json]
  sqlx-js ci [--root <dir>] [--json] [--shadow-url <url>] [--shadow-admin-url <url>]
  sqlx-js db install | check [--root <dir>]
  sqlx-js db plan | apply [--root <dir>] [-- <pgschema args>]
  sqlx-js prepare [--check | --offline | --verify | --watch] [--json | --jsonl] [--strict-inference] [--root <dir>] [--dts <path>] [--no-prune] [--shadow-url <url>]
  sqlx-js migrate dev [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] [--strict-inference] | verify [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] [--strict-inference] | run [--dry-run] [--json] [--lock-timeout <ms>] | info [--json] | check [--json] | revert [--dry-run] [--json] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] | add <name> | squash <name> [--shadow-admin-url <url> | --shadow-url <url>] [--replace] [--pg-dump <path>] [--lock-timeout <ms>] | archive list | archive restore <name> [--force]
  sqlx-js schema dump [--schema <path>] [--manifest <path>] [--no-manifest] [--shadow-url <url>]
  sqlx-js schema check [--schema <path>] [--shadow-url <url>]
  sqlx-js --version
  sqlx-js-diagnostics github|unix < prepare-diagnostics.json

env:
  DATABASE_URL=postgres://...  (supports sslmode, cert paths, application_name, options, connect_timeout, statement_timeout)
  SHADOW_DATABASE_URL=postgres://...  (optional pre-created disposable shadow DB)
  SHADOW_ADMIN_DATABASE_URL=postgres://...  (optional admin URL for auto-created shadow DBs)

flags:
  --root <dir>             scan root (default: cwd)
  --dts <path>             declarations output (default: <root>/sqlx-js-env.d.ts)
  --check                  read-only offline verification of cache and declarations
  --offline                regenerate declarations from committed cache, no DB
  --verify                 prepare against DB/shadow and compare committed generated artifacts
  --watch                  re-prepare on file change (persistent PG connection)
  --no-prune               keep orphaned cache entries (default: remove)
  --migrations <dir>       migrations directory (default: <root>/migrations)
  --dry-run                validate and print migrate run/revert plan without applying migrations
  --json                   machine-readable output for prepare and migration inspection/dry-run commands
  --jsonl                  streaming machine-readable output for prepare --watch
  --strict-inference       fail when query inference degrades or emits unknown types
  --force                  allow archive restore to overwrite existing migration files
  --lock-timeout <ms>      advisory-lock acquisition timeout for migrate run/revert/dev/verify/squash
  --shadow-url <url>       use an existing disposable shadow DB instead of auto-creating one
  --shadow-admin-url <url> admin/maintenance DB URL used to auto-create shadow DBs
  --replace                archive replaced migrations after migrate squash writes the baseline
  --pg-dump <path>         pg_dump executable for migrate squash (default: pg_dump)
  --schema <path>          schema snapshot path (default: <root>/.sqlx-js/schema/schema.json)
  --manifest <path>        LLM schema manifest path (default: <root>/.sqlx-js/schema/schema.md)
  --no-manifest            skip writing the LLM schema manifest during schema dump
  --schema-provider <name> init schema workflow: builtin (default) or pgschema
`,
  init: `usage: sqlx-js init [--root <dir>] [--schema-provider builtin|pgschema]`,
  doctor: `usage: sqlx-js doctor [--root <dir>] [--dts <path>] [--json]`,
  ci: `usage: sqlx-js ci [--root <dir>] [--json] [--shadow-url <url>] [--shadow-admin-url <url>] [--migrations <dir>]`,
  db: `usage: sqlx-js db install | check [--root <dir>] | plan | apply [--root <dir>] [-- <pgschema args>]`,
  prepare: `usage: sqlx-js prepare [--check | --offline | --verify | --watch] [--json | --jsonl] [--strict-inference] [--root <dir>] [--dts <path>] [--no-prune] [--shadow-url <url>]`,
  migrate: `usage: sqlx-js migrate dev [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] [--strict-inference] | verify [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] [--strict-inference] | run [--dry-run] [--json] [--lock-timeout <ms>] | info [--json] | check [--json] | revert [--dry-run] [--json] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] | add <name> | squash <name> [--shadow-admin-url <url> | --shadow-url <url>] [--replace] [--pg-dump <path>] [--lock-timeout <ms>] | archive list | archive restore <name> [--force]`,
  schema: `usage: sqlx-js schema dump [--schema <path>] [--manifest <path>] [--no-manifest] [--shadow-url <url>] | check [--schema <path>] [--shadow-url <url>]`,
};

function printHelp(scope: HelpScope, error = false): void {
  (error ? console.error : console.log)(HELP[scope]);
}

function exitHelp(scope: HelpScope): never {
  printHelp(scope);
  process.exit(0);
}

function usageError(message: string, scope: HelpScope = "root"): never {
  console.error(`sqlx-js: ${message}`);
  printHelp(scope, true);
  process.exit(2);
}

const rawArgv = process.argv.slice(2);
const passthroughIndex = rawArgv.indexOf("--");
const cliArgv = passthroughIndex >= 0 ? rawArgv.slice(0, passthroughIndex) : rawArgv;
const passthroughArgs = passthroughIndex >= 0 ? rawArgv.slice(passthroughIndex + 1) : [];
const cmd = cliArgv[0];

const scopes = new Set<HelpScope>(["init", "doctor", "ci", "db", "prepare", "migrate", "schema"]);

if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (!cmd || cmd === "--help" || cmd === "-h") exitHelp("root");
if (!scopes.has(cmd as HelpScope)) usageError(`unknown command ${JSON.stringify(cmd)}`);
const scope = cmd as Exclude<HelpScope, "root">;
if (cliArgv.includes("--help") || cliArgv.includes("-h")) exitHelp(scope);
if (passthroughIndex >= 0 && cmd !== "db") usageError("arguments after -- are only supported by sqlx-js db", scope);

const ROOT_OPTIONS: ParseArgsOptionsConfig = {
  root: { type: "string" },
  help: { type: "boolean", short: "h" },
};

function optionsFor(command: string, subcommand?: string): ParseArgsOptionsConfig {
  if (command === "init") return { ...ROOT_OPTIONS, "schema-provider": { type: "string" } };
  if (command === "doctor") return { ...ROOT_OPTIONS, dts: { type: "string" }, json: { type: "boolean" } };
  if (command === "ci") return {
    ...ROOT_OPTIONS,
    json: { type: "boolean" },
    migrations: { type: "string" },
    "shadow-url": { type: "string" },
    "shadow-admin-url": { type: "string" },
  };
  if (command === "db") return ROOT_OPTIONS;
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
      "no-prune": { type: "boolean" },
      "shadow-url": { type: "string" },
      migrations: { type: "string" },
      "strict-inference": { type: "boolean" },
    };
  }
  if (command === "schema") {
    const common = {
      ...ROOT_OPTIONS,
      schema: { type: "string" },
      "shadow-url": { type: "string" },
      migrations: { type: "string" },
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
  if (subcommand === "dev") {
    return {
      ...common,
      "shadow-admin-url": { type: "string" },
      "shadow-url": { type: "string" },
      "lock-timeout": { type: "string" },
      "no-prune": { type: "boolean" },
      "strict-inference": { type: "boolean" },
    };
  }
  if (subcommand === "verify") {
    return {
      ...common,
      "shadow-admin-url": { type: "string" },
      "shadow-url": { type: "string" },
      "lock-timeout": { type: "string" },
      "strict-inference": { type: "boolean" },
    };
  }
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

const commandArgv = cliArgv.slice(1);
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
  usageError((error as Error).message, scope);
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
    usageError(`${label}: expected ${min === max ? min : `${min} to ${max}`} positional argument(s)`, scope);
  }
}

function validateInvocation(): void {
  if (cmd === "init" || cmd === "doctor" || cmd === "ci" || cmd === "prepare") {
    requirePositionals(0, 0, cmd);
    return;
  }
  if (cmd === "db") {
    requirePositionals(1, 1, "db");
    const sub = positionals[0];
    if (sub !== "install" && sub !== "check" && sub !== "plan" && sub !== "apply") {
      usageError(`unknown db command ${JSON.stringify(sub)}`, "db");
    }
    if (passthroughArgs.length > 0 && sub !== "plan" && sub !== "apply") {
      usageError(`db ${sub} does not accept arguments after --`, "db");
    }
    return;
  }
  if (cmd === "schema") {
    requirePositionals(1, 1, "schema");
    const sub = positionals[0];
    if (sub !== "dump" && sub !== "check") usageError(`unknown schema command ${JSON.stringify(sub)}`, "schema");
    return;
  }
  const sub = positionals[0];
  if (!sub) usageError("migrate command is required", "migrate");
  if (["dev", "verify", "run", "info", "check", "revert"].includes(sub)) {
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
      if (flag("--force")) usageError("--force is only supported by migrate archive restore", "migrate");
    } else if (action === "restore") requirePositionals(3, 3, "migrate archive restore");
    else usageError(`unknown migrate archive command ${JSON.stringify(action)}`, "migrate");
    return;
  }
  usageError(`unknown migrate command ${JSON.stringify(sub)}`, "migrate");
}

validateInvocation();

const root = resolve(arg("--root", process.cwd())!);
if (cmd !== "doctor") {
  try {
    assertSupportedRuntime();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
const needsTypeScript =
  cmd === "doctor" ||
  cmd === "ci" ||
  cmd === "prepare" ||
  (cmd === "migrate" && (positionals[0] === "dev" || positionals[0] === "verify"));
if (needsTypeScript) {
  try {
    import.meta.resolve("typescript");
  } catch {
    const message = "sqlx-js: TypeScript is required for source scanning. Install it with `npm install --save-dev typescript` or `bun add --dev typescript`.";
    if (cmd === "doctor" && flag("--json")) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: false,
        checks: [{ name: "typescript", status: "error", message }],
      }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(2);
  }
}
let envError: string | undefined;
const needsEnvironment =
  cmd === "doctor" ||
  cmd === "ci" ||
  cmd === "schema" ||
  (cmd === "db" && (positionals[0] === "plan" || positionals[0] === "apply")) ||
  (cmd === "prepare" && !flag("--check") && !flag("--offline")) ||
  (cmd === "migrate" && !["add", "check", "archive"].includes(positionals[0]!));
if (needsEnvironment) {
  try {
    loadRootEnv(root);
  } catch (e) {
    envError = (e as Error).message;
    if (cmd !== "doctor") {
      console.error(envError);
      process.exit(2);
    }
  }
}
const databaseUrl = process.env.DATABASE_URL ?? "";
const shadowUrlArg = arg("--shadow-url");
const shadowUrl = shadowUrlArg ?? process.env.SHADOW_DATABASE_URL;
const shadowAdminUrl = arg("--shadow-admin-url") ?? process.env.SHADOW_ADMIN_DATABASE_URL;
const cacheDir = join(root, ".sqlx-js");
const dtsArg = arg("--dts");
const dtsPath = dtsArg ? resolve(root, dtsArg) : join(root, "sqlx-js-env.d.ts");
const migrationsDir = join(root, arg("--migrations", "migrations")!);
const schemaArg = arg("--schema");
const schemaPath = schemaArg ? resolve(root, schemaArg) : join(root, ".sqlx-js/schema/schema.json");
const manifestArg = arg("--manifest");
const manifestPath = manifestArg ? resolve(root, manifestArg) : join(root, ".sqlx-js/schema/schema.md");

if (cmd === "init") {
  const { runInit } = await import("../src/commands/init");
  const provider = arg("--schema-provider", "builtin");
  if (provider !== "builtin" && provider !== "pgschema") {
    console.error("--schema-provider must be builtin or pgschema");
    process.exit(2);
  }
  runInit({ root, schemaProvider: provider });
} else if (cmd === "doctor") {
  const { runDoctor } = await import("../src/commands/doctor");
  await runDoctor({ root, databaseUrl, cacheDir, dtsPath, json: flag("--json"), envError });
} else if (cmd === "ci") {
  const { runCi } = await import("../src/commands/ci");
  runCi({
    executable: process.execPath,
    cliPath: fileURLToPath(import.meta.url),
    root,
    config: await loadConfig(root),
    schemaPath,
    json: flag("--json"),
    shadowUrl,
    shadowAdminUrl,
    migrationsDir: arg("--migrations"),
  });
} else if (cmd === "db") {
  const { runPgschemaCommand, runPgschemaInstall } = await import("../src/commands/pgschema");
  const sub = positionals[0];
  if (sub === "install") {
    try {
      await runPgschemaInstall({ root });
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
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
      console.error((e as Error).message);
      process.exit(2);
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
  const prepareMode = prepareVerify ? "verify" : prepareCheck ? "check" : prepareOffline ? "offline" : "prepare";
  const failPrepare = (
    message: string,
    phase: PrepareDiagnosticPhase,
    exitCode = 2,
    location: { file?: string; line?: number; column?: number } = {},
  ): never => {
    if (prepareJsonl) {
      console.log(JSON.stringify({
        formatVersion: 1,
        event: "error",
        timestamp: new Date().toISOString(),
        diagnostic: { severity: "error", phase, message, ...location },
      }));
    } else if (prepareJson) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: false,
        mode: prepareMode,
        sites: 0,
        entries: 0,
        failures: 1,
        pruned: 0,
        functions: 0,
        diagnostics: [{ severity: "error", phase, message, ...location }],
      }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(exitCode);
  };
  if ([prepareCheck, prepareOffline, prepareVerify, prepareWatch].filter(Boolean).length > 1) {
    failPrepare("--check, --offline, --verify, and --watch are mutually exclusive", "config");
  }
  if ((prepareCheck || prepareOffline) && shadowUrlArg) {
    failPrepare(
      "--shadow-url cannot be used with offline prepare modes; use live prepare or schema check --shadow-url",
      "config",
    );
  }
  if (prepareWatch && prepareJson) {
    failPrepare("--watch and --json are mutually exclusive", "config");
  }
  if (prepareJson && prepareJsonl) {
    failPrepare("--json and --jsonl are mutually exclusive", "config");
  }
  if (prepareJsonl && !prepareWatch) {
    failPrepare("--jsonl is only supported by prepare --watch", "config");
  }
  if ((prepareCheck || prepareOffline || prepareVerify) && flag("--no-prune")) {
    failPrepare("--no-prune is only supported by live prepare and prepare --watch", "config");
  }
  const prepareShadowUrl = prepareCheck || prepareOffline ? undefined : shadowUrl;
  const prepareDatabaseUrl = prepareShadowUrl ?? databaseUrl;
  if (!prepareCheck && !prepareOffline && !prepareDatabaseUrl) {
    failPrepare("DATABASE_URL is required for prepare (use --check or --offline without a database)", "connect");
  }
  const opts = {
    root,
    databaseUrl: prepareDatabaseUrl,
    cacheDir,
    dtsPath,
    check: prepareCheck,
    offline: prepareOffline,
    verify: prepareVerify,
    json: prepareJson,
    prune: !flag("--no-prune"),
    strictInference: flag("--strict-inference"),
  };
  const applyShadowMigrations = prepareShadowUrl
    ? (await import("../src/commands/schema")).applyShadowMigrations
    : undefined;
  if (prepareWatch) {
    const { runWatch } = await import("../src/commands/watch");
    await runWatch({
      ...opts,
      jsonl: prepareJsonl,
      ...(prepareShadowUrl
        ? {
            beforePrepare: async () => {
              const result = await applyShadowMigrations!(prepareShadowUrl, migrationsDir);
              return { resetSession: result.applied > 0 };
            },
          }
        : {}),
    });
  } else {
    if (prepareShadowUrl) {
      try {
        await applyShadowMigrations!(
          prepareShadowUrl,
          migrationsDir,
          prepareJson ? () => {} : console.log,
        );
      } catch (e) {
        failPrepare((e as Error).message, "shadow", 1);
      }
    }
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
} else if (cmd === "schema") {
  const { runSchemaCheck, runSchemaDump } = await import("../src/commands/schema");
  const sub = positionals[0];
  const schemaDatabaseUrl = shadowUrl ?? databaseUrl;
  if (!schemaDatabaseUrl) {
    console.error("DATABASE_URL is required for schema commands (or pass --shadow-url)");
    process.exit(2);
  }
  const opts = {
    databaseUrl,
    snapshotPath: schemaPath,
    manifestPath,
    writeManifest: !flag("--no-manifest"),
    shadowUrl,
    migrationsDir,
  };
  if (sub === "dump") await runSchemaDump(opts);
  else if (sub === "check") await runSchemaCheck(opts);
} else if (cmd === "migrate") {
  const {
    migrateArchiveList,
    migrateArchiveRestore,
    migrateCheck,
    migrateDev,
    migrateRun,
    migrateInfo,
    migrateRevert,
    migrateAdd,
    migrateSquash,
    migrateVerify,
  } = await import("../src/commands/migrate");
  const sub = positionals[0];
  const revertDryRun = sub === "revert" && flag("--dry-run");
  const workflowShadowOnly = ((sub === "dev" || sub === "verify" || sub === "squash") && !!shadowUrl) || (revertDryRun && !!shadowUrl);
  if (!databaseUrl && sub !== "add" && sub !== "check" && sub !== "archive" && !workflowShadowOnly) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const tRaw = arg("--lock-timeout");
  const lockTimeoutMs = tRaw ? Number(tRaw) : undefined;
  if (lockTimeoutMs !== undefined && !Number.isFinite(lockTimeoutMs)) {
    usageError("--lock-timeout must be a finite number of milliseconds", "migrate");
  }
  if (sub === "dev") {
    await migrateDev({
      root,
      databaseUrl,
      migrationsDir,
      cacheDir,
      dtsPath,
      prune: !flag("--no-prune"),
      shadowUrl,
      shadowAdminUrl,
      lockTimeoutMs,
      strictInference: flag("--strict-inference"),
    });
  } else if (sub === "verify") {
    await migrateVerify({
      root,
      databaseUrl,
      migrationsDir,
      cacheDir,
      dtsPath,
      shadowUrl,
      shadowAdminUrl,
      lockTimeoutMs,
      strictInference: flag("--strict-inference"),
    });
  } else if (sub === "run") {
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
} else {
  usageError(`unknown command ${JSON.stringify(cmd)}`);
}
