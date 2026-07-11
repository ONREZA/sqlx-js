import { queryId } from "./query-id";
import type { ExecuteResult } from "./runtime";
import type { TypedSql } from "./typed";

export type QueryExecutionMode = "many" | "one" | "optional" | "execute";
export type QueryExecutionMetadata = { queryId: string; queryName?: string };
export const QUERY_EXECUTOR: unique symbol = Symbol.for("@onreza/sqlx-js.query-executor") as never;

export type QueryExecutorMethod = (
  mode: QueryExecutionMode,
  query: string,
  params: unknown[],
  metadata: QueryExecutionMetadata,
) => Promise<unknown>;

type QueryEntry = { params: unknown; row: unknown };
type ParamsOf<T> = T extends { params: infer P }
  ? P extends readonly unknown[] ? P : [P]
  : never[];
type RowOf<T> = T extends { row: infer R } ? R : never;
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
  run<Queries extends Record<Query, QueryEntry>, FileQueries>(
    executor: TypedSql<Queries, FileQueries>,
    ...params: ParamsOf<Queries[Query]>
  ): Promise<QueryModeResult<Mode, RowOf<Queries[Query]>>>;
};

type DefinitionQuery<Definition> = Definition extends QueryDefinition<infer Query, QueryExecutionMode> ? Query : never;
type DefinitionMode<Definition> = Definition extends QueryDefinition<string, infer Mode> ? Mode : never;
type RegistryQuery<Definition, Registry extends { queries: object }> =
  DefinitionQuery<Definition> extends keyof Registry["queries"]
    ? Registry["queries"][DefinitionQuery<Definition>]
    : never;

export type QueryParamsFor<Definition, Registry extends { queries: object }> =
  RegistryQuery<Definition, Registry> extends { params: infer Params } ? Params : never;
export type QueryRowFor<Definition, Registry extends { queries: object }> = RowOf<RegistryQuery<Definition, Registry>>;
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
    type RuntimeExecutor = {
      (query: string, ...params: unknown[]): Promise<unknown>;
      one(query: string, ...params: unknown[]): Promise<unknown>;
      optional(query: string, ...params: unknown[]): Promise<unknown>;
      execute(query: string, ...params: unknown[]): Promise<unknown>;
      readonly [QUERY_EXECUTOR]?: QueryExecutorMethod;
    };
    return Object.freeze({
      query,
      mode,
      queryId: metadata.queryId,
      ...(name ? { queryName: name } : {}),
      async run(executor: RuntimeExecutor, ...params: unknown[]) {
        const execute = executor[QUERY_EXECUTOR];
        if (execute) return await execute(mode, query, params, metadata);
        if (mode === "one") return await executor.one(query, ...params);
        if (mode === "optional") return await executor.optional(query, ...params);
        if (mode === "execute") return await executor.execute(query, ...params);
        return await executor(query, ...params);
      },
    });
  }) as unknown as DefineQueryMethod<Mode>;
}

export const defineQuery = Object.assign(definitionMethod("many"), {
  one: definitionMethod("one"),
  optional: definitionMethod("optional"),
  execute: definitionMethod("execute"),
});
