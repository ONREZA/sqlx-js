import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgClient, parseDatabaseUrl } from "./pg/wire";
import { applyPending, MIGRATE_LOCK_KEY_VALUE } from "./commands/migrate";

const MIGRATE_LOCK_KEY = MIGRATE_LOCK_KEY_VALUE;

let defaultClient: SQL | null = null;

export function getClient(): SQL {
  if (!defaultClient) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("bun-sqlx: DATABASE_URL is not set");
    defaultClient = new SQL({ url, bigint: true });
  }
  return defaultClient;
}

export function setClient(client: SQL): void {
  defaultClient = client;
}

export async function close(): Promise<void> {
  if (defaultClient) {
    await defaultClient.close();
    defaultClient = null;
  }
}

type AnyFn = (...args: unknown[]) => Promise<unknown[]>;
type AnyOneFn = (...args: unknown[]) => Promise<unknown>;
type AnyOptionalFn = (...args: unknown[]) => Promise<unknown | null>;

const SUFFIX = /[!?]$/;

function renameRows(rows: unknown[]): unknown[] {
  if (rows.length === 0) return rows;
  const first = rows[0];
  if (first === null || typeof first !== "object") return rows;
  const keys = Object.keys(first as Record<string, unknown>);
  const renames: { from: string; to: string }[] = [];
  for (const k of keys) {
    if (SUFFIX.test(k)) renames.push({ from: k, to: k.slice(0, -1) });
  }
  if (renames.length === 0) return rows;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>;
    for (const { from, to } of renames) {
      r[to] = r[from];
      delete r[from];
    }
  }
  return rows;
}

async function runQuery(client: SQL, query: string, params: unknown[]): Promise<unknown[]> {
  const rows = await client.unsafe(query, params);
  return renameRows(rows);
}

async function runOne(client: SQL, query: string, params: unknown[]): Promise<unknown> {
  const rows = await runQuery(client, query, params);
  if (rows.length === 1) return rows[0];
  throw new Error(`bun-sqlx.one: expected exactly 1 row, got ${rows.length}`);
}

async function runOptional(client: SQL, query: string, params: unknown[]): Promise<unknown | null> {
  const rows = await runQuery(client, query, params);
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  throw new Error(`bun-sqlx.optional: expected 0 or 1 row, got ${rows.length}`);
}

const sqlFileCache = new Map<string, string>();
function loadSqlFile(path: string): string {
  let s = sqlFileCache.get(path);
  if (s !== undefined) return s;
  s = readFileSync(resolve(process.cwd(), path), "utf8");
  sqlFileCache.set(path, s);
  return s;
}

export function clearSqlFileCache(): void {
  sqlFileCache.clear();
}

type FileCallable = AnyFn & { one: AnyOneFn; optional: AnyOptionalFn };
type SqlCallable = AnyFn & { file: FileCallable; one: AnyOneFn; optional: AnyOptionalFn };

function makeBoundCallable(client: SQL): SqlCallable {
  const fn: AnyFn = (async (query: string, ...params: unknown[]) => {
    return runQuery(client, query, params);
  }) as AnyFn;
  const file: AnyFn = (async (path: string, ...params: unknown[]) => {
    return runQuery(client, loadSqlFile(path), params);
  }) as AnyFn;
  (file as FileCallable).one = (async (path: string, ...params: unknown[]) => {
    return runOne(client, loadSqlFile(path), params);
  }) as AnyOneFn;
  (file as FileCallable).optional = (async (path: string, ...params: unknown[]) => {
    return runOptional(client, loadSqlFile(path), params);
  }) as AnyOptionalFn;
  (fn as SqlCallable).file = file as FileCallable;
  (fn as SqlCallable).one = (async (query: string, ...params: unknown[]) => {
    return runOne(client, query, params);
  }) as AnyOneFn;
  (fn as SqlCallable).optional = (async (query: string, ...params: unknown[]) => {
    return runOptional(client, query, params);
  }) as AnyOptionalFn;
  return fn as SqlCallable;
}

type SqlRoot = SqlCallable & {
  transaction: <R>(fn: (tx: SqlCallable) => Promise<R>) => Promise<R>;
};

const root: SqlRoot = (async (query: string, ...params: unknown[]) => {
  return runQuery(getClient(), query, params);
}) as SqlRoot;

const rootFile: AnyFn = (async (path: string, ...params: unknown[]) => {
  return runQuery(getClient(), loadSqlFile(path), params);
}) as AnyFn;
(rootFile as FileCallable).one = (async (path: string, ...params: unknown[]) => {
  return runOne(getClient(), loadSqlFile(path), params);
}) as AnyOneFn;
(rootFile as FileCallable).optional = (async (path: string, ...params: unknown[]) => {
  return runOptional(getClient(), loadSqlFile(path), params);
}) as AnyOptionalFn;
root.file = rootFile as FileCallable;

root.one = (async (query: string, ...params: unknown[]) => {
  return runOne(getClient(), query, params);
}) as AnyOneFn;
root.optional = (async (query: string, ...params: unknown[]) => {
  return runOptional(getClient(), query, params);
}) as AnyOptionalFn;

root.transaction = async <R>(fn: (tx: SqlCallable) => Promise<R>): Promise<R> => {
  const c = getClient();
  return (await c.begin(async (txClient) => {
    const tx = makeBoundCallable(txClient);
    return await fn(tx);
  })) as R;
};

export const sql: SqlRoot = root;
export const unsafe = sql;

export type MigrateOptions = {
  dir?: string;
  databaseUrl?: string;
  log?: (msg: string) => void;
};

export async function migrate(opts: MigrateOptions = {}): Promise<void> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("bun-sqlx.migrate: DATABASE_URL is required");
  const dir = opts.dir ?? "migrations";
  const log = opts.log ?? ((m: string) => console.log(`[bun-sqlx] ${m}`));

  const cfg = parseDatabaseUrl(url);
  const client = new PgClient(cfg);
  await client.connect();
  let locked = false;
  try {
    await client.simpleQuery(`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`);
    locked = true;
    let appliedAny = false;
    const result = await applyPending(client, dir, (e) => {
      if (e.kind === "applied") {
        log(`migrate: applied ${String(e.version).padStart(4, "0")}_${e.name}`);
        appliedAny = true;
      } else if (e.kind === "tampered") {
        throw new Error(
          `bun-sqlx.migrate: ${e.version}_${e.name} hash mismatch (applied ${e.applied.slice(0, 16)}… vs current ${e.current.slice(0, 16)}…)`,
        );
      } else {
        throw new Error(`bun-sqlx.migrate: ${e.version}_${e.name} failed — ${e.error}`);
      }
    });
    if (!appliedAny) log(`migrate: up-to-date (${result.applied + result.failed + result.tampered === 0 ? "no pending" : ""})`);
  } finally {
    if (locked) {
      try { await client.simpleQuery(`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`); } catch {}
    }
    await client.end();
  }
}
