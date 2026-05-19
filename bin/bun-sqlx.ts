#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { runPrepare } from "../src/commands/prepare";
import { runWatch } from "../src/commands/watch";
import { migrateRun, migrateInfo, migrateRevert, migrateAdd } from "../src/commands/migrate";

function help(): never {
  console.error(`bun-sqlx — compile-time-checked SQL for Bun + Postgres

usage:
  bun-sqlx prepare [--check | --watch] [--root <dir>] [--dts <path>] [--no-prune]
  bun-sqlx migrate run | info | revert | add <name>

env:
  DATABASE_URL=postgres://...

flags:
  --root <dir>     scan root (default: cwd)
  --dts <path>     declarations output (default: <root>/bun-sqlx-env.d.ts)
  --check          offline mode: validate cache vs sources, no DB
  --watch          re-prepare on file change (persistent PG connection)
  --no-prune       keep orphaned cache entries (default: remove)
`);
  process.exit(2);
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  return process.argv[i + 1] ?? def;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const cmd = process.argv[2];
const root = resolve(arg("--root", process.cwd())!);
const databaseUrl = process.env.DATABASE_URL ?? "";
const cacheDir = join(root, ".bun-sqlx");
const dtsPath = arg("--dts") ? resolve(arg("--dts")!) : join(root, "bun-sqlx-env.d.ts");
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
  if (!databaseUrl && process.argv[3] !== "add") {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const sub = process.argv[3];
  if (sub === "run") await migrateRun({ databaseUrl, migrationsDir });
  else if (sub === "info") await migrateInfo({ databaseUrl, migrationsDir });
  else if (sub === "revert") await migrateRevert({ databaseUrl, migrationsDir });
  else if (sub === "add") {
    const name = process.argv[4];
    if (!name) { console.error("migrate add: name required"); process.exit(2); }
    migrateAdd({ databaseUrl, migrationsDir, name });
  } else help();
} else {
  help();
}
