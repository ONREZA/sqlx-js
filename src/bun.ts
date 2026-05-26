import * as rt from "./bun-runtime";
import type { Typed as TypedFor, TypedFile as TypedFileFor, TypedSql as TypedSqlFor } from "./typed";

export interface KnownQueries {}
export interface KnownFileQueries {}

export type { SqlxJsConfig } from "./config";
export type { SslMode, ConnConfig } from "./pg/wire";
export { PgError, ConnectionLostError } from "./pg/wire";
export { NoRowsError, TooManyRowsError } from "./runtime";
export type { TransactionOptions, MigrateOptions } from "./runtime";
export type { BunClient } from "./bun-runtime";

export type TypedFile = TypedFileFor<KnownFileQueries>;
export type TypedSql = TypedSqlFor<KnownQueries, KnownFileQueries>;
export type Typed = TypedFor<KnownQueries, KnownFileQueries, import("./runtime").TransactionOptions>;

export const sql: Typed = rt.sql as unknown as Typed;

export type Unsafe = (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
export const unsafe: Unsafe = rt.unsafe as Unsafe;
export const getClient = rt.getClient;
export const setClient = rt.setClient;
export const close = rt.close;
export { migrate, clearSqlFileCache, encodePgArrayLiteral, id } from "./runtime";
