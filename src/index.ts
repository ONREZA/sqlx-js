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

export type {
  ImmutableJson,
  JsonArray,
  JsonCompatible,
  JsonInputArray,
  JsonInputObject,
  JsonInputValue,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  SqlxJsonParseOptions,
} from "./json-value";
export {
  EXTENDED_JSON_PROTOCOL_VERSION,
  JsonNumber,
  SqlxJson,
} from "./json-value";
export type {
  PgDate,
  PgTime,
  PgTimestamp,
  PgTimestamptz,
  TemporalApi,
} from "./temporal-api";
export type JsonInput = import("./json-value").JsonInputValue;

export { defineConfig, defineDatabaseProfiles } from "./config";
export type {
  DatabaseProfile,
  DatabaseProfiles,
  EnumCatalogConfig,
  ExactDuplicateIgnore,
  QueryAuditConfig,
  ScanConfig,
  SqlxJsConfig,
} from "./config";
export type { TemporalPolicy, TemporalPolicyOptions, TimestampWithoutTimeZoneMode } from "./temporal";
export type { SslMode, ConnConfig, PgNotice } from "./pg/wire";
export { PgError, ConnectionLostError } from "./pg/wire";
export {
  ClientClosingError,
  GenerationRecycledError,
  NoRowsError,
  QueryAbortedError,
  QueryTimeoutError,
  ResultDecodeError,
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
  QueryExecutionPath,
  QueryExecutionOptions,
  QueryOutcome,
  QueryTimeoutPhase,
  ResultDecodeErrorDetails,
} from "./runtime";
export type { ExecuteResult, JsonParameter, PgArrayParameter, KnownSqlState } from "./runtime";
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
  QueryErrorEvent,
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
  runtimeDescriptors?: true;
  jsonProtocol: typeof import("./json-value").EXTENDED_JSON_PROTOCOL_VERSION;
  temporal?: import("./temporal").TemporalPolicy;
};

export interface DefaultQueryRegistry {
  queries: KnownQueries;
  fileQueries: KnownFileQueries;
  functions: KnownFunctions;
  jsonProtocol: typeof import("./json-value").EXTENDED_JSON_PROTOCOL_VERSION;
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
type RegistryTemporalPolicy<Registry extends QueryRegistry> =
  Registry extends { temporal: infer Policy extends import("./temporal").TemporalPolicy }
    ? Policy
    : import("./temporal").TemporalPolicy;
type ExplicitTemporalOptionsFor<Registry extends QueryRegistry> =
  RegistryTemporalPolicy<Registry>["timestampWithoutTimeZone"] extends "allow"
    ? { temporal: RegistryTemporalPolicy<Registry> }
    : { temporal?: RegistryTemporalPolicy<Registry> };
type DescriptorTemporalOptionsFor<Registry extends QueryRegistry> =
  { temporal?: RegistryTemporalPolicy<Registry> };
type ExecutionOptionsFor<Registry extends QueryRegistry> =
  Registry extends { runtimeDescriptors: true }
    ? (
      | ({
        queryDescriptors: import("./runtime-descriptors").RuntimeQueryDescriptors;
        execution?: never;
      } & DescriptorTemporalOptionsFor<Registry>)
      | ({
        queryDescriptors?: never;
        execution: "adaptive";
      } & ExplicitTemporalOptionsFor<Registry>)
    )
    : (
      | ({
        queryDescriptors: import("./runtime-descriptors").RuntimeQueryDescriptors;
        execution?: never;
      } & DescriptorTemporalOptionsFor<Registry>)
      | ({
        queryDescriptors?: never;
        execution?: "adaptive";
      } & ExplicitTemporalOptionsFor<Registry>)
    );
type GeneratedClientOptionsFor<Registry extends QueryRegistry> =
  Omit<
    import("./postgres-runtime").CreateSqlClientOptions,
    "typeCodecs" | "types" | "profile" | "queryDescriptors" | "execution" | "temporal"
  > & ExecutionOptionsFor<Registry> & (
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
  Omit<
    import("./postgres-runtime").CreateSqlClientOptions,
    "profile" | "queryDescriptors" | "execution" | "temporal"
  > & ExecutionOptionsFor<Registry> & (
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
      ? Registry extends { runtimeDescriptors: true }
        ? [url: string | undefined, options: PlainClientOptionsFor<Registry>]
        : [url?: string, options?: PlainClientOptionsFor<Registry>]
      : [url: string | undefined, options: GeneratedClientOptionsFor<Registry>];
type RawClientOptionsFor<Registry extends QueryRegistry> =
  Omit<import("./postgres-runtime").CreateClientOptions, "temporal">
  & ExplicitTemporalOptionsFor<Registry>;
type CreateRawClientArgs<Registry extends QueryRegistry> =
  keyof RegistryRuntimeTypes<Registry> extends never
    ? [url?: string, options?: RawClientOptionsFor<Registry>]
    : [
      url: string | undefined,
      options: Omit<RawClientOptionsFor<Registry>, "types"> & {
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
export type {
  DefineQueryOptions,
  MappedQueryDefinition,
  QueryDefinition,
  QueryExecutionMode,
  QueryParameterHelpers,
  QueryResultAssertions,
  QueryResultElementAssertion,
  QueryValidationExpectation,
} from "./query";
export type { RuntimeQueryDescriptors } from "./runtime-descriptors";
export { defineQuery } from "./query";
export { queryId } from "./query-id";

/** @deprecated Prefer a generated registry bound with createSqlClient(). */
export const sql: Typed = rt.sql as unknown as Typed;

export type Unsafe = (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
/** @deprecated Prefer a generated registry bound with createSqlClient(). */
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
/** @deprecated Prefer passing temporalApi to createSqlClient(). */
export const configureDefaultTemporalApi = rt.configureDefaultTemporalApi;
/** @deprecated Prefer createSqlClient().close(). */
export const close = rt.close;
/** @deprecated Prefer createSqlClient().ready(). */
export const ready = rt.ready;
/** @deprecated Prefer createSqlClient().ping(). */
export const ping = rt.ping;
/** @deprecated Prefer createSqlClient().snapshot(). */
export const snapshot = rt.snapshot;
export { migrate, clearSqlFileCache, encodePgArrayLiteral, id, json, array } from "./runtime";
