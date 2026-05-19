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

export const MIGRATE_LOCK_KEY_VALUE = 18750938867203960;

const FILE_RE = /^(\d+)_(.+)\.up\.sql$/;

function readMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const out: MigrationFile[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = FILE_RE.exec(f);
    if (!m) continue;
    const version = parseInt(m[1]!, 10);
    const name = m[2]!;
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
    CREATE TABLE IF NOT EXISTS _bun_sqlx_migrations (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      up_hash TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function listApplied(c: PgClient): Promise<Map<number, { name: string; hash: string }>> {
  const r = await c.simpleQuery("SELECT version, name, up_hash FROM _bun_sqlx_migrations ORDER BY version");
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
      const escName = m.name.replace(/'/g, "''");
      const escHash = m.upHash.replace(/'/g, "''");
      await c.simpleQuery(
        `INSERT INTO _bun_sqlx_migrations (version, name, up_hash) VALUES (${m.version}, '${escName}', '${escHash}')`,
      );
      await c.simpleQuery("COMMIT");
      counts.applied++;
      onEvent?.({ kind: "applied", version: m.version, name: m.name });
    } catch (err) {
      await c.simpleQuery("ROLLBACK");
      counts.failed++;
      onEvent?.({ kind: "failed", version: m.version, name: m.name, error: (err as Error).message });
      return counts;
    }
  }
  return counts;
}

const MIGRATE_LOCK_KEY = MIGRATE_LOCK_KEY_VALUE;

export async function migrateRun(opts: MigrateOptions): Promise<void> {
  const cfg = parseDatabaseUrl(opts.databaseUrl);
  const c = new PgClient(cfg);
  await c.connect();
  let exitCode = 0;
  let locked = false;
  try {
    await c.simpleQuery(`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`);
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
      try { await c.simpleQuery(`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`); } catch {}
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

export async function migrateRevert(opts: MigrateOptions): Promise<void> {
  const cfg = parseDatabaseUrl(opts.databaseUrl);
  const c = new PgClient(cfg);
  await c.connect();
  await ensureTable(c);
  const applied = await listApplied(c);
  const all = readMigrations(opts.migrationsDir);

  let last: MigrationFile | null = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (applied.has(all[i]!.version)) { last = all[i]!; break; }
  }
  if (!last) { console.log("nothing to revert"); await c.end(); return; }
  if (!last.downPath) {
    console.error(`migration ${last.version}_${last.name} has no .down.sql`);
    process.exit(1);
  }
  console.log(`reverting ${last.version}_${last.name}…`);
  const downSql = readFileSync(last.downPath, "utf8");
  await c.simpleQuery("BEGIN");
  try {
    await c.simpleQuery(downSql);
    await c.simpleQuery(`DELETE FROM _bun_sqlx_migrations WHERE version = ${last.version}`);
    await c.simpleQuery("COMMIT");
    console.log(`  ✓ reverted`);
  } catch (err) {
    await c.simpleQuery("ROLLBACK");
    console.error(`  ✗ ${(err as Error).message}`);
    process.exit(1);
  }
  await c.end();
}

export function migrateAdd(opts: MigrateOptions & { name: string }): void {
  if (!existsSync(opts.migrationsDir)) mkdirSync(opts.migrationsDir, { recursive: true });
  const existing = readMigrations(opts.migrationsDir);
  const nextVersion = (existing[existing.length - 1]?.version ?? 0) + 1;
  const safe = opts.name.replace(/[^a-zA-Z0-9_]+/g, "_");
  const fname = `${String(nextVersion).padStart(4, "0")}_${safe}.up.sql`;
  const full = join(opts.migrationsDir, fname);
  writeFileSync(full, `-- ${opts.name}\n`);
  console.log(`created ${full}`);
}
