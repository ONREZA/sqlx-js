import postgres from "postgres";
import { resolve } from "node:path";
import {
  ClientClosingError,
  createSqlRuntime,
  encodePgArrayLiteral,
  GenerationRecycledError,
  parameterKind,
  parsePgArrayLiteral,
  QueryAbortedError,
  QueryTimeoutError,
  toPgError,
  TransactionTimeoutError,
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
import { arrayElementOid, builtinArrayOids } from "./pg/oids";
import { PostgresTypeRegistry, type RuntimeTypeCodecs } from "./postgres-codecs";
import { queryId } from "./query-id";
import type { QueryExecutionMetadata } from "./query";

export type PostgresClient = postgres.Sql<{ bigint: bigint }>;
export type PostgresOptions = postgres.Options<Record<string, postgres.PostgresType>>;
export type CreateClientOptions = PostgresOptions & {
  statementTimeoutMs?: number;
};

export type ClientState = "healthy" | "poisoned" | "recycling" | "failed" | "closing" | "closed";

export type QueryStartEvent = {
  queryId: string;
  queryName?: string;
  generation: number;
};

export type QueryTimeoutEvent = QueryStartEvent & {
  durationMs: number;
  timeoutMs: number;
  phase: "bootstrap" | "execution";
  outcome: "not_sent" | "unknown";
};

export type ClientStateChangeEvent = {
  from: ClientState;
  to: ClientState;
  generation: number;
  reason?: unknown;
};

export type ClientLifecycleEvent = QueryStartEvent | QueryTimeoutEvent | ClientStateChangeEvent;

export type ClientSnapshot = {
  generation: number;
  state: ClientState;
  activeOperations: number;
  lastSuccessAt: number | null;
  lastTimeoutAt: number | null;
  recycleCount: number;
};

export type CloseOptions = {
  graceMs?: number;
  forceAfterMs?: number;
};

export type DeadlineOptions = {
  timeoutMs?: number;
};

export type CreateSqlClientOptions = CreateClientOptions & {
  onQuery?: OnQueryHook;
  onQueryHookError?: OnQueryHookError;
  onQueryStart?: (event: QueryStartEvent) => void | Promise<void>;
  onQueryTimeout?: (event: QueryTimeoutEvent) => void | Promise<void>;
  onClientStateChange?: (event: ClientStateChangeEvent) => void | Promise<void>;
  onLifecycleHookError?: (error: unknown, event: ClientLifecycleEvent) => void | Promise<void>;
  operationTimeoutMs?: number;
  cancelGraceMs?: number;
  fileRoot?: string;
  reloadSqlFiles?: boolean;
  sqlFiles?: Readonly<Record<string, string>>;
  typeCodecs?: RuntimeTypeCodecs;
};
type PostgresQueryClient = PostgresClient | postgres.TransactionSql<{ bigint: bigint }>;
type PendingQuery = PromiseLike<RuntimeQueryResult> & {
  cancel?: () => unknown;
  execute?: () => PendingQuery;
};
type TransactionState = {
  expired?: Error;
  deadlineAt?: number;
  expire?: () => void;
  pending: Set<PendingQuery>;
  interrupt: Deferred<never>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type OperationRecord = {
  id: number;
  generation: PoolGeneration;
  metadata: QueryExecutionMetadata;
  startedAt: number;
  deadlineAt?: number;
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
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resolvedFileRoot(value?: string): string {
  return resolve(value ?? process.env.SQLX_JS_FILE_ROOT ?? process.cwd());
}

export function normalizeRuntimeDatabaseUrl(url: string): string {
  if (!/^postgres(?:ql)?:\/\//i.test(url)) return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has("schema")) return url;
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

class ManagedPostgresRuntime implements RuntimeClient {
  readonly fileRoot: string;
  readonly reloadSqlFiles: boolean;
  readonly sqlFiles?: Readonly<Record<string, string>>;
  readonly onQuery?: OnQueryHook;
  readonly onQueryHookError?: OnQueryHookError;
  private readonly onQueryStart?: CreateSqlClientOptions["onQueryStart"];
  private readonly onQueryTimeout?: CreateSqlClientOptions["onQueryTimeout"];
  private readonly onClientStateChange?: CreateSqlClientOptions["onClientStateChange"];
  private readonly onLifecycleHookError?: CreateSqlClientOptions["onLifecycleHookError"];
  private readonly operationTimeoutMs?: number;
  private readonly cancelGraceMs: number;
  private readonly prepare: boolean;
  private readonly typeCodecs?: RuntimeTypeCodecs;
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

  constructor(createPool: () => PostgresClient, options: CreateSqlClientOptions) {
    this.createPool = createPool;
    this.onQuery = options.onQuery;
    this.onQueryHookError = options.onQueryHookError;
    this.onQueryStart = options.onQueryStart;
    this.onQueryTimeout = options.onQueryTimeout;
    this.onClientStateChange = options.onClientStateChange;
    this.onLifecycleHookError = options.onLifecycleHookError;
    this.operationTimeoutMs = validateOptionalTimeout(options.operationTimeoutMs, "operationTimeoutMs");
    this.cancelGraceMs = validateTimeout(options.cancelGraceMs ?? 1_000, "cancelGraceMs", true);
    this.prepare = options.prepare ?? true;
    this.fileRoot = resolvedFileRoot(options.fileRoot);
    this.reloadSqlFiles = options.reloadSqlFiles ?? false;
    this.sqlFiles = options.sqlFiles;
    this.typeCodecs = options.typeCodecs;
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
    const generation = this.acceptGeneration();
    const timeoutMs = validateOptionalTimeout(
      request.options?.timeoutMs ?? this.operationTimeoutMs,
      "timeoutMs",
    );
    const operation = this.startOperation(generation, request.metadata, timeoutMs, request.options?.signal);
    const work = this.executeQuery(generation, operation, request);
    try {
      const result = await Promise.race([work, operation.interruption.promise]);
      this.lastSuccessAt = Date.now();
      this.notifyQuery({
        ...request.metadata,
        query: request.observedQuery,
        params: request.observedParams,
        durationMs: performance.now() - operation.startedAt,
        rowCount: result.count ?? result.length,
      });
      return result;
    } catch (cause) {
      const error = operation.interrupted ?? toPgError(cause) ?? cause;
      this.notifyQuery({
        ...request.metadata,
        query: request.observedQuery,
        params: request.observedParams,
        durationMs: performance.now() - operation.startedAt,
        error,
      });
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
    const timeoutMs = validateOptionalTimeout(options.timeoutMs ?? this.operationTimeoutMs, "timeoutMs");
    const metadata = { queryId: queryId("sqlx-js.transaction"), queryName: "sqlx-js.transaction" };
    const operation = this.startOperation(generation, metadata, undefined, undefined);
    const state: TransactionState = { pending: new Set(), interrupt: deferred<never>() };
    operation.transactionState = state;
    void state.interrupt.promise.catch(() => {});
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
        state.interrupt.reject(error);
      };
      state.expire = expire;
      const remainingMs = operation.deadlineAt - performance.now();
      if (remainingMs <= 0) expire();
      else timer = setTimeout(expire, remainingMs);
    }
    if (options.signal) {
      abortListener = () => {
        if (operation.interrupted || state.expired || !generation.active.has(operation.id)) return;
        const error = new QueryAbortedError(this.interruptionDetails(operation), options.signal?.reason);
        abortError = error;
        operation.interrupted = error;
        state.expired = error;
        this.cancelTransaction(state);
        operation.interruption.reject(error);
        state.interrupt.reject(error);
      };
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener("abort", abortListener, { once: true });
    }

    const begin = this.executeTransaction(generation, operation, state, fn);
    try {
      let result: R;
      try {
        result = await Promise.race([
          begin,
          operation.interruption.promise,
          state.interrupt.promise,
        ]);
      } finally {
        if (operation.deadlineAt !== undefined && performance.now() >= operation.deadlineAt) expire?.();
      }
      if (operation.interrupted) throw operation.interrupted;
      this.lastSuccessAt = Date.now();
      return result;
    } catch (cause) {
      const error = operation.interrupted ?? cause;
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
      throw toPgError(error) ?? error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (options.signal && abortListener) options.signal.removeEventListener("abort", abortListener);
      state.expire = undefined;
      state.expired ??= new Error("sqlx-js.transaction: scoped executor is no longer active");
      this.finishOperation(operation);
    }
  }

  async ready(options: DeadlineOptions = {}): Promise<void> {
    const generation = this.acceptGeneration();
    const timeoutMs = validateOptionalTimeout(options.timeoutMs ?? this.operationTimeoutMs, "timeoutMs");
    const metadata = { queryId: queryId("sqlx-js.ready"), queryName: "sqlx-js.ready" };
    const operation = this.startOperation(generation, metadata, timeoutMs, undefined);
    const work = this.bootstrap(generation, operation);
    try {
      await Promise.race([work, operation.interruption.promise]);
    } finally {
      this.finishOperation(operation);
    }
  }

  async ping(options: DeadlineOptions = {}): Promise<void> {
    const timeoutMs = validateOptionalTimeout(options.timeoutMs ?? this.operationTimeoutMs, "timeoutMs");
    await this.execute({
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
      registry: new PostgresTypeRegistry(pool, this.typeCodecs),
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
      ...(timeoutMs === undefined ? {} : { deadlineAt: startedAt + timeoutMs }),
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
    this.notifyLifecycle(this.onQueryStart, {
      ...metadata,
      generation: generation.id,
    });
    if (signal) {
      operation.abortListener = () => this.abortOperation(operation, signal.reason);
      if (signal.aborted) operation.abortListener();
      else signal.addEventListener("abort", operation.abortListener, { once: true });
    }
    return operation;
  }

  private finishOperation(operation: OperationRecord): void {
    if (operation.timer !== undefined) clearTimeout(operation.timer);
    if (operation.signal && operation.abortListener) {
      operation.signal.removeEventListener("abort", operation.abortListener);
    }
    operation.generation.active.delete(operation.id);
    if (this.activeOperationCount() === 0) {
      for (const resolve of this.activeDrainWaiters) resolve();
      this.activeDrainWaiters.clear();
    }
  }

  private async executeQuery(
    generation: PoolGeneration,
    operation: OperationRecord,
    request: RuntimeQueryRequest,
  ): Promise<RuntimeQueryResult> {
    this.checkOperation(operation);
    await this.bootstrap(generation, operation);
    this.checkOperation(operation);
    operation.phase = "execution";
    const params = this.encodeParams(generation.pool, request.params);
    this.checkOperation(operation);
    const pending = generation.pool.unsafe(
      request.query,
      params as never[],
      { prepare: this.prepare },
    ) as unknown as PendingQuery;
    this.checkOperation(operation);
    operation.pending = pending;
    operation.sent = true;
    pending.execute?.();
    const driver = Promise.resolve(pending);
    operation.driver = driver;
    generation.driverPending.add(driver);
    void driver.finally(() => {
      operation.driverSettled = true;
      generation.driverPending.delete(driver);
    }).catch(() => {});
    try {
      return await driver as RuntimeQueryResult;
    } finally {
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
      const scoped = new TransactionRuntimeClient(this, generation, tx, state);
      return await Promise.race([fn(scoped), state.interrupt.promise]);
    }) as Promise<R>;
    operation.driver = driver;
    generation.driverPending.add(driver);
    void driver.finally(() => {
      operation.driverSettled = true;
      generation.driverPending.delete(driver);
    }).catch(() => {});
    return await driver;
  }

  async executeTransactionQuery(
    generation: PoolGeneration,
    client: PostgresQueryClient,
    state: TransactionState,
    request: RuntimeQueryRequest,
  ): Promise<RuntimeQueryResult> {
    this.checkTransactionState(state);
    const timeoutMs = validateOptionalTimeout(request.options?.timeoutMs, "timeoutMs");
    const startedAt = performance.now();
    this.notifyLifecycle(this.onQueryStart, { ...request.metadata, generation: generation.id });
    this.checkTransactionState(state);
    const deadlineAt = timeoutMs === undefined ? undefined : startedAt + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
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
    if (request.options?.signal) {
      const signal = request.options.signal;
      abortListener = () => interrupt(new QueryAbortedError({
        phase: "execution",
        outcome: sent ? "unknown" : "not_sent",
        queryId: request.metadata.queryId,
        generation: generation.id,
      }, signal.reason));
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }
    let pending: PendingQuery | undefined;
    try {
      const params = this.encodeParams(generation.pool, request.params);
      this.checkTransactionState(state);
      if (deadlineAt !== undefined && performance.now() >= deadlineAt && !state.expired) {
        expire?.();
      }
      if (state.expired) throw state.expired;
      pending = client.unsafe(
        request.query,
        params as never[],
        { prepare: this.prepare },
      ) as unknown as PendingQuery;
      this.checkTransactionState(state);
      if (deadlineAt !== undefined && performance.now() >= deadlineAt && !state.expired) {
        expire?.();
      }
      if (state.expired) throw state.expired;
      state.pending.add(pending);
      sent = true;
      pending.execute?.();
      const driver = Promise.resolve(pending);
      generation.driverPending.add(driver);
      void driver.finally(() => generation.driverPending.delete(driver)).catch(() => {});
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
      this.notifyQuery({
        ...request.metadata,
        query: request.observedQuery,
        params: request.observedParams,
        durationMs: performance.now() - startedAt,
        rowCount: result.count ?? result.length,
      });
      return result;
    } catch (cause) {
      const error = state.expired ?? toPgError(cause) ?? cause;
      this.notifyQuery({
        ...request.metadata,
        query: request.observedQuery,
        params: request.observedParams,
        durationMs: performance.now() - startedAt,
        error,
      });
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (request.options?.signal && abortListener) {
        request.options.signal.removeEventListener("abort", abortListener);
      }
      if (pending) state.pending.delete(pending);
    }
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

  private checkTransactionState(state: TransactionState): void {
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
    for (const operation of generation.active.values()) {
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

  private async retireGeneration(generation: PoolGeneration): Promise<void> {
    const pending = [...generation.driverPending];
    if (pending.length > 0) {
      await waitAtMost(Promise.allSettled(pending), this.cancelGraceMs);
    }
    await generation.pool.end({ timeout: 0 });
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
        operation.transactionState.interrupt.reject(error);
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

  private encodeParam(client: PostgresClient, param: unknown): unknown {
    const kind = parameterKind(param);
    if (kind === "json") return client.json((param as JsonParameter).value as never);
    if (kind === "array") {
      const value = [...(param as PgArrayParameter).value];
      const hasJson = value.some((item) => parameterKind(item) === "json");
      if (hasJson && value.every((item) => item === null || parameterKind(item) === "json")) {
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

  private notifyQuery(event: Parameters<OnQueryHook>[0]): void {
    try {
      const pending = this.onQuery?.(event);
      if (pending) void pending.catch((error) => this.notifyQueryError(error, event));
    } catch (error) {
      this.notifyQueryError(error, event);
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
    try {
      const pending = hook?.(event);
      if (pending) void pending.catch((error) => this.notifyLifecycleError(error, event));
    } catch (error) {
      this.notifyLifecycleError(error, event);
    }
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
        await generation.pool.end({ timeout: remainingMs / 1_000 });
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

class TransactionRuntimeClient implements RuntimeClient {
  readonly fileRoot: string;
  readonly reloadSqlFiles: boolean;
  readonly sqlFiles?: Readonly<Record<string, string>>;

  constructor(
    private readonly runtime: ManagedPostgresRuntime,
    private readonly generation: PoolGeneration,
    private readonly client: PostgresQueryClient,
    private readonly state: TransactionState,
  ) {
    this.fileRoot = runtime.fileRoot;
    this.reloadSqlFiles = runtime.reloadSqlFiles;
    this.sqlFiles = runtime.sqlFiles;
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
    return await this.runtime.executeTransactionQuery(this.generation, this.client, this.state, request);
  }

  async transaction<R>(): Promise<R> {
    throw new Error("sqlx-js.transaction: nested transactions are not supported");
  }

  async close(): Promise<void> {}
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

const STRING_ARRAY_ELEMENT_OIDS = new Set([
  18,
  19,
  25,
  27,
  28,
  29,
  142,
  600,
  601,
  602,
  603,
  604,
  628,
  650,
  718,
  774,
  790,
  829,
  869,
  1042,
  1043,
  1083,
  1186,
  1266,
  1560,
  1562,
  1700,
  2950,
  2205,
  2206,
  3220,
  3614,
  3615,
  3904,
  3906,
  3908,
  3910,
  3912,
  3926,
  4451,
  4536,
]);
const JSON_ELEMENT_OIDS = new Set([114, 3802]);

function parseSimpleArrayElement(oid: number): ((value: string) => unknown) | undefined {
  switch (oid) {
    case 16:
      return (value) => value === "t";
    case 20:
      return (value) => BigInt(value);
    case 21:
    case 23:
    case 26:
    case 700:
    case 701:
      return (value) => Number(value);
    default:
      return STRING_ARRAY_ELEMENT_OIDS.has(oid) ? (value) => value : undefined;
  }
}

function postgresTypes(): Record<string, postgres.PostgresType> {
  const types: Record<string, postgres.PostgresType> = { bigint: postgres.BigInt };
  for (const oid of builtinArrayOids()) {
    const elementOid = arrayElementOid(oid);
    if (elementOid === undefined) continue;
    if (JSON_ELEMENT_OIDS.has(elementOid)) {
      types[`array_${oid}`] = {
        to: oid,
        from: [oid],
        serialize: (value) => Array.isArray(value) ? encodePgArrayLiteral(value) : String(value),
        parse: (value) => parsePgArrayLiteral(value, JSON.parse),
      };
      continue;
    }
    const parseElement = parseSimpleArrayElement(elementOid);
    if (!parseElement) continue;
    types[`array_${oid}`] = {
      to: oid,
      from: [oid],
      serialize: (value) => Array.isArray(value) ? encodePgArrayLiteral(value) : String(value),
      parse: (value) => parsePgArrayLiteral(value, parseElement),
    };
  }
  return types;
}

export function createClient(url = process.env.DATABASE_URL, options: CreateClientOptions = {}): PostgresClient {
  if (!url) throw new Error("sqlx-js: DATABASE_URL is not set");
  const { statementTimeoutMs, ...pgOptions } = options;
  if (statementTimeoutMs !== undefined) validateTimeout(statementTimeoutMs, "statementTimeoutMs", true);
  const connection = statementTimeoutMs !== undefined
    ? { ...(pgOptions.connection ?? {}), statement_timeout: statementTimeoutMs }
    : pgOptions.connection;
  const client = postgres(normalizeRuntimeDatabaseUrl(url), {
    ...pgOptions,
    ...(connection ? { connection } : {}),
    types: { ...postgresTypes(), ...(pgOptions.types ?? {}) },
  }) as PostgresClient;
  return client;
}

function postgresClientOptions(options: CreateSqlClientOptions): CreateClientOptions {
  const {
    onQuery: _onQuery,
    onQueryHookError: _onQueryHookError,
    onQueryStart: _onQueryStart,
    onQueryTimeout: _onQueryTimeout,
    onClientStateChange: _onClientStateChange,
    onLifecycleHookError: _onLifecycleHookError,
    operationTimeoutMs: _operationTimeoutMs,
    cancelGraceMs: _cancelGraceMs,
    fileRoot: _fileRoot,
    reloadSqlFiles: _reloadSqlFiles,
    sqlFiles: _sqlFiles,
    typeCodecs: _typeCodecs,
    ...clientOptions
  } = options;
  return clientOptions;
}

function createManagedClient(url: string | undefined, options: CreateSqlClientOptions): ManagedPostgresRuntime {
  if (!url) throw new Error("sqlx-js: DATABASE_URL is not set");
  const clientOptions = postgresClientOptions(options);
  return new ManagedPostgresRuntime(() => createClient(url, clientOptions), options);
}

function createDefaultClient(): ManagedPostgresRuntime {
  return createManagedClient(process.env.DATABASE_URL, {});
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
  createManagedClient(createPool: () => PostgresClient, options: CreateSqlClientOptions = {}) {
    return managedClientApi(new ManagedPostgresRuntime(createPool, options));
  },
};

const runtime = createSqlRuntime(getRuntimeClient);

export const sql = runtime.sql;
export const unsafe = runtime.unsafe;
