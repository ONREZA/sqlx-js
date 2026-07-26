import {
  DEFAULT_MIGRATE_LOCK_KEY,
  acquireMigrateLock,
  applyPending,
  releaseMigrateLock,
} from "./migration-core";
import { parseDatabaseUrl, PgClient } from "./pg/wire";

export type MigrateOptions = {
  dir?: string;
  databaseUrl?: string;
  log?: (message: string) => void;
  lockKey?: number | bigint;
  lockTimeoutMs?: number;
};

function normalizeLockKey(lockKey: number | bigint): bigint {
  if (typeof lockKey === "bigint") return lockKey;
  if (!Number.isSafeInteger(lockKey)) {
    throw new Error(`sqlx-js.migrate: lockKey must be a safe integer or bigint, got ${lockKey}`);
  }
  return BigInt(lockKey);
}

export async function migrate(options: MigrateOptions = {}): Promise<void> {
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("sqlx-js.migrate: DATABASE_URL is required");
  const dir = options.dir ?? "migrations";
  const log = options.log ?? ((message: string) => console.log(`[sqlx-js] ${message}`));
  const lockKey = normalizeLockKey(options.lockKey ?? DEFAULT_MIGRATE_LOCK_KEY);

  const client = new PgClient(parseDatabaseUrl(url));
  await client.connect();
  let locked = false;
  try {
    await acquireMigrateLock(client, lockKey, options.lockTimeoutMs);
    locked = true;
    let appliedAny = false;
    const result = await applyPending(client, dir, (event) => {
      if (event.kind === "applied") {
        log(`migrate: applied ${String(event.version).padStart(4, "0")}_${event.name}`);
        appliedAny = true;
      } else if (event.kind === "adopted") {
        log(
          `migrate: adopted ${String(event.version).padStart(4, "0")}_${event.name} `
          + `(${event.replaced} replaced)`,
        );
        appliedAny = true;
      } else if (event.kind === "tampered") {
        throw new Error(
          `sqlx-js.migrate: ${event.version}_${event.name} hash mismatch `
          + `(applied ${event.applied.slice(0, 16)}… vs current ${event.current.slice(0, 16)}…)`,
        );
      } else {
        throw new Error(`sqlx-js.migrate: ${event.version}_${event.name} failed — ${event.error}`);
      }
    });
    if (!appliedAny) {
      const status = result.applied + result.failed + result.tampered === 0 ? "no pending" : "";
      log(`migrate: up-to-date (${status})`);
    }
  } finally {
    if (locked) {
      try {
        await releaseMigrateLock(client, lockKey);
      } catch (error) {
        log(`migrate: failed to release advisory lock: ${(error as Error).message}`);
      }
    }
    await client.end();
  }
}
