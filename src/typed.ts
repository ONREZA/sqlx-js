type ParamsOf<T> = T extends { params: infer P extends readonly unknown[] } ? P : never[];
type RowOf<T> = T extends { row: infer R } ? R : never;

export type TypedFile<TFileQueries> = {
  <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>): Promise<RowOf<TFileQueries[P]>[]>;
  one: <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>) => Promise<RowOf<TFileQueries[P]>>;
  optional: <P extends keyof TFileQueries>(path: P, ...params: ParamsOf<TFileQueries[P]>) => Promise<RowOf<TFileQueries[P]> | null>;
};

export type TypedSql<TQueries, TFileQueries> = {
  <Q extends keyof TQueries>(query: Q, ...params: ParamsOf<TQueries[Q]>): Promise<RowOf<TQueries[Q]>[]>;
  one: <Q extends keyof TQueries>(query: Q, ...params: ParamsOf<TQueries[Q]>) => Promise<RowOf<TQueries[Q]>>;
  optional: <Q extends keyof TQueries>(query: Q, ...params: ParamsOf<TQueries[Q]>) => Promise<RowOf<TQueries[Q]> | null>;
  file: TypedFile<TFileQueries>;
  id: (...parts: string[]) => string;
};

export type Typed<TQueries, TFileQueries, TTransactionOptions> = TypedSql<TQueries, TFileQueries> & {
  transaction: {
    <R>(fn: (tx: TypedSql<TQueries, TFileQueries>) => Promise<R>): Promise<R>;
    <R>(opts: TTransactionOptions, fn: (tx: TypedSql<TQueries, TFileQueries>) => Promise<R>): Promise<R>;
  };
};
