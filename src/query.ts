import { queryId } from "./query-id";
import { rewriteNamedParameters } from "./sql-params";
import type { ExecuteResult, QueryExecutionOptions } from "./runtime";
import type { TypedSqlForRegistry } from "./typed";

export type QueryExecutionMode = "many" | "one" | "optional" | "execute";
export type QueryExecutionMetadata = { queryId: string; queryName?: string };
export const QUERY_EXECUTOR: unique symbol = Symbol.for("@onreza/sqlx-js.query-executor") as never;

export type QueryExecutorMethod = (
  mode: QueryExecutionMode,
  query: string,
  params: unknown[],
  metadata: QueryExecutionMetadata,
  options?: QueryExecutionOptions,
) => Promise<unknown>;

type NamedQueryEntry = { params: Record<string, unknown>; row: unknown };
type PositionalQueryEntry = { params: readonly unknown[]; row: unknown };
type QueryEntry = NamedQueryEntry | PositionalQueryEntry;
type QueryWireParams = Record<string, unknown> | readonly unknown[];
type KnownQueryEntry<Query extends string> = Query extends keyof import("./index").KnownQueries
  ? import("./index").KnownQueries[Query]
  : never;
type KnownQueryWireParams<Query extends string> = [KnownQueryEntry<Query>] extends [never]
  ? QueryWireParams
  : KnownQueryEntry<Query> extends { params: infer Params extends QueryWireParams } ? Params : QueryWireParams;
type CheckedMappedWireParams<Query extends string, WireParams extends QueryWireParams> =
  [KnownQueryEntry<Query>] extends [never]
    ? WireParams
    : WireParams extends ReadonlyWireParams<KnownQueryWireParams<Query>>
      ? KnownQueryWireParams<Query> extends readonly unknown[]
        ? WireParams
        : Exclude<keyof WireParams, keyof KnownQueryWireParams<Query>> extends never
          ? WireParams
          : WireParams & {
            [Key in Exclude<keyof WireParams, keyof KnownQueryWireParams<Query>>]: never;
          }
      : ReadonlyWireParams<KnownQueryWireParams<Query>>;
declare const MAPPED_QUERY_INPUT: unique symbol;
type QueryModeResult<Mode extends QueryExecutionMode, Row> =
  Mode extends "many" ? Row[]
    : Mode extends "one" ? Row
      : Mode extends "optional" ? Row | null
        : ExecuteResult;

export type QueryDefinition<
  Query extends string = string,
  Mode extends QueryExecutionMode = QueryExecutionMode,
> = {
  readonly query: Query;
  readonly mode: Mode;
  readonly queryId: string;
  readonly queryName?: string;
  mapParams<Input, const WireParams extends QueryWireParams>(
    mapper: (input: Input, helpers: QueryParameterHelpers) => CheckedMappedWireParams<Query, WireParams>,
  ): MappedQueryDefinition<Query, Mode, Input>;
  run<Registry extends { queries: Record<Query, NamedQueryEntry>; fileQueries: object }>(
    executor: TypedSqlForRegistry<Registry>,
    params: RegistryParams<Query, Registry>,
    options?: QueryExecutionOptions,
  ): Promise<QueryResultFor<QueryDefinition<Query, Mode>, Registry>>;
  run<Registry extends { queries: Record<Query, PositionalQueryEntry>; fileQueries: object }>(
    executor: TypedSqlForRegistry<Registry>,
    ...params: RegistryParams<Query, Registry> & readonly unknown[]
  ): Promise<QueryResultFor<QueryDefinition<Query, Mode>, Registry>>;
  runWith<Registry extends { queries: Record<Query, QueryEntry>; fileQueries: object }>(
    options: QueryExecutionOptions,
    executor: TypedSqlForRegistry<Registry>,
    ...params: RegistryParams<Query, Registry> extends readonly unknown[]
      ? RegistryParams<Query, Registry>
      : [RegistryParams<Query, Registry>]
  ): Promise<QueryResultFor<QueryDefinition<Query, Mode>, Registry>>;
};

export type QueryParameterHelpers = Pick<
  TypedSqlForRegistry<{ queries: object; fileQueries: object }>,
  "json" | "array"
>;

type ReadonlyWireParams<Params> = Params extends readonly unknown[] ? Readonly<Params> : Params;

export type MappedQueryDefinition<
  Query extends string = string,
  Mode extends QueryExecutionMode = QueryExecutionMode,
  Input = unknown,
> = {
  readonly query: Query;
  readonly mode: Mode;
  readonly queryId: string;
  readonly queryName?: string;
  readonly [MAPPED_QUERY_INPUT]: Input;
  run<Registry extends { queries: Record<Query, QueryEntry>; fileQueries: object }>(
    executor: TypedSqlForRegistry<Registry>,
    input: Input,
    options?: QueryExecutionOptions,
  ): Promise<QueryResultFor<MappedQueryDefinition<Query, Mode, Input>, Registry>>;
  runWith<Registry extends { queries: Record<Query, QueryEntry>; fileQueries: object }>(
    options: QueryExecutionOptions,
    executor: TypedSqlForRegistry<Registry>,
    input: Input,
  ): Promise<QueryResultFor<MappedQueryDefinition<Query, Mode, Input>, Registry>>;
};

type DefinitionQuery<Definition> = Definition extends { readonly query: infer Query extends string } ? Query : never;
type DefinitionMode<Definition> =
  Definition extends { readonly mode: infer Mode extends QueryExecutionMode } ? Mode : never;
type RegistryQuery<Query extends string, Registry extends { queries: object }> = Registry extends {
  queries: Record<Query, infer Entry>;
} ? Entry : never;
type RegistryParams<Query extends string, Registry extends { queries: object }> =
  RegistryQuery<Query, Registry>["params" & keyof RegistryQuery<Query, Registry>];
type RegistryRow<Query extends string, Registry extends { queries: object }> =
  RegistryQuery<Query, Registry>["row" & keyof RegistryQuery<Query, Registry>];

export type QueryWireParamsFor<Definition, Registry extends { queries: object }> =
  RegistryParams<DefinitionQuery<Definition>, Registry>;
export type QueryParamsFor<Definition, Registry extends { queries: object }> = Definition extends {
  readonly [MAPPED_QUERY_INPUT]: infer Input;
} ? Input : QueryWireParamsFor<Definition, Registry>;
export type QueryRowFor<Definition, Registry extends { queries: object }> =
  RegistryRow<DefinitionQuery<Definition>, Registry>;
export type QueryResultFor<Definition, Registry extends { queries: object }> = QueryModeResult<
  DefinitionMode<Definition>,
  QueryRowFor<Definition, Registry>
>;

type DefineQueryMethod<Mode extends QueryExecutionMode> = {
  <const Query extends string>(query: Query): QueryDefinition<Query, Mode>;
  <const Query extends string>(name: string, query: Query): QueryDefinition<Query, Mode>;
};

function definitionMethod<Mode extends QueryExecutionMode>(mode: Mode): DefineQueryMethod<Mode> {
  return ((nameOrQuery: string, maybeQuery?: string) => {
    const query = maybeQuery ?? nameOrQuery;
    const name = maybeQuery === undefined ? undefined : nameOrQuery;
    if (name !== undefined && name.trim() === "") {
      throw new Error("sqlx-js.defineQuery: query name must not be empty");
    }
    const metadata: QueryExecutionMetadata = {
      queryId: queryId(query),
      ...(name ? { queryName: name } : {}),
    };
    const named = rewriteNamedParameters(query).names.length > 0;
    type RuntimeExecutor = {
      (query: string, ...params: unknown[]): Promise<unknown>;
      one(query: string, ...params: unknown[]): Promise<unknown>;
      optional(query: string, ...params: unknown[]): Promise<unknown>;
      execute(query: string, ...params: unknown[]): Promise<unknown>;
      json: QueryParameterHelpers["json"];
      array: QueryParameterHelpers["array"];
      readonly [QUERY_EXECUTOR]?: QueryExecutorMethod;
    };
    const run = async (executor: RuntimeExecutor, params: unknown[], options?: QueryExecutionOptions) => {
      const execute = executor[QUERY_EXECUTOR];
      if (execute) return await execute(mode, query, params, metadata, options);
      if (options) {
        throw new Error("sqlx-js.defineQuery: execution options require a managed sqlx-js executor");
      }
      if (mode === "one") return await executor.one(query, ...params);
      if (mode === "optional") return await executor.optional(query, ...params);
      if (mode === "execute") return await executor.execute(query, ...params);
      return await executor(query, ...params);
    };
    const definition = {
      query,
      mode,
      queryId: metadata.queryId,
      ...(name ? { queryName: name } : {}),
      mapParams<Input, WireParams extends QueryWireParams>(
        mapper: (input: Input, helpers: QueryParameterHelpers) => WireParams,
      ) {
        return Object.freeze({
          query,
          mode,
          queryId: metadata.queryId,
          ...(name ? { queryName: name } : {}),
          async run(executor: RuntimeExecutor, input: Input, options?: QueryExecutionOptions) {
            const mapped = mapper(input, { json: executor.json, array: executor.array });
            return await run(executor, Array.isArray(mapped) ? [...mapped] : [mapped], options);
          },
          async runWith(options: QueryExecutionOptions, executor: RuntimeExecutor, input: Input) {
            const mapped = mapper(input, { json: executor.json, array: executor.array });
            return await run(executor, Array.isArray(mapped) ? [...mapped] : [mapped], options);
          },
        });
      },
      async run(executor: RuntimeExecutor, ...params: unknown[]) {
        const options = named && params.length > 1
          ? params.pop() as QueryExecutionOptions
          : undefined;
        return await run(executor, params, options);
      },
      async runWith(options: QueryExecutionOptions, executor: RuntimeExecutor, ...params: unknown[]) {
        return await run(executor, params, options);
      },
    };
    return Object.freeze(definition);
  }) as unknown as DefineQueryMethod<Mode>;
}

export const defineQuery = Object.assign(definitionMethod("many"), {
  one: definitionMethod("one"),
  optional: definitionMethod("optional"),
  execute: definitionMethod("execute"),
});
