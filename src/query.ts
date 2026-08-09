import { queryId } from "./query-id";
import { rewriteNamedParameters } from "./sql-params";
import type { ExecuteResult, QueryExecutionOptions } from "./runtime";
import type { TypedSqlForRegistry } from "./typed";

export type QueryExecutionMode = "many" | "one" | "optional" | "execute";
export type QueryExecutionMetadata = { queryId: string; queryName?: string };
export type QueryValidationExpectation = "parse-only";
export type QueryResultElementAssertion = { readonly elements: "non-null" };
export type QueryResultAssertions = Readonly<Record<string, QueryResultElementAssertion>>;
export type QueryTimestampWithoutTimeZonePolicy =
  | "reject"
  | { readonly allow: true; readonly reason: string };
export type DefineQueryOptions = {
  nullableParams?: readonly (string | number)[];
  expectedValidation?: QueryValidationExpectation;
  resultAssertions?: QueryResultAssertions;
  temporal?: {
    readonly timestampWithoutTimeZone: QueryTimestampWithoutTimeZonePolicy;
  };
};
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
declare const MAPPED_QUERY_INPUT: unique symbol;
declare const MAPPED_QUERY_WIRE_PARAMS: unique symbol;
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
  readonly profiles?: readonly string[];
  mapParams<Input, const WireParams extends QueryWireParams>(
    mapper: (input: Input, helpers: QueryParameterHelpers) => WireParams,
  ): MappedQueryDefinition<Query, Mode, Input, WireParams>;
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

type ReadonlyWireParams<Params> = Readonly<Params>;

type ExactWireShape<Actual extends QueryWireParams, Expected> =
  [Actual] extends [ReadonlyWireParams<Expected>]
    ? [Exclude<keyof Actual, keyof Expected>] extends [never]
      ? true
      : false
    : false;

export type MappedQueryDefinition<
  Query extends string = string,
  Mode extends QueryExecutionMode = QueryExecutionMode,
  Input = unknown,
  WireParams extends QueryWireParams = QueryWireParams,
> = {
  readonly query: Query;
  readonly mode: Mode;
  readonly queryId: string;
  readonly queryName?: string;
  readonly profiles?: readonly string[];
  readonly [MAPPED_QUERY_INPUT]: Input;
  readonly [MAPPED_QUERY_WIRE_PARAMS]: WireParams;
  run<Registry extends { queries: Record<Query, QueryEntry>; fileQueries: object }>(
    executor: MappedExecutor<Query, Registry, WireParams>,
    input: Input,
    options?: QueryExecutionOptions,
  ): Promise<QueryResultFor<MappedQueryDefinition<Query, Mode, Input>, Registry>>;
  runWith<Registry extends { queries: Record<Query, QueryEntry>; fileQueries: object }>(
    options: QueryExecutionOptions,
    executor: MappedExecutor<Query, Registry, WireParams>,
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
type MappedExecutor<
  Query extends string,
  Registry extends { queries: object; fileQueries: object },
  WireParams extends QueryWireParams,
> = ExactWireShape<WireParams, RegistryParams<Query, NoInfer<Registry>>> extends false
  ? never
  : TypedSqlForRegistry<Registry>;

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
  <const Query extends string>(query: Query, options?: DefineQueryOptions): QueryDefinition<Query, Mode>;
  <const Query extends string>(
    name: string,
    query: Query,
    options?: DefineQueryOptions,
  ): QueryDefinition<Query, Mode>;
};

function validateDefinitionOptions(
  query: string,
  options: DefineQueryOptions | undefined,
  queryName: string | undefined,
): void {
  if (!options) return;
  if (options.expectedValidation !== undefined && options.expectedValidation !== "parse-only") {
    throw new Error("sqlx-js.defineQuery: expectedValidation must be \"parse-only\"");
  }
  if (options.temporal !== undefined) {
    if (!options.temporal || typeof options.temporal !== "object" || Array.isArray(options.temporal)) {
      throw new Error("sqlx-js.defineQuery: temporal must be an object");
    }
    const keys = Object.keys(options.temporal);
    if (keys.length !== 1 || keys[0] !== "timestampWithoutTimeZone") {
      throw new Error("sqlx-js.defineQuery: temporal must contain timestampWithoutTimeZone");
    }
  }
  const timestampPolicy = options.temporal?.timestampWithoutTimeZone;
  if (options.temporal !== undefined && timestampPolicy === undefined) {
    throw new Error("sqlx-js.defineQuery: temporal must contain timestampWithoutTimeZone");
  }
  if (timestampPolicy !== undefined && timestampPolicy !== "reject") {
    if (
      !timestampPolicy
      || typeof timestampPolicy !== "object"
      || Array.isArray(timestampPolicy)
    ) {
      throw new Error(
        "sqlx-js.defineQuery: temporal.timestampWithoutTimeZone allow requires a non-empty reason",
      );
    }
    const unknown = Object.keys(timestampPolicy).find((key) => key !== "allow" && key !== "reason");
    if (unknown) {
      throw new Error(
        `sqlx-js.defineQuery: temporal.timestampWithoutTimeZone allow has unknown option ${JSON.stringify(unknown)}`,
      );
    }
    if (
      Object.keys(timestampPolicy).length !== 2
      || !Object.hasOwn(timestampPolicy, "allow")
      || !Object.hasOwn(timestampPolicy, "reason")
      || timestampPolicy.allow !== true
      || typeof timestampPolicy.reason !== "string"
      || timestampPolicy.reason.trim() === ""
    ) {
      throw new Error(
        "sqlx-js.defineQuery: temporal.timestampWithoutTimeZone allow requires a non-empty reason",
      );
    }
    if (!queryName) {
      throw new Error(
        "sqlx-js.defineQuery: temporal.timestampWithoutTimeZone allow requires a named query",
      );
    }
  }
  if (options.nullableParams !== undefined) {
    if (!Array.isArray(options.nullableParams)) {
      throw new Error("sqlx-js.defineQuery: nullableParams must be an array");
    }
    const rewritten = rewriteNamedParameters(query);
    const named = rewritten.names.length > 0;
    const seen = new Set<string | number>();
    for (const param of options.nullableParams) {
      const valid = named
        ? typeof param === "string" && rewritten.names.includes(param)
        : typeof param === "number" && Number.isSafeInteger(param) && param >= 1 && param <= rewritten.positionalCount;
      if (!valid) {
        throw new Error(
          named
            ? `sqlx-js.defineQuery: nullableParams must reference named query parameters (${rewritten.names.join(", ")})`
            : `sqlx-js.defineQuery: nullableParams must contain 1-based indexes up to ${rewritten.positionalCount}`,
        );
      }
      if (seen.has(param)) throw new Error("sqlx-js.defineQuery: nullableParams must be unique");
      seen.add(param);
    }
  }
  if (options.resultAssertions !== undefined) {
    if (
      !options.resultAssertions
      || typeof options.resultAssertions !== "object"
      || Array.isArray(options.resultAssertions)
    ) {
      throw new Error("sqlx-js.defineQuery: resultAssertions must be an object");
    }
    for (const [column, assertion] of Object.entries(options.resultAssertions)) {
      if (!column) throw new Error("sqlx-js.defineQuery: resultAssertions column names must not be empty");
      if (
        !assertion
        || typeof assertion !== "object"
        || Array.isArray(assertion)
        || Object.keys(assertion).length !== 1
        || assertion.elements !== "non-null"
      ) {
        throw new Error(
          `sqlx-js.defineQuery: resultAssertions.${column} must be { elements: \"non-null\" }`,
        );
      }
    }
  }
}

function definitionMethod<Mode extends QueryExecutionMode, Profiles extends readonly string[] = readonly []>(
  mode: Mode,
  profiles: Profiles = [] as unknown as Profiles,
): DefineQueryMethod<Mode> {
  return ((
    nameOrQuery: string,
    queryOrOptions?: string | DefineQueryOptions,
    namedOptions?: DefineQueryOptions,
  ) => {
    const namedDefinition = typeof queryOrOptions === "string";
    const query = namedDefinition ? queryOrOptions : nameOrQuery;
    const name = namedDefinition ? nameOrQuery : undefined;
    const options = namedDefinition ? namedOptions : queryOrOptions;
    if (name !== undefined && name.trim() === "") {
      throw new Error("sqlx-js.defineQuery: query name must not be empty");
    }
    validateDefinitionOptions(query, options, name);
    const metadata: QueryExecutionMetadata = {
      queryId: queryId(query),
      ...(name ? { queryName: name } : {}),
    };
    const declaredProfiles = profiles.length > 0 ? Object.freeze([...profiles]) : undefined;
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
      ...(declaredProfiles ? { profiles: declaredProfiles } : {}),
      mapParams<Input, WireParams extends QueryWireParams>(
        mapper: (input: Input, helpers: QueryParameterHelpers) => WireParams,
      ) {
        return Object.freeze({
          query,
          mode,
          queryId: metadata.queryId,
          ...(name ? { queryName: name } : {}),
          ...(declaredProfiles ? { profiles: declaredProfiles } : {}),
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
  for<const Profiles extends readonly string[]>(...profiles: Profiles) {
    if (profiles.length === 0) {
      throw new Error("sqlx-js.defineQuery.for: at least one profile is required");
    }
    if (profiles.some((profile) => profile.trim() === "")) {
      throw new Error("sqlx-js.defineQuery.for: profile names must not be empty");
    }
    if (new Set(profiles).size !== profiles.length) {
      throw new Error("sqlx-js.defineQuery.for: profile names must be unique");
    }
    const declared = Object.freeze([...profiles]) as unknown as Profiles;
    return Object.freeze({
      many: definitionMethod("many", declared),
      one: definitionMethod("one", declared),
      optional: definitionMethod("optional", declared),
      execute: definitionMethod("execute", declared),
    });
  },
});
