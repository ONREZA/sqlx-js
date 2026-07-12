import * as rt from "./postgres-runtime";
import type {
  TypedFile as TypedFileFor,
  TypedForRegistry,
  TypedSqlForRegistry,
} from "./typed";
import type {
  QueryParamsFor,
  QueryResultFor,
  QueryRowFor,
  QueryWireParamsFor,
} from "./query";

export interface KnownQueries {}
export interface KnownFileQueries {}
export interface KnownFunctions {}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonInput = string | number | boolean | JsonInputObject | JsonInputArray;
export type JsonInputValue = JsonPrimitive | JsonInputObject | JsonInputArray;
export type JsonInputObject = { readonly [key: string]: JsonInputValue | undefined };
export type JsonInputArray = readonly JsonInputValue[];

export { defineConfig } from "./config";
export type { ScanConfig, SqlxJsConfig } from "./config";
export type { SslMode, ConnConfig } from "./pg/wire";
export { PgError, ConnectionLostError } from "./pg/wire";
export { NoRowsError, TooManyRowsError, TransactionTimeoutError, SQLSTATE, isPgError } from "./runtime";
export type { TransactionOptions, MigrateOptions, OnQueryEvent, OnQueryHook, OnQueryHookError } from "./runtime";
export type { ExecuteResult, JsonParameter, PgArrayParameter, JsonCompatible, KnownSqlState } from "./runtime";
export type { RuntimeTypeCodec, RuntimeTypeCodecs } from "./postgres-codecs";
export type { PostgresClient, PostgresOptions, CreateClientOptions } from "./postgres-runtime";

export type TypedFile = TypedFileFor<KnownFileQueries>;
export type TypedSql = TypedSqlForRegistry<DefaultQueryRegistry>;
export type Typed = TypedForRegistry<DefaultQueryRegistry, import("./runtime").TransactionOptions>;

export type QueryRegistry = {
  queries: object;
  fileQueries: object;
  runtimeTypes?: object;
};

export interface DefaultQueryRegistry {
  queries: KnownQueries;
  fileQueries: KnownFileQueries;
  functions: KnownFunctions;
}

export type SqlClient<Registry extends QueryRegistry = DefaultQueryRegistry> = {
  sql: TypedForRegistry<Registry, import("./runtime").TransactionOptions>;
  unsafe: Unsafe;
  client: import("./postgres-runtime").PostgresClient;
  ready: () => Promise<void>;
  close: () => Promise<void>;
};

type RegistryRuntimeTypes<Registry extends QueryRegistry> =
  Registry extends { runtimeTypes: infer RuntimeTypes extends object } ? RuntimeTypes : object;
export type RuntimeTypeCodecsFor<Registry extends QueryRegistry> =
  import("./postgres-codecs").RuntimeTypeCodecs & {
    readonly [Name in keyof RegistryRuntimeTypes<Registry> & string]:
      import("./postgres-codecs").RuntimeTypeCodec<RegistryRuntimeTypes<Registry>[Name]>;
  };
export type RuntimePostgresTypesFor<Registry extends QueryRegistry> = {
  readonly [Name in keyof RegistryRuntimeTypes<Registry> & string]:
    import("postgres").PostgresType<RegistryRuntimeTypes<Registry>[Name]>;
};
type GeneratedClientOptionsFor<Registry extends QueryRegistry> =
  Omit<import("./postgres-runtime").CreateClientOptions, "typeCodecs" | "types"> & (
    | {
      typeCodecs: RuntimeTypeCodecsFor<Registry>;
      types?: import("./postgres-runtime").CreateClientOptions["types"];
    }
    | {
      typeCodecs?: never;
      types: RuntimePostgresTypesFor<Registry>;
    }
  );
type CreateClientArgs<Registry extends QueryRegistry> =
  keyof RegistryRuntimeTypes<Registry> extends never
    ? [url?: string, options?: import("./postgres-runtime").CreateClientOptions]
    : [url: string | undefined, options: GeneratedClientOptionsFor<Registry>];

export type SqlExecutor<Registry extends QueryRegistry = DefaultQueryRegistry> =
  TypedSqlForRegistry<Registry>;
export type QueryParams<Definition, Registry extends QueryRegistry = DefaultQueryRegistry> =
  QueryParamsFor<Definition, Registry>;
export type QueryWireParams<Definition, Registry extends QueryRegistry = DefaultQueryRegistry> =
  QueryWireParamsFor<Definition, Registry>;
export type QueryRow<Definition, Registry extends QueryRegistry = DefaultQueryRegistry> =
  QueryRowFor<Definition, Registry>;
export type QueryResult<Definition, Registry extends QueryRegistry = DefaultQueryRegistry> =
  QueryResultFor<Definition, Registry>;
export type { MappedQueryDefinition, QueryDefinition, QueryExecutionMode, QueryParameterHelpers } from "./query";
export { defineQuery } from "./query";
export { queryId } from "./query-id";

export const sql: Typed = rt.sql as unknown as Typed;

export type Unsafe = (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
export const unsafe: Unsafe = rt.unsafe as Unsafe;
export const getClient = rt.getClient;
export const setClient = rt.setClient;
export function createClient<Registry extends QueryRegistry = DefaultQueryRegistry>(
  ...args: CreateClientArgs<Registry>
): import("./postgres-runtime").PostgresClient {
  const [url, options] = args as [string | undefined, import("./postgres-runtime").CreateClientOptions | undefined];
  return rt.createClient(url, options);
}
export function createSqlClient<Registry extends QueryRegistry = DefaultQueryRegistry>(
  ...args: CreateClientArgs<Registry>
): SqlClient<Registry> {
  const [url, options] = args as [string | undefined, import("./postgres-runtime").CreateClientOptions | undefined];
  return rt.createSqlClient(url, options) as unknown as SqlClient<Registry>;
}
export const close = rt.close;
export const ready = rt.ready;
export { migrate, clearSqlFileCache, encodePgArrayLiteral, id, json, array } from "./runtime";
