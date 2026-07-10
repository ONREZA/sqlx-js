import * as rt from "./postgres-runtime";
import type { Typed as TypedFor, TypedFile as TypedFileFor, TypedSql as TypedSqlFor } from "./typed";

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
export { NoRowsError, TooManyRowsError } from "./runtime";
export type { TransactionOptions, MigrateOptions, OnQueryEvent, OnQueryHook } from "./runtime";
export type { ExecuteResult, JsonParameter, PgArrayParameter } from "./runtime";
export type { PostgresClient, PostgresOptions, CreateClientOptions } from "./postgres-runtime";

export type TypedFile = TypedFileFor<KnownFileQueries>;
export type TypedSql = TypedSqlFor<KnownQueries, KnownFileQueries>;
export type Typed = TypedFor<KnownQueries, KnownFileQueries, import("./runtime").TransactionOptions>;

export const sql: Typed = rt.sql as unknown as Typed;

export type Unsafe = (query: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
export const unsafe: Unsafe = rt.unsafe as Unsafe;
export const getClient = rt.getClient;
export const setClient = rt.setClient;
export const createClient = rt.createClient;
export const close = rt.close;
export { migrate, clearSqlFileCache, encodePgArrayLiteral, id, json, array } from "./runtime";
