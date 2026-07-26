import type { CacheEntry } from "../cache";
import {
  lookupArrayElementNullability,
  lookupColumnType,
  lookupJsonbType,
  type SqlxJsConfig,
} from "../config";
import type { ColumnSource } from "../pg/analyze";
import { arrayTsType, oidToTs, type ArrayElementNullability } from "../pg/oids";
import {
  effectiveParamTargets,
  type ParamMap,
  type ParamMapResult,
  type ParamTarget,
} from "../pg/param-map";
import { SchemaCache, compositeLiteral, type CustomTypeInfo } from "../pg/schema";
import type { FieldDescription } from "../pg/wire";

const JSON_OIDS = new Set([114, 3802]);
const JSON_ARRAY_OIDS = new Set([199, 3807]);
const JSON_INPUT_VALUE = "unknown";

function jsonParameter(type: string): string {
  return `import("@onreza/sqlx-js").JsonParameter<${type}>`;
}

function arrayParameter(type: string, nonNullElements: boolean): string {
  return `import("@onreza/sqlx-js").PgArrayParameter<${type}, ${nonNullElements ? "false" : "boolean"}>`;
}

function enumUnion(values: string[]): string {
  if (values.length === 0) return "never";
  return values.map((v) => JSON.stringify(v)).join(" | ");
}

function resolveTs(oid: number, customLookup: (o: number) => CustomTypeInfo | undefined): string {
  const c = customLookup(oid);
  if (c) {
    if (c.kind === "enum") return enumUnion(c.values);
    if (c.kind === "enumArray") return arrayTsType(enumUnion(c.element.values));
    if (c.kind === "scalar") return c.tsType;
    if (c.kind === "scalarArray") return arrayTsType(c.element.tsType, c.element.notNull ? "non-null" : "unknown");
    if (c.kind === "composite") return compositeLiteral(c);
    if (c.kind === "compositeArray") return arrayTsType(compositeLiteral(c.element));
  }
  return oidToTs(oid).ts;
}

function isScalarColumnType(oid: number, schema: SchemaCache): boolean {
  if (JSON_OIDS.has(oid) || JSON_ARRAY_OIDS.has(oid) || schema.arrayElement(oid) !== undefined) return false;
  const custom = schema.customType(oid);
  return custom?.kind !== "enumArray" && custom?.kind !== "scalarArray" && custom?.kind !== "compositeArray";
}

export function resolveColumnTs(
  f: FieldDescription,
  schema: SchemaCache,
  cfg: SqlxJsConfig,
  sources: ColumnSource[] | null = null,
  arrayElementNullability: ArrayElementNullability = "unknown",
): string {
  const directSource = directColumnSource(f, schema);
  const effectiveSources = directSource ? [directSource] : sources ?? [];
  const schemaArray = schema.arrayElement(f.typeOid);
  const nonNullElements = arrayElementNullability === "non-null"
    || schemaArray?.nullability === "non-null"
    || (effectiveSources.length > 0 && effectiveSources.every((source) =>
      lookupArrayElementNullability(cfg, source.schema, source.table, source.column) === "non-null"));
  if (f.tableOid !== 0 && f.columnAttr !== 0) {
    const tbl = schema.tableNameByOid(f.tableOid);
    const colName = schema.columnNameByAttno(f.tableOid, f.columnAttr);
    if (tbl && colName) {
      const configured = configuredColumnTs(f.typeOid, schema, cfg, {
        schema: tbl.schema,
        table: tbl.name,
        column: colName,
      }, nonNullElements);
      if (configured) return configured;
    }
  }
  if (sources && sources.length > 0) {
    const configured = sources.map((source) => configuredColumnTs(f.typeOid, schema, cfg, source, nonNullElements));
    if (configured.every((type): type is string => type !== undefined) && new Set(configured).size === 1) {
      return configured[0]!;
    }
  }
  if (schemaArray) return arrayTsType(schemaArray.tsType, nonNullElements ? "non-null" : "unknown");
  return resolveTs(f.typeOid, (oid) => schema.customType(oid));
}

function directColumnSource(f: FieldDescription, schema: SchemaCache): ColumnSource | undefined {
  if (f.tableOid === 0 || f.columnAttr === 0) return undefined;
  const table = schema.tableNameByOid(f.tableOid);
  const column = schema.columnNameByAttno(f.tableOid, f.columnAttr);
  return table && column ? { schema: table.schema, table: table.name, column } : undefined;
}

function configuredColumnTs(
  typeOid: number,
  schema: SchemaCache,
  cfg: SqlxJsConfig,
  source: ColumnSource,
  nonNullElements: boolean,
): string | undefined {
  if (JSON_OIDS.has(typeOid)) {
    return lookupJsonbType(cfg, source.schema, source.table, source.column);
  }
  if (JSON_ARRAY_OIDS.has(typeOid)) {
    const declaration = lookupJsonbType(cfg, source.schema, source.table, source.column);
    return declaration ? arrayTsType(declaration, nonNullElements ? "non-null" : "unknown") : undefined;
  }
  if (isScalarColumnType(typeOid, schema)) {
    return lookupColumnType(cfg, source.schema, source.table, source.column);
  }
  return undefined;
}

export function resolveParamTs(
  paramIndex: number,
  paramLabel: string,
  paramOid: number,
  paramMap: ParamMap,
  schema: SchemaCache,
  cfg: SqlxJsConfig,
): string {
  const sources = resolveParamSources(effectiveParamTargets(paramMap.get(paramIndex)), schema);
  const configuredNonNullElements = sources.some((source) =>
    lookupArrayElementNullability(cfg, source.schema, source.table, source.column) === "non-null");
  const schemaNonNullElements = schema.arrayElement(paramOid)?.nullability === "non-null";
  const nonNullElements = configuredNonNullElements || schemaNonNullElements;
  if (isScalarColumnType(paramOid, schema)) {
    const decl = resolveConfiguredParamDeclaration(
      paramLabel,
      "columnTypes",
      sources,
      (source) => lookupColumnType(cfg, source.schema, source.table, source.column),
    );
    if (decl) return decl;
  }
  if (JSON_OIDS.has(paramOid)) {
    const decl = resolveConfiguredParamDeclaration(
      paramLabel,
      "jsonbTypes",
      sources,
      (source) => lookupJsonbType(cfg, source.schema, source.table, source.column),
    );
    if (decl) return jsonParameter(decl);
    return jsonParameter(JSON_INPUT_VALUE);
  }
  if (JSON_ARRAY_OIDS.has(paramOid)) {
    const decl = resolveConfiguredParamDeclaration(
      paramLabel,
      "jsonbTypes",
      sources,
      (source) => lookupJsonbType(cfg, source.schema, source.table, source.column),
    );
    if (decl) return arrayParameter(jsonParameter(decl), nonNullElements);
    return arrayParameter(jsonParameter(JSON_INPUT_VALUE), nonNullElements);
  }
  const array = schema.arrayElement(paramOid);
  if (array) return arrayParameter(array.tsType, nonNullElements);
  const custom = schema.customType(paramOid);
  if (custom) {
    return resolveTs(paramOid, () => custom);
  }
  return resolveTs(paramOid, (oid) => schema.customType(oid));
}

function resolveParamSources(targets: ParamTarget[], schema: SchemaCache): ColumnSource[] {
  const sources = new Map<string, ColumnSource>();
  for (const target of targets) {
    const column = resolveTargetColumn(target, schema);
    const table = resolvedTargetTable(target, schema);
    if (!column || !table) continue;
    const source = { schema: table.schema, table: table.name, column };
    sources.set(JSON.stringify([source.schema, source.table, source.column]), source);
  }
  return [...sources.values()];
}

function resolveConfiguredParamDeclaration(
  paramLabel: string,
  configKey: "columnTypes" | "jsonbTypes",
  sources: ColumnSource[],
  lookup: (source: ColumnSource) => string | undefined,
): string | undefined {
  const declarations = new Map<string, string[]>();
  for (const source of sources) {
    const declaration = lookup(source);
    if (!declaration) continue;
    const columns = declarations.get(declaration) ?? [];
    columns.push(`${source.schema}.${source.table}.${source.column}`);
    declarations.set(declaration, columns);
  }
  if (declarations.size <= 1) return declarations.keys().next().value;
  const details = [...declarations]
    .map(([declaration, columns]) => `${columns.sort().join(", ")} -> ${declaration}`)
    .sort()
    .join("; ");
  throw new Error(`sqlx-js: parameter ${paramLabel} maps to conflicting ${configKey} declarations: ${details}`);
}

function resolvedTargetTable(
  target: { schema?: string; table: string },
  schema: SchemaCache,
): { schema: string; name: string } | undefined {
  const oid = schema.resolveTable(target.schema, target.table);
  return oid === undefined ? undefined : schema.tableNameByOid(oid);
}

function resolveTargetColumn(
  target: { schema?: string; table: string; column?: string; columnIndex?: number },
  schema: SchemaCache,
): string | undefined {
  if (target.column) return target.column;
  if (target.columnIndex === undefined) return undefined;
  const oid = schema.resolveTable(target.schema, target.table);
  if (oid === undefined) return undefined;
  const cols = schema.columnsOf(oid);
  if (!cols) return undefined;
  return [...cols.values()].sort((a, b) => a.attnum - b.attnum)[target.columnIndex - 1]?.name;
}

export function resolveParamNullable(
  paramIndex: number,
  pm: ParamMapResult,
  schema: SchemaCache,
): boolean {
  const binding = pm.bindings.get(paramIndex);
  const dmlTargets = binding?.dmlTargets ?? [];
  if (dmlTargets.length === 0) return pm.forceNullable.has(paramIndex);
  const propagated = dmlTargets.filter((candidate) => !candidate.nullSafe);
  const dmlAcceptsNull = propagated.length === 0 || propagated.every(({ target }) => {
    const oid = schema.resolveTable(target.schema, target.table);
    if (oid === undefined) return false;
    const column = resolveTargetColumn(target, schema);
    if (!column) return false;
    const col = schema.columnsOf(oid)?.get(column);
    return col ? !col.notNull : false;
  });
  if (!dmlAcceptsNull) return false;
  return binding?.referenceTargets.length === 0 || pm.forceNullable.has(paramIndex);
}

export function columnInference(
  nullable: boolean,
  sources: ColumnSource[] | null,
  schema: SchemaCache,
  degraded?: { reason: string },
  override?: "non-null" | "nullable",
): CacheEntry["inference"]["columns"][number] {
  const resolvedSources = sources?.map((source) => {
    const tableOid = schema.resolveTable(source.schema, source.table);
    const column = tableOid === undefined ? undefined : schema.columnsOf(tableOid)?.get(source.column);
    return {
      ...source,
      ...(column ? { notNull: column.notNull } : {}),
    };
  }) ?? null;
  if (override) {
    return {
      sources: resolvedSources,
      reason: `forced ${override} by the result alias`,
      hint: "Keep alias overrides limited to application invariants that PostgreSQL cannot express",
    };
  }
  if (degraded) {
    return {
      sources: resolvedSources,
      reason: `conservative fallback: ${degraded.reason}`,
      hint: "Add the unsupported query shape to the corpus before extending inference",
    };
  }
  if (!resolvedSources || resolvedSources.length === 0) {
    return nullable
      ? {
        sources: null,
        reason: "the supported SQL expression can produce NULL",
        hint: "Use an explicit projection or a ! alias only when an application invariant proves non-null",
      }
      : {
        sources: null,
        reason: "the supported SQL expression is proven non-null",
      };
  }
  if (nullable) {
    return resolvedSources.some((source) => source.notNull === false)
      ? {
        sources: resolvedSources,
        reason: "at least one source column allows NULL",
        hint: "Add a NOT NULL constraint or a supported narrowing predicate when that matches the schema contract",
      }
      : {
        sources: resolvedSources,
        reason: "widened by outer-join or nullable expression semantics",
        hint: "Use an explicit projection or a ! alias only when an application invariant proves non-null",
      };
  }
  return resolvedSources.some((source) => source.notNull === false)
    ? {
      sources: resolvedSources,
      reason: "narrowed to non-null by the query",
    }
    : {
      sources: resolvedSources,
      reason: "all source columns are NOT NULL",
    };
}

export function paramInference(
  paramIndex: number,
  nullable: boolean,
  pm: ParamMapResult,
): CacheEntry["inference"]["params"][number] {
  const binding = pm.bindings.get(paramIndex);
  const targets = [
    ...(binding?.dmlTargets ?? []).map(({ target, nullSafe }) => ({
      kind: "dml" as const,
      ...target,
      ...(nullSafe ? { nullSafe: true } : {}),
    })),
    ...(binding?.referenceTargets ?? []).map((target) => ({
      kind: "predicate" as const,
      ...target,
    })),
  ];
  if (targets.length === 0) {
    return {
      targets,
      reason: nullable
        ? "the parameter has an explicit nullable branch"
        : "PostgreSQL inferred the type without a direct column target",
      hint: "Add an explicit PostgreSQL cast when the inferred type is not the intended wire contract",
    };
  }
  return {
    targets,
    reason: nullable
      ? pm.forceNullable.has(paramIndex)
        ? "a NULL-safe SQL branch explicitly accepts NULL"
        : "all stored targets accept NULL and no strict predicate forbids it"
      : binding?.dmlTargets.length
        ? "a stored target or strict predicate requires a non-null value"
        : "a predicate reference requires a non-null value",
  };
}

const ALIAS_OVERRIDE = /^(.+?)([!?])$/;

export function parseColumnOverride(name: string): { name: string; override?: "non-null" | "nullable" } {
  const m = ALIAS_OVERRIDE.exec(name);
  if (!m) return { name };
  return { name: m[1]!, override: m[2] === "!" ? "non-null" : "nullable" };
}

export function isAliasOrExpression(f: FieldDescription, schema: SchemaCache): boolean {
  if (f.tableOid === 0 || f.columnAttr === 0) return true;
  const real = schema.columnNameByAttno(f.tableOid, f.columnAttr);
  return real !== undefined && real !== f.name;
}

export function duplicateOutputColumns(fields: FieldDescription[]): string[] {
  const counts = new Map<string, number>();
  for (const field of fields) {
    const name = parseColumnOverride(field.name).name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([name]) => name).sort();
}
