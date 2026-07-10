import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PgClient, decodeText } from "./pg/wire";

export type MigrationFile = {
  version: number;
  name: string;
  upPath: string;
  downPath: string | null;
  upSql: string;
  upHash: string;
  squash: SquashMetadata | null;
};

export type SquashReplacement = {
  version: number;
  name: string;
  upHash: string;
};

export type SquashMetadata = {
  format: 1;
  replaces: SquashReplacement[];
};

export type MigrationStore = {
  table: string;
};

export const SQUASH_PREFIX = "-- sqlx-js-squash:";
export const DEFAULT_MIGRATE_LOCK_KEY = 18750938867203960n;

const FILE_RE = /^(\d+)_(.+)\.up\.sql$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MIGRATIONS_TABLE = "_sqlx_js_migrations";

export function readMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const out: MigrationFile[] = [];
  for (const file of readdirSync(dir).sort()) {
    const match = FILE_RE.exec(file);
    if (!match) continue;
    const version = parseInt(match[1]!, 10);
    const name = match[2]!;
    if (!SAFE_NAME_RE.test(name)) {
      throw new Error(
        `sqlx-js.migrate: unsafe migration filename ${file} — name must match /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`,
      );
    }
    const upPath = join(dir, file);
    const downPath = join(dir, `${match[1]}_${name}.down.sql`);
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

export function parseSquashMetadata(sql: string): SquashMetadata | null {
  const line = sql.split(/\r?\n/).find((value) => value.startsWith(SQUASH_PREFIX));
  if (!line) return null;
  const raw = line.slice(SQUASH_PREFIX.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`sqlx-js.migrate: invalid squash metadata JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("sqlx-js.migrate: invalid squash metadata");
  const value = parsed as { format?: unknown; replaces?: unknown };
  if (value.format !== 1 || !Array.isArray(value.replaces) || value.replaces.length === 0) {
    throw new Error("sqlx-js.migrate: invalid squash metadata");
  }
  const replaces: SquashReplacement[] = [];
  for (const replacement of value.replaces) {
    if (!replacement || typeof replacement !== "object") {
      throw new Error("sqlx-js.migrate: invalid squash replacement metadata");
    }
    const item = replacement as { version?: unknown; name?: unknown; upHash?: unknown };
    if (typeof item.version !== "number" || !Number.isSafeInteger(item.version) || item.version <= 0) {
      throw new Error("sqlx-js.migrate: invalid squash replacement version");
    }
    if (typeof item.name !== "string" || !SAFE_NAME_RE.test(item.name)) {
      throw new Error("sqlx-js.migrate: invalid squash replacement name");
    }
    if (typeof item.upHash !== "string" || !/^[a-f0-9]{64}$/.test(item.upHash)) {
      throw new Error("sqlx-js.migrate: invalid squash replacement hash");
    }
    replaces.push({ version: item.version, name: item.name, upHash: item.upHash });
  }
  return { format: 1, replaces };
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

async function findMigrationStore(client: PgClient): Promise<MigrationStore | null> {
  const result = await client.simpleQuery(`
    SELECT n.nspname, cls.relname
    FROM pg_class cls
    JOIN pg_namespace n ON n.oid = cls.relnamespace
    WHERE cls.oid = to_regclass('${MIGRATIONS_TABLE}')
  `);
  const row = result.rows[0];
  if (!row) return null;
  const schema = decodeText(row[0]!);
  const table = decodeText(row[1]!);
  if (!schema || !table) throw new Error(`sqlx-js.migrate: failed to resolve ${MIGRATIONS_TABLE} identifier`);
  return { table: `${quoteIdent(schema)}.${quoteIdent(table)}` };
}

async function resolveMigrationStore(client: PgClient): Promise<MigrationStore> {
  const store = await findMigrationStore(client);
  if (!store) throw new Error(`sqlx-js.migrate: failed to resolve ${MIGRATIONS_TABLE} in current search_path`);
  return store;
}

export async function ensureTable(client: PgClient): Promise<MigrationStore> {
  const existing = await findMigrationStore(client);
  if (existing) return existing;
  await client.simpleQuery(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      up_hash TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  return resolveMigrationStore(client);
}

export async function listApplied(
  client: PgClient,
  store?: MigrationStore,
): Promise<Map<number, { name: string; hash: string }>> {
  const resolved = store ?? await resolveMigrationStore(client);
  const result = await client.simpleQuery(`SELECT version, name, up_hash FROM ${resolved.table} ORDER BY version`);
  const out = new Map<number, { name: string; hash: string }>();
  for (const row of result.rows) {
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

type InternalMigrationPlanItem =
  | { kind: "apply"; migration: MigrationFile }
  | { kind: "adopt"; migration: MigrationFile; replaced: number };

export type MigrationValidationOutcome =
  | { kind: "tampered"; version: number; name: string; applied: string; current: string }
  | { kind: "failed"; version: number; name: string; error: string };

function appliedSquashSupersededVersions(
  all: MigrationFile[],
  applied: Map<number, { name: string; hash: string }>,
  onEvent?: (event: MigrationValidationOutcome) => void,
): Set<number> | null {
  const superseded = new Set<number>();
  const byVersion = new Map(all.map((migration) => [migration.version, migration]));
  const visitedSquashes = new Set<number>();
  const visitReplacements = (migration: MigrationFile): boolean => {
    if (!migration.squash || visitedSquashes.has(migration.version)) return true;
    visitedSquashes.add(migration.version);
    for (const replacement of migration.squash.replaces) {
      superseded.add(replacement.version);
      const current = byVersion.get(replacement.version);
      if (!current?.squash || current.version >= migration.version) continue;
      if (current.name !== replacement.name || current.upHash !== replacement.upHash) {
        onEvent?.({ kind: "tampered", version: replacement.version, name: replacement.name, applied: replacement.upHash, current: current.upHash });
        return false;
      }
      if (!visitReplacements(current)) return false;
    }
    return true;
  };
  for (const migration of all) {
    if (!migration.squash) continue;
    const current = applied.get(migration.version);
    if (!current) continue;
    if (current.hash !== migration.upHash) {
      onEvent?.({ kind: "tampered", version: migration.version, name: migration.name, applied: current.hash, current: migration.upHash });
      return null;
    }
    if (!visitReplacements(migration)) return null;
  }
  return superseded;
}

function squashCoveredVersions(all: MigrationFile[]): Set<number> {
  const covered = new Set<number>();
  for (const migration of all) {
    if (!migration.squash) continue;
    for (const replacement of migration.squash.replaces) {
      if (replacement.version >= migration.version) {
        throw new Error(
          `sqlx-js.migrate: squash replacement ${replacement.version}_${replacement.name} must be older than ${migration.version}_${migration.name}`,
        );
      }
      covered.add(replacement.version);
    }
  }
  return covered;
}

export function effectiveSquashReplacements(all: MigrationFile[]): SquashReplacement[] {
  const covered = squashCoveredVersions(all);
  return all
    .filter((migration) => !covered.has(migration.version))
    .map((migration) => ({ version: migration.version, name: migration.name, upHash: migration.upHash }));
}

function preflightSquashMigrations(
  all: MigrationFile[],
  applied: Map<number, { name: string; hash: string }>,
  superseded: Set<number>,
  onEvent?: (event: MigrationValidationOutcome) => void,
): "ok" | "failed" | "tampered" {
  const byVersion = new Map(all.map((migration) => [migration.version, migration]));
  for (const migration of all) {
    if (!migration.squash) continue;
    let present = 0;
    for (const replacement of migration.squash.replaces) {
      if (replacement.version >= migration.version) {
        onEvent?.({
          kind: "failed",
          version: migration.version,
          name: migration.name,
          error: `squash replacement ${replacement.version}_${replacement.name} must be older than ${migration.version}_${migration.name}`,
        });
        return "failed";
      }
      const current = byVersion.get(replacement.version);
      if (
        current &&
        !superseded.has(replacement.version) &&
        (current.name !== replacement.name || current.upHash !== replacement.upHash)
      ) {
        onEvent?.({
          kind: "tampered",
          version: replacement.version,
          name: replacement.name,
          applied: replacement.upHash,
          current: current.upHash,
        });
        return "tampered";
      }
      const currentApplied = applied.get(replacement.version);
      if (!currentApplied) continue;
      present++;
      if (currentApplied.hash !== replacement.upHash || currentApplied.name !== replacement.name) {
        onEvent?.({
          kind: "tampered",
          version: replacement.version,
          name: replacement.name,
          applied: currentApplied.hash,
          current: replacement.upHash,
        });
        return "tampered";
      }
    }
    if (present > 0 && present !== migration.squash.replaces.length) {
      onEvent?.({
        kind: "failed",
        version: migration.version,
        name: migration.name,
        error: `squash migration replaces ${migration.squash.replaces.length} migration(s), but only ${present} matching row(s) are applied`,
      });
      return "failed";
    }
  }
  return "ok";
}

function planSquashAdoption(
  migration: MigrationFile,
  applied: Map<number, { name: string; hash: string }>,
  onEvent?: (event: MigrationValidationOutcome) => void,
): { kind: "none" } | { kind: "adopt"; replaced: number } | { kind: "failed" } | { kind: "tampered" } {
  if (!migration.squash) return { kind: "none" };
  let present = 0;
  for (const replacement of migration.squash.replaces) {
    if (replacement.version >= migration.version) {
      onEvent?.({
        kind: "failed",
        version: migration.version,
        name: migration.name,
        error: `squash replacement ${replacement.version}_${replacement.name} must be older than ${migration.version}_${migration.name}`,
      });
      return { kind: "failed" };
    }
    const current = applied.get(replacement.version);
    if (!current) continue;
    present++;
    if (current.hash !== replacement.upHash || current.name !== replacement.name) {
      onEvent?.({
        kind: "tampered",
        version: replacement.version,
        name: replacement.name,
        applied: current.hash,
        current: replacement.upHash,
      });
      return { kind: "tampered" };
    }
  }
  if (present === 0) return { kind: "none" };
  if (present !== migration.squash.replaces.length) {
    onEvent?.({
      kind: "failed",
      version: migration.version,
      name: migration.name,
      error: `squash migration replaces ${migration.squash.replaces.length} migration(s), but only ${present} matching row(s) are applied`,
    });
    return { kind: "failed" };
  }
  return { kind: "adopt", replaced: migration.squash.replaces.length };
}

export function buildMigrationPlan(
  all: MigrationFile[],
  applied: Map<number, { name: string; hash: string }>,
  onEvent?: (event: MigrationValidationOutcome) => void,
): { kind: "ok"; steps: InternalMigrationPlanItem[] } | { kind: "failed" } | { kind: "tampered" } {
  const plannedApplied = new Map(applied);
  const superseded = appliedSquashSupersededVersions(all, plannedApplied, onEvent);
  if (!superseded) return { kind: "tampered" };
  const preflight = preflightSquashMigrations(all, plannedApplied, superseded, onEvent);
  if (preflight !== "ok") return { kind: preflight };

  const steps: InternalMigrationPlanItem[] = [];
  for (const migration of all) {
    if (superseded.has(migration.version)) continue;
    const current = plannedApplied.get(migration.version);
    if (current) {
      if (current.hash !== migration.upHash) {
        onEvent?.({
          kind: "tampered",
          version: migration.version,
          name: migration.name,
          applied: current.hash,
          current: migration.upHash,
        });
        return { kind: "tampered" };
      }
      continue;
    }
    const adoption = planSquashAdoption(migration, plannedApplied, onEvent);
    if (adoption.kind === "adopt") {
      steps.push({ kind: "adopt", migration, replaced: adoption.replaced });
      for (const replacement of migration.squash!.replaces) plannedApplied.delete(replacement.version);
      plannedApplied.set(migration.version, { name: migration.name, hash: migration.upHash });
      continue;
    }
    if (adoption.kind === "tampered" || adoption.kind === "failed") return { kind: adoption.kind };
    steps.push({ kind: "apply", migration });
    plannedApplied.set(migration.version, { name: migration.name, hash: migration.upHash });
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

export async function resetMigrationSession(client: PgClient): Promise<void> {
  await client.simpleQuery("RESET ALL");
}

async function executeSquashAdoption(
  client: PgClient,
  store: MigrationStore,
  migration: MigrationFile,
  applied: Map<number, { name: string; hash: string }>,
  replaced: number,
  onEvent?: (event: ApplyOutcome) => void,
): Promise<"done" | "failed"> {
  if (!migration.squash) return "failed";
  let committed = false;
  await client.simpleQuery("BEGIN");
  try {
    for (const replacement of migration.squash.replaces) {
      await client.execParamsText(`DELETE FROM ${store.table} WHERE version = $1`, [String(replacement.version)]);
    }
    await client.execParamsText(
      `INSERT INTO ${store.table} (version, name, up_hash) VALUES ($1, $2, $3)`,
      [String(migration.version), migration.name, migration.upHash],
    );
    await client.simpleQuery("COMMIT");
    committed = true;
  } catch (error) {
    let rollbackError: string | undefined;
    if (!committed) {
      try { await client.simpleQuery("ROLLBACK"); } catch (rollback) { rollbackError = (rollback as Error).message; }
    }
    const message = rollbackError
      ? `${(error as Error).message} (rollback also failed: ${rollbackError})`
      : (error as Error).message;
    onEvent?.({ kind: "failed", version: migration.version, name: migration.name, error: message });
    return "failed";
  }
  try {
    await resetMigrationSession(client);
  } catch (error) {
    onEvent?.({
      kind: "failed",
      version: migration.version,
      name: migration.name,
      error: `failed to reset migration session: ${(error as Error).message}`,
    });
    return "failed";
  }
  for (const replacement of migration.squash.replaces) applied.delete(replacement.version);
  applied.set(migration.version, { name: migration.name, hash: migration.upHash });
  onEvent?.({ kind: "adopted", version: migration.version, name: migration.name, replaced });
  return "done";
}

export async function planPending(
  client: PgClient,
  migrationsDir: string,
  onEvent?: (event: PlanOutcome) => void,
): Promise<{ pending: number; adoptable: number; tampered: number; failed: number; steps: MigrationPlanItem[] }> {
  const store = await findMigrationStore(client);
  const applied = store ? await listApplied(client, store) : new Map<number, { name: string; hash: string }>();
  const all = readMigrations(migrationsDir);
  const counts = { pending: 0, adoptable: 0, tampered: 0, failed: 0 };
  const plan = buildMigrationPlan(all, applied, onEvent);
  if (plan.kind === "tampered") return { ...counts, tampered: 1, steps: [] };
  if (plan.kind === "failed") return { ...counts, failed: 1, steps: [] };
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

export async function inspectMigrationPlan(client: PgClient, migrationsDir: string): Promise<MigrationPlanSnapshot> {
  const diagnostics: MigrationPlanDiagnostic[] = [];
  const result = await planPending(client, migrationsDir, (event) => {
    if (event.kind === "tampered" || event.kind === "failed") diagnostics.push(event);
  });
  return { ok: result.tampered === 0 && result.failed === 0, ...result, diagnostics };
}

export async function inspectMigrations(client: PgClient, migrationsDir: string): Promise<MigrationInfoSnapshot> {
  const store = await findMigrationStore(client);
  const applied = store ? await listApplied(client, store) : new Map<number, { name: string; hash: string }>();
  const all = readMigrations(migrationsDir);
  const validation: MigrationValidationOutcome[] = [];
  const plan = buildMigrationPlan(all, applied, (event) => validation.push(event));
  const planned = new Map<number, InternalMigrationPlanItem>();
  if (plan.kind === "ok") {
    for (const step of plan.steps) planned.set(step.migration.version, step);
  }
  const validationByVersion = new Map(validation.map((event) => [event.version, event]));
  const superseded = appliedSquashSupersededVersions(all, applied) ?? new Set<number>();
  const summary: Record<MigrationInfoStatus, number> = {
    applied: 0,
    pending: 0,
    adoptable: 0,
    superseded: 0,
    tampered: 0,
    failed: 0,
  };
  const items = all.map((migration): MigrationInfoItem => {
    const validationEvent = validationByVersion.get(migration.version);
    if (validationEvent?.kind === "tampered") {
      summary.tampered++;
      return {
        version: migration.version,
        name: migration.name,
        status: "tampered",
        detail: `hash mismatch: applied ${validationEvent.applied.slice(0, 16)} vs current ${validationEvent.current.slice(0, 16)}`,
      };
    }
    if (validationEvent?.kind === "failed") {
      summary.failed++;
      return { version: migration.version, name: migration.name, status: "failed", detail: validationEvent.error };
    }
    if (superseded.has(migration.version)) {
      summary.superseded++;
      return { version: migration.version, name: migration.name, status: "superseded" };
    }
    const current = applied.get(migration.version);
    if (current) {
      if (current.hash !== migration.upHash) {
        summary.tampered++;
        return {
          version: migration.version,
          name: migration.name,
          status: "tampered",
          detail: `hash mismatch: applied ${current.hash.slice(0, 16)} vs current ${migration.upHash.slice(0, 16)}`,
        };
      }
      summary.applied++;
      return { version: migration.version, name: migration.name, status: "applied" };
    }
    const plannedStep = planned.get(migration.version);
    if (plannedStep?.kind === "adopt") {
      summary.adoptable++;
      return {
        version: migration.version,
        name: migration.name,
        status: "adoptable",
        detail: `${plannedStep.replaced} replaced`,
      };
    }
    summary.pending++;
    return { version: migration.version, name: migration.name, status: "pending" };
  });
  return { historyTable: store?.table ?? null, summary, items };
}

export async function applyPending(
  client: PgClient,
  migrationsDir: string,
  onEvent?: (event: ApplyOutcome) => void,
): Promise<{ applied: number; tampered: number; failed: number }> {
  const store = await ensureTable(client);
  const applied = await listApplied(client, store);
  const all = readMigrations(migrationsDir);
  const counts = { applied: 0, tampered: 0, failed: 0 };
  const plan = buildMigrationPlan(all, applied, onEvent);
  if (plan.kind === "tampered") return { ...counts, tampered: 1 };
  if (plan.kind === "failed") return { ...counts, failed: 1 };

  for (const step of plan.steps) {
    const migration = step.migration;
    if (step.kind === "adopt") {
      const adoption = await executeSquashAdoption(client, store, migration, applied, step.replaced, onEvent);
      if (adoption === "failed") return { ...counts, failed: counts.failed + 1 };
      counts.applied++;
      continue;
    }
    let committed = false;
    await client.simpleQuery("BEGIN");
    try {
      await client.simpleQuery(migration.upSql);
      await client.execParamsText(
        `INSERT INTO ${store.table} (version, name, up_hash) VALUES ($1, $2, $3)`,
        [String(migration.version), migration.name, migration.upHash],
      );
      await client.simpleQuery("COMMIT");
      committed = true;
    } catch (error) {
      let rollbackError: string | undefined;
      if (!committed) {
        try { await client.simpleQuery("ROLLBACK"); } catch (rollback) { rollbackError = (rollback as Error).message; }
      }
      counts.failed++;
      const message = rollbackError
        ? `${(error as Error).message} (rollback also failed: ${rollbackError})`
        : (error as Error).message;
      onEvent?.({ kind: "failed", version: migration.version, name: migration.name, error: message });
      return counts;
    }
    try {
      await resetMigrationSession(client);
    } catch (error) {
      counts.failed++;
      onEvent?.({
        kind: "failed",
        version: migration.version,
        name: migration.name,
        error: `failed to reset migration session: ${(error as Error).message}`,
      });
      return counts;
    }
    counts.applied++;
    applied.set(migration.version, { name: migration.name, hash: migration.upHash });
    onEvent?.({ kind: "applied", version: migration.version, name: migration.name });
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
  client: PgClient,
  lockKey: number | bigint = DEFAULT_MIGRATE_LOCK_KEY,
  timeoutMs?: number,
): Promise<void> {
  if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
    throw new Error(`sqlx-js.migrate: lockTimeoutMs must be a finite number, got ${timeoutMs}`);
  }
  const key = lockKeyToString(lockKey);
  if (timeoutMs === undefined || timeoutMs <= 0) {
    await client.simpleQuery(`SELECT pg_advisory_lock(${key})`);
    return;
  }
  const start = Date.now();
  let delay = 50;
  while (true) {
    const result = await client.simpleQuery(`SELECT pg_try_advisory_lock(${key})`);
    if (decodeText(result.rows[0]?.[0] ?? null) === "t") return;
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
  client: PgClient,
  lockKey: number | bigint = DEFAULT_MIGRATE_LOCK_KEY,
): Promise<void> {
  const key = lockKeyToString(lockKey);
  await client.simpleQuery(`SELECT pg_advisory_unlock(${key})`);
}
