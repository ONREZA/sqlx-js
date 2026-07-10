import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { PgClient, parseDatabaseUrl, decodeText } from "../pg/wire";
import { openSession, prepareOnce, verifyPrepareArtifacts } from "./prepare";
import {
  introspectConnected,
  schemaSnapshotEqual,
  type SchemaFunctionSnapshot,
  type SchemaRelationSnapshot,
  type SchemaSnapshot,
  type SchemaTypeSnapshot,
} from "../schema-snapshot";

export type MigrateOptions = {
  databaseUrl: string;
  migrationsDir: string;
};

export type MigrationWorkflowOptions = MigrateOptions & {
  root: string;
  cacheDir: string;
  dtsPath: string;
  prune?: boolean;
  shadowUrl?: string;
  shadowAdminUrl?: string;
  lockKey?: number | bigint;
  lockTimeoutMs?: number;
};

type MigrationFile = {
  version: number;
  name: string;
  upPath: string;
  downPath: string | null;
  upSql: string;
  upHash: string;
  squash: SquashMetadata | null;
};

type SquashReplacement = {
  version: number;
  name: string;
  upHash: string;
};

type SquashMetadata = {
  format: 1;
  replaces: SquashReplacement[];
};

export type MigrationStore = {
  table: string;
};

const SQUASH_PREFIX = "-- sqlx-js-squash:";

export const DEFAULT_MIGRATE_LOCK_KEY = 18750938867203960n;

const FILE_RE = /^(\d+)_(.+)\.up\.sql$/;
const DOWN_FILE_RE = /^(\d+)_(.+)\.down\.sql$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MIGRATIONS_TABLE = "_sqlx_js_migrations";

function readMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const out: MigrationFile[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = FILE_RE.exec(f);
    if (!m) continue;
    const version = parseInt(m[1]!, 10);
    const name = m[2]!;
    if (!SAFE_NAME_RE.test(name)) {
      throw new Error(
        `sqlx-js.migrate: unsafe migration filename ${f} — name must match /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`,
      );
    }
    const upPath = join(dir, f);
    const downPath = join(dir, `${m[1]}_${name}.down.sql`);
    const upSql = readFileSync(upPath, "utf8");
    out.push({
      version,
      name,
      upPath,
      downPath: existsSync(downPath) ? downPath : null,
      upSql,
      upHash: createHash("sha256").update(upSql).digest("hex"),
      squash: parseSquashMetadata(upSql),
    });
  }
  return out;
}

function parseSquashMetadata(sql: string): SquashMetadata | null {
  const line = sql.split(/\r?\n/).find((l) => l.startsWith(SQUASH_PREFIX));
  if (!line) return null;
  const raw = line.slice(SQUASH_PREFIX.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`sqlx-js.migrate: invalid squash metadata JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("sqlx-js.migrate: invalid squash metadata");
  }
  const obj = parsed as { format?: unknown; replaces?: unknown };
  if (obj.format !== 1 || !Array.isArray(obj.replaces) || obj.replaces.length === 0) {
    throw new Error("sqlx-js.migrate: invalid squash metadata");
  }
  const replaces: SquashReplacement[] = [];
  for (const r of obj.replaces) {
    if (!r || typeof r !== "object") throw new Error("sqlx-js.migrate: invalid squash replacement metadata");
    const item = r as { version?: unknown; name?: unknown; upHash?: unknown };
    if (typeof item.version !== "number" || !Number.isSafeInteger(item.version) || item.version <= 0) {
      throw new Error("sqlx-js.migrate: invalid squash replacement version");
    }
    if (typeof item.name !== "string" || !SAFE_NAME_RE.test(item.name)) {
      throw new Error("sqlx-js.migrate: invalid squash replacement name");
    }
    if (typeof item.upHash !== "string" || !/^[a-f0-9]{64}$/.test(item.upHash)) {
      throw new Error("sqlx-js.migrate: invalid squash replacement hash");
    }
    replaces.push({ version: item.version as number, name: item.name, upHash: item.upHash });
  }
  return { format: 1, replaces };
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function databaseUrlWithDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceDatabaseUrl(databaseUrl: string): string {
  return databaseUrlWithDatabase(databaseUrl, "postgres");
}

function generatedShadowDatabaseName(): string {
  return `sqlx_js_shadow_${process.pid}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

async function findMigrationStore(c: PgClient): Promise<MigrationStore | null> {
  const r = await c.simpleQuery(`
    SELECT n.nspname, cls.relname
    FROM pg_class cls
    JOIN pg_namespace n ON n.oid = cls.relnamespace
    WHERE cls.oid = to_regclass('${MIGRATIONS_TABLE}')
  `);
  const row = r.rows[0];
  if (!row) return null;
  const schema = decodeText(row[0]!);
  const table = decodeText(row[1]!);
  if (!schema || !table) {
    throw new Error(`sqlx-js.migrate: failed to resolve ${MIGRATIONS_TABLE} identifier`);
  }
  return { table: `${quoteIdent(schema)}.${quoteIdent(table)}` };
}

async function resolveMigrationStore(c: PgClient): Promise<MigrationStore> {
  const store = await findMigrationStore(c);
  if (!store) {
    throw new Error(`sqlx-js.migrate: failed to resolve ${MIGRATIONS_TABLE} in current search_path`);
  }
  return store;
}

export async function ensureTable(c: PgClient): Promise<MigrationStore> {
  const existing = await findMigrationStore(c);
  if (existing) return existing;
  await c.simpleQuery(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      up_hash TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  return resolveMigrationStore(c);
}

export async function listApplied(
  c: PgClient,
  store?: MigrationStore,
): Promise<Map<number, { name: string; hash: string }>> {
  const s = store ?? await resolveMigrationStore(c);
  const r = await c.simpleQuery(`SELECT version, name, up_hash FROM ${s.table} ORDER BY version`);
  const out = new Map<number, { name: string; hash: string }>();
  for (const row of r.rows) {
    out.set(Number(decodeText(row[0]!)), { name: decodeText(row[1]!)!, hash: decodeText(row[2]!)! });
  }
  return out;
}

export type ApplyOutcome =
  | { kind: "applied"; version: number; name: string }
  | { kind: "adopted"; version: number; name: string; replaced: number }
  | { kind: "tampered"; version: number; name: string; applied: string; current: string }
  | { kind: "failed"; version: number; name: string; error: string };

export type PlanOutcome =
  | { kind: "pending"; version: number; name: string }
  | { kind: "adoptable"; version: number; name: string; replaced: number }
  | { kind: "tampered"; version: number; name: string; applied: string; current: string }
  | { kind: "failed"; version: number; name: string; error: string };

export type MigrationPlanItem =
  | { kind: "apply"; version: number; name: string }
  | { kind: "adopt"; version: number; name: string; replaced: number };

export type MigrationPlanDiagnostic = Extract<PlanOutcome, { kind: "tampered" | "failed" }>;

export type MigrationPlanSnapshot = {
  ok: boolean;
  pending: number;
  adoptable: number;
  tampered: number;
  failed: number;
  steps: MigrationPlanItem[];
  diagnostics: MigrationPlanDiagnostic[];
};

export type MigrationInfoStatus = "applied" | "pending" | "adoptable" | "superseded" | "tampered" | "failed";

export type MigrationInfoItem = {
  version: number;
  name: string;
  status: MigrationInfoStatus;
  detail?: string;
};

export type MigrationInfoSnapshot = {
  historyTable: string | null;
  summary: Record<MigrationInfoStatus, number>;
  items: MigrationInfoItem[];
};

export type MigrationArchive = {
  name: string;
  path: string;
  files: string[];
};

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

type InternalMigrationPlanItem =
  | { kind: "apply"; migration: MigrationFile }
  | { kind: "adopt"; migration: MigrationFile; replaced: number };

type MigrationValidationOutcome =
  | { kind: "tampered"; version: number; name: string; applied: string; current: string }
  | { kind: "failed"; version: number; name: string; error: string };

function appliedSquashSupersededVersions(
  all: MigrationFile[],
  applied: Map<number, { name: string; hash: string }>,
  onEvent?: (e: MigrationValidationOutcome) => void,
): Set<number> | null {
  const superseded = new Set<number>();
  const byVersion = new Map(all.map((m) => [m.version, m]));
  const visitedSquashes = new Set<number>();
  const visitReplacements = (m: MigrationFile): boolean => {
    if (!m.squash || visitedSquashes.has(m.version)) return true;
    visitedSquashes.add(m.version);
    for (const r of m.squash.replaces) {
      superseded.add(r.version);
      const current = byVersion.get(r.version);
      if (!current?.squash || current.version >= m.version) continue;
      if (current.name !== r.name || current.upHash !== r.upHash) {
        onEvent?.({ kind: "tampered", version: r.version, name: r.name, applied: r.upHash, current: current.upHash });
        return false;
      }
      if (!visitReplacements(current)) return false;
    }
    return true;
  };
  for (const m of all) {
    if (!m.squash) continue;
    const a = applied.get(m.version);
    if (!a) continue;
    if (a.hash !== m.upHash) {
      onEvent?.({ kind: "tampered", version: m.version, name: m.name, applied: a.hash, current: m.upHash });
      return null;
    }
    if (!visitReplacements(m)) return null;
  }
  return superseded;
}

function squashCoveredVersions(all: MigrationFile[]): Set<number> {
  const covered = new Set<number>();
  for (const m of all) {
    if (!m.squash) continue;
    for (const r of m.squash.replaces) {
      if (r.version >= m.version) {
        throw new Error(
          `sqlx-js.migrate: squash replacement ${r.version}_${r.name} must be older than ${m.version}_${m.name}`,
        );
      }
      covered.add(r.version);
    }
  }
  return covered;
}

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

async function listUserSchemas(c: PgClient): Promise<string[]> {
  const r = await c.simpleQuery(`
    SELECT nspname
    FROM pg_namespace
    WHERE nspname <> 'information_schema'
      AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    ORDER BY nspname
  `);
  return r.rows.map((row) => decodeText(row[0]!)!).filter((schema) => schema.length > 0);
}

async function isolateShadowSchemaState(c: PgClient): Promise<void> {
  for (const schema of await listUserSchemas(c)) {
    await c.simpleQuery(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  }
  await c.simpleQuery("CREATE SCHEMA IF NOT EXISTS public");
  await resetMigrationSession(c);
}

type ShadowDatabaseHandle = {
  databaseUrl: string;
  cleanup: () => Promise<void>;
};

async function useExplicitShadowDatabase(databaseUrl: string): Promise<ShadowDatabaseHandle> {
  const c = new PgClient(parseDatabaseUrl(databaseUrl));
  await c.connect();
  try {
    await isolateShadowSchemaState(c);
  } finally {
    await c.end();
  }
  return { databaseUrl, cleanup: async () => {} };
}

async function createDisposableShadowDatabase(
  databaseUrl: string,
  shadowAdminUrl?: string,
  log: (msg: string) => void = console.log,
): Promise<ShadowDatabaseHandle> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create an automatic shadow database (or pass --shadow-url)");
  }
  const name = generatedShadowDatabaseName();
  const adminUrl = shadowAdminUrl ?? maintenanceDatabaseUrl(databaseUrl);
  const shadowUrl = databaseUrlWithDatabase(databaseUrl, name);
  const owner = parseDatabaseUrl(databaseUrl).user;
  const admin = new PgClient(parseDatabaseUrl(adminUrl));
  await admin.connect();
  try {
    await admin.simpleQuery(`CREATE DATABASE ${quoteIdent(name)} OWNER ${quoteIdent(owner)}`);
  } catch (err) {
    throw new Error(
      `sqlx-js.migrate: failed to create shadow database ${name}: ${(err as Error).message}. ` +
      "Grant CREATEDB, pass --shadow-admin-url, or pass --shadow-url.",
    );
  } finally {
    await admin.end();
  }
  log(`shadow: created ${name}`);
  let dropped = false;
  return {
    databaseUrl: shadowUrl,
    cleanup: async () => {
      if (dropped) return;
      dropped = true;
      const dropAdmin = new PgClient(parseDatabaseUrl(adminUrl));
      await dropAdmin.connect();
      try {
        await dropAdmin.simpleQuery(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
        log(`shadow: dropped ${name}`);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}

async function withWorkflowShadowDatabase<T>(
  opts: Pick<MigrationWorkflowOptions, "databaseUrl" | "shadowUrl" | "shadowAdminUrl">,
  fn: (databaseUrl: string) => Promise<T>,
): Promise<T> {
  const handle = opts.shadowUrl
    ? await useExplicitShadowDatabase(opts.shadowUrl)
    : await createDisposableShadowDatabase(opts.databaseUrl, opts.shadowAdminUrl);
  let fnError: unknown;
  try {
    return await fn(handle.databaseUrl);
  } catch (err) {
    fnError = err;
    throw err;
  } finally {
    try {
      await handle.cleanup();
    } catch (cleanupErr) {
      if (fnError) console.warn(`shadow: cleanup failed after command error: ${(cleanupErr as Error).message}`);
      else throw cleanupErr;
    }
  }
}

async function withDryRunShadowDatabase<T>(
  opts: Pick<MigrationWorkflowOptions, "databaseUrl" | "shadowUrl" | "shadowAdminUrl">,
  fn: (databaseUrl: string) => Promise<T>,
  log?: (msg: string) => void,
): Promise<T> {
  if (opts.shadowUrl) return fn(opts.shadowUrl);
  const handle = await createDisposableShadowDatabase(opts.databaseUrl, opts.shadowAdminUrl, log);
  let fnError: unknown;
  try {
    return await fn(handle.databaseUrl);
  } catch (err) {
    fnError = err;
    throw err;
  } finally {
    try {
      await handle.cleanup();
    } catch (cleanupErr) {
      if (fnError) console.warn(`shadow: cleanup failed after command error: ${(cleanupErr as Error).message}`);
      else throw cleanupErr;
    }
  }
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

async function prepareWorkflowArtifacts(opts: MigrationWorkflowOptions, databaseUrl: string): Promise<boolean> {
  const prepareOpts = {
    root: opts.root,
    databaseUrl,
    cacheDir: opts.cacheDir,
    dtsPath: opts.dtsPath,
    check: false,
    prune: opts.prune,
  };
  const session = await openSession(prepareOpts);
  try {
    const r = await prepareOnce(prepareOpts, session);
    if (r.failures > 0) {
      console.error(`\n${r.failures} query/queries failed to prepare`);
      return false;
    }
    console.log(`\nprepared ${r.entries} unique query/queries → ${opts.dtsPath}`);
    return true;
  } finally {
    await session.client.end();
  }
}

async function prepareInTemporaryArtifacts(opts: MigrationWorkflowOptions, databaseUrl: string): Promise<boolean> {
  const verification = await verifyPrepareArtifacts({
    root: opts.root,
    databaseUrl,
    cacheDir: opts.cacheDir,
    dtsPath: opts.dtsPath,
    check: false,
    verify: true,
    prune: true,
  });
  return verification.ok;
}

function effectiveSquashReplacements(all: MigrationFile[]): SquashReplacement[] {
  const covered = squashCoveredVersions(all);
  return all
    .filter((m) => !covered.has(m.version))
    .map((m) => ({ version: m.version, name: m.name, upHash: m.upHash }));
}

function preflightSquashMigrations(
  all: MigrationFile[],
  applied: Map<number, { name: string; hash: string }>,
  superseded: Set<number>,
  onEvent?: (e: MigrationValidationOutcome) => void,
): "ok" | "failed" | "tampered" {
  const byVersion = new Map(all.map((m) => [m.version, m]));
  for (const m of all) {
    if (!m.squash) continue;
    let present = 0;
    for (const r of m.squash.replaces) {
      if (r.version >= m.version) {
        onEvent?.({
          kind: "failed",
          version: m.version,
          name: m.name,
          error: `squash replacement ${r.version}_${r.name} must be older than ${m.version}_${m.name}`,
        });
        return "failed";
      }
      const current = byVersion.get(r.version);
      if (current && !superseded.has(r.version) && (current.name !== r.name || current.upHash !== r.upHash)) {
        onEvent?.({ kind: "tampered", version: r.version, name: r.name, applied: r.upHash, current: current.upHash });
        return "tampered";
      }
      const a = applied.get(r.version);
      if (!a) continue;
      present++;
      if (a.hash !== r.upHash || a.name !== r.name) {
        onEvent?.({ kind: "tampered", version: r.version, name: r.name, applied: a.hash, current: r.upHash });
        return "tampered";
      }
    }
    if (present > 0 && present !== m.squash.replaces.length) {
      onEvent?.({
        kind: "failed",
        version: m.version,
        name: m.name,
        error: `squash migration replaces ${m.squash.replaces.length} migration(s), but only ${present} matching row(s) are applied`,
      });
      return "failed";
    }
  }
  return "ok";
}

function planSquashAdoption(
  m: MigrationFile,
  applied: Map<number, { name: string; hash: string }>,
  onEvent?: (e: MigrationValidationOutcome) => void,
): { kind: "none" } | { kind: "adopt"; replaced: number } | { kind: "failed" } | { kind: "tampered" } {
  if (!m.squash) return { kind: "none" };
  let present = 0;
  for (const r of m.squash.replaces) {
    if (r.version >= m.version) {
      onEvent?.({
        kind: "failed",
        version: m.version,
        name: m.name,
        error: `squash replacement ${r.version}_${r.name} must be older than ${m.version}_${m.name}`,
      });
      return { kind: "failed" };
    }
    const a = applied.get(r.version);
    if (!a) continue;
    present++;
    if (a.hash !== r.upHash || a.name !== r.name) {
      onEvent?.({ kind: "tampered", version: r.version, name: r.name, applied: a.hash, current: r.upHash });
      return { kind: "tampered" };
    }
  }

  if (present === 0) return { kind: "none" };
  if (present !== m.squash.replaces.length) {
    onEvent?.({
      kind: "failed",
      version: m.version,
      name: m.name,
      error: `squash migration replaces ${m.squash.replaces.length} migration(s), but only ${present} matching row(s) are applied`,
    });
    return { kind: "failed" };
  }

  return { kind: "adopt", replaced: m.squash.replaces.length };
}

function buildMigrationPlan(
  all: MigrationFile[],
  applied: Map<number, { name: string; hash: string }>,
  onEvent?: (e: MigrationValidationOutcome) => void,
): { kind: "ok"; steps: InternalMigrationPlanItem[] } | { kind: "failed" } | { kind: "tampered" } {
  const plannedApplied = new Map(applied);
  const superseded = appliedSquashSupersededVersions(all, plannedApplied, onEvent);
  if (!superseded) return { kind: "tampered" };
  const preflight = preflightSquashMigrations(all, plannedApplied, superseded, onEvent);
  if (preflight !== "ok") return { kind: preflight };

  const steps: InternalMigrationPlanItem[] = [];
  for (const m of all) {
    if (superseded.has(m.version)) continue;
    const a = plannedApplied.get(m.version);
    if (a) {
      if (a.hash !== m.upHash) {
        onEvent?.({ kind: "tampered", version: m.version, name: m.name, applied: a.hash, current: m.upHash });
        return { kind: "tampered" };
      }
      continue;
    }
    const adoption = planSquashAdoption(m, plannedApplied, onEvent);
    if (adoption.kind === "adopt") {
      steps.push({ kind: "adopt", migration: m, replaced: adoption.replaced });
      for (const r of m.squash!.replaces) plannedApplied.delete(r.version);
      plannedApplied.set(m.version, { name: m.name, hash: m.upHash });
      continue;
    }
    if (adoption.kind === "tampered" || adoption.kind === "failed") return { kind: adoption.kind };
    steps.push({ kind: "apply", migration: m });
    plannedApplied.set(m.version, { name: m.name, hash: m.upHash });
  }
  return { kind: "ok", steps };
}

function publicPlanItem(step: InternalMigrationPlanItem): MigrationPlanItem {
  if (step.kind === "apply") {
    return { kind: "apply", version: step.migration.version, name: step.migration.name };
  }
  return {
    kind: "adopt",
    version: step.migration.version,
    name: step.migration.name,
    replaced: step.replaced,
  };
}

async function resetMigrationSession(c: PgClient): Promise<void> {
  await c.simpleQuery("RESET ALL");
}

async function executeSquashAdoption(
  c: PgClient,
  store: MigrationStore,
  m: MigrationFile,
  applied: Map<number, { name: string; hash: string }>,
  replaced: number,
  onEvent?: (e: ApplyOutcome) => void,
): Promise<"done" | "failed"> {
  if (!m.squash) return "failed";

  let committed = false;
  await c.simpleQuery("BEGIN");
  try {
    for (const r of m.squash.replaces) {
      await c.execParamsText(`DELETE FROM ${store.table} WHERE version = $1`, [String(r.version)]);
    }
    await c.execParamsText(
      `INSERT INTO ${store.table} (version, name, up_hash) VALUES ($1, $2, $3)`,
      [String(m.version), m.name, m.upHash],
    );
    await c.simpleQuery("COMMIT");
    committed = true;
  } catch (err) {
    let rollbackErr: string | undefined;
    if (!committed) {
      try { await c.simpleQuery("ROLLBACK"); } catch (rb) { rollbackErr = (rb as Error).message; }
    }
    const message = rollbackErr
      ? `${(err as Error).message} (rollback also failed: ${rollbackErr})`
      : (err as Error).message;
    onEvent?.({ kind: "failed", version: m.version, name: m.name, error: message });
    return "failed";
  }
  try {
    await resetMigrationSession(c);
  } catch (err) {
    onEvent?.({ kind: "failed", version: m.version, name: m.name, error: `failed to reset migration session: ${(err as Error).message}` });
    return "failed";
  }
  for (const r of m.squash.replaces) applied.delete(r.version);
  applied.set(m.version, { name: m.name, hash: m.upHash });
  onEvent?.({ kind: "adopted", version: m.version, name: m.name, replaced });
  return "done";
}

export async function planPending(
  c: PgClient,
  migrationsDir: string,
  onEvent?: (e: PlanOutcome) => void,
): Promise<{ pending: number; adoptable: number; tampered: number; failed: number; steps: MigrationPlanItem[] }> {
  const store = await findMigrationStore(c);
  const applied = store ? await listApplied(c, store) : new Map<number, { name: string; hash: string }>();
  const all = readMigrations(migrationsDir);
  const counts = { pending: 0, adoptable: 0, tampered: 0, failed: 0 };
  const plan = buildMigrationPlan(all, applied, onEvent);
  if (plan.kind === "tampered") {
    counts.tampered++;
    return { ...counts, steps: [] };
  }
  if (plan.kind === "failed") {
    counts.failed++;
    return { ...counts, steps: [] };
  }
  const steps = plan.steps.map(publicPlanItem);
  for (const step of steps) {
    if (step.kind === "apply") {
      counts.pending++;
      onEvent?.({ kind: "pending", version: step.version, name: step.name });
    } else {
      counts.adoptable++;
      onEvent?.({ kind: "adoptable", version: step.version, name: step.name, replaced: step.replaced });
    }
  }
  return { ...counts, steps };
}

export async function inspectMigrationPlan(c: PgClient, migrationsDir: string): Promise<MigrationPlanSnapshot> {
  const diagnostics: MigrationPlanDiagnostic[] = [];
  const result = await planPending(c, migrationsDir, (e) => {
    if (e.kind === "tampered" || e.kind === "failed") diagnostics.push(e);
  });
  return {
    ok: result.tampered === 0 && result.failed === 0,
    ...result,
    diagnostics,
  };
}

export async function inspectMigrations(c: PgClient, migrationsDir: string): Promise<MigrationInfoSnapshot> {
  const store = await findMigrationStore(c);
  const applied = store ? await listApplied(c, store) : new Map<number, { name: string; hash: string }>();
  const all = readMigrations(migrationsDir);
  const validation: MigrationValidationOutcome[] = [];
  const plan = buildMigrationPlan(all, applied, (e) => validation.push(e));
  const planned = new Map<number, InternalMigrationPlanItem>();
  if (plan.kind === "ok") {
    for (const step of plan.steps) planned.set(step.migration.version, step);
  }
  const validationByVersion = new Map(validation.map((e) => [e.version, e]));
  const superseded = appliedSquashSupersededVersions(all, applied) ?? new Set<number>();
  const summary: Record<MigrationInfoStatus, number> = {
    applied: 0,
    pending: 0,
    adoptable: 0,
    superseded: 0,
    tampered: 0,
    failed: 0,
  };
  const items = all.map((m): MigrationInfoItem => {
    const validationEvent = validationByVersion.get(m.version);
    if (validationEvent?.kind === "tampered") {
      summary.tampered++;
      return {
        version: m.version,
        name: m.name,
        status: "tampered",
        detail: `hash mismatch: applied ${validationEvent.applied.slice(0, 16)} vs current ${validationEvent.current.slice(0, 16)}`,
      };
    }
    if (validationEvent?.kind === "failed") {
      summary.failed++;
      return { version: m.version, name: m.name, status: "failed", detail: validationEvent.error };
    }
    if (superseded.has(m.version)) {
      summary.superseded++;
      return { version: m.version, name: m.name, status: "superseded" };
    }
    const a = applied.get(m.version);
    if (a) {
      if (a.hash !== m.upHash) {
        summary.tampered++;
        return {
          version: m.version,
          name: m.name,
          status: "tampered",
          detail: `hash mismatch: applied ${a.hash.slice(0, 16)} vs current ${m.upHash.slice(0, 16)}`,
        };
      }
      summary.applied++;
      return { version: m.version, name: m.name, status: "applied" };
    }
    const plannedStep = planned.get(m.version);
    if (plannedStep?.kind === "adopt") {
      summary.adoptable++;
      return { version: m.version, name: m.name, status: "adoptable", detail: `${plannedStep.replaced} replaced` };
    }
    summary.pending++;
    return { version: m.version, name: m.name, status: "pending" };
  });
  return { historyTable: store?.table ?? null, summary, items };
}

export async function applyPending(
  c: PgClient,
  migrationsDir: string,
  onEvent?: (e: ApplyOutcome) => void,
): Promise<{ applied: number; tampered: number; failed: number }> {
  const store = await ensureTable(c);
  const applied = await listApplied(c, store);
  const all = readMigrations(migrationsDir);
  const counts = { applied: 0, tampered: 0, failed: 0 };
  const plan = buildMigrationPlan(all, applied, onEvent);
  if (plan.kind === "tampered") {
    counts.tampered++;
    return counts;
  }
  if (plan.kind === "failed") {
    counts.failed++;
    return counts;
  }

  for (const step of plan.steps) {
    const m = step.migration;
    if (step.kind === "adopt") {
      const adoption = await executeSquashAdoption(c, store, m, applied, step.replaced, onEvent);
      if (adoption === "failed") {
        counts.failed++;
        return counts;
      }
      counts.applied++;
      continue;
    }
    let committed = false;
    await c.simpleQuery("BEGIN");
    try {
      await c.simpleQuery(m.upSql);
      await c.execParamsText(
        `INSERT INTO ${store.table} (version, name, up_hash) VALUES ($1, $2, $3)`,
        [String(m.version), m.name, m.upHash],
      );
      await c.simpleQuery("COMMIT");
      committed = true;
    } catch (err) {
      let rollbackErr: string | undefined;
      if (!committed) {
        try { await c.simpleQuery("ROLLBACK"); } catch (rb) { rollbackErr = (rb as Error).message; }
      }
      counts.failed++;
      const message = rollbackErr
        ? `${(err as Error).message} (rollback also failed: ${rollbackErr})`
        : (err as Error).message;
      onEvent?.({ kind: "failed", version: m.version, name: m.name, error: message });
      return counts;
    }
    try {
      await resetMigrationSession(c);
    } catch (err) {
      counts.failed++;
      onEvent?.({ kind: "failed", version: m.version, name: m.name, error: `failed to reset migration session: ${(err as Error).message}` });
      return counts;
    }
    counts.applied++;
    applied.set(m.version, { name: m.name, hash: m.upHash });
    onEvent?.({ kind: "applied", version: m.version, name: m.name });
  }
  return counts;
}

function lockKeyToString(lockKey: number | bigint): string {
  if (typeof lockKey === "bigint") return lockKey.toString();
  if (!Number.isSafeInteger(lockKey)) {
    throw new Error(`sqlx-js.migrate: lockKey must be a safe integer or bigint, got ${lockKey}`);
  }
  return BigInt(lockKey).toString();
}

export async function acquireMigrateLock(
  c: PgClient,
  lockKey: number | bigint = DEFAULT_MIGRATE_LOCK_KEY,
  timeoutMs?: number,
): Promise<void> {
  if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
    throw new Error(`sqlx-js.migrate: lockTimeoutMs must be a finite number, got ${timeoutMs}`);
  }
  const key = lockKeyToString(lockKey);
  if (timeoutMs === undefined || timeoutMs <= 0) {
    await c.simpleQuery(`SELECT pg_advisory_lock(${key})`);
    return;
  }
  const start = Date.now();
  let delay = 50;
  while (true) {
    const r = await c.simpleQuery(`SELECT pg_try_advisory_lock(${key})`);
    const got = decodeText(r.rows[0]?.[0] ?? null) === "t";
    if (got) return;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      throw new Error(`sqlx-js.migrate: failed to acquire advisory lock ${key} within ${timeoutMs}ms`);
    }
    const remaining = timeoutMs - elapsed;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, 2000);
  }
}

export async function releaseMigrateLock(
  c: PgClient,
  lockKey: number | bigint = DEFAULT_MIGRATE_LOCK_KEY,
): Promise<void> {
  const key = lockKeyToString(lockKey);
  await c.simpleQuery(`SELECT pg_advisory_unlock(${key})`);
}

function safeMigrationName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^[^a-zA-Z0-9]+/, "");
  if (!safe) throw new Error(`sqlx-js.migrate: invalid migration name "${name}"`);
  return safe;
}

function renderSquashMigration(replaces: SquashReplacement[], schemaSql: string): string {
  const metadata: SquashMetadata = { format: 1, replaces };
  return [
    `${SQUASH_PREFIX} ${JSON.stringify(metadata)}`,
    "-- generated by sqlx-js migrate squash",
    "-- This baseline can be applied to an empty database or adopted by a database",
    "-- that has all replaced migrations recorded with matching hashes.",
    "",
    schemaSql.trimEnd(),
    "",
  ].join("\n");
}

export function sanitizePgDumpSchema(sql: string): string {
  const out: string[] = [];
  let state: PgDumpScanState = { dollarQuote: null, blockComment: false, singleQuote: null };
  for (const line of sql.split(/\r?\n/)) {
    if (!state.dollarQuote && !state.blockComment && !state.singleQuote && line.trimStart().startsWith("\\")) continue;
    out.push(line);
    state = scanPgDumpLine(line, state);
  }
  return out.join("\n").trimEnd() + "\n";
}

type PgDumpScanState = {
  dollarQuote: string | null;
  blockComment: boolean;
  singleQuote: "standard" | "escape" | null;
};

function matchDollarQuote(line: string, index: number): string | null {
  const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(line.slice(index));
  return m?.[0] ?? null;
}

function scanPgDumpLine(line: string, current: PgDumpScanState): PgDumpScanState {
  const state = { ...current };
  let i = 0;
  while (i < line.length) {
    if (state.singleQuote) {
      while (i < line.length) {
        if (state.singleQuote === "escape" && line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] !== "'") {
          i++;
          continue;
        }
        if (line[i + 1] === "'") {
          i += 2;
          continue;
        }
        i++;
        state.singleQuote = null;
        break;
      }
      continue;
    }
    if (state.dollarQuote) {
      const end = line.indexOf(state.dollarQuote, i);
      if (end === -1) return state;
      i = end + state.dollarQuote.length;
      state.dollarQuote = null;
      continue;
    }
    if (state.blockComment) {
      const end = line.indexOf("*/", i);
      if (end === -1) return state;
      i = end + 2;
      state.blockComment = false;
      continue;
    }
    const ch = line[i];
    const next = line[i + 1];
    if (ch === "-" && next === "-") break;
    if (ch === "/" && next === "*") {
      state.blockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const escapeString = i > 0 && (line[i - 1] === "E" || line[i - 1] === "e");
      state.singleQuote = escapeString ? "escape" : "standard";
      i++;
      continue;
    }
    if (ch === "$") {
      const tag = matchDollarQuote(line, i);
      if (tag) {
        state.dollarQuote = tag;
        i += tag.length;
        continue;
      }
    }
    i++;
  }
  return state;
}

function archiveMigrations(migrationsDir: string, archiveName: string, migrations: MigrationFile[]): string {
  const archiveDir = join(migrationsDir, ".archive", archiveName);
  if (existsSync(archiveDir)) {
    throw new Error(`sqlx-js.migrate: archive already exists: ${archiveDir}`);
  }
  mkdirSync(archiveDir, { recursive: true });
  for (const m of migrations) {
    renameSync(m.upPath, join(archiveDir, basename(m.upPath)));
    if (m.downPath) renameSync(m.downPath, join(archiveDir, basename(m.downPath)));
  }
  return archiveDir;
}

function validateArchiveName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`sqlx-js.migrate: unsafe archive name ${name}`);
  }
}

function isMigrationSqlFile(file: string): boolean {
  const up = FILE_RE.exec(file);
  const down = DOWN_FILE_RE.exec(file);
  const m = up ?? down;
  return !!m && SAFE_NAME_RE.test(m[2]!);
}

export function listMigrationArchives(migrationsDir: string): MigrationArchive[] {
  const archiveRoot = join(migrationsDir, ".archive");
  if (!existsSync(archiveRoot)) return [];
  return readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_NAME_RE.test(entry.name))
    .map((entry) => {
      const path = join(archiveRoot, entry.name);
      const files = readdirSync(path)
        .filter((file) => isMigrationSqlFile(file))
        .sort();
      return { name: entry.name, path, files };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function restoreMigrationArchive(
  migrationsDir: string,
  archiveName: string,
  opts: { force?: boolean } = {},
): { archiveName: string; restored: string[] } {
  validateArchiveName(archiveName);
  const archiveDir = join(migrationsDir, ".archive", archiveName);
  if (!existsSync(archiveDir)) {
    throw new Error(`sqlx-js.migrate: archive not found: ${archiveName}`);
  }
  const files = readdirSync(archiveDir)
    .filter((file) => isMigrationSqlFile(file))
    .sort();
  if (files.length === 0) throw new Error(`sqlx-js.migrate: archive is empty: ${archiveName}`);

  const conflicts = files.filter((file) => existsSync(join(migrationsDir, file)));
  if (conflicts.length > 0 && !opts.force) {
    throw new Error(`sqlx-js.migrate: restore would overwrite existing migration file(s): ${conflicts.join(", ")}`);
  }

  for (const file of files) {
    renameSync(join(archiveDir, file), join(migrationsDir, file));
  }
  return { archiveName, restored: files };
}

export function createSquashMigration(opts: {
  migrationsDir: string;
  name: string;
  schemaSql: string;
  replace?: boolean;
}): { version: number; name: string; upPath: string; replaced: number; archiveDir?: string } {
  if (!existsSync(opts.migrationsDir)) mkdirSync(opts.migrationsDir, { recursive: true });
  const existing = readMigrations(opts.migrationsDir);
  if (existing.length === 0) throw new Error("sqlx-js.migrate: no migrations to squash");
  if (opts.schemaSql.trim() === "") throw new Error("sqlx-js.migrate: squash schema SQL is empty");

  const safe = safeMigrationName(opts.name);
  const nextVersion = (existing[existing.length - 1]?.version ?? 0) + 1;
  const padded = String(nextVersion).padStart(4, "0");
  const upPath = join(opts.migrationsDir, `${padded}_${safe}.up.sql`);
  if (existsSync(upPath)) throw new Error(`sqlx-js.migrate: migration already exists: ${upPath}`);

  const replaces = effectiveSquashReplacements(existing);
  writeFileSync(upPath, renderSquashMigration(replaces, opts.schemaSql));

  let archiveDir: string | undefined;
  if (opts.replace) {
    archiveDir = archiveMigrations(opts.migrationsDir, `${padded}_${safe}`, existing);
  }

  return { version: nextVersion, name: safe, upPath, replaced: replaces.length, archiveDir };
}

function pgDumpEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const cfg = parseDatabaseUrl(databaseUrl);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PGHOST = cfg.host;
  env.PGPORT = String(cfg.port);
  env.PGUSER = cfg.user;
  env.PGDATABASE = cfg.database;
  if (cfg.password) env.PGPASSWORD = cfg.password;
  else delete env.PGPASSWORD;
  if (cfg.sslmode) env.PGSSLMODE = cfg.sslmode;
  else delete env.PGSSLMODE;
  if (cfg.applicationName) env.PGAPPNAME = cfg.applicationName;
  else delete env.PGAPPNAME;
  if (cfg.connectTimeoutMs) env.PGCONNECT_TIMEOUT = String(cfg.connectTimeoutMs / 1000);
  else delete env.PGCONNECT_TIMEOUT;
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  delete env.PGPASSFILE;
  return env;
}

export function dumpSchema(databaseUrl: string, pgDumpPath = "pg_dump"): string {
  const tmp = mkdtempSync(join(tmpdir(), "sqlx-js-pgdump-"));
  const outPath = join(tmp, "schema.sql");
  const args = [
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--exclude-table=*._sqlx_js_migrations",
    "--exclude-table=_sqlx_js_migrations",
    "--exclude-table=public._sqlx_js_migrations",
    `--file=${outPath}`,
    "-w",
  ];
  try {
    const r = spawnSync(pgDumpPath, args, {
      encoding: "utf8",
      env: pgDumpEnv(databaseUrl),
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) {
      throw new Error(`sqlx-js.migrate: failed to run ${pgDumpPath}: ${r.error.message}`);
    }
    if (r.status !== 0) {
      throw new Error(`sqlx-js.migrate: ${pgDumpPath} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
    }
    const schema = sanitizePgDumpSchema(readFileSync(outPath, "utf8"));
    if (schema.trim() === "") throw new Error("sqlx-js.migrate: pg_dump returned empty schema");
    return schema;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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
  assertMigrationCheckOk(opts.migrationsDir);
  let ok = true;
  await withWorkflowShadowDatabase(opts, async (shadowDatabaseUrl) => {
    await applyMigrationsForWorkflow(shadowDatabaseUrl, opts.migrationsDir, opts.lockKey, opts.lockTimeoutMs);
    await validateLatestDownForWorkflow(shadowDatabaseUrl, opts.migrationsDir);
    ok = await prepareWorkflowArtifacts(opts, shadowDatabaseUrl);
  });
  if (!ok) process.exit(1);
}

export async function migrateVerify(opts: MigrationWorkflowOptions): Promise<void> {
  assertMigrationCheckOk(opts.migrationsDir);
  let ok = true;
  await withWorkflowShadowDatabase(opts, async (shadowDatabaseUrl) => {
    await applyMigrationsForWorkflow(shadowDatabaseUrl, opts.migrationsDir, opts.lockKey, opts.lockTimeoutMs);
    await validateLatestDownForWorkflow(shadowDatabaseUrl, opts.migrationsDir);
    ok = await prepareInTemporaryArtifacts(opts, shadowDatabaseUrl);
  });
  if (!ok) process.exit(1);
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
    await isolateShadowSchemaState(c);
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
