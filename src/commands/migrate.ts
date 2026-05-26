import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PgClient, parseDatabaseUrl, decodeText } from "../pg/wire";

export type MigrateOptions = {
  databaseUrl: string;
  migrationsDir: string;
};

type MigrationFile = {
  version: number;
  name: string;
  upPath: string;
  downPath: string | null;
  upSql: string;
  upHash: string;
};

export const DEFAULT_MIGRATE_LOCK_KEY = 18750938867203960n;

const FILE_RE = /^(\d+)_(.+)\.up\.sql$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

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
    });
  }
  return out;
}

export async function ensureTable(c: PgClient): Promise<void> {
  await c.simpleQuery(`
    CREATE TABLE IF NOT EXISTS _sqlx_js_migrations (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      up_hash TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function listApplied(c: PgClient): Promise<Map<number, { name: string; hash: string }>> {
  const r = await c.simpleQuery("SELECT version, name, up_hash FROM _sqlx_js_migrations ORDER BY version");
  const out = new Map<number, { name: string; hash: string }>();
  for (const row of r.rows) {
    out.set(Number(decodeText(row[0]!)), { name: decodeText(row[1]!)!, hash: decodeText(row[2]!)! });
  }
  return out;
}

export type ApplyOutcome =
  | { kind: "applied"; version: number; name: string }
  | { kind: "tampered"; version: number; name: string; applied: string; current: string }
  | { kind: "failed"; version: number; name: string; error: string };

export async function applyPending(
  c: PgClient,
  migrationsDir: string,
  onEvent?: (e: ApplyOutcome) => void,
): Promise<{ applied: number; tampered: number; failed: number }> {
  await ensureTable(c);
  const applied = await listApplied(c);
  const all = readMigrations(migrationsDir);
  const counts = { applied: 0, tampered: 0, failed: 0 };

  for (const m of all) {
    const a = applied.get(m.version);
    if (a) {
      if (a.hash !== m.upHash) {
        counts.tampered++;
        onEvent?.({ kind: "tampered", version: m.version, name: m.name, applied: a.hash, current: m.upHash });
        return counts;
      }
      continue;
    }
    await c.simpleQuery("BEGIN");
    try {
      await c.simpleQuery(m.upSql);
      await c.execParamsText(
        "INSERT INTO _sqlx_js_migrations (version, name, up_hash) VALUES ($1, $2, $3)",
        [String(m.version), m.name, m.upHash],
      );
      await c.simpleQuery("COMMIT");
      counts.applied++;
      onEvent?.({ kind: "applied", version: m.version, name: m.name });
    } catch (err) {
      let rollbackErr: string | undefined;
      try { await c.simpleQuery("ROLLBACK"); } catch (rb) { rollbackErr = (rb as Error).message; }
      counts.failed++;
      const message = rollbackErr
        ? `${(err as Error).message} (rollback also failed: ${rollbackErr})`
        : (err as Error).message;
      onEvent?.({ kind: "failed", version: m.version, name: m.name, error: message });
      return counts;
    }
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

export async function migrateRun(
  opts: MigrateOptions & { lockKey?: number | bigint; lockTimeoutMs?: number },
): Promise<void> {
  const cfg = parseDatabaseUrl(opts.databaseUrl);
  const c = new PgClient(cfg);
  await c.connect();
  let exitCode = 0;
  let locked = false;
  const lockKey = opts.lockKey ?? DEFAULT_MIGRATE_LOCK_KEY;
  try {
    await acquireMigrateLock(c, lockKey, opts.lockTimeoutMs);
    locked = true;
    await applyPending(c, opts.migrationsDir, (e) => {
      if (e.kind === "applied") console.log(`applying ${e.version}_${e.name}…\n  ✓ applied`);
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

export async function migrateInfo(opts: MigrateOptions): Promise<void> {
  const cfg = parseDatabaseUrl(opts.databaseUrl);
  const c = new PgClient(cfg);
  await c.connect();
  await ensureTable(c);
  const applied = await listApplied(c);
  const all = readMigrations(opts.migrationsDir);
  console.log(`migrations in ${opts.migrationsDir}:`);
  for (const m of all) {
    const a = applied.get(m.version);
    const status = !a ? "pending" : a.hash === m.upHash ? "applied" : "applied (tampered!)";
    console.log(`  ${String(m.version).padStart(4, "0")}_${m.name}: ${status}`);
  }
  await c.end();
}

export type RevertOutcome =
  | { kind: "noop" }
  | { kind: "no-down"; version: number; name: string }
  | { kind: "reverted"; version: number; name: string }
  | { kind: "failed"; version: number; name: string; error: string };

export async function revertLast(c: PgClient, migrationsDir: string): Promise<RevertOutcome> {
  await ensureTable(c);
  const applied = await listApplied(c);
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
    await c.execParamsText("DELETE FROM _sqlx_js_migrations WHERE version = $1", [String(last.version)]);
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

export async function migrateRevert(
  opts: MigrateOptions & { lockKey?: number | bigint; lockTimeoutMs?: number },
): Promise<void> {
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

export function migrateAdd(opts: MigrateOptions & { name: string }): void {
  if (!existsSync(opts.migrationsDir)) mkdirSync(opts.migrationsDir, { recursive: true });
  const existing = readMigrations(opts.migrationsDir);
  const nextVersion = (existing[existing.length - 1]?.version ?? 0) + 1;
  const safe = opts.name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^[^a-zA-Z0-9]+/, "");
  if (!safe) throw new Error(`sqlx-js.migrate: invalid migration name "${opts.name}"`);
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
