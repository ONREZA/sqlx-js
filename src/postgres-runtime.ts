import postgres from "postgres";
import { resolve } from "node:path";
import {
  createSqlRuntime,
  encodePgArrayLiteral,
  isPrimitiveArrayElement,
  parameterKind,
  parsePgArrayLiteral,
  TransactionTimeoutError,
  type JsonParameter,
  type OnQueryHook,
  type OnQueryHookError,
  type PgArrayParameter,
  type RuntimeClient,
  type RuntimeQueryResult,
  type RuntimeTransactionOptions,
} from "./runtime";
import { arrayElementOid, builtinArrayOids } from "./pg/oids";

export type PostgresClient = postgres.Sql<{ bigint: bigint }>;
export type PostgresOptions = postgres.Options<Record<string, postgres.PostgresType>>;
export type CreateClientOptions = PostgresOptions & {
  onQuery?: OnQueryHook;
  onQueryHookError?: OnQueryHookError;
  statementTimeoutMs?: number;
  fileRoot?: string;
  reloadSqlFiles?: boolean;
  sqlFiles?: Readonly<Record<string, string>>;
};
type PostgresQueryClient = PostgresClient | postgres.TransactionSql<{ bigint: bigint }>;
type PendingQuery = PromiseLike<RuntimeQueryResult> & { cancel?: () => void };
type TransactionState = {
  expired?: TransactionTimeoutError;
  pending: Set<PendingQuery>;
};

const HOOKS = Symbol.for("sqlx-js.hooks");
type AttachedHooks = {
  onQuery?: OnQueryHook;
  onQueryHookError?: OnQueryHookError;
  prepare: boolean;
  fileRoot: string;
  reloadSqlFiles: boolean;
  sqlFiles?: Readonly<Record<string, string>>;
};

function resolvedFileRoot(value?: string): string {
  return resolve(value ?? process.env.SQLX_JS_FILE_ROOT ?? process.cwd());
}

class PostgresRuntimeClient implements RuntimeClient {
  constructor(
    public readonly client: PostgresQueryClient,
    public readonly onQuery?: OnQueryHook,
    public readonly onQueryHookError?: OnQueryHookError,
    public readonly prepare = true,
    public readonly fileRoot = resolvedFileRoot(),
    public readonly reloadSqlFiles = false,
    public readonly sqlFiles?: Readonly<Record<string, string>>,
    private readonly transactionScoped = false,
    private readonly transactionState?: TransactionState,
  ) {}

  async query(query: string, params: unknown[]): Promise<RuntimeQueryResult> {
    if (this.transactionState?.expired) throw this.transactionState.expired;
    const pending = this.client.unsafe(
      query,
      params as never[],
      { prepare: this.prepare },
    ) as unknown as PendingQuery;
    this.transactionState?.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.transactionState?.pending.delete(pending);
    }
  }

  transformParam(param: unknown): unknown {
    const kind = parameterKind(param);
    if (kind === "json") return this.client.json((param as JsonParameter).value as never);
    if (kind === "array") {
      const value = [...(param as PgArrayParameter).value];
      if (value.every(isPrimitiveArrayElement)) return encodePgArrayLiteral(value);
      if (value.every((item) => item === null || parameterKind(item) === "json")) {
        return this.client.array(value as never[], 3807);
      }
      return this.client.array(value as never[]);
    }
    return param;
  }

  async transaction<R>(
    fn: (client: RuntimeClient) => Promise<R>,
    options: RuntimeTransactionOptions = {},
  ): Promise<R> {
    if (this.transactionScoped || !("begin" in this.client)) {
      throw new Error("sqlx-js.transaction: nested transactions are not supported");
    }
    return await this.client.begin(async (tx) => {
      const state: TransactionState | undefined = options.timeoutMs === undefined
        ? undefined
        : { pending: new Set() };
      const scoped = new PostgresRuntimeClient(
        tx,
        this.onQuery,
        this.onQueryHookError,
        this.prepare,
        this.fileRoot,
        this.reloadSqlFiles,
        this.sqlFiles,
        true,
        state,
      );
      if (options.timeoutMs === undefined) return await fn(scoped);
      return await runTransactionWithTimeout(options.timeoutMs, state!, () => fn(scoped));
    }) as R;
  }

  async close(): Promise<void> {
    if ("end" in this.client) await this.client.end();
  }
}

async function runTransactionWithTimeout<R>(
  timeoutMs: number,
  state: TransactionState,
  fn: () => Promise<R>,
): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TransactionTimeoutError(timeoutMs);
      state.expired = error;
      for (const query of state.pending) {
        try {
          query.cancel?.();
        } catch {}
      }
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let defaultClient: PostgresRuntimeClient | null = null;

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

type MutableCodecOptions = {
  parsers?: Record<number, (value: string) => unknown>;
  serializers?: Record<number, (value: unknown) => unknown>;
  types?: Record<string, postgres.PostgresType>;
};

function typeOids(value: number | number[] | null | undefined): number[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function installJsonArrayCodecs(client: PostgresClient): void {
  const options = client.options as unknown as MutableCodecOptions;
  options.parsers ??= {};
  options.serializers ??= {};
  const configured = Object.values(options.types ?? {});
  for (const oid of [199, 3807]) {
    const hasParser = configured.some((type) => typeOids(type.from).includes(oid));
    const hasSerializer = configured.some((type) => type.to === oid);
    if (!hasParser) options.parsers[oid] = (value) => parsePgArrayLiteral(value, JSON.parse);
    if (!hasSerializer) {
      options.serializers[oid] = (value) => Array.isArray(value) ? encodePgArrayLiteral(value) : String(value);
    }
  }
}

export function createClient(url = process.env.DATABASE_URL, options: CreateClientOptions = {}): PostgresClient {
  if (!url) throw new Error("sqlx-js: DATABASE_URL is not set");
  const { onQuery, onQueryHookError, statementTimeoutMs, fileRoot, reloadSqlFiles, sqlFiles, ...pgOptions } = options;
  const connection = statementTimeoutMs !== undefined
    ? { ...(pgOptions.connection ?? {}), statement_timeout: statementTimeoutMs }
    : pgOptions.connection;
  const client = postgres(url, {
    ...pgOptions,
    ...(connection ? { connection } : {}),
    types: { ...postgresTypes(), ...(pgOptions.types ?? {}) },
  }) as PostgresClient;
  (client as unknown as Record<symbol, unknown>)[HOOKS] = {
    onQuery,
    onQueryHookError,
    prepare: pgOptions.prepare ?? true,
    fileRoot: resolvedFileRoot(fileRoot),
    reloadSqlFiles: reloadSqlFiles ?? false,
    sqlFiles,
  } satisfies AttachedHooks;
  return client;
}

function createDefaultClient(): PostgresRuntimeClient {
  const client = createClient();
  const attached = (client as unknown as Record<symbol, unknown>)[HOOKS] as AttachedHooks;
  return new PostgresRuntimeClient(
    client,
    attached.onQuery,
    attached.onQueryHookError,
    attached.prepare,
    attached.fileRoot,
    attached.reloadSqlFiles,
    attached.sqlFiles,
  );
}

function getRuntimeClient(): PostgresRuntimeClient {
  defaultClient ??= createDefaultClient();
  return defaultClient;
}

export function getClient(): PostgresClient {
  return getRuntimeClient().client as PostgresClient;
}

export function setClient(
  client: PostgresClient,
  options?: {
    onQuery?: OnQueryHook;
    onQueryHookError?: OnQueryHookError;
    prepare?: boolean;
    fileRoot?: string;
    reloadSqlFiles?: boolean;
    sqlFiles?: Readonly<Record<string, string>>;
  },
): void {
  installJsonArrayCodecs(client);
  const attached = (client as unknown as Record<symbol, unknown>)[HOOKS] as AttachedHooks | undefined;
  defaultClient = new PostgresRuntimeClient(
    client,
    options?.onQuery ?? attached?.onQuery,
    options?.onQueryHookError ?? attached?.onQueryHookError,
    options?.prepare ?? attached?.prepare ?? client.options?.prepare ?? true,
    resolvedFileRoot(options?.fileRoot ?? attached?.fileRoot),
    options?.reloadSqlFiles ?? attached?.reloadSqlFiles ?? false,
    options?.sqlFiles ?? attached?.sqlFiles,
  );
}

export async function close(): Promise<void> {
  if (defaultClient) {
    await defaultClient.close();
    defaultClient = null;
  }
}

export function createSqlClient(url = process.env.DATABASE_URL, options: CreateClientOptions = {}) {
  const client = createClient(url, options);
  const attached = (client as unknown as Record<symbol, unknown>)[HOOKS] as AttachedHooks;
  const runtimeClient = new PostgresRuntimeClient(
    client,
    attached.onQuery,
    attached.onQueryHookError,
    attached.prepare,
    attached.fileRoot,
    attached.reloadSqlFiles,
    attached.sqlFiles,
  );
  const runtime = createSqlRuntime(() => runtimeClient);
  return {
    ...runtime,
    client,
    close: async () => runtimeClient.close(),
  };
}

const runtime = createSqlRuntime(getRuntimeClient);

export const sql = runtime.sql;
export const unsafe = runtime.unsafe;
