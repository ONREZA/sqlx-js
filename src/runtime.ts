import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { PgClient, parseDatabaseUrl, PgError } from "./pg/wire";
import { applyPending, acquireMigrateLock, releaseMigrateLock, DEFAULT_MIGRATE_LOCK_KEY } from "./migration-core";
import { bindNamedParameters, rewriteNamedParameters } from "./sql-params";

export type OnQueryEvent = {
  query: string;
  params: unknown[];
  durationMs: number;
  rowCount?: number;
  error?: unknown;
};

export type OnQueryHook = (event: OnQueryEvent) => void | Promise<void>;
export type OnQueryHookError = (error: unknown, event: OnQueryEvent) => void | Promise<void>;

export type RuntimeQueryResult = unknown[] & {
  count?: number | null;
  command?: string | null;
};

export type RuntimeClient = {
  query: (query: string, params: unknown[]) => Promise<RuntimeQueryResult>;
  transformParam?: (param: unknown) => unknown;
  transaction: <R>(fn: (client: RuntimeClient) => Promise<R>) => Promise<R>;
  close: () => Promise<void>;
  onQuery?: OnQueryHook;
  onQueryHookError?: OnQueryHookError;
  fileRoot?: string;
  reloadSqlFiles?: boolean;
};

type AnyFn = (...args: unknown[]) => Promise<unknown[]>;
type AnyOneFn = (...args: unknown[]) => Promise<unknown>;
type AnyOptionalFn = (...args: unknown[]) => Promise<unknown | null>;
type AnyExecuteFn = (...args: unknown[]) => Promise<ExecuteResult>;
type IdentifierFn = (...parts: string[]) => string;

const PARAMETER_KIND = Symbol("sqlx-js.parameter");

export type JsonParameter<T = JsonInputValue> = {
  readonly [PARAMETER_KIND]: "json";
  readonly value: T;
};

export type PgArrayParameter<T = unknown> = {
  readonly [PARAMETER_KIND]: "array";
  readonly value: readonly (T | null)[];
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonInputValue = JsonPrimitive | JsonInputObject | JsonInputArray;
export type JsonInputObject = { readonly [key: string]: JsonInputValue | undefined };
export type JsonInputArray = readonly JsonInputValue[];

export type ExecuteResult = {
  rowCount: number;
  command: string;
};

export function json<T extends JsonInputValue>(value: T): JsonParameter<T> {
  return { [PARAMETER_KIND]: "json", value };
}

export function array<T>(value: readonly (T | null)[]): PgArrayParameter<T> {
  return { [PARAMETER_KIND]: "array", value };
}

export function parameterKind(value: unknown): "json" | "array" | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as { [PARAMETER_KIND]?: "json" | "array" })[PARAMETER_KIND];
}

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

export function isPrimitiveArrayElement(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (v instanceof Date || v instanceof Uint8Array) return true;
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
    if (parameterKind(v) === "json") {
      parts.push(quoteArrayElement(JSON.stringify((v as JsonParameter).value)));
      continue;
    }
    if (v instanceof Date) {
      parts.push(quoteArrayElement(v.toISOString()));
      continue;
    }
    if (v instanceof Uint8Array) {
      parts.push(quoteArrayElement(`\\x${Buffer.from(v).toString("hex")}`));
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

type PgArrayValue<T> = T | null | PgArrayValue<T>[];

export function parsePgArrayLiteral<T = string>(
  input: string,
  parseElement: (value: string) => T = (value) => value as T,
): PgArrayValue<T>[] {
  let i = 0;

  const parseQuoted = (): T => {
    i++;
    let out = "";
    while (i < input.length) {
      const ch = input[i++]!;
      if (ch === '"') return parseElement(out);
      if (ch === "\\") {
        if (i < input.length) out += input[i++]!;
      } else {
        out += ch;
      }
    }
    throw new Error("sqlx-js: malformed PostgreSQL array literal");
  };

  const parseUnquoted = (): T | null => {
    const start = i;
    while (i < input.length && input[i] !== "," && input[i] !== "}") i++;
    const raw = input.slice(start, i);
    return raw === "NULL" ? null : parseElement(raw);
  };

  const parseArray = (): PgArrayValue<T>[] => {
    if (input[i] !== "{") throw new Error("sqlx-js: malformed PostgreSQL array literal");
    i++;
    const out: PgArrayValue<T>[] = [];
    while (i < input.length) {
      if (input[i] === "}") {
        i++;
        return out;
      }
      const value = input[i] === "{"
        ? parseArray()
        : input[i] === '"'
          ? parseQuoted()
          : parseUnquoted();
      out.push(value);
      if (input[i] === ",") {
        i++;
        continue;
      }
      if (input[i] === "}") continue;
      if (i >= input.length) break;
      throw new Error("sqlx-js: malformed PostgreSQL array literal");
    }
    throw new Error("sqlx-js: malformed PostgreSQL array literal");
  };

  const parsed = parseArray();
  if (i !== input.length) throw new Error("sqlx-js: malformed PostgreSQL array literal");
  return parsed;
}

export function encodeParam(p: unknown): unknown {
  const kind = parameterKind(p);
  if (kind === "json") return JSON.stringify((p as JsonParameter).value);
  if (kind === "array") return encodePgArrayLiteral([...(p as PgArrayParameter).value]);
  return p;
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

// SQLSTATE is exactly five characters from [0-9A-Z]; lowercase or other shapes
// are never valid, so transport codes like "EPIPE" must not match on shape alone.
const SQLSTATE = /^[0-9A-Z]{5}$/;

function firstString(...candidates: unknown[]): string | undefined {
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function toPgError(e: unknown): PgError | null {
  if (e instanceof PgError) return e;
  if (e === null || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  const code = typeof o.code === "string" ? o.code : undefined;
  // `_name` variants are postgres.js; bare forms are node-postgres. Bare
  // `column`/`schema`/`table` can also collide with runtime-added Error
  // properties, so we read namespaced variants first and only accept strings.
  const severity = firstString(o.severity, o.severity_local);
  // A genuine database error is identified by the driver's branded name
  // (Postgres.js) or by a SQLSTATE-shaped code paired with a severity. Transport
  // and system errors (EPIPE, ECONNREFUSED, CONNECTION_ENDED) carry neither, so
  // they pass through untouched instead of masquerading as a PgError.
  const isDatabaseError =
    o.name === "PostgresError" ||
    (code !== undefined && SQLSTATE.test(code) && severity !== undefined);
  if (!isDatabaseError) return null;

  const fields: Record<string, string> = {};
  if (typeof o.message === "string" && o.message.length > 0) fields.M = o.message;
  if (code) fields.C = code;
  if (typeof o.detail === "string" && o.detail.length > 0) fields.D = o.detail;
  if (typeof o.hint === "string" && o.hint.length > 0) fields.H = o.hint;
  const position = firstString(o.position) ?? (typeof o.position === "number" && Number.isFinite(o.position) ? String(o.position) : undefined);
  if (position) fields.P = position;
  if (severity) fields.S = severity;
  const table = firstString(o.table_name, o.table);
  if (table) fields.t = table;
  const column = firstString(o.column_name, o.column);
  if (column) fields.c = column;
  const constraint = firstString(o.constraint_name, o.constraint);
  if (constraint) fields.n = constraint;
  const schema = firstString(o.schema_name, o.schema);
  if (schema) fields.s = schema;
  return new PgError(fields, { cause: e });
}

export const _internal = {
  renameRows,
  encodeParam,
  isPrimitiveArrayElement,
  parsePgArrayLiteral,
  loadSqlFile,
  buildSetTransaction,
  clearIdentifierCache,
  parameterKind,
  toPgError,
};

async function runRawQuery(client: RuntimeClient, query: string, params: unknown[]): Promise<RuntimeQueryResult> {
  const bound = bindNamedParameters(rewriteNamedParameters(query), params);
  query = bound.query;
  params = bound.params;
  const encoded = params.length === 0
    ? params
    : params.map((p) => client.transformParam ? client.transformParam(p) : encodeParam(p));
  const onQuery = client.onQuery;
  if (!onQuery) {
    try {
      return await client.query(query, encoded);
    } catch (e) {
      throw toPgError(e) ?? e;
    }
  }
  const start = performance.now();
  try {
    const result = await client.query(query, encoded);
    notifyQuery(client, {
      query,
      params,
      durationMs: performance.now() - start,
      rowCount: result.count ?? result.length,
    });
    return result;
  } catch (e) {
    const error = toPgError(e) ?? e;
    notifyQuery(client, { query, params, durationMs: performance.now() - start, error });
    throw error;
  }
}

function notifyQuery(client: RuntimeClient, event: OnQueryEvent): void {
  try {
    const pending = client.onQuery?.(event);
    if (pending) void pending.catch((error) => notifyQueryHookError(client, error, event));
  } catch (error) {
    notifyQueryHookError(client, error, event);
  }
}

function notifyQueryHookError(client: RuntimeClient, error: unknown, event: OnQueryEvent): void {
  try {
    const pending = client.onQueryHookError?.(error, event);
    if (pending) void pending.catch(() => {});
  } catch {
  }
}

async function runQuery(client: RuntimeClient, query: string, params: unknown[]): Promise<unknown[]> {
  return renameRows(await runRawQuery(client, query, params));
}

async function runExecute(client: RuntimeClient, query: string, params: unknown[]): Promise<ExecuteResult> {
  const result = await runRawQuery(client, query, params);
  return {
    rowCount: result.count ?? result.length,
    command: result.command ?? "",
  };
}

async function runOne(client: RuntimeClient, query: string, params: unknown[]): Promise<unknown> {
  const rows = await runQuery(client, query, params);
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) throw new NoRowsError();
  throw new TooManyRowsError(rows.length, "1");
}

async function runOptional(client: RuntimeClient, query: string, params: unknown[]): Promise<unknown | null> {
  const rows = await runQuery(client, query, params);
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  throw new TooManyRowsError(rows.length, "0 or 1");
}

type SqlFileCacheEntry = { mtimeMs: number; size: number; content: string };
const sqlFileCache = new Map<string, SqlFileCacheEntry>();
function loadSqlFile(
  path: string,
  fileRoot = process.env.SQLX_JS_FILE_ROOT ?? process.cwd(),
  reload = false,
): string {
  const root = resolve(fileRoot);
  if (isAbsolute(path)) {
    throw new Error(`sqlx-js.sql.file: path must be relative to fileRoot: ${path}`);
  }
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`sqlx-js.sql.file: path escapes fileRoot: ${path}`);
  }
  try {
    const cached = sqlFileCache.get(full);
    if (cached && !reload) return cached.content;
    const st = statSync(full);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.content;
    }
    const content = readFileSync(full, "utf8");
    sqlFileCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, content });
    return content;
  } catch (err) {
    throw new Error(`sqlx-js.sql.file: cannot read ${path}: ${(err as Error).message}`);
  }
}

export function clearSqlFileCache(): void {
  sqlFileCache.clear();
}

type IdentifierWhitelist = {
  names: Set<string>;
  paths: Set<string>;
};

type IdentifierCacheEntry = {
  path: string;
  mtimeMs: number;
  size: number;
  whitelist: IdentifierWhitelist;
};

let identifierCache: IdentifierCacheEntry | null = null;

function clearIdentifierCache(): void {
  identifierCache = null;
}

function identifierSnapshotPath(): string {
  return process.env.SQLX_JS_SCHEMA_PATH
    ? resolve(process.cwd(), process.env.SQLX_JS_SCHEMA_PATH)
    : resolve(process.cwd(), ".sqlx-js/schema/schema.json");
}

function addPath(whitelist: IdentifierWhitelist, parts: string[]): void {
  for (const part of parts) whitelist.names.add(part);
  whitelist.paths.add(parts.join("\0"));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function arrayProp(obj: Record<string, unknown> | null, key: string): unknown[] {
  const value = obj?.[key];
  return Array.isArray(value) ? value : [];
}

function stringProp(obj: Record<string, unknown> | null, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
}

function buildIdentifierWhitelist(snapshot: unknown): IdentifierWhitelist {
  const whitelist: IdentifierWhitelist = { names: new Set(), paths: new Set() };
  const root = asRecord(snapshot);
  for (const schema of arrayProp(root, "schemas")) {
    if (typeof schema === "string") whitelist.names.add(schema);
  }
  for (const relRaw of arrayProp(root, "relations")) {
    const rel = asRecord(relRaw);
    const schema = stringProp(rel, "schema");
    const name = stringProp(rel, "name");
    if (!schema || !name) continue;
    addPath(whitelist, [schema, name]);
    for (const colRaw of arrayProp(rel, "columns")) {
      const colName = stringProp(asRecord(colRaw), "name");
      if (!colName) continue;
      whitelist.names.add(colName);
      addPath(whitelist, [name, colName]);
      addPath(whitelist, [schema, name, colName]);
    }
    for (const idxRaw of arrayProp(rel, "indexes")) {
      const idxName = stringProp(asRecord(idxRaw), "name");
      if (idxName) addPath(whitelist, [schema, idxName]);
    }
    for (const constraintRaw of arrayProp(rel, "constraints")) {
      const constraintName = stringProp(asRecord(constraintRaw), "name");
      if (constraintName) {
        addPath(whitelist, [schema, constraintName]);
        addPath(whitelist, [name, constraintName]);
        addPath(whitelist, [schema, name, constraintName]);
      }
    }
  }
  for (const typeRaw of arrayProp(root, "types")) {
    const t = asRecord(typeRaw);
    const schema = stringProp(t, "schema");
    const name = stringProp(t, "name");
    if (schema && name) addPath(whitelist, [schema, name]);
  }
  for (const fnRaw of arrayProp(root, "functions")) {
    const fn = asRecord(fnRaw);
    const schema = stringProp(fn, "schema");
    const name = stringProp(fn, "name");
    if (schema && name) addPath(whitelist, [schema, name]);
  }
  return whitelist;
}

function loadIdentifierWhitelist(): IdentifierWhitelist {
  const path = identifierSnapshotPath();
  if (!existsSync(path)) {
    throw new Error(`sqlx-js.id: schema snapshot not found at ${path}. Run \`sqlx-js schema dump\`.`);
  }
  const st = statSync(path);
  if (identifierCache && identifierCache.path === path && identifierCache.mtimeMs === st.mtimeMs && identifierCache.size === st.size) {
    return identifierCache.whitelist;
  }
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  const whitelist = buildIdentifierWhitelist(snapshot);
  identifierCache = { path, mtimeMs: st.mtimeMs, size: st.size, whitelist };
  return whitelist;
}

function quoteIdentifier(part: string): string {
  if (part.length === 0) throw new Error("sqlx-js.id: identifier segment must not be empty");
  if (part.includes("\0")) throw new Error("sqlx-js.id: identifier segment must not contain NUL");
  return `"${part.replace(/"/g, '""')}"`;
}

export function id(...parts: string[]): string {
  if (parts.length === 0) throw new Error("sqlx-js.id: at least one identifier segment is required");
  if (parts.length > 3) throw new Error("sqlx-js.id: expected 1 to 3 identifier segments");
  const whitelist = loadIdentifierWhitelist();
  const ok = parts.length === 1
    ? whitelist.names.has(parts[0]!)
    : whitelist.paths.has(parts.join("\0"));
  if (!ok) {
    throw new Error(`sqlx-js.id: identifier is not present in schema snapshot: ${parts.join(".")}`);
  }
  return parts.map(quoteIdentifier).join(".");
}

type FileCallable = AnyFn & { one: AnyOneFn; optional: AnyOptionalFn; execute: AnyExecuteFn };
type SqlCallable = AnyFn & {
  file: FileCallable;
  one: AnyOneFn;
  optional: AnyOptionalFn;
  execute: AnyExecuteFn;
  id: IdentifierFn;
  json: typeof json;
  array: typeof array;
};

function makeBoundCallable(client: RuntimeClient): SqlCallable {
  const fn: AnyFn = (async (query: string, ...params: unknown[]) => {
    return runQuery(client, query, params);
  }) as AnyFn;
  const file: AnyFn = (async (path: string, ...params: unknown[]) => {
    return runQuery(client, loadSqlFile(path, client.fileRoot, client.reloadSqlFiles), params);
  }) as AnyFn;
  (file as FileCallable).one = (async (path: string, ...params: unknown[]) => {
    return runOne(client, loadSqlFile(path, client.fileRoot, client.reloadSqlFiles), params);
  }) as AnyOneFn;
  (file as FileCallable).optional = (async (path: string, ...params: unknown[]) => {
    return runOptional(client, loadSqlFile(path, client.fileRoot, client.reloadSqlFiles), params);
  }) as AnyOptionalFn;
  (file as FileCallable).execute = (async (path: string, ...params: unknown[]) => {
    return runExecute(client, loadSqlFile(path, client.fileRoot, client.reloadSqlFiles), params);
  }) as AnyExecuteFn;
  (fn as SqlCallable).file = file as FileCallable;
  (fn as SqlCallable).one = (async (query: string, ...params: unknown[]) => {
    return runOne(client, query, params);
  }) as AnyOneFn;
  (fn as SqlCallable).optional = (async (query: string, ...params: unknown[]) => {
    return runOptional(client, query, params);
  }) as AnyOptionalFn;
  (fn as SqlCallable).execute = (async (query: string, ...params: unknown[]) => {
    return runExecute(client, query, params);
  }) as AnyExecuteFn;
  (fn as SqlCallable).id = id;
  (fn as SqlCallable).json = json;
  (fn as SqlCallable).array = array;
  return fn as SqlCallable;
}

export type TransactionOptions = {
  isolation?: "read uncommitted" | "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
  deferrable?: boolean;
};

export type SqlRoot = SqlCallable & {
  transaction: <R>(
    fnOrOpts: TransactionOptions | ((tx: SqlCallable) => Promise<R>),
    fn?: (tx: SqlCallable) => Promise<R>,
  ) => Promise<R>;
};

function buildSetTransaction(opts: TransactionOptions): string {
  const parts: string[] = [];
  if (opts.isolation) parts.push(`ISOLATION LEVEL ${opts.isolation.toUpperCase()}`);
  if (opts.readOnly !== undefined) parts.push(opts.readOnly ? "READ ONLY" : "READ WRITE");
  if (opts.deferrable !== undefined) parts.push(opts.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE");
  if (parts.length === 0) return "";
  return `SET TRANSACTION ${parts.join(" ")}`;
}

export type RuntimeApi = {
  sql: SqlRoot;
  unsafe: (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
};

export function createSqlRuntime(getClient: () => RuntimeClient): RuntimeApi {
  const root: SqlRoot = (async (query: string, ...params: unknown[]) => {
    return runQuery(getClient(), query, params);
  }) as SqlRoot;

  const rootFile: AnyFn = (async (path: string, ...params: unknown[]) => {
    const client = getClient();
    return runQuery(client, loadSqlFile(path, client.fileRoot, client.reloadSqlFiles), params);
  }) as AnyFn;
  (rootFile as FileCallable).one = (async (path: string, ...params: unknown[]) => {
    const client = getClient();
    return runOne(client, loadSqlFile(path, client.fileRoot, client.reloadSqlFiles), params);
  }) as AnyOneFn;
  (rootFile as FileCallable).optional = (async (path: string, ...params: unknown[]) => {
    const client = getClient();
    return runOptional(client, loadSqlFile(path, client.fileRoot, client.reloadSqlFiles), params);
  }) as AnyOptionalFn;
  (rootFile as FileCallable).execute = (async (path: string, ...params: unknown[]) => {
    const client = getClient();
    return runExecute(client, loadSqlFile(path, client.fileRoot, client.reloadSqlFiles), params);
  }) as AnyExecuteFn;
  root.file = rootFile as FileCallable;

  root.one = (async (query: string, ...params: unknown[]) => {
    return runOne(getClient(), query, params);
  }) as AnyOneFn;
  root.optional = (async (query: string, ...params: unknown[]) => {
    return runOptional(getClient(), query, params);
  }) as AnyOptionalFn;
  root.execute = (async (query: string, ...params: unknown[]) => {
    return runExecute(getClient(), query, params);
  }) as AnyExecuteFn;
  root.id = id;
  root.json = json;
  root.array = array;

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
      if (!maybeFn) throw new Error("sqlx-js.transaction: callback is required");
      cb = maybeFn;
    }
    const setTx = buildSetTransaction(opts);
    return await c.transaction(async (txClient) => {
      if (setTx) await txClient.query(setTx, []);
      const tx = makeBoundCallable(txClient);
      return await cb(tx);
    });
  }) as SqlRoot["transaction"];

  const unsafe = (async (query: string, ...params: unknown[]): Promise<Record<string, unknown>[]> => {
    return (await runQuery(getClient(), query, params)) as Record<string, unknown>[];
  }) as (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;

  return { sql: root, unsafe };
}

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
    throw new Error(`sqlx-js.migrate: lockKey must be a safe integer or bigint, got ${lockKey}`);
  }
  return BigInt(lockKey);
}

export async function migrate(opts: MigrateOptions = {}): Promise<void> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("sqlx-js.migrate: DATABASE_URL is required");
  const dir = opts.dir ?? "migrations";
  const log = opts.log ?? ((m: string) => console.log(`[sqlx-js] ${m}`));
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
      } else if (e.kind === "adopted") {
        log(`migrate: adopted ${String(e.version).padStart(4, "0")}_${e.name} (${e.replaced} replaced)`);
        appliedAny = true;
      } else if (e.kind === "tampered") {
        throw new Error(
          `sqlx-js.migrate: ${e.version}_${e.name} hash mismatch (applied ${e.applied.slice(0, 16)}… vs current ${e.current.slice(0, 16)}…)`,
        );
      } else {
        throw new Error(`sqlx-js.migrate: ${e.version}_${e.name} failed — ${e.error}`);
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
