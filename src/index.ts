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
export interface KnownProfiles {}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type { PgTemporal } from "./pg/driver";
export type JsonInput = string | number | boolean | JsonInputObject | JsonInputArray;
export type JsonInputValue = JsonPrimitive | JsonInputObject | JsonInputArray;
export type JsonInputObject = { readonly [key: string]: JsonInputValue | undefined };
export type JsonInputArray = readonly JsonInputValue[];

export { defineConfig, defineDatabaseProfiles } from "./config";
export type {
  DatabaseProfile,
  DatabaseProfiles,
  EnumCatalogConfig,
  ScanConfig,
  SqlxJsConfig,
} from "./config";
export type { SslMode, ConnConfig, PgNotice } from "./pg/wire";
export { PgError, ConnectionLostError } from "./pg/wire";
export {
  ClientClosingError,
  GenerationRecycledError,
  NoRowsError,
  QueryAbortedError,
  QueryTimeoutError,
  TooManyRowsError,
  TransactionTimeoutError,
  SQLSTATE,
  isPgError,
} from "./runtime";
export type {
  TransactionOptions,
  MigrateOptions,
  OnQueryEvent,
  OnQueryHook,
  OnQueryHookError,
  QueryExecutionOptions,
  QueryOutcome,
  QueryTimeoutPhase,
} from "./runtime";
export type { ExecuteResult, JsonParameter, PgArrayParameter, JsonCompatible, KnownSqlState } from "./runtime";
export type { RuntimeTypeCodec, RuntimeTypeCodecs } from "./postgres-codecs";
export type {
  ClientLifecycleEvent,
  ClientSnapshot,
  ClientState,
  ClientStateChangeEvent,
  CloseOptions,
  CreateClientOptions,
  CreateSqlClientOptions,
  DeadlineOptions,
  PostgresClient,
  PostgresOptions,
  PostgresType,
  QueryStartEvent,
  QueryTimeoutEvent,
} from "./postgres-runtime";

export type TypedFile = TypedFileFor<KnownFileQueries>;
export type TypedSql = TypedSqlForRegistry<DefaultQueryRegistry>;
export type Typed = TypedForRegistry<DefaultQueryRegistry, import("./runtime").TransactionOptions>;

export type QueryRegistry = {
  queries: object;
  fileQueries: object;
  runtimeTypes?: object;
  profile?: import("./config").DatabaseProfile;
};

export interface DefaultQueryRegistry {
  queries: KnownQueries;
  fileQueries: KnownFileQueries;
  functions: KnownFunctions;
}

type ProfileTransactionSetting<Profile> =
  Profile extends {
    readonly transactionSettings: readonly (infer Setting extends string)[];
  } ? Setting : never;
type DeclaredRegistryTransactionSetting<Registry extends QueryRegistry> =
  Registry extends { readonly profile: infer Profile }
    ? ProfileTransactionSetting<Profile>
    : never;
type RegistryTransactionSetting<Registry extends QueryRegistry> =
  string extends DeclaredRegistryTransactionSetting<Registry>
    ? never
    : DeclaredRegistryTransactionSetting<Registry>;
export type SqlTransactionOptions<Registry extends QueryRegistry = DefaultQueryRegistry> =
  import("./runtime").TransactionOptions<RegistryTransactionSetting<Registry>>;

export type SqlClient<Registry extends QueryRegistry = DefaultQueryRegistry> = {
  sql: TypedForRegistry<Registry, SqlTransactionOptions<Registry>>;
  unsafe: [RegistryTransactionSetting<Registry>] extends [never] ? Unsafe : never;
  ready: (options?: import("./postgres-runtime").DeadlineOptions) => Promise<void>;
  ping: (options?: import("./postgres-runtime").DeadlineOptions) => Promise<void>;
  snapshot: () => import("./postgres-runtime").ClientSnapshot;
  close: (options?: import("./postgres-runtime").CloseOptions) => Promise<void>;
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
    import("./postgres-runtime").PostgresType<RegistryRuntimeTypes<Registry>[Name]>;
};
type GeneratedPostgresTypesFor<Registry extends QueryRegistry> =
  NonNullable<import("./postgres-runtime").CreateClientOptions["types"]> &
  RuntimePostgresTypesFor<Registry>;
type GeneratedClientOptionsFor<Registry extends QueryRegistry> =
  Omit<import("./postgres-runtime").CreateSqlClientOptions, "typeCodecs" | "types" | "profile"> & (
    | {
      typeCodecs: RuntimeTypeCodecsFor<Registry>;
      types?: import("./postgres-runtime").CreateSqlClientOptions["types"];
    }
    | {
      typeCodecs?: never;
      types: GeneratedPostgresTypesFor<Registry>;
    }
  ) & (
    Registry extends { profile: infer Profile extends import("./config").DatabaseProfile }
      ? { profile: Profile }
      : { profile?: never }
  );
type PlainClientOptionsFor<Registry extends QueryRegistry> =
  Omit<import("./postgres-runtime").CreateSqlClientOptions, "profile"> & (
    Registry extends { profile: infer Profile extends import("./config").DatabaseProfile }
      ? { profile: Profile }
      : { profile?: never }
  );
type CreateClientArgs<Registry extends QueryRegistry> =
  Registry extends { profile: import("./config").DatabaseProfile }
    ? [
      url: string | undefined,
      options: keyof RegistryRuntimeTypes<Registry> extends never
        ? PlainClientOptionsFor<Registry>
        : GeneratedClientOptionsFor<Registry>,
    ]
    : keyof RegistryRuntimeTypes<Registry> extends never
      ? [url?: string, options?: PlainClientOptionsFor<Registry>]
      : [url: string | undefined, options: GeneratedClientOptionsFor<Registry>];
type CreateRawClientArgs<Registry extends QueryRegistry> =
  keyof RegistryRuntimeTypes<Registry> extends never
    ? [url?: string, options?: import("./postgres-runtime").CreateClientOptions]
    : [
      url: string | undefined,
      options: Omit<import("./postgres-runtime").CreateClientOptions, "types"> & {
        types: GeneratedPostgresTypesFor<Registry>;
      },
    ];

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
export function createClient<Registry extends QueryRegistry = DefaultQueryRegistry>(
  ...args: CreateRawClientArgs<Registry>
): import("./postgres-runtime").PostgresClient {
  const [url, options] = args as [string | undefined, import("./postgres-runtime").CreateClientOptions | undefined];
  return rt.createClient(url, options);
}
type KnownProfileName = keyof KnownProfiles & string;
type KnownProfileRegistry<Name extends KnownProfileName> =
  KnownProfiles[Name] extends QueryRegistry & {
    profile: import("./config").DatabaseProfile;
  } ? KnownProfiles[Name] : never;
type KnownProfileClientOptions<Name extends KnownProfileName> =
  keyof RegistryRuntimeTypes<KnownProfileRegistry<Name>> extends never
    ? PlainClientOptionsFor<KnownProfileRegistry<Name>>
    : GeneratedClientOptionsFor<KnownProfileRegistry<Name>>;
export function createSqlClient<const Name extends KnownProfileName>(
  url: string | undefined,
  options: KnownProfileClientOptions<Name> & {
    profile: KnownProfileRegistry<Name>["profile"] & { readonly name: Name };
  },
): SqlClient<KnownProfileRegistry<Name>>;
export function createSqlClient<Registry extends QueryRegistry = DefaultQueryRegistry>(
  ...args: CreateClientArgs<Registry>
): SqlClient<Registry>;
export function createSqlClient(
  ...args: [url?: string, options?: import("./postgres-runtime").CreateSqlClientOptions]
): SqlClient<QueryRegistry> {
  const [url, options] = args as [string | undefined, import("./postgres-runtime").CreateSqlClientOptions | undefined];
  return rt.createSqlClient(url, options) as unknown as SqlClient<QueryRegistry>;
}
export const close = rt.close;
export const ready = rt.ready;
export const ping = rt.ping;
export const snapshot = rt.snapshot;
export { migrate, clearSqlFileCache, encodePgArrayLiteral, id, json, array } from "./runtime";
