import type { QUERY_EXECUTOR, QueryExecutorMethod } from "./query";

declare const QUERY_REGISTRY: unique symbol;

type EntryParams<Entry> = Entry["params" & keyof Entry];
type RowOf<T> = T extends { row: infer R } ? R : never;
type ExecuteResult = import("./runtime").ExecuteResult;
type QueryExecutionOptions = import("./runtime").QueryExecutionOptions;
type JsonCompatible<T> = import("./runtime").JsonCompatible<T>;
type SqlxJson<T> = import("./json-value").SqlxJson<T>;
type PgArrayParameter<T, NullableElements extends boolean = boolean> = import("./runtime").PgArrayParameter<T, NullableElements>;
type PgArrayElement<Values extends readonly unknown[]> = Exclude<Values[number], null>;
type PgArrayContainsNull<Values extends readonly unknown[]> = null extends Values[number] ? true : false;

type JsonFn = <T>(value: T & JsonCompatible<T>) => SqlxJson<T>;
type ArrayFn = <const Values extends readonly unknown[]>(
  value: Values,
) => PgArrayParameter<PgArrayElement<Values>, PgArrayContainsNull<Values>>;

type RuntimeObjectKey<Shape> = Shape extends unknown
  ? Extract<keyof Shape, string | number>
  : never;

export type ExtraNamedParamKeys<Actual, Expected> =
  Exclude<RuntimeObjectKey<Actual>, RuntimeObjectKey<Expected>>;

export type ExactNamedParams<Expected, Actual extends Expected> =
  Actual & Record<ExtraNamedParamKeys<Actual, Expected>, never>;

type QueryMethodResult<Entry, Mode extends "many" | "one" | "optional" | "execute"> =
  Mode extends "many" ? Promise<RowOf<Entry>[]>
    : Mode extends "one" ? Promise<RowOf<Entry>>
      : Mode extends "optional" ? Promise<RowOf<Entry> | null>
        : Promise<ExecuteResult>;

type QueryParams<Queries, Query extends keyof Queries> =
  EntryParams<Queries[Query]>;

type QueryArguments<Params> = Params extends readonly unknown[] ? Params : [Params];

// Keeps an equivalent unresolved forwarding tuple callable before exact-key analysis.
type SameType<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

type ExactQueryArgumentShape<Actual, Expected> =
  SameType<Actual, Readonly<QueryArguments<Expected>>> extends true
    ? true
    : [Actual] extends [Readonly<QueryArguments<Expected>>]
      ? Expected extends readonly unknown[]
        ? true
        : Actual extends readonly [infer NamedActual]
          ? [NamedActual] extends [Expected]
            ? [ExtraNamedParamKeys<NamedActual, Expected>] extends [never] ? true : false
            : false
          : false
      : false;

type CompatibleQuery<Query, Actual, Expected> =
  ExactQueryArgumentShape<Actual, Expected> extends false ? never : Query;

type TypedQueryMethod<Queries, Mode extends "many" | "one" | "optional" | "execute"> = <
  Query extends keyof Queries,
  const Actual extends readonly unknown[],
>(
  query: CompatibleQuery<Query, Actual, QueryParams<Queries, NoInfer<Query>>>,
  ...params: Actual
) => QueryMethodResult<Queries[Query], Mode>;

export type TypedFile<TFileQueries> = TypedQueryMethod<TFileQueries, "many"> & {
  one: TypedQueryMethod<TFileQueries, "one">;
  optional: TypedQueryMethod<TFileQueries, "optional">;
  execute: TypedQueryMethod<TFileQueries, "execute">;
};

export type TypedSqlForRegistry<Registry extends { queries: object; fileQueries: object }> =
  TypedQueryMethod<Registry["queries"], "many"> & {
    one: TypedQueryMethod<Registry["queries"], "one">;
    optional: TypedQueryMethod<Registry["queries"], "optional">;
    execute: TypedQueryMethod<Registry["queries"], "execute">;
    with: (options: QueryExecutionOptions) => TypedSqlForRegistry<Registry>;
    file: TypedFile<Registry["fileQueries"]>;
    id: (...parts: string[]) => string;
    json: JsonFn;
    array: ArrayFn;
    readonly [QUERY_EXECUTOR]?: QueryExecutorMethod;
    readonly [QUERY_REGISTRY]?: Registry;
  };

export type TypedSql<TQueries extends object, TFileQueries extends object> = TypedSqlForRegistry<{
  queries: TQueries;
  fileQueries: TFileQueries;
}>;

export type TypedTransactionSqlForRegistry<
  Registry extends { queries: object; fileQueries: object },
> = TypedSqlForRegistry<Registry> & {
  savepoint: <R>(
    fn: (savepoint: TypedTransactionSqlForRegistry<Registry>) => Promise<R>,
  ) => Promise<R>;
};

type TransactionRootForRegistry<
  Registry extends { queries: object; fileQueries: object },
  TTransactionOptions,
> = TTransactionOptions extends { settings: unknown }
  ? Pick<TypedSqlForRegistry<Registry>, "id" | "json" | "array">
  : TypedSqlForRegistry<Registry>;

export type TypedForRegistry<
  Registry extends { queries: object; fileQueries: object },
  TTransactionOptions,
> = TransactionRootForRegistry<Registry, TTransactionOptions> & {
  transaction: {
    <R>(opts: TTransactionOptions, fn: (tx: TypedTransactionSqlForRegistry<Registry>) => Promise<R>): Promise<R>;
  } & (
    TTransactionOptions extends { settings: unknown }
      ? object
      : {
        <R>(fn: (tx: TypedTransactionSqlForRegistry<Registry>) => Promise<R>): Promise<R>;
      }
  );
};

export type Typed<
  TQueries extends object,
  TFileQueries extends object,
  TTransactionOptions,
> = TypedForRegistry<{
  queries: TQueries;
  fileQueries: TFileQueries;
}, TTransactionOptions>;
