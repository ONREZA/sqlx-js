import { PgError } from "./pg/wire";
import { bindNamedParameters, rewriteNamedParameters } from "./sql-params";
import { queryId } from "./query-id";
import {
  QUERY_EXECUTOR,
  type QueryExecutionMetadata,
  type QueryExecutionMode,
  type QueryExecutorMethod,
} from "./query";
import {
  clearIdentifierCache,
  clearSqlFileCache,
  id,
  loadSqlFile,
} from "./runtime-files";
import {
  createSqlxJson,
  isSqlxJson,
  parseJsonResult,
  type SqlxJson,
  stringifyJsonParameter,
  type JsonCompatible,
} from "./json-value";
import { assertNoDateSqlValue, isDateValue } from "./sql-value";
import { isTemporalValue } from "./temporal-api";

export { clearSqlFileCache, id } from "./runtime-files";
export { migrate, type MigrateOptions } from "./runtime-migrate";
export { parseJsonResult, stringifyJsonParameter } from "./json-value";
export type { JsonCompatible, SqlxJson } from "./json-value";
export { assertNoDateSqlValue, isDateValue } from "./sql-value";

export type OnQueryEvent = {
  queryId: string;
  queryName?: string;
  profile?: string;
  role?: string;
  executionPath?: QueryExecutionPath;
  query: string;
  params: unknown[];
  durationMs: number;
  rowCount?: number;
  error?: unknown;
};

export type QueryExecutionPath = "adaptive" | "descriptor";

export type OnQueryHook = (event: OnQueryEvent) => void | Promise<void>;
export type OnQueryHookError = (error: unknown, event: OnQueryEvent) => void | Promise<void>;

export type QueryExecutionOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type RuntimeQueryRequest = {
  query: string;
  params: unknown[];
  observedQuery: string;
  observedParams: unknown[];
  metadata: QueryExecutionMetadata;
  options?: QueryExecutionOptions;
};

export type RuntimeQueryResult = unknown[] & {
  count?: number | null;
  command?: string | null;
};

export type RuntimeTransactionOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type RuntimeClient = {
  query: (query: string, params: unknown[]) => Promise<RuntimeQueryResult>;
  execute?: (request: RuntimeQueryRequest) => Promise<RuntimeQueryResult>;
  transformParams?: (params: unknown[]) => unknown[] | PromiseLike<unknown[]>;
  transaction: <R>(fn: (client: RuntimeClient) => Promise<R>, options?: RuntimeTransactionOptions) => Promise<R>;
  savepoint?: <R>(fn: (client: RuntimeClient) => Promise<R>) => Promise<R>;
  close: () => Promise<void>;
  onQuery?: OnQueryHook;
  onQueryHookError?: OnQueryHookError;
  fileRoot?: string;
  reloadSqlFiles?: boolean;
  sqlFiles?: Readonly<Record<string, string>>;
  transactionSettings?: readonly string[];
};

type AnyFn = (...args: unknown[]) => Promise<unknown[]>;
type AnyOneFn = (...args: unknown[]) => Promise<unknown>;
type AnyOptionalFn = (...args: unknown[]) => Promise<unknown | null>;
type AnyExecuteFn = (...args: unknown[]) => Promise<ExecuteResult>;
type IdentifierFn = (...parts: string[]) => string;

const PARAMETER_KIND = Symbol("sqlx-js.parameter");

/** @deprecated Use SqlxJson<T>. */
export type JsonParameter<T = unknown> = SqlxJson<T>;

type PgArrayScalar<T, NullableElements extends boolean> =
  T | (NullableElements extends true ? null : never);

type PgArrayElement<Values extends readonly unknown[]> = Exclude<Values[number], null>;
type PgArrayContainsNull<Values extends readonly unknown[]> = null extends Values[number] ? true : false;

export type PgArrayParameter<T = unknown, NullableElements extends boolean = boolean> = {
  readonly [PARAMETER_KIND]: "array";
  readonly value: readonly PgArrayScalar<T, NullableElements>[];
};

export type ExecuteResult = {
  rowCount: number;
  command: string;
};

export function json<T>(value: T & JsonCompatible<T>): SqlxJson<T> {
  return createSqlxJson(value);
}

export function array<const Values extends readonly unknown[]>(
  value: Values,
): PgArrayParameter<PgArrayElement<Values>, PgArrayContainsNull<Values>>;
export function array(value: readonly unknown[]): PgArrayParameter {
  return { [PARAMETER_KIND]: "array", value };
}

export function parameterKind(value: unknown): "json" | "array" | undefined {
  if (isSqlxJson(value)) return "json";
  if (!value || typeof value !== "object") return undefined;
  return (value as { [PARAMETER_KIND]?: "json" | "array" })[PARAMETER_KIND];
}

function renameRows(rows: unknown[]): unknown[] {
  assertNoDateSqlValue(rows, "PostgreSQL result");
  if (rows.length === 0) return rows;
  const first = rows[0];
  if (first === null || typeof first !== "object") return rows;
  let rename: Map<string, string> | undefined;
  for (const k of Object.keys(first as Record<string, unknown>)) {
    if (k.endsWith("!") || k.endsWith("?")) {
      rename ??= new Map();
      rename.set(k, k.slice(0, -1));
    }
  }
  if (!rename) return rows;
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
  if (isDateValue(v)) return false;
  if (v instanceof Uint8Array || isTemporalValue(v)) return true;
  const t = typeof v;
  return t === "string" || t === "number" || t === "bigint" || t === "boolean";
}

function quoteArrayElement(raw: string): string {
  return '"' + raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function encodePgArrayLiteral(
  arr: unknown[],
  serializeElement?: (value: unknown) => string,
): string {
  return encodePgArrayLiteralInternal(arr, serializeElement, false);
}

export function encodePgArrayLiteralElements(
  arr: unknown[],
  serializeElement: (value: unknown) => string,
): string {
  return encodePgArrayLiteralInternal(arr, serializeElement, true);
}

function encodePgArrayLiteralInternal(
  arr: unknown[],
  serializeElement: ((value: unknown) => string) | undefined,
  nestedArraysAreElements: boolean,
): string {
  const parts: string[] = [];
  for (const v of arr) {
    if (v === null) {
      parts.push("NULL");
      continue;
    }
    if (v === undefined) {
      throw new Error("sqlx-js: undefined is not a PostgreSQL value; pass null explicitly");
    }
    if (Array.isArray(v) && !nestedArraysAreElements) {
      parts.push(encodePgArrayLiteralInternal(v, serializeElement, nestedArraysAreElements));
      continue;
    }
    if (serializeElement) {
      parts.push(quoteArrayElement(serializeElement(v)));
      continue;
    }
    if (parameterKind(v) === "json") {
      parts.push(quoteArrayElement(stringifyJsonParameter(v as JsonParameter)));
      continue;
    }
    if (isDateValue(v)) {
      throw new Error("sqlx-js: JavaScript Date is not supported; use the matching Temporal type");
    }
    if (isTemporalValue(v)) {
      throw new Error("sqlx-js: Temporal array values require a known PostgreSQL temporal array type");
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
  const dimensions = /^(?:\[-?\d+:-?\d+\])+=/.exec(input);
  let i = dimensions?.[0].length ?? 0;

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
  assertNoDateSqlValue(p, "PostgreSQL parameter");
  const kind = parameterKind(p);
  if (kind === "json") return stringifyJsonParameter(p as JsonParameter);
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

export type QueryTimeoutPhase = "bootstrap" | "execution";
export type QueryOutcome = "not_sent" | "unknown";

type QueryInterruptionDetails = {
  phase: QueryTimeoutPhase;
  outcome: QueryOutcome;
  queryId: string;
  generation: number;
};

export class QueryTimeoutError extends Error {
  readonly phase: QueryTimeoutPhase;
  readonly outcome: QueryOutcome;
  readonly queryId: string;
  readonly generation: number;

  constructor(public readonly timeoutMs: number, details: QueryInterruptionDetails) {
    super(`query exceeded ${timeoutMs}ms during ${details.phase}`);
    this.name = "QueryTimeoutError";
    this.phase = details.phase;
    this.outcome = details.outcome;
    this.queryId = details.queryId;
    this.generation = details.generation;
  }
}

export class QueryAbortedError extends Error {
  readonly phase: QueryTimeoutPhase;
  readonly outcome: QueryOutcome;
  readonly queryId: string;
  readonly generation: number;
  readonly reason: unknown;

  constructor(details: QueryInterruptionDetails, reason?: unknown) {
    super(`query aborted during ${details.phase}`);
    this.name = "QueryAbortedError";
    this.phase = details.phase;
    this.outcome = details.outcome;
    this.queryId = details.queryId;
    this.generation = details.generation;
    this.reason = reason;
  }
}

export class GenerationRecycledError extends Error {
  readonly outcome: QueryOutcome;
  readonly queryId: string;
  readonly generation: number;

  constructor(details: Pick<QueryInterruptionDetails, "outcome" | "queryId" | "generation">, cause?: unknown) {
    super(`database client generation ${details.generation} was recycled`, { cause });
    this.name = "GenerationRecycledError";
    this.outcome = details.outcome;
    this.queryId = details.queryId;
    this.generation = details.generation;
  }
}

export class ClientClosingError extends Error {
  readonly phase?: QueryTimeoutPhase;
  readonly outcome?: QueryOutcome;
  readonly queryId?: string;
  readonly generation?: number;

  constructor(details?: QueryInterruptionDetails) {
    super("database client is closing");
    this.name = "ClientClosingError";
    this.phase = details?.phase;
    this.outcome = details?.outcome;
    this.queryId = details?.queryId;
    this.generation = details?.generation;
  }
}

export class TransactionTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly outcome: "rolled_back" | "unknown" = "unknown",
    public readonly generation = 0,
  ) {
    super(`transaction exceeded ${timeoutMs}ms`);
    this.name = "TransactionTimeoutError";
  }
}

// SQLSTATE is exactly five characters from [0-9A-Z]; lowercase or other shapes
// are never valid, so transport codes like "EPIPE" must not match on shape alone.
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

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
    (code !== undefined && SQLSTATE_PATTERN.test(code) && severity !== undefined);
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

export const SQLSTATE = {
  notNullViolation: "23502",
  foreignKeyViolation: "23503",
  uniqueViolation: "23505",
  checkViolation: "23514",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
} as const;

export type KnownSqlState = (typeof SQLSTATE)[keyof typeof SQLSTATE];

export function isPgError(error: unknown): error is PgError;
export function isPgError<const Code extends string>(error: unknown, code: Code): error is PgError & { readonly code: Code };
export function isPgError(error: unknown, code?: string): error is PgError {
  return error instanceof PgError && (code === undefined || error.code === code);
}

export const _internal = {
  renameRows,
  encodeParam,
  isPrimitiveArrayElement,
  parsePgArrayLiteral,
  loadSqlFile,
  buildSetTransaction,
  validateTransactionTimeout,
  clearIdentifierCache,
  parameterKind,
  toPgError,
};

const runtimeQueries = new Map<string, {
  id: string;
  rewritten: ReturnType<typeof rewriteNamedParameters>;
}>();
const MAX_RUNTIME_QUERIES = 1024;

function runtimeQuery(query: string): {
  id: string;
  rewritten: ReturnType<typeof rewriteNamedParameters>;
} {
  let cached = runtimeQueries.get(query);
  if (!cached) {
    cached = {
      id: queryId(query),
      rewritten: rewriteNamedParameters(query),
    };
    if (runtimeQueries.size >= MAX_RUNTIME_QUERIES) runtimeQueries.clear();
    runtimeQueries.set(query, cached);
  }
  return cached;
}

function observedMetadata(id: string, metadata?: QueryExecutionMetadata): QueryExecutionMetadata {
  if (metadata) return metadata;
  return { queryId: id };
}

async function runRawQuery(
  client: RuntimeClient,
  query: string,
  params: unknown[],
  metadata?: QueryExecutionMetadata,
  options?: QueryExecutionOptions,
): Promise<RuntimeQueryResult> {
  const observedQuery = query;
  const observedParams = params;
  const cached = runtimeQuery(query);
  const bound = bindNamedParameters(cached.rewritten, params);
  query = bound.query;
  params = bound.params;
  assertNoDateSqlValue(params, "PostgreSQL parameter");
  const observed = observedMetadata(cached.id, metadata);
  if (client.execute) {
    return await client.execute({
      query,
      params,
      observedQuery,
      observedParams,
      metadata: observed,
      options,
    });
  }
  if (options) {
    throw new Error("sqlx-js: query execution options require a managed sqlx-js executor");
  }
  const onQuery = client.onQuery;
  if (!onQuery) {
    try {
      const transformed = client.transformParams
        ? client.transformParams(params)
        : params.length === 0 ? params : params.map(encodeParam);
      const encoded = isPromiseLike(transformed) ? await transformed : transformed;
      assertNoDateSqlValue(encoded, "PostgreSQL parameter");
      return await client.query(query, encoded);
    } catch (e) {
      throw toPgError(e) ?? e;
    }
  }
  const start = performance.now();
  try {
    const transformed = client.transformParams
      ? client.transformParams(params)
      : params.length === 0 ? params : params.map(encodeParam);
    const encoded = isPromiseLike(transformed) ? await transformed : transformed;
    assertNoDateSqlValue(encoded, "PostgreSQL parameter");
    const result = await client.query(query, encoded);
    notifyQuery(client, {
      ...observed,
      query: observedQuery,
      params: observedParams,
      durationMs: performance.now() - start,
      rowCount: result.count ?? result.length,
    });
    return result;
  } catch (e) {
    const error = toPgError(e) ?? e;
    notifyQuery(client, { ...observed, query: observedQuery, params: observedParams, durationMs: performance.now() - start, error });
    throw error;
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>)?.then === "function";
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

async function runQuery(
  client: RuntimeClient,
  query: string,
  params: unknown[],
  metadata?: QueryExecutionMetadata,
  options?: QueryExecutionOptions,
): Promise<unknown[]> {
  return renameRows(await runRawQuery(client, query, params, metadata, options));
}

async function runExecute(
  client: RuntimeClient,
  query: string,
  params: unknown[],
  metadata?: QueryExecutionMetadata,
  options?: QueryExecutionOptions,
): Promise<ExecuteResult> {
  const result = await runRawQuery(client, query, params, metadata, options);
  assertNoDateSqlValue(result, "PostgreSQL result");
  return {
    rowCount: result.count ?? result.length,
    command: result.command ?? "",
  };
}

async function runOne(
  client: RuntimeClient,
  query: string,
  params: unknown[],
  metadata?: QueryExecutionMetadata,
  options?: QueryExecutionOptions,
): Promise<unknown> {
  const rows = await runQuery(client, query, params, metadata, options);
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) throw new NoRowsError();
  throw new TooManyRowsError(rows.length, "1");
}

async function runOptional(
  client: RuntimeClient,
  query: string,
  params: unknown[],
  metadata?: QueryExecutionMetadata,
  options?: QueryExecutionOptions,
): Promise<unknown | null> {
  const rows = await runQuery(client, query, params, metadata, options);
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  throw new TooManyRowsError(rows.length, "0 or 1");
}

type FileCallable = AnyFn & { one: AnyOneFn; optional: AnyOptionalFn; execute: AnyExecuteFn };
type SqlCallable = AnyFn & {
  file: FileCallable;
  one: AnyOneFn;
  optional: AnyOptionalFn;
  execute: AnyExecuteFn;
  with: (options: QueryExecutionOptions) => SqlCallable;
  id: IdentifierFn;
  json: typeof json;
  array: typeof array;
  [QUERY_EXECUTOR]: QueryExecutorMethod;
};

type SavepointSqlCallable = SqlCallable & {
  savepoint: <R>(fn: (client: SavepointSqlCallable) => Promise<R>) => Promise<R>;
};

function executeDefinedQuery(
  client: RuntimeClient,
  mode: QueryExecutionMode,
  query: string,
  params: unknown[],
  metadata: QueryExecutionMetadata,
  options?: QueryExecutionOptions,
): Promise<unknown> {
  if (mode === "one") return runOne(client, query, params, metadata, options);
  if (mode === "optional") return runOptional(client, query, params, metadata, options);
  if (mode === "execute") return runExecute(client, query, params, metadata, options);
  return runQuery(client, query, params, metadata, options);
}

function mergeQueryExecutionOptions(
  defaults: QueryExecutionOptions | undefined,
  overrides: QueryExecutionOptions | undefined,
): QueryExecutionOptions | undefined {
  if (!defaults) return overrides ? { ...overrides } : undefined;
  if (!overrides) return defaults;
  return { ...defaults, ...overrides };
}

function makeSqlCallable(
  getClient: () => RuntimeClient,
  defaultOptions?: QueryExecutionOptions,
): SqlCallable {
  const fn: AnyFn = (async (query: string, ...params: unknown[]) => {
    return runQuery(getClient(), query, params, undefined, defaultOptions);
  }) as AnyFn;
  const file: AnyFn = (async (path: string, ...params: unknown[]) => {
    const client = getClient();
    return runQuery(
      client,
      loadSqlFile(path, client.fileRoot, client.reloadSqlFiles, client.sqlFiles),
      params,
      undefined,
      defaultOptions,
    );
  }) as AnyFn;
  (file as FileCallable).one = (async (path: string, ...params: unknown[]) => {
    const client = getClient();
    return runOne(
      client,
      loadSqlFile(path, client.fileRoot, client.reloadSqlFiles, client.sqlFiles),
      params,
      undefined,
      defaultOptions,
    );
  }) as AnyOneFn;
  (file as FileCallable).optional = (async (path: string, ...params: unknown[]) => {
    const client = getClient();
    return runOptional(
      client,
      loadSqlFile(path, client.fileRoot, client.reloadSqlFiles, client.sqlFiles),
      params,
      undefined,
      defaultOptions,
    );
  }) as AnyOptionalFn;
  (file as FileCallable).execute = (async (path: string, ...params: unknown[]) => {
    const client = getClient();
    return runExecute(
      client,
      loadSqlFile(path, client.fileRoot, client.reloadSqlFiles, client.sqlFiles),
      params,
      undefined,
      defaultOptions,
    );
  }) as AnyExecuteFn;
  (fn as SqlCallable).file = file as FileCallable;
  (fn as SqlCallable).one = (async (query: string, ...params: unknown[]) => {
    return runOne(getClient(), query, params, undefined, defaultOptions);
  }) as AnyOneFn;
  (fn as SqlCallable).optional = (async (query: string, ...params: unknown[]) => {
    return runOptional(getClient(), query, params, undefined, defaultOptions);
  }) as AnyOptionalFn;
  (fn as SqlCallable).execute = (async (query: string, ...params: unknown[]) => {
    return runExecute(getClient(), query, params, undefined, defaultOptions);
  }) as AnyExecuteFn;
  (fn as SqlCallable).with = (options) =>
    makeSqlCallable(getClient, mergeQueryExecutionOptions(defaultOptions, options));
  (fn as SqlCallable).id = id;
  (fn as SqlCallable).json = json;
  (fn as SqlCallable).array = array;
  (fn as SqlCallable)[QUERY_EXECUTOR] = (mode, query, params, metadata, options) => {
    return executeDefinedQuery(
      getClient(),
      mode,
      query,
      params,
      metadata,
      mergeQueryExecutionOptions(defaultOptions, options),
    );
  };
  return fn as SqlCallable;
}

function makeBoundCallable(client: RuntimeClient): SavepointSqlCallable {
  const fn = makeSqlCallable(() => client) as SavepointSqlCallable;
  (fn as SavepointSqlCallable).savepoint = async <R>(
    callback: (savepoint: SavepointSqlCallable) => Promise<R>,
  ): Promise<R> => {
    if (!client.savepoint) throw new Error("sqlx-js.savepoint: savepoints require a transaction-scoped executor");
    return await client.savepoint(async (savepointClient) =>
      await callback(makeBoundCallable(savepointClient))
    );
  };
  return fn as SavepointSqlCallable;
}

type TransactionOptionBase = {
  isolation?: "read uncommitted" | "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
  deferrable?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type TransactionOptions<Setting extends string = never> = TransactionOptionBase & (
  [Setting] extends [never]
    ? { settings?: never }
    : { settings: Readonly<Record<Setting, string>> }
);

type RuntimeSqlTransactionOptions = TransactionOptionBase & {
  settings?: Readonly<Record<string, string>>;
};

export type SqlRoot = SqlCallable & {
  transaction: <R>(
    fnOrOpts: RuntimeSqlTransactionOptions | ((tx: SqlCallable) => Promise<R>),
    fn?: (tx: SqlCallable) => Promise<R>,
  ) => Promise<R>;
};

const TRANSACTION_ISOLATIONS = new Set([
  "read uncommitted",
  "read committed",
  "repeatable read",
  "serializable",
]);

function buildSetTransaction(opts: TransactionOptionBase): string {
  if (opts.isolation !== undefined && !TRANSACTION_ISOLATIONS.has(opts.isolation)) {
    throw new Error(`sqlx-js.transaction: unsupported isolation level ${JSON.stringify(opts.isolation)}`);
  }
  if (opts.readOnly !== undefined && typeof opts.readOnly !== "boolean") {
    throw new Error("sqlx-js.transaction: readOnly must be a boolean");
  }
  if (opts.deferrable !== undefined && typeof opts.deferrable !== "boolean") {
    throw new Error("sqlx-js.transaction: deferrable must be a boolean");
  }
  const parts: string[] = [];
  if (opts.isolation) parts.push(`ISOLATION LEVEL ${opts.isolation.toUpperCase()}`);
  if (opts.readOnly !== undefined) parts.push(opts.readOnly ? "READ ONLY" : "READ WRITE");
  if (opts.deferrable !== undefined) parts.push(opts.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE");
  if (parts.length === 0) return "";
  return `SET TRANSACTION ${parts.join(" ")}`;
}

function validateTransactionTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) return;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error(`sqlx-js.transaction: timeoutMs must be an integer from 1 to 2147483647, got ${timeoutMs}`);
  }
}

function transactionSettingsJson(
  settings: Readonly<Record<string, string>> | undefined,
  expected: readonly string[] | undefined,
): string | undefined {
  if (!expected || expected.length === 0) {
    if (settings !== undefined) {
      throw new Error(
        "sqlx-js.transaction: settings require a profiled client with declared transactionSettings",
      );
    }
    return undefined;
  }
  if (settings === undefined) {
    throw new Error(`sqlx-js.transaction: profile requires transaction settings: ${expected.join(", ")}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("sqlx-js.transaction: settings must be an object of string values");
  }
  const keys = Object.keys(settings);
  const missing = expected.filter((name) => !Object.hasOwn(settings, name));
  const unexpected = keys.filter((name) => !expected.includes(name));
  const values = expected.map((name) => [name, settings[name]] as const);
  const invalid = values
    .filter(([, value]) => typeof value !== "string")
    .map(([name]) => name);
  if (missing.length > 0 || unexpected.length > 0 || invalid.length > 0) {
    const reasons = [
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0 ? [`unexpected ${unexpected.join(", ")}`] : []),
      ...(invalid.length > 0 ? [`non-string ${invalid.join(", ")}`] : []),
    ];
    throw new Error(`sqlx-js.transaction: transaction settings must match the profile; ${reasons.join("; ")}`);
  }
  return JSON.stringify(Object.fromEntries(values));
}

const SET_TRANSACTION_SETTINGS = `
SELECT pg_catalog.set_config(setting.name, setting.value, true)
FROM pg_catalog.jsonb_each_text($1::pg_catalog.text::pg_catalog.jsonb) AS setting(name, value)
`.trim();

export type RuntimeApi = {
  sql: SqlRoot;
  unsafe: (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
};

export function createSqlRuntime(getClient: () => RuntimeClient): RuntimeApi {
  const directClient = (): RuntimeClient => {
    const client = getClient();
    if (client.transactionSettings) {
      throw new Error(
        "sqlx-js: client requires transaction settings; "
        + "execute SQL through sql.transaction({ settings }, callback)",
      );
    }
    return client;
  };
  const root = makeSqlCallable(directClient) as SqlRoot;

  root.transaction = (async <R>(
    fnOrOpts: RuntimeSqlTransactionOptions | ((tx: SqlCallable) => Promise<R>),
    maybeFn?: (tx: SqlCallable) => Promise<R>,
  ): Promise<R> => {
    let opts: RuntimeSqlTransactionOptions = {};
    let cb: (tx: SqlCallable) => Promise<R>;
    if (typeof fnOrOpts === "function") {
      if (maybeFn !== undefined) {
        throw new Error("sqlx-js.transaction: pass either a callback or options followed by a callback");
      }
      cb = fnOrOpts;
    } else {
      if (!fnOrOpts || typeof fnOrOpts !== "object" || Array.isArray(fnOrOpts)) {
        throw new Error("sqlx-js.transaction: options must be an object");
      }
      opts = fnOrOpts;
      if (typeof maybeFn !== "function") throw new Error("sqlx-js.transaction: callback is required");
      cb = maybeFn;
    }
    const setTx = buildSetTransaction(opts);
    validateTransactionTimeout(opts.timeoutMs);
    const c = getClient();
    const settingsJson = transactionSettingsJson(opts.settings, c.transactionSettings);
    return await c.transaction(async (txClient) => {
      if (setTx) await txClient.query(setTx, []);
      if (settingsJson) await txClient.query(SET_TRANSACTION_SETTINGS, [settingsJson]);
      const tx = makeBoundCallable(txClient);
      return await cb(tx);
    }, { timeoutMs: opts.timeoutMs, signal: opts.signal });
  }) as SqlRoot["transaction"];

  const unsafe = (async (query: string, ...params: unknown[]): Promise<Record<string, unknown>[]> => {
    return (await runQuery(directClient(), query, params)) as Record<string, unknown>[];
  }) as (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;

  return { sql: root, unsafe };
}
