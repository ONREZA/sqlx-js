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
import { parseJsonResult, stringifyJsonParameter } from "./json-value";
import { assertNoDateSqlValue } from "./sql-value";
import {
  array,
  encodeParam,
  isPrimitiveArrayElement,
  parameterKind,
  parsePgArrayLiteral,
  renameRows,
  json,
  type ExecuteResult,
} from "./runtime-parameters";
import { NoRowsError, TooManyRowsError, toPgError } from "./runtime-errors";

export { clearSqlFileCache, id } from "./runtime-files";
export { migrate, type MigrateOptions } from "./runtime-migrate";
export { parseJsonResult, stringifyJsonParameter } from "./json-value";
export type { JsonCompatible, SqlxJson } from "./json-value";
export { assertNoDateSqlValue, isDateValue } from "./sql-value";
export {
  array,
  encodePgArrayLiteral,
  encodePgArrayLiteralElements,
  json,
  parameterKind,
  parsePgArrayLiteral,
  type ExecuteResult,
  type PgArrayParameter,
} from "./runtime-parameters";
export {
  ClientClosingError,
  GenerationRecycledError,
  isPgError,
  NoRowsError,
  QueryAbortedError,
  QueryTimeoutError,
  ResultDecodeError,
  SQLSTATE,
  TooManyRowsError,
  TransactionTimeoutError,
  toPgError,
  withResultDecodeQueryMetadata,
  type KnownSqlState,
  type QueryOutcome,
  type QueryTimeoutPhase,
  type ResultDecodeErrorDetails,
} from "./runtime-errors";

export type OnQueryEvent = {
  queryId: string;
  queryName?: string;
  profile?: string;
  role?: string;
  executionPath?: QueryExecutionPath;
  query: string;
  params: unknown[];
  durationMs: number;
  preDispatchDurationMs?: number;
  acquireDurationMs?: number;
  executionDurationMs?: number;
  connectionCreated?: boolean;
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
  let executionStartedAt: number | undefined;
  try {
    const transformed = client.transformParams
      ? client.transformParams(params)
      : params.length === 0 ? params : params.map(encodeParam);
    const encoded = isPromiseLike(transformed) ? await transformed : transformed;
    assertNoDateSqlValue(encoded, "PostgreSQL parameter");
    executionStartedAt = performance.now();
    const result = await client.query(query, encoded);
    const completedAt = performance.now();
    notifyQuery(client, {
      ...observed,
      query: observedQuery,
      params: observedParams,
      durationMs: completedAt - start,
      preDispatchDurationMs: executionStartedAt - start,
      executionDurationMs: completedAt - executionStartedAt,
      rowCount: result.count ?? result.length,
    });
    return result;
  } catch (e) {
    const error = toPgError(e) ?? e;
    const completedAt = performance.now();
    notifyQuery(client, {
      ...observed,
      query: observedQuery,
      params: observedParams,
      durationMs: completedAt - start,
      ...(executionStartedAt === undefined ? {} : {
        preDispatchDurationMs: executionStartedAt - start,
        executionDurationMs: completedAt - executionStartedAt,
      }),
      error,
    });
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
  const observed = observedMetadata(runtimeQuery(query).id, metadata);
  const rows = await runQuery(client, query, params, metadata, options);
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) throw new NoRowsError(undefined, observed);
  throw new TooManyRowsError(rows.length, "1", observed);
}

async function runOptional(
  client: RuntimeClient,
  query: string,
  params: unknown[],
  metadata?: QueryExecutionMetadata,
  options?: QueryExecutionOptions,
): Promise<unknown | null> {
  const observed = observedMetadata(runtimeQuery(query).id, metadata);
  const rows = await runQuery(client, query, params, metadata, options);
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  throw new TooManyRowsError(rows.length, "0 or 1", observed);
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
