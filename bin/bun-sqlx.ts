#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { runPrepare } from "../src/commands/prepare";
import { runWatch } from "../src/commands/watch";
import { migrateRun, migrateInfo, migrateRevert, migrateAdd } from "../src/commands/migrate";
import pkg from "../package.json";

const VERSION = pkg.version;

function help(): never {
  console.error(`bun-sqlx — compile-time-checked SQL for Bun + Postgres (v${VERSION})

usage:
  bun-sqlx prepare [--check | --watch] [--root <dir>] [--dts <path>] [--no-prune]
  bun-sqlx migrate run [--lock-timeout <ms>] | info | revert [--lock-timeout <ms>] | add <name>
  bun-sqlx --version

env:
  DATABASE_URL=postgres://...  (supports ?sslmode=require|verify-ca|verify-full)

flags:
  --root <dir>             scan root (default: cwd)
  --dts <path>             declarations output (default: <root>/bun-sqlx-env.d.ts)
  --check                  offline mode: validate cache vs sources, no DB
  --watch                  re-prepare on file change (persistent PG connection)
  --no-prune               keep orphaned cache entries (default: remove)
  --migrations <dir>       migrations directory (default: <root>/migrations)
  --lock-timeout <ms>      advisory-lock acquisition timeout for migrate run/revert
`);
  process.exit(2);
}

function arg(name: string, def?: string): string | undefined {
  const argv = process.argv;
  const eq = `${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === name) return argv[i + 1] ?? def;
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return def;
}

function flag(name: string): boolean {
  for (const a of process.argv) {
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
const cacheDir = join(root, ".bun-sqlx");
const dtsArg = arg("--dts");
const dtsPath = dtsArg ? resolve(dtsArg) : join(root, "bun-sqlx-env.d.ts");
const migrationsDir = join(root, arg("--migrations", "migrations")!);

if (cmd === "prepare") {
  if (!flag("--check") && !databaseUrl) {
    console.error("DATABASE_URL is required for prepare (use --check for offline)");
    process.exit(2);
  }
  const opts = {
    root,
    databaseUrl,
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
    await runWatch(opts);
  } else {
    await runPrepare(opts);
  }
} else if (cmd === "migrate") {
  const sub = process.argv[3];
  if (!databaseUrl && sub !== "add") {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const tRaw = arg("--lock-timeout");
  const lockTimeoutMs = tRaw ? Number(tRaw) : undefined;
  if (sub === "run") {
    await migrateRun({ databaseUrl, migrationsDir, lockTimeoutMs });
  } else if (sub === "info") await migrateInfo({ databaseUrl, migrationsDir });
  else if (sub === "revert") await migrateRevert({ databaseUrl, migrationsDir, lockTimeoutMs });
  else if (sub === "add") {
    const name = process.argv[4];
    if (!name) { console.error("migrate add: name required"); process.exit(2); }
    migrateAdd({ databaseUrl, migrationsDir, name });
  } else help();
} else {
  help();
}
