type ParamsOf<T> = T extends { params: infer P }
  ? P extends readonly unknown[] ? P : [P]
  : never[];
type RowOf<T> = T extends { row: infer R } ? R : never;
type ExecuteResult = import("./runtime").ExecuteResult;
type JsonInputValue = import("./runtime").JsonInputValue;
type JsonParameter<T> = import("./runtime").JsonParameter<T>;
type PgArrayParameter<T> = import("./runtime").PgArrayParameter<T>;

type JsonFn = <T extends JsonInputValue>(value: T) => JsonParameter<T>;
type ArrayFn = <T>(value: readonly (T | null)[]) => PgArrayParameter<T>;

export type TypedFile<TFileQueries> = {
  <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>): Promise<RowOf<TFileQueries[P]>[]>;
  one: <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>) => Promise<RowOf<TFileQueries[P]>>;
  optional: <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>) => Promise<RowOf<TFileQueries[P]> | null>;
  execute: <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>) => Promise<ExecuteResult>;
};

export type TypedSql<TQueries, TFileQueries> = {
  <Q extends keyof TQueries>(query: Q, ...params: ParamsOf<TQueries[Q]>): Promise<RowOf<TQueries[Q]>[]>;
  one: <Q extends keyof TQueries>(query: Q, ...params: ParamsOf<TQueries[Q]>) => Promise<RowOf<TQueries[Q]>>;
  optional: <Q extends keyof TQueries>(query: Q, ...params: ParamsOf<TQueries[Q]>) => Promise<RowOf<TQueries[Q]> | null>;
  execute: <Q extends keyof TQueries>(query: Q, ...params: ParamsOf<TQueries[Q]>) => Promise<ExecuteResult>;
  file: TypedFile<TFileQueries>;
  id: (...parts: string[]) => string;
  json: JsonFn;
  array: ArrayFn;
};

export type Typed<TQueries, TFileQueries, TTransactionOptions> = TypedSql<TQueries, TFileQueries> & {
  transaction: {
    <R>(fn: (tx: TypedSql<TQueries, TFileQueries>) => Promise<R>): Promise<R>;
    <R>(opts: TTransactionOptions, fn: (tx: TypedSql<TQueries, TFileQueries>) => Promise<R>): Promise<R>;
  };
};
