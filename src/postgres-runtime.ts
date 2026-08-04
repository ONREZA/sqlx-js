import { resolve } from "node:path";
import {
  ClientClosingError,
  assertNoDateSqlValue,
  createSqlRuntime,
  encodePgArrayLiteral,
  GenerationRecycledError,
  parameterKind,
  parsePgArrayLiteral,
  QueryAbortedError,
  QueryTimeoutError,
  ResultDecodeError,
  toPgError,
  TransactionTimeoutError,
  withResultDecodeQueryMetadata,
  type JsonParameter,
  type OnQueryHook,
  type OnQueryHookError,
  type PgArrayParameter,
  type QueryExecutionOptions,
  type RuntimeClient,
  type RuntimeQueryRequest,
  type RuntimeQueryResult,
  type RuntimeTransactionOptions,
} from "./runtime";
import {
  EXECUTE_KNOWN_PARAMS,
  createPostgresClient,
  type KnownParamsQueryClient,
  type PostgresClient as InternalPostgresClient,
  type PostgresOptions as InternalPostgresOptions,
  type PostgresQueryClient,
  type PostgresType,
} from "./pg/driver";
import { PostgresTypeRegistry, type RuntimeTypeCodecs } from "./postgres-codecs";
import {
  prepareRuntimeDescriptors,
  type PreparedRuntimeDescriptors,
  type RuntimeQueryDescriptor,
} from "./runtime-descriptors";
import { queryId } from "./query-id";
import type { QueryExecutionMetadata } from "./query";
import type { DatabaseProfile } from "./config";
import {
  resolveTemporalPolicy,
  type TemporalPolicy,
} from "./temporal";
import { resolveTemporalApi, type TemporalApi } from "./temporal-api";
import { ConnectionLostError, PgError } from "./pg/wire";
import {
  createTransactionRuntimeClient,
  type PendingQuery,
  type TransactionState,
} from "./postgres-transaction-runtime";
import {
  normalizeRuntimeDatabaseUrl,
  profileClientOptions,
  validateRuntimeProfile,
  type ClientLifecycleEvent,
  type ClientSnapshot,
  type ClientState,
  type CloseOptions,
  type CreateClientOptions,
  type CreateSqlClientOptions,
  type DeadlineOptions,
} from "./postgres-client-options";
export { normalizeRuntimeDatabaseUrl } from "./postgres-client-options";
export type {
  ClientLifecycleEvent,
  ClientSnapshot,
  ClientState,
  ClientStateChangeEvent,
  CloseOptions,
  CreateClientOptions,
  CreateSqlClientOptions,
  DeadlineOptions,
  QueryStartEvent,
  QueryErrorEvent,
  QueryTimeoutEvent,
} from "./postgres-client-options";

export type PostgresClient = InternalPostgresClient;
export type PostgresOptions = InternalPostgresOptions;
export type { PostgresType, TemporalApi };
type Deferred<T> = {
  promise: Promise<T>;
  reject(error: unknown): void;
};

type OperationRecord = {
  id: number;
  generation: PoolGeneration;
  metadata: QueryExecutionMetadata;
  startedAt: number;
  deadlineAt: number | undefined;
  phase: "bootstrap" | "execution";
  bootstrapStarted: boolean;
  sent: boolean;
  pending?: PendingQuery;
  driver?: Promise<unknown>;
  driverSettled: boolean;
  interrupted?: Error;
  interruption: Deferred<never>;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  transactionState?: TransactionState;
};

type PoolGeneration = {
  id: number;
  pool: PostgresClient;
  registry: PostgresTypeRegistry;
  state: "healthy" | "poisoned" | "retiring";
  active: Map<number, OperationRecord>;
  driverPending: Set<Promise<unknown>>;
  recycle?: Promise<void>;
};

function deferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((_, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

function resolvedFileRoot(value?: string): string {
  return resolve(value ?? process.env.SQLX_JS_FILE_ROOT ?? process.cwd());
}

const SAFE_LIFECYCLE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_LIFECYCLE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function lifecycleErrorCode(error: unknown): string | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_LIFECYCLE_ERROR_CODE.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function lifecycleErrorDetails(error: unknown): {
  errorName: string;
  errorCode?: string;
  databaseError?: {
    sqlstate: string;
    severity?: string;
  };
} {
  const candidateName = error instanceof Error ? error.name : typeof error;
  const errorName = SAFE_LIFECYCLE_ERROR_NAME.test(candidateName)
    ? candidateName
    : error instanceof Error ? "Error" : typeof error;
  if (error instanceof PgError && error.code) {
    return {
      errorName,
      errorCode: error.code,
      databaseError: {
        sqlstate: error.code,
        ...(error.severity ? { severity: error.severity } : {}),
      },
    };
  }
  const errorCode = lifecycleErrorCode(error);
  return { errorName, ...(errorCode ? { errorCode } : {}) };
}

// Admission, transaction deadlines, and generation recycling mutate the same
// operation record; keeping them together makes no-replay/outcome ordering reviewable.
class ManagedPostgresRuntime implements RuntimeClient {
  readonly fileRoot: string;
  readonly reloadSqlFiles: boolean;
  readonly sqlFiles?: Readonly<Record<string, string>>;
  readonly onQuery?: OnQueryHook;
  readonly onQueryHookError?: OnQueryHookError;
  readonly transactionSettings?: readonly string[];
  private readonly onQueryStart?: CreateSqlClientOptions["onQueryStart"];
  private readonly onQueryTimeout?: CreateSqlClientOptions["onQueryTimeout"];
  private readonly onQueryError?: CreateSqlClientOptions["onQueryError"];
  private readonly onClientStateChange?: CreateSqlClientOptions["onClientStateChange"];
  private readonly onLifecycleHookError?: CreateSqlClientOptions["onLifecycleHookError"];
  private readonly operationTimeoutMs?: number;
  private readonly cancelGraceMs: number;
  private readonly profile?: DatabaseProfile;
  private readonly typeCodecs?: RuntimeTypeCodecs;
  private readonly descriptors?: PreparedRuntimeDescriptors;
  private readonly createPool: () => PostgresClient;
  private current: PoolGeneration;
  private generations = new Set<PoolGeneration>();
  private state: ClientState = "healthy";
  private nextGeneration = 1;
  private nextOperation = 1;
  private recoveryEpoch = 0;
  private shutdownStarted = false;
  private closePromise?: Promise<void>;
  private activeDrainWaiters = new Set<() => void>();
  private lastSuccessAt: number | null = null;
  private lastTimeoutAt: number | null = null;
  private recycleCount = 0;

  constructor(
    createPool: (temporal: TemporalPolicy) => PostgresClient,
    options: CreateSqlClientOptions,
  ) {
    const hasQueryDescriptors = Object.hasOwn(options, "queryDescriptors");
    if (options.execution === "adaptive" && hasQueryDescriptors) {
      throw new Error("sqlx-js: execution: \"adaptive\" cannot be combined with queryDescriptors");
    }
    this.onQuery = options.onQuery;
    this.onQueryHookError = options.onQueryHookError;
    this.onQueryStart = options.onQueryStart;
    this.onQueryTimeout = options.onQueryTimeout;
    this.onQueryError = options.onQueryError;
    this.onClientStateChange = options.onClientStateChange;
    this.onLifecycleHookError = options.onLifecycleHookError;
    this.operationTimeoutMs = validateOptionalTimeout(options.operationTimeoutMs, "operationTimeoutMs");
    this.cancelGraceMs = validateTimeout(options.cancelGraceMs ?? 1_000, "cancelGraceMs", true);
    if (options.profile) validateRuntimeProfile(options.profile);
    const transactionSettings = options.profile?.transactionSettings
      ? Object.freeze([...options.profile.transactionSettings])
      : undefined;
    this.profile = options.profile
      ? Object.freeze({
        name: options.profile.name,
        role: options.profile.role,
        ...(transactionSettings ? { transactionSettings } : {}),
      })
      : undefined;
    this.transactionSettings = transactionSettings;
    this.fileRoot = resolvedFileRoot(options.fileRoot);
    this.reloadSqlFiles = options.reloadSqlFiles ?? false;
    this.sqlFiles = options.sqlFiles;
    this.typeCodecs = options.typeCodecs;
    this.descriptors = hasQueryDescriptors
      ? prepareRuntimeDescriptors(options.queryDescriptors!, this.profile)
      : undefined;
    const configuredTemporal = options.temporal === undefined
      ? undefined
      : resolveTemporalPolicy(options.temporal);
    if (
      configuredTemporal
      && this.descriptors
      && (
        configuredTemporal.infinity !== this.descriptors.temporal.infinity
        || configuredTemporal.timestampWithoutTimeZone !== this.descriptors.temporal.timestampWithoutTimeZone
        || configuredTemporal.sessionTimeZone !== this.descriptors.temporal.sessionTimeZone
      )
    ) {
      throw new Error(
        "sqlx-js: temporal policy does not match the generated query descriptor",
      );
    }
    const temporal = this.descriptors?.temporal
      ?? configuredTemporal
      ?? resolveTemporalPolicy(undefined);
    this.createPool = () => createPool(temporal);
    this.current = this.createGeneration();
  }

  async query(query: string, params: unknown[]): Promise<RuntimeQueryResult> {
    return await this.execute({
      query,
      params,
      observedQuery: query,
      observedParams: params,
      metadata: { queryId: queryId(query) },
    });
  }

  async execute(request: RuntimeQueryRequest): Promise<RuntimeQueryResult> {
    this.assertTransactionContext();
    return await this.executeRequest(request);
  }

  private async executeRequest(request: RuntimeQueryRequest): Promise<RuntimeQueryResult> {
    const generation = this.acceptGeneration();
    const descriptor = this.descriptors?.queries.get(request.metadata.queryId);
    const signal = validateOptionalAbortSignal(request.options?.signal);
    const timeoutMs = validateOptionalTimeout(
      request.options?.timeoutMs ?? this.operationTimeoutMs,
      "timeoutMs",
    );
    const operation = this.startOperation(generation, request.metadata, timeoutMs, signal);
    const work = this.executeQuery(generation, operation, request, descriptor);
    try {
      const result = await Promise.race([work, operation.interruption.promise]);
      this.lastSuccessAt = Date.now();
      if (this.onQuery) {
        this.notifyQuery({
          ...request.metadata,
          executionPath: request.params.length === 0
            ? undefined
            : descriptor ? "descriptor" : "adaptive",
          query: request.observedQuery,
          params: request.observedParams,
          durationMs: performance.now() - operation.startedAt,
          rowCount: result.count ?? result.length,
        });
      }
      return result;
    } catch (cause) {
      let error: unknown = operation.interrupted;
      if (error === undefined) {
        const normalized = toPgError(cause) ?? cause;
        error = operation.phase === "execution" && normalized instanceof ResultDecodeError
          ? withResultDecodeQueryMetadata(normalized, request.metadata)
          : normalized;
      }
      this.notifyOperationError(operation, error);
      if (this.onQuery) {
        this.notifyQuery({
          ...request.metadata,
          executionPath: request.params.length === 0
            ? undefined
            : descriptor ? "descriptor" : "adaptive",
          query: request.observedQuery,
          params: request.observedParams,
          durationMs: performance.now() - operation.startedAt,
          error,
        });
      }
      throw error;
    } finally {
      this.finishOperation(operation);
    }
  }

  async transaction<R>(
    fn: (client: RuntimeClient) => Promise<R>,
    options: RuntimeTransactionOptions = {},
  ): Promise<R> {
    const generation = this.acceptGeneration();
    const signal = validateOptionalAbortSignal(options.signal);
    const timeoutMs = validateOptionalTimeout(options.timeoutMs ?? this.operationTimeoutMs, "timeoutMs");
    const metadata = { queryId: queryId("sqlx-js.transaction"), queryName: "sqlx-js.transaction" };
    const operation = this.startOperation(generation, metadata, undefined, undefined);
    const state: TransactionState = {
      pending: new Set(),
      interrupt: operation.interruption,
      nextSavepoint: 1,
    };
    operation.transactionState = state;
    let timeoutError: TransactionTimeoutError | undefined;
    let abortError: QueryAbortedError | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let expire: (() => void) | undefined;

    if (timeoutMs !== undefined) {
      operation.deadlineAt = operation.startedAt + timeoutMs;
      state.deadlineAt = operation.deadlineAt;
      expire = () => {
        if (operation.interrupted || state.expired || !generation.active.has(operation.id)) return;
        const error = new TransactionTimeoutError(timeoutMs, "unknown", generation.id);
        timeoutError = error;
        operation.interrupted = error;
        state.expired = error;
        this.lastTimeoutAt = Date.now();
        this.notifyTimeout(operation, timeoutMs);
        this.cancelTransaction(state);
        operation.interruption.reject(error);
      };
      state.expire = expire;
      const remainingMs = operation.deadlineAt - performance.now();
      if (remainingMs <= 0) expire();
      else timer = setTimeout(expire, remainingMs);
    }
    if (signal) {
      abortListener = () => {
        if (operation.interrupted || state.expired || !generation.active.has(operation.id)) return;
        const error = new QueryAbortedError(this.interruptionDetails(operation), signal.reason);
        abortError = error;
        operation.interrupted = error;
        state.expired = error;
        this.cancelTransaction(state);
        operation.interruption.reject(error);
      };
      try {
        if (signal.aborted) abortListener();
        else signal.addEventListener("abort", abortListener, { once: true });
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        state.expire = undefined;
        state.expired ??= new Error("sqlx-js.transaction: scoped executor is no longer active");
        this.finishOperation(operation);
        detachAbortListener(signal, abortListener);
        void operation.interruption.promise.catch(() => {});
        throw error;
      }
    }

    const begin = this.executeTransaction(generation, operation, state, fn);
    try {
      let result: R;
      try {
        result = await Promise.race([
          begin,
          operation.interruption.promise,
        ]);
      } finally {
        if (operation.deadlineAt !== undefined && performance.now() >= operation.deadlineAt) expire?.();
      }
      if (operation.interrupted) throw operation.interrupted;
      this.lastSuccessAt = Date.now();
      return result;
    } catch (cause) {
      const error = operation.interrupted ?? toPgError(cause) ?? cause;
      this.notifyOperationError(operation, error);
      if (error === timeoutError) {
        const rolledBack = await settlesWith(begin, timeoutError, this.cancelGraceMs);
        if (rolledBack) throw new TransactionTimeoutError(timeoutMs!, "rolled_back", generation.id);
        this.poisonGeneration(generation, operation, timeoutError!);
        throw timeoutError!;
      }
      if (error === abortError) {
        const cleaned = await settlesWith(begin, abortError, this.cancelGraceMs);
        if (!cleaned) this.poisonGeneration(generation, operation, abortError!);
        throw abortError!;
      }
      if (error instanceof QueryTimeoutError || error instanceof QueryAbortedError) {
        const cleaned = await settlesWith(begin, error, this.cancelGraceMs);
        if (!cleaned) this.poisonGeneration(generation, operation, error);
        throw error;
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      state.expire = undefined;
      state.expired ??= new Error("sqlx-js.transaction: scoped executor is no longer active");
      this.finishOperation(operation);
      detachAbortListener(signal, abortListener);
    }
  }

  private assertTransactionContext(): void {
    if (!this.profile || !this.transactionSettings) return;
    throw new Error(
      `sqlx-js: profile ${this.profile.name} requires transaction settings; `
      + "execute SQL through sql.transaction({ settings }, callback)",
    );
  }

  async ready(options: DeadlineOptions = {}): Promise<void> {
    const generation = this.acceptGeneration();
    const timeoutMs = validateOptionalTimeout(options.timeoutMs ?? this.operationTimeoutMs, "timeoutMs");
    const metadata = { queryId: queryId("sqlx-js.ready"), queryName: "sqlx-js.ready" };
    const operation = this.startOperation(generation, metadata, timeoutMs, undefined);
    const work = this.bootstrap(generation, operation);
    try {
      await Promise.race([work, operation.interruption.promise]);
    } catch (cause) {
      const error = operation.interrupted ?? toPgError(cause) ?? cause;
      this.notifyOperationError(operation, error);
      throw error;
    } finally {
      this.finishOperation(operation);
    }
  }

  async ping(options: DeadlineOptions = {}): Promise<void> {
    const timeoutMs = validateOptionalTimeout(options.timeoutMs ?? this.operationTimeoutMs, "timeoutMs");
    await this.executeRequest({
      query: "SELECT 1",
      params: [],
      observedQuery: "SELECT 1",
      observedParams: [],
      metadata: { queryId: queryId("SELECT 1"), queryName: "sqlx-js.ping" },
      options: { timeoutMs },
    });
  }

  snapshot(): ClientSnapshot {
    let activeOperations = 0;
    for (const generation of this.generations) activeOperations += generation.active.size;
    return Object.freeze({
      generation: this.current.id,
      state: this.state,
      activeOperations,
      lastSuccessAt: this.lastSuccessAt,
      lastTimeoutAt: this.lastTimeoutAt,
      recycleCount: this.recycleCount,
    });
  }

  close(options: CloseOptions = {}): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const graceMs = validateTimeout(options.graceMs ?? 5_000, "graceMs", true);
    const forceAfterMs = validateTimeout(options.forceAfterMs ?? 10_000, "forceAfterMs", true);
    if (forceAfterMs < graceMs) {
      return Promise.reject(new Error("sqlx-js.close: forceAfterMs must be greater than or equal to graceMs"));
    }
    this.shutdownStarted = true;
    this.closePromise = Promise.resolve().then(() => this.closeManaged(graceMs, forceAfterMs));
    this.transition("closing", this.current.id);
    return this.closePromise;
  }

  private createGeneration(): PoolGeneration {
    const pool = this.createPool();
    const generation: PoolGeneration = {
      id: this.nextGeneration++,
      pool,
      registry: new PostgresTypeRegistry(pool, this.typeCodecs, this.descriptors?.types),
      state: "healthy",
      active: new Map(),
      driverPending: new Set(),
    };
    this.generations.add(generation);
    return generation;
  }

  private acceptGeneration(): PoolGeneration {
    if (this.shutdownStarted) throw new ClientClosingError();
    if (this.state === "failed" || this.current.state !== "healthy") {
      throw new Error("sqlx-js: managed database client has no healthy generation");
    }
    return this.current;
  }

  private startOperation(
    generation: PoolGeneration,
    metadata: QueryExecutionMetadata,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): OperationRecord {
    const startedAt = performance.now();
    const operation: OperationRecord = {
      id: this.nextOperation++,
      generation,
      metadata,
      startedAt,
      deadlineAt: timeoutMs === undefined ? undefined : startedAt + timeoutMs,
      phase: "bootstrap",
      bootstrapStarted: false,
      sent: false,
      driverSettled: false,
      interruption: deferred<never>(),
      signal,
    };
    generation.active.set(operation.id, operation);
    if (timeoutMs !== undefined) {
      operation.timer = setTimeout(() => this.timeoutOperation(operation, timeoutMs), timeoutMs);
    }
    if (this.onQueryStart) {
      this.notifyLifecycle(this.onQueryStart, {
        ...metadata,
        generation: generation.id,
      });
    }
    if (signal) {
      operation.abortListener = () => this.abortOperation(operation, signal.reason);
      try {
        if (signal.aborted) operation.abortListener();
        else signal.addEventListener("abort", operation.abortListener, { once: true });
      } catch (error) {
        this.finishOperation(operation);
        void operation.interruption.promise.catch(() => {});
        throw error;
      }
    }
    return operation;
  }

  private finishOperation(operation: OperationRecord): void {
    if (operation.timer !== undefined) clearTimeout(operation.timer);
    operation.generation.active.delete(operation.id);
    detachAbortListener(operation.signal, operation.abortListener);
    if (this.activeDrainWaiters.size > 0 && this.activeOperationCount() === 0) {
      for (const resolve of this.activeDrainWaiters) resolve();
      this.activeDrainWaiters.clear();
    }
  }

  private async executeQuery(
    generation: PoolGeneration,
    operation: OperationRecord,
    request: RuntimeQueryRequest,
    descriptor: RuntimeQueryDescriptor | undefined,
  ): Promise<RuntimeQueryResult> {
    this.checkOperation(operation);
    await this.bootstrap(generation, operation);
    this.checkOperation(operation);
    operation.phase = "execution";
    const params = this.encodeParams(generation.pool, request.params);
    this.checkOperation(operation);
    const pending = descriptor
      ? this.pendingDescriptorQuery(
        generation,
        generation.pool,
        request.metadata.queryId,
        request.query,
        descriptor,
        params,
      )
      : generation.pool.unsafe(request.query, params as never[]) as unknown as PendingQuery;
    this.checkOperation(operation);
    operation.pending = pending;
    operation.sent = true;
    pending.execute?.();
    const driver = Promise.resolve(pending);
    operation.driver = driver;
    try {
      return await driver as RuntimeQueryResult;
    } finally {
      operation.driverSettled = true;
      this.checkOperation(operation);
    }
  }

  private async executeTransaction<R>(
    generation: PoolGeneration,
    operation: OperationRecord,
    state: TransactionState,
    fn: (client: RuntimeClient) => Promise<R>,
  ): Promise<R> {
    this.checkTransactionOperation(operation, state);
    await this.bootstrap(generation, operation, false);
    this.checkTransactionOperation(operation, state);
    operation.phase = "execution";
    operation.sent = true;
    const driver = generation.pool.begin(async (tx) => {
      if (state.expired) throw state.expired;
      const scoped = createTransactionRuntimeClient(this, generation, tx, state);
      try {
        return await Promise.race([fn(scoped), state.interrupt.promise]);
      } finally {
        scoped.finish();
        await scoped.settle();
      }
    }) as Promise<R>;
    operation.driver = driver;
    try {
      return await driver;
    } finally {
      operation.driverSettled = true;
    }
  }

  async executeTransactionQuery(
    generation: PoolGeneration,
    client: PostgresQueryClient,
    state: TransactionState,
    request: RuntimeQueryRequest,
  ): Promise<RuntimeQueryResult> {
    this.checkTransactionState(state);
    const descriptor = this.descriptors?.queries.get(request.metadata.queryId);
    const signal = validateOptionalAbortSignal(request.options?.signal);
    const timeoutMs = validateOptionalTimeout(request.options?.timeoutMs, "timeoutMs");
    const startedAt = performance.now();
    if (this.onQueryStart) {
      this.notifyLifecycle(this.onQueryStart, { ...request.metadata, generation: generation.id });
    }
    this.checkTransactionState(state);
    const deadlineAt = timeoutMs === undefined ? undefined : startedAt + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let abortListenerActive = true;
    let expire: (() => void) | undefined;
    let sent = false;
    const interrupt = (error: Error) => {
      if (state.expired) return;
      state.expired = error;
      this.cancelTransaction(state);
      state.interrupt.reject(error);
    };
    if (timeoutMs !== undefined) {
      expire = () => {
        if (state.expired) return;
        const error = new QueryTimeoutError(timeoutMs, {
          phase: "execution",
          outcome: sent ? "unknown" : "not_sent",
          queryId: request.metadata.queryId,
          generation: generation.id,
        });
        this.lastTimeoutAt = Date.now();
        this.notifyLifecycle(this.onQueryTimeout, {
          ...request.metadata,
          generation: generation.id,
          durationMs: performance.now() - startedAt,
          timeoutMs,
          phase: "execution",
          outcome: sent ? "unknown" : "not_sent",
        });
        interrupt(error);
      };
      const remainingMs = deadlineAt! - performance.now();
      if (remainingMs <= 0) expire();
      else timer = setTimeout(expire, remainingMs);
    }
    if (signal) {
      abortListener = () => {
        if (!abortListenerActive) return;
        interrupt(new QueryAbortedError({
          phase: "execution",
          outcome: sent ? "unknown" : "not_sent",
          queryId: request.metadata.queryId,
          generation: generation.id,
        }, signal.reason));
      };
      try {
        if (signal.aborted) abortListener();
        else signal.addEventListener("abort", abortListener, { once: true });
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        abortListenerActive = false;
        detachAbortListener(signal, abortListener);
        throw error;
      }
    }
    let pending: PendingQuery | undefined;
    try {
      const params = this.encodeParams(generation.pool, request.params);
      this.checkTransactionState(state);
      if (deadlineAt !== undefined && performance.now() >= deadlineAt && !state.expired) {
        expire?.();
      }
      if (state.expired) throw state.expired;
      pending = descriptor
        ? this.pendingDescriptorQuery(
          generation,
          client,
          request.metadata.queryId,
          request.query,
          descriptor,
          params,
        )
        : client.unsafe(request.query, params as never[]) as unknown as PendingQuery;
      this.checkTransactionState(state);
      if (deadlineAt !== undefined && performance.now() >= deadlineAt && !state.expired) {
        expire?.();
      }
      if (state.expired) throw state.expired;
      state.pending.add(pending);
      sent = true;
      pending.execute?.();
      const driver = Promise.resolve(pending);
      let result: RuntimeQueryResult;
      try {
        result = await Promise.race([driver, state.interrupt.promise]) as RuntimeQueryResult;
      } finally {
        this.checkTransactionState(state);
        if (deadlineAt !== undefined && performance.now() >= deadlineAt && !state.expired) {
          expire?.();
        }
        if (state.expired) throw state.expired;
      }
      if (this.onQuery) {
        this.notifyQuery({
          ...request.metadata,
          executionPath: request.params.length === 0
            ? undefined
            : descriptor ? "descriptor" : "adaptive",
          query: request.observedQuery,
          params: request.observedParams,
          durationMs: performance.now() - startedAt,
          rowCount: result.count ?? result.length,
        });
      }
      return result;
    } catch (cause) {
      let error: unknown = state.expired;
      if (error === undefined) {
        const normalized = toPgError(cause) ?? cause;
        error = normalized instanceof ResultDecodeError
          ? withResultDecodeQueryMetadata(normalized, request.metadata)
          : normalized;
      }
      if (error instanceof ConnectionLostError) {
        error = this.failTransaction(state, error);
      }
      this.notifyQueryFailure(
        request.metadata,
        generation.id,
        startedAt,
        "execution",
        sent,
        error,
      );
      if (this.onQuery) {
        this.notifyQuery({
          ...request.metadata,
          executionPath: request.params.length === 0
            ? undefined
            : descriptor ? "descriptor" : "adaptive",
          query: request.observedQuery,
          params: request.observedParams,
          durationMs: performance.now() - startedAt,
          error,
        });
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abortListenerActive = false;
      detachAbortListener(signal, abortListener);
      if (pending) state.pending.delete(pending);
    }
  }

  async executeTransactionControl(
    client: PostgresQueryClient,
    state: TransactionState,
    query: string,
  ): Promise<void> {
    this.checkTransactionState(state);
    let pending: PendingQuery | undefined;
    try {
      pending = client.unsafe(query, []) as unknown as PendingQuery;
      state.pending.add(pending);
      pending.execute?.();
      await Promise.race([Promise.resolve(pending), state.interrupt.promise]);
      this.checkTransactionState(state);
    } catch (cause) {
      const error = state.expired ?? toPgError(cause) ?? cause;
      throw this.failTransaction(state, error);
    } finally {
      if (pending) state.pending.delete(pending);
    }
  }

  private failTransaction(state: TransactionState, cause: unknown): Error {
    if (state.expired) return state.expired;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    state.expired = error;
    this.cancelTransaction(state);
    state.interrupt.reject(error);
    return error;
  }

  private async bootstrap(
    generation: PoolGeneration,
    operation: OperationRecord,
    checkDeadline = true,
  ): Promise<void> {
    try {
      const pending = generation.registry.ready();
      if (pending) {
        operation.bootstrapStarted = true;
        await pending;
      }
    } catch (error) {
      throw toPgError(error) ?? error;
    }
    if (checkDeadline) this.checkOperation(operation);
  }

  private checkTransactionOperation(operation: OperationRecord, state: TransactionState): void {
    if (operation.interrupted) throw operation.interrupted;
    this.checkTransactionState(state);
  }

  checkTransactionState(state: TransactionState): void {
    if (!state.expired && state.deadlineAt !== undefined && performance.now() >= state.deadlineAt) {
      state.expire?.();
    }
    if (state.expired) throw state.expired;
  }

  private checkOperation(operation: OperationRecord): void {
    if (operation.interrupted) throw operation.interrupted;
    if (operation.deadlineAt !== undefined && performance.now() >= operation.deadlineAt) {
      this.timeoutOperation(operation, Math.max(1, Math.round(operation.deadlineAt - operation.startedAt)));
      throw operation.interrupted!;
    }
  }

  private timeoutOperation(operation: OperationRecord, timeoutMs: number): void {
    if (operation.interrupted || !operation.generation.active.has(operation.id)) return;
    const error = new QueryTimeoutError(timeoutMs, this.interruptionDetails(operation));
    operation.interrupted = error;
    this.lastTimeoutAt = Date.now();
    this.notifyTimeout(operation, timeoutMs);
    operation.interruption.reject(error);
    this.poisonGeneration(operation.generation, operation, error);
  }

  private abortOperation(operation: OperationRecord, reason: unknown): void {
    if (operation.interrupted || !operation.generation.active.has(operation.id)) return;
    const error = new QueryAbortedError(this.interruptionDetails(operation), reason);
    operation.interrupted = error;
    this.cancelPending(operation.pending);
    operation.interruption.reject(error);
    if (operation.bootstrapStarted && !operation.sent) {
      this.poisonGeneration(operation.generation, operation, error);
      return;
    }
    if (operation.sent && operation.driver) {
      void this.recycleIfDriverStalls(operation, error);
    }
  }

  private async recycleIfDriverStalls(operation: OperationRecord, cause: Error): Promise<void> {
    await waitAtMost(operation.driver!, this.cancelGraceMs);
    if (!operation.driverSettled) this.poisonGeneration(operation.generation, operation, cause);
  }

  private interruptionDetails(operation: OperationRecord) {
    return {
      phase: operation.phase,
      outcome: operation.sent ? "unknown" as const : "not_sent" as const,
      queryId: operation.metadata.queryId,
      generation: operation.generation.id,
    };
  }

  private poisonGeneration(generation: PoolGeneration, trigger: OperationRecord, cause: Error): void {
    if (generation.state !== "healthy") return;
    generation.state = "poisoned";
    if (this.shutdownStarted) {
      this.interruptGenerationForShutdown(generation, trigger);
      return;
    }
    this.transition("poisoned", generation.id, cause);
    if (this.shutdownStarted) {
      this.interruptGenerationForShutdown(generation, trigger);
      return;
    }
    this.trackDriver(generation, trigger);
    for (const operation of generation.active.values()) {
      this.trackDriver(generation, operation);
      this.cancelPending(operation.pending);
      if (operation === trigger || operation.interrupted) continue;
      const error = new GenerationRecycledError({
        outcome: operation.sent ? "unknown" : "not_sent",
        queryId: operation.metadata.queryId,
        generation: generation.id,
      }, cause);
      this.interruptOperation(operation, error);
    }
    this.transition("recycling", generation.id, cause);
    if (this.shutdownStarted) return;
    const epoch = ++this.recoveryEpoch;
    let replacement: PoolGeneration;
    try {
      replacement = this.createGeneration();
      this.current = replacement;
      this.recycleCount++;
    } catch (error) {
      this.transition("failed", generation.id, error);
      generation.state = "retiring";
      generation.recycle = this.retireGeneration(generation).catch(() => {});
      return;
    }
    generation.state = "retiring";
    generation.recycle = this.retireGeneration(generation).then(
      () => {
        if (this.recoveryEpoch === epoch && this.state === "recycling") {
          this.transition("healthy", replacement.id);
        }
      },
      (error) => {
        if (this.state !== "closing" && this.state !== "closed" && this.state !== "failed") {
          this.transition("failed", generation.id, error);
        }
      },
    );
  }

  private trackDriver(generation: PoolGeneration, operation: OperationRecord): void {
    const driver = operation.driver;
    if (!driver || operation.driverSettled || generation.driverPending.has(driver)) return;
    generation.driverPending.add(driver);
    void driver.finally(() => {
      operation.driverSettled = true;
      generation.driverPending.delete(driver);
    }).catch(() => {});
  }

  private async retireGeneration(generation: PoolGeneration): Promise<void> {
    const pending = [...generation.driverPending];
    if (pending.length > 0) {
      await waitAtMost(Promise.allSettled(pending), this.cancelGraceMs);
    }
    await generation.pool.end();
    this.generations.delete(generation);
  }

  private cancelTransaction(state: TransactionState): void {
    for (const pending of state.pending) this.cancelPending(pending);
  }

  private interruptGenerationForShutdown(generation: PoolGeneration, trigger: OperationRecord): void {
    for (const operation of generation.active.values()) {
      this.cancelPending(operation.pending);
      if (operation === trigger || operation.interrupted) continue;
      const error = new ClientClosingError(this.interruptionDetails(operation));
      this.interruptOperation(operation, error);
    }
  }

  private interruptOperation(operation: OperationRecord, error: Error): void {
    operation.interrupted = error;
    if (operation.transactionState) {
      this.cancelTransaction(operation.transactionState);
      if (!operation.transactionState.expired) {
        operation.transactionState.expired = error;
      }
    }
    operation.interruption.reject(error);
  }

  private cancelPending(pending?: PendingQuery): void {
    if (!pending?.cancel) return;
    try {
      const result = pending.cancel();
      if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
    } catch {}
  }

  private encodeParams(client: PostgresClient, params: unknown[]): unknown[] {
    return params.length === 0 ? params : params.map((param) => this.encodeParam(client, param));
  }

  private pendingDescriptorQuery(
    generation: PoolGeneration,
    client: PostgresQueryClient,
    queryId: string,
    query: string,
    descriptor: RuntimeQueryDescriptor,
    params: unknown[],
  ): PendingQuery {
    if (descriptor.params.length !== params.length) {
      throw new Error(
        `sqlx-js: runtime descriptor ${queryId} expects `
        + `${descriptor.params.length} parameter(s), received ${params.length}`,
      );
    }
    const executeKnown = (client as PostgresQueryClient & Partial<KnownParamsQueryClient>)[EXECUTE_KNOWN_PARAMS];
    if (!executeKnown) {
      throw new Error("sqlx-js: queryDescriptors require the integrated PostgreSQL driver");
    }
    const parameterOids = descriptor.params.map((type) =>
      typeof type === "number" ? type : generation.registry.descriptorOid(type));
    return executeKnown.call(client, query, parameterOids, params) as unknown as PendingQuery;
  }

  private encodeParam(client: PostgresClient, param: unknown): unknown {
    assertNoDateSqlValue(param, "PostgreSQL parameter");
    const kind = parameterKind(param);
    if (kind === "json") return client.json(param as JsonParameter);
    if (kind === "array") {
      const value = [...(param as PgArrayParameter).value];
      const hasJson = value.some((item) => parameterKind(item) === "json");
      if (hasJson) {
        if (!value.every((item) => item === null || parameterKind(item) === "json")) {
          throw new Error("sqlx-js: PostgreSQL JSON arrays must contain only SqlxJson documents or null");
        }
        return client.array(value as never[], 3807);
      }
      return client.typed(value as never[], 0);
    }
    return param;
  }

  private notifyTimeout(operation: OperationRecord, timeoutMs: number): void {
    this.notifyLifecycle(this.onQueryTimeout, {
      ...operation.metadata,
      generation: operation.generation.id,
      durationMs: performance.now() - operation.startedAt,
      timeoutMs,
      phase: operation.phase,
      outcome: operation.sent ? "unknown" : "not_sent",
    });
  }

  private notifyOperationError(operation: OperationRecord, error: unknown): void {
    this.notifyQueryFailure(
      operation.metadata,
      operation.generation.id,
      operation.startedAt,
      operation.phase,
      operation.sent,
      error,
    );
  }

  private notifyQueryFailure(
    metadata: QueryExecutionMetadata,
    generation: number,
    startedAt: number,
    phase: "bootstrap" | "execution",
    sent: boolean,
    error: unknown,
  ): void {
    this.notifyLifecycle(this.onQueryError, {
      ...metadata,
      generation,
      durationMs: performance.now() - startedAt,
      phase,
      outcome: sent ? "unknown" : "not_sent",
      ...lifecycleErrorDetails(error),
    });
  }

  private notifyQuery(event: Parameters<OnQueryHook>[0]): void {
    const profiled = this.profileEvent(event);
    try {
      const pending = this.onQuery?.(profiled);
      if (pending) void pending.catch((error) => this.notifyQueryError(error, profiled));
    } catch (error) {
      this.notifyQueryError(error, profiled);
    }
  }

  private notifyQueryError(error: unknown, event: Parameters<OnQueryHook>[0]): void {
    try {
      const pending = this.onQueryHookError?.(error, event);
      if (pending) void pending.catch(() => {});
    } catch {}
  }

  private notifyLifecycle<Event extends ClientLifecycleEvent>(
    hook: ((event: Event) => void | Promise<void>) | undefined,
    event: Event,
  ): void {
    const profiled = this.profileEvent(event);
    try {
      const pending = hook?.(profiled);
      if (pending) void pending.catch((error) => this.notifyLifecycleError(error, profiled));
    } catch (error) {
      this.notifyLifecycleError(error, profiled);
    }
  }

  private profileEvent<Event extends object>(event: Event): Event & {
    profile?: string;
    role?: string;
  } {
    if (!this.profile) return event;
    return { ...event, profile: this.profile.name, role: this.profile.role };
  }

  private notifyLifecycleError(error: unknown, event: ClientLifecycleEvent): void {
    try {
      const pending = this.onLifecycleHookError?.(error, event);
      if (pending) void pending.catch(() => {});
    } catch {}
  }

  private transition(to: ClientState, generation: number, reason?: unknown): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.notifyLifecycle(this.onClientStateChange, {
      from,
      to,
      generation,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private async closeManaged(graceMs: number, forceAfterMs: number): Promise<void> {
    const startedAt = performance.now();
    await this.waitForActiveOperations(graceMs);
    for (const generation of this.generations) {
      for (const operation of generation.active.values()) {
        this.cancelPending(operation.pending);
        if (operation.interrupted) continue;
        const closingError = new ClientClosingError(this.interruptionDetails(operation));
        this.interruptOperation(operation, closingError);
      }
    }
    const remainingMs = Math.max(0, forceAfterMs - (performance.now() - startedAt));
    const closing = [...this.generations].map(async (generation) => {
      try {
        await generation.pool.end();
      } catch {}
    });
    await waitAtMost(Promise.allSettled(closing), remainingMs);
    this.generations.clear();
    this.transition("closed", this.current.id);
  }

  private activeOperationCount(): number {
    let count = 0;
    for (const generation of this.generations) count += generation.active.size;
    return count;
  }

  private async waitForActiveOperations(timeoutMs: number): Promise<void> {
    if (this.activeOperationCount() === 0 || timeoutMs === 0) return;
    await new Promise<void>((resolve) => {
      let complete = false;
      const finish = () => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        this.activeDrainWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.activeDrainWaiters.add(finish);
      if (this.activeOperationCount() === 0) finish();
    });
  }
}

function validateTimeout(value: number, name: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) {
    throw new Error(`sqlx-js: ${name} must be an integer from ${minimum} to 2147483647, got ${value}`);
  }
  return value;
}

function validateOptionalTimeout(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : validateTimeout(value, name);
}

function validateOptionalAbortSignal(value: AbortSignal | undefined): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object"
    || value === null
    || typeof value.aborted !== "boolean"
    || typeof value.addEventListener !== "function"
    || typeof value.removeEventListener !== "function"
  ) {
    throw new TypeError("sqlx-js: signal must be an AbortSignal");
  }
  return value;
}

function detachAbortListener(
  signal: AbortSignal | undefined,
  listener: (() => void) | undefined,
): void {
  if (!signal || !listener) return;
  try {
    signal.removeEventListener("abort", listener);
  } catch {}
}

async function waitAtMost(promise: PromiseLike<unknown>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let complete = false;
    const finish = (settled: boolean) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void Promise.resolve(promise).then(
      () => finish(true),
      () => finish(true),
    );
  });
}

async function settlesWith(promise: Promise<unknown>, expected: unknown, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let complete = false;
    const finish = (result: boolean) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(false),
      (error) => finish(error === expected),
    );
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === "function";
}

let defaultClient: ManagedPostgresRuntime | null = null;
let defaultTemporalApi: TemporalApi | null = null;

export function configureDefaultTemporalApi(api: TemporalApi): void {
  if (defaultClient || defaultTemporalApi) {
    throw new Error("sqlx-js: the default Temporal API is already configured");
  }
  defaultTemporalApi = resolveTemporalApi(api);
}

export function createClient(url = process.env.DATABASE_URL, options: CreateClientOptions = {}): PostgresClient {
  if (!url) throw new Error("sqlx-js: DATABASE_URL is not set");
  return createPostgresClient(normalizeRuntimeDatabaseUrl(url), options);
}

function createManagedClient(url: string | undefined, options: CreateSqlClientOptions): ManagedPostgresRuntime {
  if (!url) throw new Error("sqlx-js: DATABASE_URL is not set");
  const clientOptions = profileClientOptions(url, options);
  return new ManagedPostgresRuntime(
    (temporal) => createClient(url, { ...clientOptions, temporal }),
    options,
  );
}

function createDefaultClient(): ManagedPostgresRuntime {
  defaultTemporalApi ??= resolveTemporalApi(undefined);
  return createManagedClient(process.env.DATABASE_URL, { temporalApi: defaultTemporalApi });
}

function getRuntimeClient(): ManagedPostgresRuntime {
  defaultClient ??= createDefaultClient();
  return defaultClient;
}

export async function close(options: CloseOptions = {}): Promise<void> {
  if (defaultClient) {
    await defaultClient.close(options);
    defaultClient = null;
  }
}

export async function ready(options: DeadlineOptions = {}): Promise<void> {
  await getRuntimeClient().ready(options);
}

export async function ping(options: DeadlineOptions = {}): Promise<void> {
  await getRuntimeClient().ping(options);
}

export function snapshot(): ClientSnapshot {
  return getRuntimeClient().snapshot();
}

function managedClientApi(runtimeClient: ManagedPostgresRuntime) {
  const runtime = createSqlRuntime(() => runtimeClient);
  return {
    ...runtime,
    ready: (deadline?: DeadlineOptions) => runtimeClient.ready(deadline),
    ping: (deadline?: DeadlineOptions) => runtimeClient.ping(deadline),
    snapshot: () => runtimeClient.snapshot(),
    close: (closeOptions?: CloseOptions) => runtimeClient.close(closeOptions),
  };
}

export function createSqlClient(url = process.env.DATABASE_URL, options: CreateSqlClientOptions = {}) {
  return managedClientApi(createManagedClient(url, options));
}

export const _internal = {
  createManagedClient(
    createPool: (temporal: TemporalPolicy) => PostgresClient,
    options: CreateSqlClientOptions = {},
  ) {
    return managedClientApi(new ManagedPostgresRuntime(createPool, options));
  },
};

const runtime = createSqlRuntime(getRuntimeClient);

export const sql = runtime.sql;
export const unsafe = runtime.unsafe;
