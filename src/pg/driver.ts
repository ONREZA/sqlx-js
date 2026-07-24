import {
  encodePgArrayLiteral,
  encodePgArrayLiteralElements,
  parameterKind,
  parsePgArrayLiteral,
  type JsonCompatible,
  type JsonParameter,
  type RuntimeQueryResult,
} from "../runtime";
import { arrayElementOid, builtinArrayOids } from "./oids";
import {
  ConnectionLostError,
  decodeText,
  parseDatabaseUrl,
  PgClient,
  type PgNotice,
  type ConnConfig,
  type FieldDescription,
  type PgRowResult,
} from "./wire";

export type PostgresType<T = unknown> = {
  to: number;
  from: number | readonly number[];
  parse(value: string): T;
  serialize(value: T): unknown;
};

export type PgTemporal = Date | "infinity" | "-infinity";

export type PostgresOptions = {
  max?: number;
  password?: string | (() => string | Promise<string>);
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  startupOptions?: string;
  role?: string;
  onNotice?: (notice: PgNotice) => void | Promise<void>;
  types?: Readonly<Record<string, PostgresType>>;
};

type ParsedPostgresOptions = {
  max: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  startupOptions?: string;
  role?: string;
  types: Readonly<Record<string, PostgresType>>;
  parsers: Record<number, (value: string) => unknown>;
  serializers: Record<number, (value: unknown) => unknown>;
};

export type PostgresResult<Row extends Record<string, unknown> = Record<string, unknown>> =
  Row[] & RuntimeQueryResult;

export type PostgresPendingQuery<Row extends Record<string, unknown> = Record<string, unknown>> =
  PromiseLike<PostgresResult<Row>> & {
    execute(): PostgresPendingQuery<Row>;
    cancel(): Promise<void> | void;
    values(): Promise<unknown[][]>;
  };

export type PostgresQueryClient = {
  unsafe<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): PostgresPendingQuery<Row>;
  typed<T>(value: T, oid: number): PostgresParameter<T>;
  array<T>(value: readonly T[], arrayOid?: number): PostgresParameter<readonly T[]>;
  json<T>(value: T & JsonCompatible<T>): PostgresParameter<T>;
};

export type PostgresClient = PostgresQueryClient & {
  begin<T>(fn: (client: PostgresQueryClient) => T | Promise<T>): Promise<T>;
  begin<T>(options: string, fn: (client: PostgresQueryClient) => T | Promise<T>): Promise<T>;
  end(): Promise<void>;
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

const DEFAULT_MAX_CONNECTIONS = 10;
const MAX_TIMEOUT_MS = 2_147_483_647;

function optionalMilliseconds(
  value: number | undefined,
  name: string,
  allowZero: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_TIMEOUT_MS) {
    throw new Error(
      `sqlx-js: ${name} must be an integer from ${minimum} to ${MAX_TIMEOUT_MS}, got ${String(value)}`,
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
    const idleTimeoutMs = optionalMilliseconds(options.idleTimeoutMs, "idleTimeoutMs", true);
    const maxLifetimeMs = optionalMilliseconds(options.maxLifetimeMs, "maxLifetimeMs", true);
    const statementTimeoutMs = optionalMilliseconds(options.statementTimeoutMs, "statementTimeoutMs", true);
    const config = parseDatabaseUrl(url);
    if (typeof options.password === "string") config.password = options.password;
    this.passwordProvider = typeof options.password === "function" ? options.password : undefined;
    if (connectTimeoutMs !== undefined) config.connectTimeoutMs = connectTimeoutMs;
    if (options.applicationName !== undefined) config.applicationName = options.applicationName;
    if (options.startupOptions !== undefined) config.startupOptions = options.startupOptions;
    if (statementTimeoutMs !== undefined) config.statementTimeoutMs = statementTimeoutMs;
    if (options.role !== undefined) {
      config.startupParameters = { ...(config.startupParameters ?? {}), role: options.role };
    }
    if (options.onNotice !== undefined) config.onNotice = options.onNotice;
    const types = options.types ?? {};
    this.options = {
      max,
      ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
      ...(maxLifetimeMs === undefined ? {} : { maxLifetimeMs }),
      ...(statementTimeoutMs === undefined ? {} : { statementTimeoutMs }),
      ...(options.applicationName === undefined ? {} : { applicationName: options.applicationName }),
      ...(options.startupOptions === undefined ? {} : { startupOptions: options.startupOptions }),
      ...(options.role === undefined ? {} : { role: options.role }),
      types,
      parsers: builtinParsers(),
      serializers: builtinSerializers(),
    };
    installNumericTypes(this.options, types);
    this.config = config;
  }

  unsafe<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): PostgresPendingQuery<Row> {
    return new DriverQuery<Row>(
      async (setCancel, isCancelled) => {
        const lease = await this.acquire(setCancel, isCancelled);
        try {
          return await lease.slot.query(query, params, setCancel, isCancelled, true);
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

  json<T>(value: T & JsonCompatible<T>): PostgresParameter<T> {
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
      (setCancel, isCancelled) => {
        if (!this.active) {
          throw new Error("sqlx-js: transaction client cannot be used after the transaction ends");
        }
        return this.slot.query(query, params, setCancel, isCancelled, this.allowReconnect);
      },
    );
  }

  typed<T>(value: T, oid: number): PostgresParameter<T> {
    return { [PARAMETER]: true, value, oid, source: "typed" };
  }

  array<T>(value: readonly T[], arrayOid = 0): PostgresParameter<readonly T[]> {
    return { [PARAMETER]: true, value, oid: arrayOid, source: "array" };
  }

  json<T>(value: T & JsonCompatible<T>): PostgresParameter<T> {
    return { [PARAMETER]: true, value, oid: 3802, source: "json" };
  }

  deactivate(): void {
    this.active = false;
  }
}

class DriverQuery<Row extends Record<string, unknown>> implements PostgresPendingQuery<Row> {
  private promise: Promise<PostgresResult<Row>> | undefined;
  private cancelCurrent: (() => Promise<void> | void) | undefined;
  private cancelResult: Promise<void> | void = undefined;
  private cancelled = false;

  constructor(
    private readonly start: (
      setCancel: (cancel: () => Promise<void> | void) => void,
      isCancelled: () => boolean,
    ) => Promise<PostgresResult<Row>>,
  ) {}

  execute(): this {
    if (!this.promise) {
      this.promise = Promise.resolve()
        .then(() => this.start(
          (cancel) => {
            this.cancelCurrent = cancel;
            if (this.cancelled) this.cancelResult = cancel();
          },
          () => this.cancelled,
        ))
        .finally(() => {
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
    return Promise.resolve(this.execute().promise!).then(onfulfilled, onrejected);
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
  ): Promise<PostgresResult<Row>> {
    const result = this.tail.then(async () => {
      if (isCancelled()) throw queryCancelledBeforeDispatch();
      if (params.some((value) => value === undefined)) {
        throw new Error("sqlx-js: undefined is not a PostgreSQL value; pass null explicitly");
      }
      const startupAbort = new AbortController();
      setCancel(() => startupAbort.abort(queryCancelledBeforeDispatch()));
      const client = await this.readyClient(allowReconnect, startupAbort.signal);
      setCancel(() => client.cancel());
      if (isCancelled()) {
        const error = queryCancelledBeforeDispatch();
        client.destroy(error);
        throw error;
      }
      try {
        const described = params.length === 0 ? undefined : await client.describe(query);
        if (isCancelled()) {
          const error = queryCancelledBeforeDispatch();
          client.destroy(error);
          throw error;
        }
        const parameterOids = described?.paramOids ?? [];
        const encoded = params.map((value, index) =>
          encodeParameter(value, this.options, parameterOids[index])
        );
        if (isCancelled()) {
          const error = queryCancelledBeforeDispatch();
          client.destroy(error);
          throw error;
        }
        const raw = described
          ? await client.execDescribedParamsText(encoded)
          : await client.execParamsText(query, encoded);
        setCancel(() => {});
        return decodeResult<Row>(raw, this.options.parsers);
      } catch (error) {
        if (error instanceof ConnectionLostError || client.isClosed) {
          this.client = undefined;
          this.connectedAt = undefined;
          client.destroy(error instanceof Error ? error : undefined);
        }
        throw error;
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
    const signal = AbortSignal.any([this.abort.signal, operationSignal]);
    if (signal.aborted) throw abortReason(signal);
    if (this.client && !this.client.isClosed) return this.client;
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

function builtinParsers(): Record<number, (value: string) => unknown> {
  const parsers: Record<number, (value: string) => unknown> = {
    16: (value) => value === "t",
    17: parseBytea,
    20: BigInt,
    21: Number,
    23: Number,
    26: Number,
    114: JSON.parse,
    700: Number,
    701: Number,
    1082: parseDate,
    1114: parseTimestamp,
    1184: parseTimestamptz,
    2278: () => undefined,
    3802: JSON.parse,
    5069: BigInt,
  };
  for (const oid of builtinArrayOids()) {
    const elementOid = arrayElementOid(oid);
    if (elementOid === undefined) continue;
    parsers[oid] = (value) => parsePgArrayLiteral(value, parsers[elementOid] ?? String);
  }
  return parsers;
}

function builtinSerializers(): Record<number, (value: unknown) => unknown> {
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
    1082: serializeDate,
    1114: serializeTimestamp,
    1184: serializeTimestamp,
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

function encodeParameter(
  value: unknown,
  options: ParsedPostgresOptions,
  inferredOid?: number,
): string | null {
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
          (item) => serializeArrayElement(item, elementOid, value.source, options),
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
  if (typeof value === "object" && !(value instanceof Date) && !(value instanceof Uint8Array)) {
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
  source: PostgresParameter["source"],
  options: ParsedPostgresOptions,
): string {
  if (parameterKind(value) === "json") {
    return serializeJson((value as JsonParameter).value);
  }
  if (isPostgresParameter(value)) {
    const oid = value.oid || elementOid;
    const serialize = options.serializers[oid];
    return String(serialize ? serialize(value.value) : serializeUnknown(value.value));
  }
  if (source === "typed" && (elementOid === 114 || elementOid === 3802)) {
    return String(value);
  }
  const serialize = options.serializers[elementOid];
  return String(serialize ? serialize(value) : serializeUnknown(value));
}

function serializeUnknown(value: unknown): unknown {
  if (value instanceof Date) return serializeTimestamp(value);
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
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value has no JSON representation");
    return serialized;
  } catch (cause) {
    throw new Error("sqlx-js: JSON parameter is not JSON-serializable", { cause });
  }
}

function isPostgresParameter(value: unknown): value is PostgresParameter {
  return !!value && typeof value === "object" && (value as Partial<PostgresParameter>)[PARAMETER] === true;
}

function decodeResult<Row extends Record<string, unknown>>(
  raw: PgRowResult,
  parsers: Record<number, (value: string) => unknown>,
): PostgresResult<Row> {
  const values = raw.rows.map((columns) => columns.map((value, index) =>
    decodeColumn(value, raw.fields[index], parsers)
  ));
  const rows = values.map((columns) => Object.fromEntries(
    raw.fields.map((field, index) => [field.name, columns[index]]),
  )) as Row[];
  const tag = raw.tag.trim();
  const parts = tag ? tag.split(/\s+/) : [];
  const last = parts.at(-1);
  const count = last !== undefined && /^\d+$/.test(last) ? Number(last) : null;
  Object.defineProperties(rows, {
    [RESULT_VALUES]: {
      value: values,
    },
    count: {
      configurable: true,
      value: count,
    },
    command: {
      configurable: true,
      value: parts[0] ?? null,
    },
  });
  return rows as PostgresResult<Row>;
}

function decodeColumn(
  value: Uint8Array | null,
  field: FieldDescription | undefined,
  parsers: Record<number, (value: string) => unknown>,
): unknown {
  const text = decodeText(value);
  if (text === null) return null;
  const parser = field ? parsers[field.typeOid] : undefined;
  return parser ? parser(text) : text;
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

function parseDate(value: string): PgTemporal {
  if (value === "infinity" || value === "-infinity") return value;
  return parseFiniteTemporal(value, "date");
}

function parseTimestamp(value: string): PgTemporal {
  if (value === "infinity" || value === "-infinity") return value;
  return parseFiniteTemporal(value, "timestamp");
}

function parseTimestamptz(value: string): PgTemporal {
  if (value === "infinity" || value === "-infinity") return value;
  return parseFiniteTemporal(value, "timestamptz");
}

function parseFiniteTemporal(
  postgresValue: string,
  kind: "date" | "timestamp" | "timestamptz",
): Date {
  const bc = postgresValue.endsWith(" BC");
  const raw = bc ? postgresValue.slice(0, -3) : postgresValue;
  const match = /^(\d+)(.*)$/.exec(raw);
  const postgresYear = match ? Number(match[1]) : Number.NaN;
  const year = bc ? 1 - postgresYear : postgresYear;
  const isoYear = Number.isSafeInteger(year)
    ? year >= 0 && year <= 9999
      ? String(year).padStart(4, "0")
      : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`
    : "";
  let isoValue = `${isoYear}${match?.[2] ?? ""}`;
  if (kind === "date") {
    isoValue += "T00:00:00.000Z";
  } else {
    isoValue = isoValue.replace(" ", "T");
    if (kind === "timestamp") isoValue += "Z";
  }
  const date = kind === "timestamptz"
    ? parseOffsetTemporal(isoValue)
    : new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `sqlx-js: PostgreSQL temporal value ${postgresValue} is outside the JavaScript Date range`,
    );
  }
  return date;
}

function parseOffsetTemporal(value: string): Date {
  const offset = /([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(value);
  if (!offset || offset.index === undefined) return new Date(Number.NaN);
  const local = new Date(`${value.slice(0, offset.index)}Z`);
  const seconds = (
    Number(offset[2]) * 60 * 60
    + Number(offset[3] ?? 0) * 60
    + Number(offset[4] ?? 0)
  ) * (offset[1] === "+" ? 1 : -1);
  return new Date(local.getTime() - seconds * 1_000);
}

function serializeDate(value: unknown): string {
  if (value === "infinity" || value === "-infinity") return value;
  if (!(value instanceof Date)) throw new Error("sqlx-js: date value must be a Date");
  return formatPostgresTemporal(value, true);
}

function serializeTimestamp(value: unknown): string {
  if (value === "infinity" || value === "-infinity") return value;
  if (!(value instanceof Date)) throw new Error("sqlx-js: timestamp value must be a Date");
  return formatPostgresTemporal(value, false);
}

function formatPostgresTemporal(value: Date, dateOnly: boolean): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error("sqlx-js: temporal parameter must be a valid Date");
  }
  const year = value.getUTCFullYear();
  const postgresYear = year <= 0 ? 1 - year : year;
  const date = [
    String(postgresYear).padStart(4, "0"),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const bc = year <= 0 ? " BC" : "";
  if (dateOnly) return `${date}${bc}`;
  const time = [
    String(value.getUTCHours()).padStart(2, "0"),
    String(value.getUTCMinutes()).padStart(2, "0"),
    String(value.getUTCSeconds()).padStart(2, "0"),
  ].join(":");
  const milliseconds = String(value.getUTCMilliseconds()).padStart(3, "0");
  return `${date}T${time}.${milliseconds}Z${bc}`;
}
