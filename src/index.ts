import * as rt from "./runtime";

export interface KnownQueries {}
export interface KnownFileQueries {}

export type { BunSqlxConfig } from "./config";
export type { SslMode, ConnConfig } from "./pg/wire";
export { PgError, ConnectionLostError } from "./pg/wire";
export { NoRowsError, TooManyRowsError } from "./runtime";
export type { TransactionOptions, MigrateOptions } from "./runtime";

type ParamsOf<T> = T extends { params: infer P extends readonly unknown[] } ? P : never[];
type RowOf<T> = T extends { row: infer R } ? R : never;

export type TypedFile = {
  <P extends keyof KnownFileQueries>(path: P, ...params: ParamsOf<KnownFileQueries[P]>): Promise<RowOf<KnownFileQueries[P]>[]>;
  one: <P extends keyof KnownFileQueries>(path: P, ...params: ParamsOf<KnownFileQueries[P]>) => Promise<RowOf<KnownFileQueries[P]>>;
  optional: <P extends keyof KnownFileQueries>(path: P, ...params: ParamsOf<KnownFileQueries[P]>) => Promise<RowOf<KnownFileQueries[P]> | null>;
};

export type TypedSql = {
  <Q extends keyof KnownQueries>(query: Q, ...params: ParamsOf<KnownQueries[Q]>): Promise<RowOf<KnownQueries[Q]>[]>;
  one: <Q extends keyof KnownQueries>(query: Q, ...params: ParamsOf<KnownQueries[Q]>) => Promise<RowOf<KnownQueries[Q]>>;
  optional: <Q extends keyof KnownQueries>(query: Q, ...params: ParamsOf<KnownQueries[Q]>) => Promise<RowOf<KnownQueries[Q]> | null>;
  file: TypedFile;
};

export type Typed = TypedSql & {
  transaction: {
    <R>(fn: (tx: TypedSql) => Promise<R>): Promise<R>;
    <R>(opts: rt.TransactionOptions, fn: (tx: TypedSql) => Promise<R>): Promise<R>;
  };
};

export const sql: Typed = rt.sql as unknown as Typed;

export type Unsafe = (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
export const unsafe: Unsafe = rt.unsafe as Unsafe;
export const getClient = rt.getClient;
export const setClient = rt.setClient;
export const close = rt.close;
export const migrate = rt.migrate;
export const clearSqlFileCache = rt.clearSqlFileCache;
export const encodePgArrayLiteral = rt.encodePgArrayLiteral;
