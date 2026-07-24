import type { QUERY_EXECUTOR, QueryExecutorMethod } from "./query";

declare const QUERY_REGISTRY: unique symbol;

type ParamsOf<T> = T extends { params: infer P }
  ? P extends readonly unknown[] ? P : [P]
  : never[];
type RowOf<T> = T extends { row: infer R } ? R : never;
type ExecuteResult = import("./runtime").ExecuteResult;
type JsonCompatible<T> = import("./runtime").JsonCompatible<T>;
type JsonParameter<T> = import("./runtime").JsonParameter<T>;
type PgArrayParameter<T, NullableElements extends boolean = boolean> = import("./runtime").PgArrayParameter<T, NullableElements>;
type PgArrayElement<Values extends readonly unknown[]> = Exclude<Values[number], null>;
type PgArrayContainsNull<Values extends readonly unknown[]> = null extends Values[number] ? true : false;

type JsonFn = <T>(value: T & JsonCompatible<T>) => JsonParameter<T>;
type ArrayFn = <const Values extends readonly unknown[]>(
  value: Values,
) => PgArrayParameter<PgArrayElement<Values>, PgArrayContainsNull<Values>>;

export type TypedFile<TFileQueries> = {
  <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>): Promise<RowOf<TFileQueries[P]>[]>;
  one: <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>) => Promise<RowOf<TFileQueries[P]>>;
  optional: <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>) => Promise<RowOf<TFileQueries[P]> | null>;
  execute: <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>) => Promise<ExecuteResult>;
};

export type TypedSqlForRegistry<Registry extends { queries: object; fileQueries: object }> = {
  <Q extends keyof Registry["queries"]>(
    query: Q,
    ...params: ParamsOf<Registry["queries"][Q]>
  ): Promise<RowOf<Registry["queries"][Q]>[]>;
  one: <Q extends keyof Registry["queries"]>(
    query: Q,
    ...params: ParamsOf<Registry["queries"][Q]>
  ) => Promise<RowOf<Registry["queries"][Q]>>;
  optional: <Q extends keyof Registry["queries"]>(
    query: Q,
    ...params: ParamsOf<Registry["queries"][Q]>
  ) => Promise<RowOf<Registry["queries"][Q]> | null>;
  execute: <Q extends keyof Registry["queries"]>(
    query: Q,
    ...params: ParamsOf<Registry["queries"][Q]>
  ) => Promise<ExecuteResult>;
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
    <R>(opts: TTransactionOptions, fn: (tx: TypedSqlForRegistry<Registry>) => Promise<R>): Promise<R>;
  } & (
    TTransactionOptions extends { settings: unknown }
      ? object
      : {
        <R>(fn: (tx: TypedSqlForRegistry<Registry>) => Promise<R>): Promise<R>;
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
