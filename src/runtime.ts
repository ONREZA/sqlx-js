import { SQL } from "bun";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { PgClient, parseDatabaseUrl } from "./pg/wire";
import { applyPending, acquireMigrateLock, releaseMigrateLock, DEFAULT_MIGRATE_LOCK_KEY } from "./commands/migrate";

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
  const rename = new Map<string, string>();
  for (const k of Object.keys(first as Record<string, unknown>)) {
    if (SUFFIX.test(k)) rename.set(k, k.slice(0, -1));
  }
  if (rename.size === 0) return rows;
  const out = new Array<unknown>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const k in r) {
      const dst = rename.get(k);
      copy[dst ?? k] = r[k];
    }
    out[i] = copy;
  }
  return out;
}

function isPrimitiveArrayElement(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  return t === "string" || t === "number" || t === "bigint" || t === "boolean";
}

function quoteArrayElement(raw: string): string {
  return '"' + raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function encodePgArrayLiteral(arr: unknown[]): string {
  const parts: string[] = [];
  for (const v of arr) {
    if (v === null || v === undefined) {
      parts.push("NULL");
      continue;
    }
    if (typeof v === "bigint") {
      parts.push(v.toString());
      continue;
    }
    if (typeof v === "number") {
      parts.push(Number.isFinite(v) ? String(v) : quoteArrayElement(String(v)));
      continue;
    }
    if (typeof v === "boolean") {
      parts.push(v ? "t" : "f");
      continue;
    }
    const s = String(v);
    if (s === "" || /[\\"{},\s]/.test(s) || s.toLowerCase() === "null") {
      parts.push(quoteArrayElement(s));
    } else {
      parts.push(s);
    }
  }
  return "{" + parts.join(",") + "}";
}

function encodeParam(p: unknown): unknown {
  if (!Array.isArray(p)) return p;
  if (p.length === 0) return p;
  if (!p.every(isPrimitiveArrayElement)) return p;
  return encodePgArrayLiteral(p);
}

export class NoRowsError extends Error {
  constructor(message = "expected exactly 1 row, got 0") {
    super(message);
    this.name = "NoRowsError";
  }
}

export class TooManyRowsError extends Error {
  public actual: number;
  constructor(actual: number, expected: "1" | "0 or 1" = "1") {
    super(`expected ${expected} row${expected === "1" ? "" : "s"}, got ${actual}`);
    this.name = "TooManyRowsError";
    this.actual = actual;
  }
}

export const _internal = {
  renameRows,
  encodeParam,
  isPrimitiveArrayElement,
  loadSqlFile,
  buildSetTransaction,
};

async function runQuery(client: SQL, query: string, params: unknown[]): Promise<unknown[]> {
  const encoded = params.length === 0 ? params : params.map(encodeParam);
  const rows = await client.unsafe(query, encoded);
  return renameRows(rows);
}

async function runOne(client: SQL, query: string, params: unknown[]): Promise<unknown> {
  const rows = await runQuery(client, query, params);
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) throw new NoRowsError();
  throw new TooManyRowsError(rows.length, "1");
}

async function runOptional(client: SQL, query: string, params: unknown[]): Promise<unknown | null> {
  const rows = await runQuery(client, query, params);
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  throw new TooManyRowsError(rows.length, "0 or 1");
}

type SqlFileCacheEntry = { mtimeMs: number; size: number; content: string };
const sqlFileCache = new Map<string, SqlFileCacheEntry>();
function loadSqlFile(path: string): string {
  const full = resolve(process.cwd(), path);
  try {
    const st = statSync(full);
    const cached = sqlFileCache.get(full);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.content;
    }
    const content = readFileSync(full, "utf8");
    sqlFileCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, content });
    return content;
  } catch (err) {
    throw new Error(`bun-sqlx.sql.file: cannot read ${path}: ${(err as Error).message}`);
  }
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

export type TransactionOptions = {
  isolation?: "read uncommitted" | "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
  deferrable?: boolean;
};

type SqlRoot = SqlCallable & {
  transaction: <R>(
    fnOrOpts: TransactionOptions | ((tx: SqlCallable) => Promise<R>),
    fn?: (tx: SqlCallable) => Promise<R>,
  ) => Promise<R>;
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

function buildSetTransaction(opts: TransactionOptions): string {
  const parts: string[] = [];
  if (opts.isolation) parts.push(`ISOLATION LEVEL ${opts.isolation.toUpperCase()}`);
  if (opts.readOnly !== undefined) parts.push(opts.readOnly ? "READ ONLY" : "READ WRITE");
  if (opts.deferrable !== undefined) parts.push(opts.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE");
  if (parts.length === 0) return "";
  return `SET TRANSACTION ${parts.join(" ")}`;
}

root.transaction = (async <R>(
  fnOrOpts: TransactionOptions | ((tx: SqlCallable) => Promise<R>),
  maybeFn?: (tx: SqlCallable) => Promise<R>,
): Promise<R> => {
  const c = getClient();
  let opts: TransactionOptions = {};
  let cb: (tx: SqlCallable) => Promise<R>;
  if (typeof fnOrOpts === "function") {
    cb = fnOrOpts;
  } else {
    opts = fnOrOpts;
    if (!maybeFn) throw new Error("bun-sqlx.transaction: callback is required");
    cb = maybeFn;
  }
  const setTx = buildSetTransaction(opts);
  return (await c.begin(async (txClient: SQL) => {
    if (setTx) await txClient.unsafe(setTx);
    const tx = makeBoundCallable(txClient);
    return await cb(tx);
  })) as R;
}) as SqlRoot["transaction"];

export const sql: SqlRoot = root;

export const unsafe = (async (query: string, ...params: unknown[]): Promise<Record<string, unknown>[]> => {
  return (await runQuery(getClient(), query, params)) as Record<string, unknown>[];
}) as (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;

export type MigrateOptions = {
  dir?: string;
  databaseUrl?: string;
  log?: (msg: string) => void;
  lockKey?: number | bigint;
  lockTimeoutMs?: number;
};

function normalizeLockKey(lockKey: number | bigint): bigint {
  if (typeof lockKey === "bigint") return lockKey;
  if (!Number.isSafeInteger(lockKey)) {
    throw new Error(`bun-sqlx.migrate: lockKey must be a safe integer or bigint, got ${lockKey}`);
  }
  return BigInt(lockKey);
}

export async function migrate(opts: MigrateOptions = {}): Promise<void> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("bun-sqlx.migrate: DATABASE_URL is required");
  const dir = opts.dir ?? "migrations";
  const log = opts.log ?? ((m: string) => console.log(`[bun-sqlx] ${m}`));
  const lockKey = normalizeLockKey(opts.lockKey ?? DEFAULT_MIGRATE_LOCK_KEY);

  const cfg = parseDatabaseUrl(url);
  const client = new PgClient(cfg);
  await client.connect();
  let locked = false;
  try {
    await acquireMigrateLock(client, lockKey, opts.lockTimeoutMs);
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
      try {
        await releaseMigrateLock(client, lockKey);
      } catch (e) {
        log(`migrate: failed to release advisory lock: ${(e as Error).message}`);
      }
    }
    await client.end();
  }
}
