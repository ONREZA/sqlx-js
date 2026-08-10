import {
  encodePgArrayLiteral,
  encodePgArrayLiteralElements,
  parameterKind,
  parsePgArrayLiteral,
  ResultDecodeError,
  type RuntimeQueryResult,
} from "../runtime";
import {
  parseJsonResult,
  stringifyJsonParameter,
  type SqlxJson,
} from "../json-value";
import { assertNoDateSqlValue, isDateValue } from "../sql-value";
import { queryId } from "../query-id";
import { arrayElementOid, builtinArrayOids } from "./oids";
import {
  resolveTemporalPolicy,
  type TemporalPolicyOptions,
} from "../temporal";
import {
  isTemporalValue,
  resolveTemporalApi,
  type TemporalApi,
} from "../temporal-api";
import {
  postgresTemporalParsers,
  postgresTemporalSerializers,
  TemporalInfinityError,
} from "./temporal-codecs";
import {
  ConnectionLostError,
  decodeTextRange,
  effectiveConnectTimeoutMs,
  parseDatabaseUrl,
  PgClient,
  type PgNotice,
  type ConnConfig,
  type FieldDescription,
} from "./wire";

export type PostgresType<T = unknown> = {
  to: number;
  from: number | readonly number[];
  parse(value: string): T;
  serialize(value: T): unknown;
};

export type PostgresOptions = {
  max?: number;
  password?: string | (() => string | Promise<string>);
  connectTimeoutMs?: number;
  keepAliveMs?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  startupOptions?: string;
  role?: string;
  onNotice?: (notice: PgNotice) => void | Promise<void>;
  temporal?: TemporalPolicyOptions;
  temporalApi?: TemporalApi;
  types?: Readonly<Record<string, PostgresType>>;
};

type ParsedPostgresOptions = {
  max: number;
  connectTimeoutMs?: number;
  keepAliveMs?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  startupOptions?: string;
  role?: string;
  temporalApi: TemporalApi;
  types: Readonly<Record<string, PostgresType>>;
  parsers: Record<number, (value: string) => unknown>;
  serializers: Record<number, (value: unknown) => unknown>;
};

export type PostgresResult<Row extends Record<string, unknown> = Record<string, unknown>> =
  Row[] & RuntimeQueryResult;

export type PostgresPendingQuery<Row extends Record<string, unknown> = Record<string, unknown>> =
  PromiseLike<PostgresResult<Row>> & {
    readonly timing?: PostgresQueryTiming;
    execute(): PostgresPendingQuery<Row>;
    cancel(): Promise<void> | void;
    values(): Promise<unknown[][]>;
  };

export type PostgresQueryTiming = {
  acquireDurationMs?: number;
  executionDurationMs?: number;
  connectionCreated?: boolean;
};

export type PostgresQueryClient = {
  unsafe<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): PostgresPendingQuery<Row>;
  typed<T>(value: T, oid: number): PostgresParameter<T>;
  array<T>(value: readonly T[], arrayOid?: number): PostgresParameter<readonly T[]>;
  json<T>(value: SqlxJson<T>): PostgresParameter<SqlxJson<T>>;
};

export type PostgresClient = PostgresQueryClient & {
  begin<T>(fn: (client: PostgresQueryClient) => T | Promise<T>): Promise<T>;
  begin<T>(options: string, fn: (client: PostgresQueryClient) => T | Promise<T>): Promise<T>;
  end(): Promise<void>;
};

export const EXECUTE_KNOWN_PARAMS = Symbol("sqlx-js.postgres.execute-known-params");

// Pool slots and OID codecs share one mutable per-generation parser/serializer
// contract; splitting them would duplicate the dispatch boundary used by both paths.
export type KnownParamsQueryClient = {
  [EXECUTE_KNOWN_PARAMS]<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameterOids: readonly number[],
    params: unknown[],
  ): PostgresPendingQuery<Row>;
};

const PARAMETER = Symbol("sqlx-js.postgres.parameter");
const RESULT_VALUES = Symbol("sqlx-js.postgres.result-values");

export type PostgresParameter<T = unknown> = {
  readonly [PARAMETER]: true;
  readonly value: T;
  readonly oid: number;
  readonly source: "typed" | "array" | "json";
};

type ConnectionLease = {
  slot: ConnectionSlot;
  release(): void;
};

type AcquireWaiter = {
  resolve(lease: ConnectionLease): void;
  reject(error: unknown): void;
};

const QUERY_STARTED_AT = Symbol("sqlx-js.query-started-at");
const QUERY_MEASURES_ACQUIRE = Symbol("sqlx-js.query-measures-acquire");
const QUERY_DISPATCHED_AT = Symbol("sqlx-js.query-dispatched-at");
type MutablePostgresQueryTiming = PostgresQueryTiming & {
  [QUERY_STARTED_AT]?: number;
  [QUERY_MEASURES_ACQUIRE]?: boolean;
  [QUERY_DISPATCHED_AT]?: number;
};

export function queryDispatchedAt(timing: PostgresQueryTiming | undefined): number | undefined {
  return (timing as MutablePostgresQueryTiming | undefined)?.[QUERY_DISPATCHED_AT];
}

const DEFAULT_MAX_CONNECTIONS = 10;
const MAX_MILLISECONDS = 2_147_483_647;

function optionalMilliseconds(
  value: number | undefined,
  name: string,
  allowZero: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_MILLISECONDS) {
    throw new Error(
      `sqlx-js: ${name} must be an integer from ${minimum} to ${MAX_MILLISECONDS}, got ${String(value)}`,
    );
  }
  return value;
}

export function createPostgresClient(url: string, options: PostgresOptions = {}): PostgresClient {
  return new PostgresPool(url, options);
}

class PostgresPool implements PostgresClient {
  readonly options: ParsedPostgresOptions;
  private readonly config: ConnConfig;
  private readonly slots = new Set<ConnectionSlot>();
  private readonly idle: ConnectionSlot[] = [];
  private readonly idleTimers = new Map<ConnectionSlot, ReturnType<typeof setTimeout>>();
  private readonly waiters: AcquireWaiter[] = [];
  private readonly passwordProvider: (() => string | Promise<string>) | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(url: string, options: PostgresOptions) {
    const max = options.max ?? DEFAULT_MAX_CONNECTIONS;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error(`sqlx-js: max must be a positive integer, got ${String(max)}`);
    }
    const connectTimeoutMs = optionalMilliseconds(options.connectTimeoutMs, "connectTimeoutMs", false);
    const keepAliveMs = optionalMilliseconds(options.keepAliveMs, "keepAliveMs", true);
    const idleTimeoutMs = optionalMilliseconds(options.idleTimeoutMs, "idleTimeoutMs", true);
    const maxLifetimeMs = optionalMilliseconds(options.maxLifetimeMs, "maxLifetimeMs", true);
    const statementTimeoutMs = optionalMilliseconds(options.statementTimeoutMs, "statementTimeoutMs", true);
    const config = parseDatabaseUrl(url);
    if (typeof options.password === "string") {
      config.password = options.password;
      config.passwordSource = "option";
    }
    this.passwordProvider = typeof options.password === "function" ? options.password : undefined;
    if (connectTimeoutMs !== undefined) config.connectTimeoutMs = connectTimeoutMs;
    if (keepAliveMs !== undefined) config.keepAliveMs = keepAliveMs;
    if (options.applicationName !== undefined) config.applicationName = options.applicationName;
    if (options.startupOptions !== undefined) config.startupOptions = options.startupOptions;
    if (statementTimeoutMs !== undefined) config.statementTimeoutMs = statementTimeoutMs;
    if (options.role !== undefined) {
      config.startupParameters = { ...(config.startupParameters ?? {}), role: options.role };
    }
    if (options.onNotice !== undefined) config.onNotice = options.onNotice;
    resolveTemporalPolicy(options.temporal);
    const temporalApi = resolveTemporalApi(options.temporalApi);
    const types = options.types ?? {};
    this.options = {
      max,
      ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
      ...(keepAliveMs === undefined ? {} : { keepAliveMs }),
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
      ...(maxLifetimeMs === undefined ? {} : { maxLifetimeMs }),
      ...(statementTimeoutMs === undefined ? {} : { statementTimeoutMs }),
      ...(options.applicationName === undefined ? {} : { applicationName: options.applicationName }),
      ...(options.startupOptions === undefined ? {} : { startupOptions: options.startupOptions }),
      ...(options.role === undefined ? {} : { role: options.role }),
      temporalApi,
      types,
      parsers: builtinParsers(temporalApi),
      serializers: builtinSerializers(temporalApi),
    };
    installNumericTypes(this.options, types);
    enforceBuiltinContracts(this.options);
    this.config = config;
  }

  unsafe<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): PostgresPendingQuery<Row> {
    return new DriverQuery<Row>(
      async (setCancel, isCancelled, timing) => {
        timing[QUERY_MEASURES_ACQUIRE] = true;
        const lease = await this.acquire(setCancel, isCancelled);
        try {
          return await lease.slot.query(query, params, setCancel, isCancelled, true, undefined, timing);
        } finally {
          lease.release();
        }
      },
    );
  }

  [EXECUTE_KNOWN_PARAMS]<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameterOids: readonly number[],
    params: unknown[],
  ): PostgresPendingQuery<Row> {
    return new DriverQuery<Row>(
      async (setCancel, isCancelled, timing) => {
        timing[QUERY_MEASURES_ACQUIRE] = true;
        const lease = await this.acquire(setCancel, isCancelled);
        try {
          return await lease.slot.query(query, params, setCancel, isCancelled, true, parameterOids, timing);
        } finally {
          lease.release();
        }
      },
    );
  }

  typed<T>(value: T, oid: number): PostgresParameter<T> {
    return { [PARAMETER]: true, value, oid, source: "typed" };
  }

  array<T>(value: readonly T[], arrayOid = 0): PostgresParameter<readonly T[]> {
    return { [PARAMETER]: true, value, oid: arrayOid, source: "array" };
  }

  json<T>(value: SqlxJson<T>): PostgresParameter<SqlxJson<T>> {
    return { [PARAMETER]: true, value, oid: 3802, source: "json" };
  }

  async begin<T>(
    options: string | ((client: PostgresQueryClient) => T | Promise<T>),
    fn?: (client: PostgresQueryClient) => T | Promise<T>,
  ): Promise<T> {
    const callback = typeof options === "function" ? options : fn;
    const transactionOptions = typeof options === "string" ? options : "";
    if (!callback) throw new Error("sqlx-js: transaction callback is required");
    const lease = await this.acquire();
    const setup = new ReservedClient(lease.slot, true);
    const client = new ReservedClient(lease.slot, false);
    try {
      await setup.unsafe(`BEGIN${transactionOptions ? ` ${transactionOptions}` : ""}`);
      try {
        const result = await callback(client);
        const transactionStatus = lease.slot.transactionStatus();
        if (transactionStatus !== "T" && transactionStatus !== "E") {
          throw new Error("sqlx-js: transaction ended before its callback completed");
        }
        const committed = await client.unsafe("COMMIT");
        if (committed.command !== "COMMIT") {
          throw new Error(`sqlx-js: PostgreSQL returned ${committed.command ?? "no command"} instead of COMMIT`);
        }
        return result;
      } catch (error) {
        try {
          await client.unsafe("ROLLBACK");
        } catch {}
        throw error;
      }
    } finally {
      client.deactivate();
      lease.release();
    }
  }

  end(): Promise<void> {
    return this.closePromise ??= this.close();
  }

  private async close(): Promise<void> {
    this.closing = true;
    const error = new Error("sqlx-js: PostgreSQL pool is closed");
    while (this.waiters.length) this.waiters.shift()!.reject(error);
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    await Promise.all([...this.slots].map((slot) => slot.destroy(error)));
    this.idle.length = 0;
    this.slots.clear();
  }

  private async acquire(
    setCancel?: (cancel: () => void) => void,
    isCancelled?: () => boolean,
  ): Promise<ConnectionLease> {
    if (this.closing) throw new Error("sqlx-js: PostgreSQL pool is closed");
    if (isCancelled?.()) throw queryCancelledBeforeDispatch();
    const idle = this.idle.pop();
    if (idle) {
      this.clearIdleTimer(idle);
      return this.lease(idle);
    }
    if (this.slots.size < this.options.max) {
      const slot = new ConnectionSlot(this.config, this.options, this.passwordProvider);
      this.slots.add(slot);
      return this.lease(slot);
    }
    return await new Promise<ConnectionLease>((resolve, reject) => {
      const waiter: AcquireWaiter = { resolve, reject };
      this.waiters.push(waiter);
      setCancel?.(() => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        reject(queryCancelledBeforeDispatch());
      });
    });
  }

  private lease(slot: ConnectionSlot): ConnectionLease {
    slot.ref();
    let released = false;
    return {
      slot,
      release: () => {
        if (released) return;
        released = true;
        if (this.closing) {
          void slot.destroy(new Error("sqlx-js: PostgreSQL pool is closed"));
          return;
        }
        if (slot.lifetimeExpired(this.options.maxLifetimeMs)) {
          this.retire(slot, new Error("sqlx-js: PostgreSQL connection reached maxLifetimeMs"));
          return;
        }
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(this.lease(slot));
        else this.park(slot);
      },
    };
  }

  private park(slot: ConnectionSlot): void {
    slot.unref();
    this.idle.push(slot);
    const delays = [
      this.options.idleTimeoutMs && this.options.idleTimeoutMs > 0
        ? this.options.idleTimeoutMs
        : undefined,
      slot.lifetimeRemaining(this.options.maxLifetimeMs),
    ].filter((value): value is number => value !== undefined);
    if (delays.length === 0) return;
    const timer = setTimeout(() => {
      this.retire(slot, new Error("sqlx-js: PostgreSQL idle connection retired"));
    }, Math.max(0, Math.min(...delays)));
    timer.unref?.();
    this.idleTimers.set(slot, timer);
  }

  private clearIdleTimer(slot: ConnectionSlot): void {
    const timer = this.idleTimers.get(slot);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(slot);
  }

  private retire(slot: ConnectionSlot, reason: Error): void {
    const index = this.idle.lastIndexOf(slot);
    if (index >= 0) this.idle.splice(index, 1);
    this.clearIdleTimer(slot);
    if (!this.slots.delete(slot)) return;
    void slot.destroy(reason);
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (this.closing) {
      waiter.reject(new Error("sqlx-js: PostgreSQL pool is closed"));
      return;
    }
    const replacement = new ConnectionSlot(this.config, this.options, this.passwordProvider);
    this.slots.add(replacement);
    waiter.resolve(this.lease(replacement));
  }
}

class ReservedClient implements PostgresQueryClient {
  private active = true;

  constructor(
    private readonly slot: ConnectionSlot,
    private readonly allowReconnect: boolean,
  ) {}

  unsafe<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): PostgresPendingQuery<Row> {
    return new DriverQuery<Row>(
      (setCancel, isCancelled, timing) => {
        if (!this.active) {
          throw new Error("sqlx-js: transaction client cannot be used after the transaction ends");
        }
        return this.slot.query(query, params, setCancel, isCancelled, this.allowReconnect, undefined, timing);
      },
    );
  }

  [EXECUTE_KNOWN_PARAMS]<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameterOids: readonly number[],
    params: unknown[],
  ): PostgresPendingQuery<Row> {
    return new DriverQuery<Row>(
      (setCancel, isCancelled, timing) => {
        if (!this.active) {
          throw new Error("sqlx-js: transaction client cannot be used after the transaction ends");
        }
        return this.slot.query(
          query,
          params,
          setCancel,
          isCancelled,
          this.allowReconnect,
          parameterOids,
          timing,
        );
      },
    );
  }

  typed<T>(value: T, oid: number): PostgresParameter<T> {
    return { [PARAMETER]: true, value, oid, source: "typed" };
  }

  array<T>(value: readonly T[], arrayOid = 0): PostgresParameter<readonly T[]> {
    return { [PARAMETER]: true, value, oid: arrayOid, source: "array" };
  }

  json<T>(value: SqlxJson<T>): PostgresParameter<SqlxJson<T>> {
    return { [PARAMETER]: true, value, oid: 3802, source: "json" };
  }

  deactivate(): void {
    this.active = false;
  }
}

class DriverQuery<Row extends Record<string, unknown>> implements PostgresPendingQuery<Row> {
  readonly timing: MutablePostgresQueryTiming = {};
  private promise: Promise<PostgresResult<Row>> | undefined;
  private cancelCurrent: (() => Promise<void> | void) | undefined;
  private cancelResult: Promise<void> | void = undefined;
  private cancelled = false;

  constructor(
    private readonly start: (
      setCancel: (cancel: () => Promise<void> | void) => void,
      isCancelled: () => boolean,
      timing: MutablePostgresQueryTiming,
    ) => Promise<PostgresResult<Row>>,
  ) {}

  execute(): this {
    if (!this.promise) {
      let started: Promise<PostgresResult<Row>>;
      this.timing[QUERY_STARTED_AT] = performance.now();
      try {
        started = this.start(
          (cancel) => {
            this.cancelCurrent = cancel;
            if (this.cancelled) this.cancelResult = cancel();
          },
          () => this.cancelled,
          this.timing,
        );
      } catch (error) {
        started = Promise.reject(error);
      }
      this.promise = started.finally(() => {
        if (this.timing[QUERY_MEASURES_ACQUIRE]) {
          this.timing.acquireDurationMs ??= performance.now() - this.timing[QUERY_STARTED_AT]!;
        }
        delete this.timing[QUERY_STARTED_AT];
        delete this.timing[QUERY_MEASURES_ACQUIRE];
        delete this.timing[QUERY_DISPATCHED_AT];
        this.cancelCurrent = undefined;
      });
    }
    return this;
  }

  cancel(): Promise<void> | void {
    if (this.cancelled) return this.cancelResult;
    this.cancelled = true;
    this.cancelResult = this.cancelCurrent?.();
    return this.cancelResult;
  }

  async values(): Promise<unknown[][]> {
    this.execute();
    const result = await this.promise!;
    return (result as PostgresResult<Row> & { [RESULT_VALUES]?: unknown[][] })[RESULT_VALUES]
      ?? result.map((row) => Object.values(row));
  }

  then<TResult1 = PostgresResult<Row>, TResult2 = never>(
    onfulfilled?: ((value: PostgresResult<Row>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().promise!.then(onfulfilled, onrejected);
  }
}

class ConnectionSlot {
  private client: PgClient | undefined;
  private connectedAt: number | undefined;
  private tail = Promise.resolve();
  private readonly abort = new AbortController();

  constructor(
    private readonly config: ConnConfig,
    private readonly options: ParsedPostgresOptions,
    private readonly passwordProvider?: () => string | Promise<string>,
  ) {}

  query<Row extends Record<string, unknown>>(
    query: string,
    params: unknown[],
    setCancel: (cancel: () => Promise<void> | void) => void,
    isCancelled: () => boolean,
    allowReconnect: boolean,
    parameterOids?: readonly number[],
    timing?: MutablePostgresQueryTiming,
  ): Promise<PostgresResult<Row>> {
    const result = this.tail.then(async () => {
      if (isCancelled()) throw queryCancelledBeforeDispatch();
      if (params.some((value) => value === undefined)) {
        throw new Error("sqlx-js: undefined is not a PostgreSQL value; pass null explicitly");
      }
      if (parameterOids && parameterOids.length !== params.length) {
        throw new Error(
          `sqlx-js: expected ${parameterOids.length} parameters, received ${params.length}`,
        );
      }
      let client = this.client;
      let connectionCreated = false;
      if (!client || client.isClosed) {
        const startupAbort = new AbortController();
        setCancel(() => startupAbort.abort(queryCancelledBeforeDispatch()));
        client = await this.readyClient(allowReconnect, startupAbort.signal);
        connectionCreated = true;
      }
      setCancel(() => client.cancel());
      if (isCancelled()) {
        const error = queryCancelledBeforeDispatch();
        client.destroy(error);
        throw error;
      }
      let executionStartedAt: number | undefined;
      try {
        const acquiredAt = performance.now();
        if (timing?.[QUERY_MEASURES_ACQUIRE] && timing[QUERY_STARTED_AT] !== undefined) {
          timing.acquireDurationMs = acquiredAt - timing[QUERY_STARTED_AT];
          timing.connectionCreated = connectionCreated;
        }
        const values: unknown[][] = [];
        const materializeRow = (payload: Uint8Array, fields: readonly FieldDescription[]) =>
          decodeDataRow<Row>(payload, fields, this.options.parsers, values, query);
        let raw;
        if (params.length === 0) {
          executionStartedAt = performance.now();
          if (timing) timing[QUERY_DISPATCHED_AT] = executionStartedAt;
          raw = await client.execParamsText(query, [], materializeRow);
        } else if (parameterOids) {
          const encoded = params.map((value, index) =>
            encodeParameter(value, this.options, parameterOids[index])
          );
          if (isCancelled()) {
            const error = queryCancelledBeforeDispatch();
            client.destroy(error);
            throw error;
          }
          executionStartedAt = performance.now();
          if (timing) timing[QUERY_DISPATCHED_AT] = executionStartedAt;
          raw = await client.execKnownParamsText(query, parameterOids, encoded, materializeRow);
        } else {
          executionStartedAt = performance.now();
          if (timing) timing[QUERY_DISPATCHED_AT] = executionStartedAt;
          raw = await client.execParamsTextWithSerializer(query, (inferredOids) => {
            const encoded = params.map((value, index) =>
              encodeParameter(value, this.options, inferredOids[index])
            );
            if (isCancelled()) {
              const error = queryCancelledBeforeDispatch();
              client.destroy(error);
              throw error;
            }
            return encoded;
          }, materializeRow);
        }
        setCancel(() => {});
        return resultWithMetadata(raw.rows, values, raw.tag);
      } catch (error) {
        if (error instanceof ConnectionLostError || client.isClosed) {
          this.client = undefined;
          this.connectedAt = undefined;
          client.destroy(error instanceof Error ? error : undefined);
        }
        throw error;
      } finally {
        if (timing && executionStartedAt !== undefined) {
          timing.executionDurationMs = performance.now() - executionStartedAt;
        }
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async destroy(reason: Error): Promise<void> {
    if (!this.abort.signal.aborted) this.abort.abort(reason);
    const client = this.client;
    this.client = undefined;
    this.connectedAt = undefined;
    client?.destroy(reason);
    await this.tail;
  }

  ref(): void {
    this.client?.ref();
  }

  unref(): void {
    this.client?.unref();
  }

  lifetimeExpired(maxLifetimeMs: number | undefined): boolean {
    return this.lifetimeRemaining(maxLifetimeMs) === 0;
  }

  transactionStatus(): string | undefined {
    return this.client?.transactionStatus;
  }

  lifetimeRemaining(maxLifetimeMs: number | undefined): number | undefined {
    if (!maxLifetimeMs || this.connectedAt === undefined) return undefined;
    return Math.max(0, maxLifetimeMs - (Date.now() - this.connectedAt));
  }

  private async readyClient(allowReconnect: boolean, operationSignal: AbortSignal): Promise<PgClient> {
    if (this.client && !this.client.isClosed) return this.client;
    const timeoutMs = effectiveConnectTimeoutMs(this.config);
    const connectHost = this.config.hostaddr ?? this.config.host;
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new Error(
        `sqlx-js: connect timeout to ${connectHost}:${this.config.port} after ${timeoutMs}ms `
        + "(includes password + TCP + TLS + authentication)",
      ));
    }, timeoutMs);
    const signal = AbortSignal.any([
      this.abort.signal,
      operationSignal,
      deadline.signal,
    ]);
    try {
      if (signal.aborted) throw abortReason(signal);
      if (!allowReconnect) {
        throw new ConnectionLostError(new Error("transaction connection is closed"));
      }
      const config = { ...this.config };
      if (this.passwordProvider) {
        const password = await abortable(this.passwordProvider(), signal);
        if (typeof password !== "string") {
          throw new Error("sqlx-js: password provider must resolve to a string");
        }
        config.password = password;
        config.passwordSource = "option";
      }
      if (signal.aborted) throw abortReason(signal);
      const client = new PgClient(config);
      this.client = client;
      const onAbort = () => client.destroy(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await client.connect();
        this.connectedAt = Date.now();
        return client;
      } catch (error) {
        if (this.client === client) this.client = undefined;
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function queryCancelledBeforeDispatch(): Error {
  return new Error("sqlx-js: query cancelled before dispatch");
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("sqlx-js: PostgreSQL connection slot is closed");
}

async function abortable<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(value), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function installNumericTypes(
  options: ParsedPostgresOptions,
  types: Readonly<Record<string, PostgresType>>,
): void {
  for (const type of Object.values(types)) {
    const from = Array.isArray(type.from) ? type.from : [type.from];
    for (const oid of from) options.parsers[oid] = type.parse;
    options.serializers[type.to] = type.serialize as (value: unknown) => unknown;
  }
}

function builtinParsers(temporalApi: TemporalApi): Record<number, (value: string) => unknown> {
  const parsers: Record<number, (value: string) => unknown> = {
    16: parseBoolean,
    17: parseBytea,
    20: BigInt,
    21: Number,
    23: Number,
    26: Number,
    114: (value) => parseJsonResult(value, temporalApi),
    700: Number,
    701: Number,
    ...postgresTemporalParsers(temporalApi),
    2278: () => undefined,
    3802: (value) => parseJsonResult(value, temporalApi),
    5069: BigInt,
  };
  for (const oid of builtinArrayOids()) {
    const elementOid = arrayElementOid(oid);
    if (elementOid === undefined) continue;
    if (elementOid === 21 || elementOid === 23 || elementOid === 26) {
      parsers[oid] = parseIntegerArray;
      continue;
    }
    parsers[oid] = (value) => parsePgArrayLiteral(value, parsers[elementOid] ?? String);
  }
  return parsers;
}

function builtinSerializers(temporalApi: TemporalApi): Record<number, (value: unknown) => unknown> {
  const serializers: Record<number, (value: unknown) => unknown> = {
    16: serializeBoolean,
    17: serializeBytea,
    20: String,
    21: String,
    23: String,
    26: String,
    114: serializeJson,
    700: String,
    701: String,
    ...postgresTemporalSerializers(temporalApi),
    3802: serializeJson,
    5069: String,
  };
  for (const oid of builtinArrayOids()) {
    const elementOid = arrayElementOid(oid);
    if (elementOid === undefined) continue;
    serializers[oid] = (value) => {
      if (!Array.isArray(value)) throw new Error(`sqlx-js: PostgreSQL type ${oid} requires an array`);
      const serialize = serializers[elementOid] ?? serializeUnknown;
      const encode = elementOid === 114 || elementOid === 3802
        ? encodePgArrayLiteralElements
        : encodePgArrayLiteral;
      return encode(value, (item) => String(serialize(item)));
    };
  }
  return serializers;
}

function enforceBuiltinContracts(options: ParsedPostgresOptions): void {
  const parsers = builtinParsers(options.temporalApi);
  const serializers = builtinSerializers(options.temporalApi);
  for (const oid of [114, 199, 1082, 1083, 1114, 1184, 1115, 1182, 1183, 1185, 3802, 3807]) {
    options.parsers[oid] = parsers[oid]!;
    options.serializers[oid] = serializers[oid]!;
  }
}

function encodeParameter(
  value: unknown,
  options: ParsedPostgresOptions,
  inferredOid?: number,
): string | null {
  assertNoDateSqlValue(value, "PostgreSQL parameter");
  if (value === null) return null;
  if (value === undefined) {
    throw new Error("sqlx-js: undefined is not a PostgreSQL value; pass null explicitly");
  }
  if (isPostgresParameter(value)) {
    const oid = value.oid || inferredOid || 0;
    if (Array.isArray(value.value)) {
      const elementOid = arrayElementOid(oid);
      if (elementOid !== undefined) {
        const encode = elementOid === 114 || elementOid === 3802
          ? encodePgArrayLiteralElements
          : encodePgArrayLiteral;
        return encode(
          [...value.value],
          (item) => serializeArrayElement(item, elementOid, options),
        );
      }
      const serializeArray = options.serializers[oid];
      if (serializeArray) return String(serializeArray(value.value));
      return encodePgArrayLiteral([...value.value], (item) => String(serializeUnknown(item)));
    }
    const serialize = options.serializers[oid];
    if (serialize) return String(serialize(value.value));
    return String(serializeUnknown(value.value));
  }
  if (inferredOid === 114 || inferredOid === 3802) {
    throw new Error("sqlx-js: PostgreSQL JSON values require a SqlxJson document created by sql.json(...)");
  }
  if (Array.isArray(value)) {
    const serialize = inferredOid === undefined ? undefined : options.serializers[inferredOid];
    if (
      inferredOid !== undefined
      && arrayElementOid(inferredOid) === undefined
      && inferredOid !== 114
      && inferredOid !== 3802
      && serialize
    ) {
      return String(serialize(value));
    }
    throw new Error("sqlx-js: PostgreSQL arrays require sql.array(...)");
  }
  if (typeof value === "object" && !(value instanceof Uint8Array)) {
    const serialize = inferredOid === undefined || inferredOid === 114 || inferredOid === 3802
      ? undefined
      : options.serializers[inferredOid];
    if (!serialize) throw new Error("sqlx-js: PostgreSQL JSON values require sql.json(...)");
    return String(serialize(value));
  }
  const serialize = inferredOid === undefined || inferredOid === 114 || inferredOid === 3802
    ? undefined
    : options.serializers[inferredOid];
  return String(serialize ? serialize(value) : serializeUnknown(value));
}

function serializeArrayElement(
  value: unknown,
  elementOid: number,
  options: ParsedPostgresOptions,
): string {
  if (parameterKind(value) === "json") {
    return serializeJson(value as SqlxJson);
  }
  if (isPostgresParameter(value)) {
    const oid = value.oid || elementOid;
    const serialize = options.serializers[oid];
    return String(serialize ? serialize(value.value) : serializeUnknown(value.value));
  }
  const serialize = options.serializers[elementOid];
  return String(serialize ? serialize(value) : serializeUnknown(value));
}

function serializeUnknown(value: unknown): unknown {
  if (isDateValue(value)) {
    throw new Error("sqlx-js: JavaScript Date is not supported; use the matching Temporal type");
  }
  if (isTemporalValue(value)) {
    throw new Error("sqlx-js: Temporal values require a known PostgreSQL temporal type");
  }
  if (value instanceof Uint8Array) return serializeBytea(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") return String(value);
  throw new Error(`sqlx-js: unsupported PostgreSQL parameter value ${Object.prototype.toString.call(value)}`);
}

function serializeBoolean(value: unknown): string {
  if (typeof value !== "boolean") throw new Error("sqlx-js: boolean value must be true or false");
  return value ? "true" : "false";
}

function serializeJson(value: unknown): string {
  return stringifyJsonParameter(value as SqlxJson);
}

function isPostgresParameter(value: unknown): value is PostgresParameter {
  return !!value && typeof value === "object" && (value as Partial<PostgresParameter>)[PARAMETER] === true;
}

function decodeDataRow<Row extends Record<string, unknown>>(
  payload: Uint8Array,
  fields: readonly FieldDescription[],
  parsers: Record<number, (value: string) => unknown>,
  values: unknown[][],
  query: string,
): Row {
  const columnCount = (payload[0]! << 8) | payload[1]!;
  const decoded = new Array<unknown>(columnCount);
  const row = {} as Row;
  let offset = 2;
  for (let index = 0; index < columnCount; index++) {
    const length = (
      (payload[offset]! << 24)
      | (payload[offset + 1]! << 16)
      | (payload[offset + 2]! << 8)
      | payload[offset + 3]!
    ) | 0;
    offset += 4;
    const field = fields[index]!;
    let value: unknown = null;
    if (length !== -1) {
      try {
        const parser = parsers[field.typeOid];
        if (parser === parseBoolean) {
          value = payload[offset] === 0x74;
        } else if (parser === parseBytea && field.typeOid === 17) {
          value = parseByteaBytes(payload, offset, offset + length);
        } else if (parser === parseIntegerArray) {
          value = parseIntegerArrayBytes(payload, offset, offset + length);
        } else if (
          parser === Number
          && (field.typeOid === 21 || field.typeOid === 23 || field.typeOid === 26)
        ) {
          value = parseInteger(payload, offset, offset + length);
        } else {
          const text = decodeTextRange(payload, offset, offset + length);
          value = parser ? parser(text) : text;
        }
        assertNoDateSqlValue(value, "PostgreSQL result");
      } catch (cause) {
        throw new ResultDecodeError({
          queryId: queryId(query),
          columnIndex: index,
          column: field.name,
          typeOid: field.typeOid,
          ...(cause instanceof TemporalInfinityError ? { hint: cause.decodeHint } : {}),
        }, cause);
      }
      offset += length;
    }
    decoded[index] = value;
    if (field.name === "__proto__") {
      Object.defineProperty(row, field.name, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      row[field.name as keyof Row] = value as Row[keyof Row];
    }
  }
  values.push(decoded);
  return row;
}

function resultWithMetadata<Row extends Record<string, unknown>>(
  rows: Row[],
  values: unknown[][],
  tag: string,
): PostgresResult<Row> {
  const commandEnd = tag.indexOf(" ");
  const command = tag
    ? commandEnd === -1 ? tag : tag.slice(0, commandEnd)
    : null;
  const countStart = tag.lastIndexOf(" ") + 1;
  let numericCount = countStart < tag.length;
  for (let index = countStart; index < tag.length; index++) {
    const code = tag.charCodeAt(index);
    if (code < 0x30 || code > 0x39) {
      numericCount = false;
      break;
    }
  }
  const count = numericCount ? Number(tag.slice(countStart)) : null;
  Object.defineProperty(rows, RESULT_VALUES, {
    value: values,
  });
  Object.defineProperty(rows, "count", {
    configurable: true,
    value: count,
  });
  Object.defineProperty(rows, "command", {
    configurable: true,
    value: command,
  });
  return rows as PostgresResult<Row>;
}

function parseBoolean(value: string): boolean {
  return value === "t";
}

function parseInteger(value: Uint8Array, start: number, end: number): number {
  let result = 0;
  let sign = 1;
  if (value[start] === 0x2d) {
    sign = -1;
    start++;
  }
  while (start < end) {
    result = result * 10 + value[start++]! - 0x30;
  }
  return result * sign;
}

function parseByteaBytes(value: Uint8Array, start: number, end: number): Uint8Array {
  if (value[start] === 0x5c && value[start + 1] === 0x78) {
    start += 2;
    const bytes = new Uint8Array((end - start) / 2);
    for (let index = 0; index < bytes.length; index++) {
      const high = value[start++]!;
      const low = value[start++]!;
      bytes[index] = (
        (high <= 0x39 ? high - 0x30 : (high | 0x20) - 0x57) * 16
        + (low <= 0x39 ? low - 0x30 : (low | 0x20) - 0x57)
      );
    }
    return bytes;
  }
  const bytes = new Uint8Array(end - start);
  let length = 0;
  while (start < end) {
    const current = value[start++]!;
    if (current !== 0x5c) {
      bytes[length++] = current;
      continue;
    }
    const escaped = value[start++]!;
    if (escaped === 0x5c) {
      bytes[length++] = escaped;
      continue;
    }
    bytes[length++] = (
      (escaped - 0x30) * 64
      + (value[start++]! - 0x30) * 8
      + value[start++]! - 0x30
    );
  }
  return length === bytes.length ? bytes : bytes.slice(0, length);
}

type PgIntegerArray = (number | null | PgIntegerArray)[];

function parseIntegerArrayBytes(value: Uint8Array, start: number, end: number): PgIntegerArray {
  while (start < end && value[start] !== 0x7b) start++;
  const root: PgIntegerArray = [];
  const stack = [root];
  start++;
  while (start < end) {
    const current = stack[stack.length - 1]!;
    const code = value[start]!;
    if (code === 0x7b) {
      const nested: PgIntegerArray = [];
      current.push(nested);
      stack.push(nested);
      start++;
      continue;
    }
    if (code === 0x7d) {
      stack.pop();
      start++;
      if (stack.length === 0) return root;
      continue;
    }
    if (code === 0x2c) {
      start++;
      continue;
    }
    if (code === 0x4e) {
      current.push(null);
      start += 4;
      continue;
    }
    let sign = 1;
    if (code === 0x2d) {
      sign = -1;
      start++;
    }
    let integer = 0;
    while (start < end) {
      const digit = value[start]!;
      if (digit === 0x2c || digit === 0x7d) break;
      integer = integer * 10 + digit - 0x30;
      start++;
    }
    current.push(integer * sign);
  }
  return root;
}

function parseIntegerArray(value: string): PgIntegerArray {
  return parsePgArrayLiteral(value, Number);
}

function parseBytea(value: string): Uint8Array {
  if (value.startsWith("\\x")) {
    const bytes = new Uint8Array((value.length - 2) / 2);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
    }
    return bytes;
  }
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "\\") {
      bytes.push(value.charCodeAt(index));
      continue;
    }
    if (value[index + 1] === "\\") {
      bytes.push(0x5c);
      index++;
      continue;
    }
    const octal = value.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/.test(octal)) {
      throw new Error("sqlx-js: malformed PostgreSQL bytea escape value");
    }
    bytes.push(Number.parseInt(octal, 8));
    index += 3;
  }
  return Uint8Array.from(bytes);
}

function serializeBytea(value: unknown): string {
  if (!(value instanceof Uint8Array)) throw new Error("sqlx-js: bytea value must be a Uint8Array");
  return `\\x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
