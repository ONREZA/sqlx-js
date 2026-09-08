import type { AnalyzedColumn, ColumnSource, NamedColumn, Scope } from "./analyze-types";
import type { FieldDescription } from "./wire";
import type { SchemaCache } from "./schema";
import { isNarrowed } from "./narrow";
import { visibleAliasName } from "./relation-alias";

export type { NamedColumn } from "./analyze-types";

export function aliasQualifiers(aliasKey: string, scope: Scope): string[] {
  const name = visibleAliasName(aliasKey);
  const keys = new Set([aliasKey, name]);
  const alias = scope.aliases.get(aliasKey);
  const oid = scope.aliasOidByName.get(aliasKey);
  const schema = alias?.kind === "table"
    ? alias.schema ?? (oid === undefined ? undefined : scope.schema.tableNameByOid(oid)?.schema)
    : undefined;
  if (schema) keys.add(`${schema}\0${name}`);
  return [...keys];
}

export function isAliasNarrowed(aliasKey: string, column: string, scope: Scope): boolean {
  return aliasQualifiers(aliasKey, scope).some((key) => isNarrowed(scope.forcedNonNull, key, column));
}

function baseColumns(aliasName: string, scope: Scope): NamedColumn[] | undefined {
  const alias = scope.aliases.get(aliasName);
  if (!alias) return undefined;
  if (alias.kind === "cte" || alias.kind === "subquery") return [...alias.columns];
  if (alias.kind !== "table") return undefined;
  const oid = scope.aliasOidByName.get(aliasName);
  const table = oid === undefined ? undefined : scope.schema.tableNameByOid(oid);
  const columns = oid === undefined ? undefined : scope.schema.columnsOf(oid);
  if (!table || !columns) return undefined;
  return [...columns].filter(([, column]) => column.attnum > 0)
    .sort((left, right) => left[1].attnum - right[1].attnum)
    .map(([name, column]) => [name, {
      nullable: !column.notNull,
      sources: [{ schema: table.schema, table: table.name, column: name }],
      arrayElementNullability: scope.schema.arrayElement?.(column.typeOid)?.nullability ?? "unknown",
    }]);
}

function scopedColumn(aliasName: string, name: string, column: AnalyzedColumn, scope: Scope): AnalyzedColumn {
  const alias = scope.aliases.get(aliasName)!;
  const returning = alias.kind === "table" ? alias.returning : undefined;
  const narrowed = returning
    ? returning.nonNullColumns.has(name)
    : isAliasNarrowed(aliasName, name, scope);
  return { ...column, nullable: narrowed ? false : column.nullable || alias.joinNullable };
}

function columnsForAlias(aliasName: string, scope: Scope): NamedColumn[] | undefined {
  const alias = scope.aliases.get(aliasName);
  const columns = baseColumns(aliasName, scope);
  return columns?.map(([name, column], index) => {
    const outputName = alias?.columnAliases?.[index] ?? name;
    return [outputName, scopedColumn(aliasName, outputName, column, scope)];
  });
}

function columnForAlias(aliasName: string, name: string, scope: Scope): AnalyzedColumn | undefined {
  const alias = scope.aliases.get(aliasName);
  if (!alias) return undefined;
  if (alias.columnAliases?.length) {
    const matches = columnsForAlias(aliasName, scope)?.filter(([outputName]) => outputName === name);
    return matches?.length === 1 ? matches[0]![1] : undefined;
  }
  if (alias.kind === "cte" || alias.kind === "subquery") {
    const matches = alias.columns.filter(([outputName]) => outputName === name);
    const column = matches.length === 1 ? matches[0]![1] : undefined;
    return column ? scopedColumn(aliasName, name, column, scope) : undefined;
  }
  if (alias.kind !== "table") return undefined;
  const oid = scope.aliasOidByName.get(aliasName);
  const table = oid === undefined ? undefined : scope.schema.tableNameByOid(oid);
  const column = oid === undefined ? undefined : scope.schema.columnsOf(oid)?.get(name);
  if (!table || !column) return undefined;
  return scopedColumn(aliasName, name, {
    nullable: !column.notNull,
    sources: [{ schema: table.schema, table: table.name, column: name }],
    arrayElementNullability: scope.schema.arrayElement?.(column.typeOid)?.nullability ?? "unknown",
  }, scope);
}

export function columnRefAlias(fields: any[], scope: Scope): string | undefined {
  const name = fields[fields.length - 2]?.String?.sval;
  if (typeof name !== "string") return undefined;
  const schema = fields.length >= 3 ? fields[fields.length - 3]?.String?.sval : undefined;
  const matches = [...scope.aliases].filter(([key, alias]) => {
    if (visibleAliasName(key) !== name) return false;
    if (schema === undefined) return true;
    if (alias.kind !== "table" || alias.returning) return false;
    const oid = scope.aliasOidByName.get(key);
    return alias.schema === schema || (oid !== undefined && scope.schema.tableNameByOid(oid)?.schema === schema);
  });
  return matches.length === 1 ? matches[0]![0] : undefined;
}

export function resolveColumnRef(fields: any[], scope: Scope): AnalyzedColumn | undefined {
  if (fields.some((field) => field.A_Star !== undefined)) return undefined;
  const name = fields[fields.length - 1]?.String?.sval;
  if (typeof name !== "string") return undefined;
  if (fields.length >= 2) {
    const alias = columnRefAlias(fields, scope);
    return alias ? columnForAlias(alias, name, scope) : undefined;
  }
  const matches: AnalyzedColumn[] = [];
  for (const [aliasName, alias] of scope.aliases) {
    if (alias.kind === "table" && alias.returning) continue;
    const column = columnForAlias(aliasName, name, scope);
    if (column) matches.push(column);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function expandStarColumns(val: any, scope: Scope): NamedColumn[] | undefined {
  const fields = val?.ColumnRef?.fields;
  if (!Array.isArray(fields) || !containsStar(val)) return undefined;
  const alias = fields.length === 1 ? scope.unqualifiedStarAlias : columnRefAlias(fields, scope);
  return alias ? columnsForAlias(alias, scope) : undefined;
}

export function colNameOfColumnRef(val: any): string | undefined {
  const fields = val?.ColumnRef?.fields;
  if (!Array.isArray(fields) || containsStar(val)) return undefined;
  return fields[fields.length - 1]?.String?.sval;
}

export function containsStar(val: any): boolean {
  return val?.ColumnRef?.fields?.some((field: any) => field.A_Star !== undefined) ?? false;
}

export function sourceFromField(field: FieldDescription, schema: SchemaCache): ColumnSource[] | null {
  if (field.tableOid === 0 || field.columnAttr === 0) return null;
  const table = schema.tableNameByOid(field.tableOid);
  const column = schema.columnNameByAttno(field.tableOid, field.columnAttr);
  return table && column ? [{ schema: table.schema, table: table.name, column }] : null;
}

export function nullableFromField(field: FieldDescription, scope: Scope): boolean {
  if (field.tableOid === 0 || field.columnAttr === 0) return true;
  if (scope.schema.isNotNull(field.tableOid, field.columnAttr) !== true) return true;
  const aliases = scope.tableRefsByOid.get(field.tableOid);
  return !aliases?.length || aliases.some((alias) => alias.joinNullable);
}
