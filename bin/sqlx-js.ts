#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPrepare } from "../src/commands/prepare";
import { runWatch } from "../src/commands/watch";
import {
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
} from "../src/commands/migrate";
import { applyShadowMigrations, runSchemaCheck, runSchemaDump } from "../src/commands/schema";
import { runInit } from "../src/commands/init";
import { runPgschemaCommand, runPgschemaInstall, type PgschemaSubcommand } from "../src/commands/pgschema";
import { loadConfig } from "../src/config";

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

function help(): never {
  console.error(`sqlx-js — compile-time-checked SQL for TypeScript + Postgres (v${VERSION})

usage:
  sqlx-js init [--root <dir>] [--schema-provider builtin|pgschema]
  sqlx-js db install | check | plan | apply [--root <dir>] [-- <pgschema args>]
  sqlx-js prepare [--check | --watch] [--root <dir>] [--dts <path>] [--no-prune] [--shadow-url <url>]
  sqlx-js migrate dev [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] | verify [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] | run [--dry-run] [--json] [--lock-timeout <ms>] | info [--json] | check [--json] | revert [--dry-run] [--json] [--shadow-admin-url <url> | --shadow-url <url>] [--lock-timeout <ms>] | add <name> | squash <name> [--shadow-admin-url <url> | --shadow-url <url>] [--replace] [--pg-dump <path>] [--lock-timeout <ms>] | archive list | archive restore <name> [--force]
  sqlx-js schema dump | check [--schema <path>] [--manifest <path>] [--no-manifest] [--shadow-url <url>]
  sqlx-js --version

env:
  DATABASE_URL=postgres://...  (supports sslmode, cert paths, application_name, connect_timeout, statement_timeout)
  SHADOW_DATABASE_URL=postgres://...  (optional pre-created disposable shadow DB)
  SHADOW_ADMIN_DATABASE_URL=postgres://...  (optional admin URL for auto-created shadow DBs)

flags:
  --root <dir>             scan root (default: cwd)
  --dts <path>             declarations output (default: <root>/sqlx-js-env.d.ts)
  --check                  offline mode: verify scanned queries exist in cache, no DB
  --watch                  re-prepare on file change (persistent PG connection)
  --no-prune               keep orphaned cache entries (default: remove)
  --migrations <dir>       migrations directory (default: <root>/migrations)
  --dry-run                validate and print migrate run/revert plan without applying migrations
  --json                   machine-readable output for migrate info/check and migrate run/revert --dry-run
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
`);
  process.exit(2);
}

const passthroughIndex = process.argv.indexOf("--");
const cliArgv = passthroughIndex >= 0 ? process.argv.slice(0, passthroughIndex) : process.argv;
const passthroughArgs = passthroughIndex >= 0 ? process.argv.slice(passthroughIndex + 1) : [];

function arg(name: string, def?: string): string | undefined {
  const eq = `${name}=`;
  for (let i = 0; i < cliArgv.length; i++) {
    const a = cliArgv[i]!;
    if (a === name) return cliArgv[i + 1] ?? def;
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return def;
}

function flag(name: string): boolean {
  for (const a of cliArgv) {
    if (a === name) return true;
  }
  return false;
}

const cmd = process.argv[2];

if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (cmd === "--help" || cmd === "-h" || !cmd) {
  help();
}

const root = resolve(arg("--root", process.cwd())!);
const databaseUrl = process.env.DATABASE_URL ?? "";
const shadowUrlArg = arg("--shadow-url");
const shadowUrl = shadowUrlArg ?? process.env.SHADOW_DATABASE_URL;
const shadowAdminUrl = arg("--shadow-admin-url") ?? process.env.SHADOW_ADMIN_DATABASE_URL;
const cacheDir = join(root, ".sqlx-js");
const dtsArg = arg("--dts");
const dtsPath = dtsArg ? resolve(dtsArg) : join(root, "sqlx-js-env.d.ts");
const migrationsDir = join(root, arg("--migrations", "migrations")!);
const schemaArg = arg("--schema");
const schemaPath = schemaArg ? resolve(schemaArg) : join(root, ".sqlx-js/schema/schema.json");
const manifestArg = arg("--manifest");
const manifestPath = manifestArg ? resolve(manifestArg) : join(root, ".sqlx-js/schema/schema.md");

if (cmd === "init") {
  const provider = arg("--schema-provider", "builtin");
  if (provider !== "builtin" && provider !== "pgschema") {
    console.error("--schema-provider must be builtin or pgschema");
    process.exit(2);
  }
  runInit({ root, schemaProvider: provider });
} else if (cmd === "db") {
  const sub = process.argv[3];
  if (sub === "install") {
    try {
      await runPgschemaInstall({ root });
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
  } else {
    if (sub !== "check" && sub !== "plan" && sub !== "apply") help();
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
  if (flag("--check") && shadowUrlArg) {
    console.error("--shadow-url cannot be used with prepare --check; use live prepare or schema check --shadow-url");
    process.exit(2);
  }
  const prepareShadowUrl = flag("--check") ? undefined : shadowUrl;
  const prepareDatabaseUrl = prepareShadowUrl ?? databaseUrl;
  if (!flag("--check") && !prepareDatabaseUrl) {
    console.error("DATABASE_URL is required for prepare (use --check for offline)");
    process.exit(2);
  }
  const opts = {
    root,
    databaseUrl: prepareDatabaseUrl,
    cacheDir,
    dtsPath,
    check: flag("--check"),
    prune: !flag("--no-prune"),
  };
  if (flag("--watch")) {
    if (flag("--check")) {
      console.error("--watch and --check are mutually exclusive");
      process.exit(2);
    }
    await runWatch({
      ...opts,
      ...(prepareShadowUrl
        ? {
            beforePrepare: async () => {
              const result = await applyShadowMigrations(prepareShadowUrl, migrationsDir);
              return { resetSession: result.applied > 0 };
            },
          }
        : {}),
    });
  } else {
    if (prepareShadowUrl) await applyShadowMigrations(prepareShadowUrl, migrationsDir);
    await runPrepare(opts);
  }
} else if (cmd === "schema") {
  const sub = process.argv[3];
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
  else help();
} else if (cmd === "migrate") {
  const sub = process.argv[3];
  const revertDryRun = sub === "revert" && flag("--dry-run");
  const workflowShadowOnly = ((sub === "dev" || sub === "verify" || sub === "squash") && !!shadowUrl) || (revertDryRun && !!shadowUrl);
  if (!databaseUrl && sub !== "add" && sub !== "check" && sub !== "squash" && sub !== "archive" && !workflowShadowOnly) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const tRaw = arg("--lock-timeout");
  const lockTimeoutMs = tRaw ? Number(tRaw) : undefined;
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
    });
  } else if (sub === "run") {
    await migrateRun({ databaseUrl, migrationsDir, lockTimeoutMs, dryRun: flag("--dry-run"), json: flag("--json") });
  } else if (sub === "info") await migrateInfo({ databaseUrl, migrationsDir, json: flag("--json") });
  else if (sub === "check") migrateCheck({ migrationsDir, json: flag("--json") });
  else if (sub === "revert") {
    await migrateRevert({
      databaseUrl,
      migrationsDir,
      lockTimeoutMs,
      dryRun: flag("--dry-run"),
      shadowUrl,
      shadowAdminUrl,
      json: flag("--json"),
    });
  }
  else if (sub === "add") {
    const name = process.argv[4];
    if (!name) { console.error("migrate add: name required"); process.exit(2); }
    migrateAdd({ databaseUrl, migrationsDir, name });
  } else if (sub === "squash") {
    const name = process.argv[4];
    if (!name) { console.error("migrate squash: name required"); process.exit(2); }
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
    const action = process.argv[4];
    if (action === "list") migrateArchiveList({ migrationsDir });
    else if (action === "restore") {
      const name = process.argv[5];
      if (!name) { console.error("migrate archive restore: name required"); process.exit(2); }
      migrateArchiveRestore({ migrationsDir, name, force: flag("--force") });
    } else help();
  } else help();
} else {
  help();
}
