import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { PgClient, parseDatabaseUrl } from "../pg/wire";
import {
  DEFAULT_MIGRATE_LOCK_KEY,
  SQUASH_PREFIX,
  acquireMigrateLock,
  applyPending,
  buildMigrationPlan,
  effectiveSquashReplacements,
  ensureTable,
  inspectMigrationPlan,
  inspectMigrations,
  listApplied,
  parseSquashMetadata,
  planPending,
  readMigrations,
  releaseMigrateLock,
  resetMigrationSession,
  type MigrationFile,
  type MigrationValidationOutcome,
  type SquashMetadata,
  type SquashReplacement,
} from "../migration-core";
import {
  introspectConnected,
  schemaSnapshotEqual,
  type SchemaFunctionSnapshot,
  type SchemaRelationSnapshot,
  type SchemaSnapshot,
  type SchemaTypeSnapshot,
} from "../schema-snapshot";
import {
  isolateShadowDatabase,
  withDryRunShadowDatabase,
  withWorkflowShadowDatabase,
} from "./shadow";
import { runSchemaWorkflow } from "./schema-workflow";
import {
  createSquashMigration,
  dumpSchema,
  listMigrationArchives,
  restoreMigrationArchive,
  safeMigrationName,
} from "./migration-files";

export * from "../migration-core";
export * from "./migration-files";

export type MigrateOptions = {
  databaseUrl: string;
  migrationsDir: string;
};

export type MigrationWorkflowOptions = MigrateOptions & {
  root: string;
  cacheDir: string;
  dtsPath: string;
  snapshotPath: string;
  prune?: boolean;
  shadowUrl?: string;
  shadowAdminUrl?: string;
  lockKey?: number | bigint;
  lockTimeoutMs?: number;
  strictInference?: boolean;
};

const FILE_RE = /^(\d+)_(.+)\.up\.sql$/;
const DOWN_FILE_RE = /^(\d+)_(.+)\.down\.sql$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export type MigrationCheckIssue = {
  severity: "error";
  code:
    | "invalid-file-name"
    | "invalid-version"
    | "duplicate-version"
    | "orphan-down"
    | "invalid-squash-metadata"
    | "invalid-squash-replacement"
    | "tampered-squash-replacement";
  message: string;
  file?: string;
  version?: number;
  name?: string;
};

export type MigrationCheckReport = {
  ok: boolean;
  migrations: number;
  archives: number;
  issues: MigrationCheckIssue[];
};

export type SchemaObjectDiff = {
  added: string[];
  removed: string[];
  changed: string[];
};

export type SchemaDiffSummary = {
  relations: SchemaObjectDiff;
  types: SchemaObjectDiff;
  functions: SchemaObjectDiff;
};

export type RevertDryRunPhase =
  | "validate"
  | "begin"
  | "isolate"
  | "previous-up"
  | "snapshot-before"
  | "target-up"
  | "down"
  | "snapshot-after"
  | "rollback";

export type RevertDryRunOutcome =
  | { kind: "noop" }
  | { kind: "no-down"; version: number; name: string }
  | { kind: "passed"; version: number; name: string }
  | { kind: "schema-mismatch"; version: number; name: string; diff: SchemaDiffSummary }
  | { kind: "failed"; version?: number; name?: string; phase: RevertDryRunPhase; error: string };

function migrationCheckIssue(
  code: MigrationCheckIssue["code"],
  message: string,
  details: Omit<MigrationCheckIssue, "severity" | "code" | "message"> = {},
): MigrationCheckIssue {
  return { severity: "error", code, message, ...details };
}

function parseMigrationVersion(raw: string): number | null {
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version <= 0) return null;
  return version;
}

export function checkMigrationFiles(migrationsDir: string): MigrationCheckReport {
  const issues: MigrationCheckIssue[] = [];
  const upByVersion = new Map<number, { file: string; stem: string; name: string; upHash: string; squash: SquashMetadata | null }>();
  const downFiles: { file: string; stem: string; version: number; name: string }[] = [];
  let migrations = 0;

  if (existsSync(migrationsDir)) {
    for (const file of readdirSync(migrationsDir).sort()) {
      const up = FILE_RE.exec(file);
      const down = DOWN_FILE_RE.exec(file);
      if (!up && !down) {
        if (file.endsWith(".up.sql") || file.endsWith(".down.sql")) {
          issues.push(migrationCheckIssue(
            "invalid-file-name",
            `migration file ${file} must be named <version>_<name>.up.sql or <version>_<name>.down.sql`,
            { file },
          ));
        }
        continue;
      }

      const match = up ?? down!;
      const version = parseMigrationVersion(match[1]!);
      const name = match[2]!;
      const stem = `${match[1]}_${name}`;
      if (version === null) {
        issues.push(migrationCheckIssue("invalid-version", `migration file ${file} has an invalid version`, { file }));
        continue;
      }
      if (!SAFE_NAME_RE.test(name)) {
        issues.push(migrationCheckIssue(
          "invalid-file-name",
          `migration file ${file} has an unsafe name`,
          { file, version, name },
        ));
        continue;
      }

      if (down) {
        downFiles.push({ file, stem, version, name });
        continue;
      }

      migrations++;
      const upSql = readFileSync(join(migrationsDir, file), "utf8");
      let squash: SquashMetadata | null = null;
      try {
        squash = parseSquashMetadata(upSql);
      } catch (e) {
        issues.push(migrationCheckIssue(
          "invalid-squash-metadata",
          `${file}: ${(e as Error).message}`,
          { file, version, name },
        ));
      }
      const upHash = createHash("sha256").update(upSql).digest("hex");
      const existing = upByVersion.get(version);
      if (existing) {
        issues.push(migrationCheckIssue(
          "duplicate-version",
          `migration version ${version} is used by both ${existing.file} and ${file}`,
          { file, version, name },
        ));
        continue;
      }
      upByVersion.set(version, { file, stem, name, upHash, squash });
    }
  }

  for (const down of downFiles) {
    const up = upByVersion.get(down.version);
    if (!up || up.stem !== down.stem) {
      issues.push(migrationCheckIssue(
        "orphan-down",
        `down migration ${down.file} does not have a matching up migration`,
        { file: down.file, version: down.version, name: down.name },
      ));
    }
  }

  for (const [version, migration] of upByVersion) {
    if (!migration.squash) continue;
    for (const r of migration.squash.replaces) {
      if (r.version >= version) {
        issues.push(migrationCheckIssue(
          "invalid-squash-replacement",
          `squash replacement ${r.version}_${r.name} must be older than ${version}_${migration.name}`,
          { file: migration.file, version, name: migration.name },
        ));
        continue;
      }
      const current = upByVersion.get(r.version);
      if (current && (current.name !== r.name || current.upHash !== r.upHash)) {
        issues.push(migrationCheckIssue(
          "tampered-squash-replacement",
          `squash replacement ${r.version}_${r.name} does not match current migration file ${current.file}`,
          { file: current.file, version: r.version, name: r.name },
        ));
      }
    }
  }

  return {
    ok: issues.length === 0,
    migrations,
    archives: listMigrationArchives(migrationsDir).length,
    issues,
  };
}

function diffByKey<T>(
  before: T[],
  after: T[],
  key: (item: T) => string,
): SchemaObjectDiff {
  const beforeMap = new Map(before.map((item) => [key(item), JSON.stringify(item)]));
  const afterMap = new Map(after.map((item) => [key(item), JSON.stringify(item)]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of afterMap.keys()) {
    if (!beforeMap.has(k)) added.push(k);
    else if (beforeMap.get(k) !== afterMap.get(k)) changed.push(k);
  }
  for (const k of beforeMap.keys()) {
    if (!afterMap.has(k)) removed.push(k);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

function schemaTypeKey(type: SchemaTypeSnapshot): string {
  return `${type.kind}:${type.schema}.${type.name}`;
}

function schemaFunctionKey(fn: SchemaFunctionSnapshot): string {
  return `${fn.schema}.${fn.name}(${fn.identityArguments})`;
}

function schemaDiffSummary(before: SchemaSnapshot, after: SchemaSnapshot): SchemaDiffSummary {
  return {
    relations: diffByKey(before.relations, after.relations, (r: SchemaRelationSnapshot) => `${r.schema}.${r.name}`),
    types: diffByKey(before.types, after.types, schemaTypeKey),
    functions: diffByKey(before.functions, after.functions, schemaFunctionKey),
  };
}

async function applyMigrationsForWorkflow(
  databaseUrl: string,
  migrationsDir: string,
  lockKey?: number | bigint,
  lockTimeoutMs?: number,
): Promise<void> {
  const c = new PgClient(parseDatabaseUrl(databaseUrl));
  await c.connect();
  let locked = false;
  try {
    await acquireMigrateLock(c, lockKey ?? DEFAULT_MIGRATE_LOCK_KEY, lockTimeoutMs);
    locked = true;
    const result = await applyPending(c, migrationsDir, (e) => {
      if (e.kind === "applied") console.log(`shadow: applied ${String(e.version).padStart(4, "0")}_${e.name}`);
      else if (e.kind === "adopted") console.log(`shadow: adopted ${String(e.version).padStart(4, "0")}_${e.name} (${e.replaced} replaced)`);
      else if (e.kind === "tampered") {
        throw new Error(
          `sqlx-js shadow: ${e.version}_${e.name} hash mismatch (applied ${e.applied.slice(0, 16)} vs current ${e.current.slice(0, 16)})`,
        );
      } else {
        throw new Error(`sqlx-js shadow: ${e.version}_${e.name} failed — ${e.error}`);
      }
    });
    if (result.applied === 0 && result.tampered === 0 && result.failed === 0) console.log("shadow: migrations up-to-date");
  } finally {
    if (locked) {
      try {
        await releaseMigrateLock(c, lockKey ?? DEFAULT_MIGRATE_LOCK_KEY);
      } catch (e) {
        console.warn(`shadow: failed to release advisory lock: ${(e as Error).message}`);
      }
    }
    await c.end();
  }
}

function latestMigrationIsSquash(migrationsDir: string): boolean {
  const all = readMigrations(migrationsDir);
  return all[all.length - 1]?.squash != null;
}

async function validateLatestDownForWorkflow(databaseUrl: string, migrationsDir: string): Promise<void> {
  const c = new PgClient(parseDatabaseUrl(databaseUrl));
  await c.connect();
  try {
    const outcome = await checkLastDownMigration(c, migrationsDir);
    if (outcome.kind === "noop") {
      console.log("shadow: no migrations to validate down");
      return;
    }
    if (outcome.kind === "passed") {
      console.log(`shadow: latest down restores schema (${String(outcome.version).padStart(4, "0")}_${outcome.name})`);
      return;
    }
    if (outcome.kind === "no-down" && latestMigrationIsSquash(migrationsDir)) {
      console.log(`shadow: latest migration has no down (expected for squash baseline ${String(outcome.version).padStart(4, "0")}_${outcome.name})`);
      return;
    }
    if (outcome.kind === "no-down") {
      throw new Error(`latest migration ${String(outcome.version).padStart(4, "0")}_${outcome.name} has no .down.sql`);
    }
    if (outcome.kind === "schema-mismatch") {
      throw new Error(`latest migration ${String(outcome.version).padStart(4, "0")}_${outcome.name} down did not restore schema`);
    }
    throw new Error(`latest down validation failed during ${outcome.phase}: ${outcome.error}`);
  } finally {
    await c.end();
  }
}

export async function migrateSquash(opts: {
  databaseUrl?: string;
  migrationsDir: string;
  name: string;
  shadowUrl?: string;
  shadowAdminUrl?: string;
  replace?: boolean;
  pgDumpPath?: string;
  lockKey?: number | bigint;
  lockTimeoutMs?: number;
}): Promise<void> {
  let schemaSql = "";
  await withWorkflowShadowDatabase({
    databaseUrl: opts.databaseUrl ?? "",
    shadowUrl: opts.shadowUrl,
    shadowAdminUrl: opts.shadowAdminUrl,
  }, async (shadowDatabaseUrl) => {
    await applyMigrationsForWorkflow(shadowDatabaseUrl, opts.migrationsDir, opts.lockKey, opts.lockTimeoutMs);
    schemaSql = dumpSchema(shadowDatabaseUrl, opts.pgDumpPath);
  });

  const result = createSquashMigration({
    migrationsDir: opts.migrationsDir,
    name: opts.name,
    schemaSql,
    replace: opts.replace,
  });
  console.log(`created ${result.upPath}`);
  console.log(`squash: replaced ${result.replaced} migration(s) with ${String(result.version).padStart(4, "0")}_${result.name}`);
  if (result.archiveDir) console.log(`squash: archived replaced migrations in ${result.archiveDir}`);
}

export async function migrateRun(
  opts: MigrateOptions & { lockKey?: number | bigint; lockTimeoutMs?: number; dryRun?: boolean; json?: boolean },
): Promise<void> {
  if (opts.json && !opts.dryRun) {
    console.error("--json for migrate run requires --dry-run");
    process.exit(2);
  }
  const cfg = parseDatabaseUrl(opts.databaseUrl);
  const c = new PgClient(cfg);
  await c.connect();
  let exitCode = 0;
  let locked = false;
  const lockKey = opts.lockKey ?? DEFAULT_MIGRATE_LOCK_KEY;
  try {
    await acquireMigrateLock(c, lockKey, opts.lockTimeoutMs);
    locked = true;
    if (opts.dryRun) {
      if (opts.json) {
        const result = await inspectMigrationPlan(c, opts.migrationsDir);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) exitCode = 1;
      } else {
        const result = await planPending(c, opts.migrationsDir, (e) => {
          if (e.kind === "pending") console.log(`would apply ${e.version}_${e.name}`);
          else if (e.kind === "adoptable") console.log(`would adopt ${e.version}_${e.name} (${e.replaced} replaced)`);
          else if (e.kind === "tampered") {
            console.error(`migration ${e.version}_${e.name} was tampered with (hash mismatch)`);
            console.error(`  applied: ${e.applied.slice(0, 16)}…`);
            console.error(`  current: ${e.current.slice(0, 16)}…`);
            exitCode = 1;
          } else {
            console.error(`planning ${e.version}_${e.name}…\n  ✗ ${e.error}`);
            exitCode = 1;
          }
        });
        if (exitCode === 0 && result.steps.length === 0) console.log("migrations up-to-date");
        else if (exitCode === 0) console.log(`dry-run: ${result.steps.length} pending action(s)`);
      }
    } else {
      await applyPending(c, opts.migrationsDir, (e) => {
        if (e.kind === "applied") console.log(`applying ${e.version}_${e.name}…\n  ✓ applied`);
        else if (e.kind === "adopted") console.log(`adopting ${e.version}_${e.name}…\n  ✓ replaced ${e.replaced} migration rows`);
        else if (e.kind === "tampered") {
          console.error(`migration ${e.version}_${e.name} was tampered with (hash mismatch)`);
          console.error(`  applied: ${e.applied.slice(0, 16)}…`);
          console.error(`  current: ${e.current.slice(0, 16)}…`);
          exitCode = 1;
        } else {
          console.error(`applying ${e.version}_${e.name}…\n  ✗ ${e.error}`);
          exitCode = 1;
        }
      });
    }
  } finally {
    if (locked) {
      try {
        await releaseMigrateLock(c, lockKey);
      } catch (e) {
        console.warn(`sqlx-js.migrate: failed to release advisory lock: ${(e as Error).message}`);
      }
    }
    await c.end();
  }
  if (exitCode !== 0) process.exit(exitCode);
}

export async function migrateInfo(opts: MigrateOptions & { json?: boolean }): Promise<void> {
  const cfg = parseDatabaseUrl(opts.databaseUrl);
  const c = new PgClient(cfg);
  await c.connect();
  try {
    const info = await inspectMigrations(c, opts.migrationsDir);
    if (opts.json) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    console.log(`migrations in ${opts.migrationsDir}:`);
    console.log(`history table: ${info.historyTable ?? "not created"}`);
    console.log(
      `summary: ${info.summary.applied} applied, ${info.summary.pending} pending, ` +
      `${info.summary.adoptable} adoptable, ${info.summary.superseded} superseded, ` +
      `${info.summary.tampered} tampered, ${info.summary.failed} failed`,
    );
    for (const item of info.items) {
      const detail = item.detail ? ` (${item.detail})` : "";
      console.log(`  ${String(item.version).padStart(4, "0")}_${item.name}: ${item.status}${detail}`);
    }
  } finally {
    await c.end();
  }
}

export function migrateCheck(opts: { migrationsDir: string; json?: boolean }): void {
  const report = checkMigrationFiles(opts.migrationsDir);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`migration files ok: ${report.migrations} migration(s), ${report.archives} archive(s)`);
  } else {
    console.error(`migration check failed: ${report.issues.length} issue(s)`);
    for (const issue of report.issues) {
      const file = issue.file ? `${issue.file}: ` : "";
      console.error(`  [${issue.severity}] ${issue.code}: ${file}${issue.message}`);
    }
  }
  if (!report.ok) process.exit(1);
}

function assertMigrationCheckOk(migrationsDir: string): void {
  const report = checkMigrationFiles(migrationsDir);
  if (report.ok) {
    console.log(`migration files ok: ${report.migrations} migration(s), ${report.archives} archive(s)`);
    return;
  }
  console.error(`migration check failed: ${report.issues.length} issue(s)`);
  for (const issue of report.issues) {
    const file = issue.file ? `${issue.file}: ` : "";
    console.error(`  [${issue.severity}] ${issue.code}: ${file}${issue.message}`);
  }
  process.exit(1);
}

export async function migrateDev(opts: MigrationWorkflowOptions): Promise<void> {
  const ok = await runSchemaWorkflow("dev", opts, {
    validate: () => assertMigrationCheckOk(opts.migrationsDir),
    materialize: async (databaseUrl) => {
      await applyMigrationsForWorkflow(databaseUrl, opts.migrationsDir, opts.lockKey, opts.lockTimeoutMs);
      await validateLatestDownForWorkflow(databaseUrl, opts.migrationsDir);
    },
  });
  if (!ok) process.exitCode = 1;
}

export async function migrateVerify(opts: MigrationWorkflowOptions): Promise<void> {
  const ok = await runSchemaWorkflow("verify", opts, {
    validate: () => assertMigrationCheckOk(opts.migrationsDir),
    materialize: async (databaseUrl) => {
      await applyMigrationsForWorkflow(databaseUrl, opts.migrationsDir, opts.lockKey, opts.lockTimeoutMs);
      await validateLatestDownForWorkflow(databaseUrl, opts.migrationsDir);
    },
  });
  if (!ok) process.exitCode = 1;
}

export type RevertOutcome =
  | { kind: "noop" }
  | { kind: "no-down"; version: number; name: string }
  | { kind: "reverted"; version: number; name: string }
  | { kind: "failed"; version: number; name: string; error: string };

export async function revertLast(c: PgClient, migrationsDir: string): Promise<RevertOutcome> {
  const store = await ensureTable(c);
  const applied = await listApplied(c, store);
  const all = readMigrations(migrationsDir);
  let last: MigrationFile | null = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (applied.has(all[i]!.version)) { last = all[i]!; break; }
  }
  if (!last) return { kind: "noop" };
  if (!last.downPath) return { kind: "no-down", version: last.version, name: last.name };
  const downSql = readFileSync(last.downPath, "utf8");
  await c.simpleQuery("BEGIN");
  try {
    await c.simpleQuery(downSql);
    await c.execParamsText(`DELETE FROM ${store.table} WHERE version = $1`, [String(last.version)]);
    await c.simpleQuery("COMMIT");
    return { kind: "reverted", version: last.version, name: last.name };
  } catch (err) {
    let rollbackErr: string | undefined;
    try { await c.simpleQuery("ROLLBACK"); } catch (rb) { rollbackErr = (rb as Error).message; }
    const msg = rollbackErr
      ? `${(err as Error).message} (rollback also failed: ${rollbackErr})`
      : (err as Error).message;
    return { kind: "failed", version: last.version, name: last.name, error: msg };
  }
}

export async function checkLastDownMigration(c: PgClient, migrationsDir: string): Promise<RevertDryRunOutcome> {
  const localCheck = checkMigrationFiles(migrationsDir);
  if (!localCheck.ok) {
    return {
      kind: "failed",
      phase: "validate",
      error: localCheck.issues.map((i) => `${i.code}: ${i.message}`).join("; "),
    };
  }

  const all = readMigrations(migrationsDir);
  const target = all[all.length - 1];
  if (!target) return { kind: "noop" };
  if (!target.downPath) return { kind: "no-down", version: target.version, name: target.name };
  const downSql = readFileSync(target.downPath, "utf8");
  const validation: MigrationValidationOutcome[] = [];
  const prefixPlan = buildMigrationPlan(all.slice(0, -1), new Map<number, { name: string; hash: string }>(), (e) => {
    validation.push(e);
  });
  if (prefixPlan.kind !== "ok") {
    return {
      kind: "failed",
      version: target.version,
      name: target.name,
      phase: "validate",
      error: validation.map((e) => e.kind === "failed" ? e.error : `${e.version}_${e.name} hash mismatch`).join("; "),
    };
  }

  let phase: RevertDryRunPhase = "begin";
  let outcome: RevertDryRunOutcome;
  let inTransaction = false;
  try {
    await c.simpleQuery("BEGIN");
    inTransaction = true;
    phase = "isolate";
    await isolateShadowDatabase(c);
    phase = "previous-up";
    for (const step of prefixPlan.steps) {
      if (step.kind === "apply") {
        await c.simpleQuery(step.migration.upSql);
        await resetMigrationSession(c);
      }
    }
    phase = "snapshot-before";
    const before = await introspectConnected(c);
    phase = "target-up";
    await c.simpleQuery(target.upSql);
    await resetMigrationSession(c);
    phase = "down";
    await c.simpleQuery(downSql);
    await resetMigrationSession(c);
    phase = "snapshot-after";
    const after = await introspectConnected(c);
    outcome = schemaSnapshotEqual(before, after)
      ? { kind: "passed", version: target.version, name: target.name }
      : {
          kind: "schema-mismatch",
          version: target.version,
          name: target.name,
          diff: schemaDiffSummary(before, after),
        };
  } catch (err) {
    outcome = {
      kind: "failed",
      version: target.version,
      name: target.name,
      phase,
      error: (err as Error).message,
    };
  }

  if (inTransaction) {
    try {
      phase = "rollback";
      await c.simpleQuery("ROLLBACK");
    } catch (err) {
      const rollbackError = (err as Error).message;
      if (outcome.kind === "failed") {
        return { ...outcome, error: `${outcome.error} (rollback also failed: ${rollbackError})` };
      }
      return {
        kind: "failed",
        version: target.version,
        name: target.name,
        phase,
        error: rollbackError,
      };
    }
  }

  return outcome;
}

function migrationLabel(version: number, name: string): string {
  return `${String(version).padStart(4, "0")}_${name}`;
}

function printSchemaObjectDiff(label: string, diff: SchemaObjectDiff): void {
  if (diff.added.length > 0) console.error(`  ${label} added: ${diff.added.join(", ")}`);
  if (diff.removed.length > 0) console.error(`  ${label} removed: ${diff.removed.join(", ")}`);
  if (diff.changed.length > 0) console.error(`  ${label} changed: ${diff.changed.join(", ")}`);
}

async function migrateRevertDryRun(
  opts: MigrateOptions & {
    lockKey?: number | bigint;
    lockTimeoutMs?: number;
    shadowUrl?: string;
    shadowAdminUrl?: string;
    json?: boolean;
  },
): Promise<void> {
  let exitCode = 0;
  await withDryRunShadowDatabase(opts, async (shadowDatabaseUrl) => {
    const cfg = parseDatabaseUrl(shadowDatabaseUrl);
    const c = new PgClient(cfg);
    await c.connect();
    const lockKey = opts.lockKey ?? DEFAULT_MIGRATE_LOCK_KEY;
    let locked = false;
    try {
      await acquireMigrateLock(c, lockKey, opts.lockTimeoutMs);
      locked = true;
      const outcome = await checkLastDownMigration(c, opts.migrationsDir);
      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
      } else if (outcome.kind === "noop") {
        console.log("revert dry-run: no migrations");
      } else if (outcome.kind === "no-down") {
        console.error(`migration ${migrationLabel(outcome.version, outcome.name)} has no .down.sql`);
        exitCode = 1;
      } else if (outcome.kind === "passed") {
        console.log(`revert dry-run: ${migrationLabel(outcome.version, outcome.name)} restores schema`);
      } else if (outcome.kind === "schema-mismatch") {
        console.error(`revert dry-run: ${migrationLabel(outcome.version, outcome.name)} down did not restore schema`);
        printSchemaObjectDiff("relations", outcome.diff.relations);
        printSchemaObjectDiff("types", outcome.diff.types);
        printSchemaObjectDiff("functions", outcome.diff.functions);
        exitCode = 1;
      } else {
        const label = outcome.version && outcome.name ? `${migrationLabel(outcome.version, outcome.name)} ` : "";
        console.error(`revert dry-run: ${label}failed during ${outcome.phase}`);
        console.error(`  ✗ ${outcome.error}`);
        exitCode = 1;
      }
      if (opts.json && outcome.kind !== "noop" && outcome.kind !== "passed") exitCode = 1;
    } finally {
      if (locked) {
        try {
          await releaseMigrateLock(c, lockKey);
        } catch (e) {
          console.warn(`sqlx-js.migrate: failed to release advisory lock: ${(e as Error).message}`);
        }
      }
      await c.end();
    }
  }, opts.json ? () => {} : console.log);
  if (exitCode !== 0) process.exit(exitCode);
}

export async function migrateRevert(
  opts: MigrateOptions & {
    lockKey?: number | bigint;
    lockTimeoutMs?: number;
    dryRun?: boolean;
    shadowUrl?: string;
    shadowAdminUrl?: string;
    json?: boolean;
  },
): Promise<void> {
  if (opts.json && !opts.dryRun) {
    console.error("--json for migrate revert requires --dry-run");
    process.exit(2);
  }
  if (opts.dryRun) {
    await migrateRevertDryRun(opts);
    return;
  }
  const cfg = parseDatabaseUrl(opts.databaseUrl);
  const c = new PgClient(cfg);
  await c.connect();
  const lockKey = opts.lockKey ?? DEFAULT_MIGRATE_LOCK_KEY;
  let locked = false;
  let exitCode = 0;
  try {
    await acquireMigrateLock(c, lockKey, opts.lockTimeoutMs);
    locked = true;
    const outcome = await revertLast(c, opts.migrationsDir);
    if (outcome.kind === "noop") {
      console.log("nothing to revert");
    } else if (outcome.kind === "no-down") {
      console.error(`migration ${outcome.version}_${outcome.name} has no .down.sql`);
      exitCode = 1;
    } else if (outcome.kind === "reverted") {
      console.log(`reverting ${outcome.version}_${outcome.name}…`);
      console.log(`  ✓ reverted`);
    } else {
      console.error(`reverting ${outcome.version}_${outcome.name}…`);
      console.error(`  ✗ ${outcome.error}`);
      exitCode = 1;
    }
  } finally {
    if (locked) {
      try {
        await releaseMigrateLock(c, lockKey);
      } catch (e) {
        console.warn(`sqlx-js.migrate: failed to release advisory lock: ${(e as Error).message}`);
      }
    }
    await c.end();
  }
  if (exitCode !== 0) process.exit(exitCode);
}

export function migrateArchiveList(opts: Pick<MigrateOptions, "migrationsDir">): void {
  const archives = listMigrationArchives(opts.migrationsDir);
  if (archives.length === 0) {
    console.log("no migration archives");
    return;
  }
  for (const archive of archives) {
    console.log(`${archive.name}: ${archive.files.length} file(s)`);
    for (const file of archive.files) console.log(`  ${file}`);
  }
}

export function migrateArchiveRestore(
  opts: Pick<MigrateOptions, "migrationsDir"> & { name: string; force?: boolean },
): void {
  const result = restoreMigrationArchive(opts.migrationsDir, opts.name, { force: opts.force });
  console.log(`restored ${result.restored.length} file(s) from ${result.archiveName}`);
  for (const file of result.restored) console.log(`  ${file}`);
}

export function migrateAdd(opts: MigrateOptions & { name: string }): void {
  if (!existsSync(opts.migrationsDir)) mkdirSync(opts.migrationsDir, { recursive: true });
  const existing = readMigrations(opts.migrationsDir);
  const nextVersion = (existing[existing.length - 1]?.version ?? 0) + 1;
  const safe = safeMigrationName(opts.name);
  const padded = String(nextVersion).padStart(4, "0");
  const upFname = `${padded}_${safe}.up.sql`;
  const downFname = `${padded}_${safe}.down.sql`;
  const upFull = join(opts.migrationsDir, upFname);
  const downFull = join(opts.migrationsDir, downFname);
  writeFileSync(upFull, `-- ${opts.name}\n-- write up DDL/DML here\n`);
  if (!existsSync(downFull)) {
    writeFileSync(downFull, `-- revert ${opts.name}\n-- write down DDL/DML here\n`);
  }
  console.log(`created ${upFull}`);
  console.log(`created ${downFull}`);
}
