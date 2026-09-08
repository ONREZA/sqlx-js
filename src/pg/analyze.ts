import { parse } from "libpg-query";
import type { FieldDescription } from "./wire";
import type { SchemaCache } from "./schema";
import type { ArrayElementNullability } from "./oids";
import { narrowFromWhere, type NonNullSet } from "./narrow";
import type { AliasInfo, AnalyzedColumn, CteColumnInfo, Scope, AnalysisResult, ColumnSource } from "./analyze-types";
import { dmlAsSelect, applyReturningScope, returningTargets, tablesFromRelation, type DmlKind } from "./returning";
import { colNameOfColumnRef, containsStar, expandStarColumns, nullableFromField, resolveColumnRef, sourceFromField, type NamedColumn } from "./analyze-columns";
import { aliasColumnNames, relationAliasKey } from "./relation-alias";
export type { AnalysisResult, ColumnSource } from "./analyze-types";

export async function analyzeQuery(
  sql: string,
  rowDesc: FieldDescription[],
  schema: SchemaCache,
): Promise<AnalysisResult> {
  const ast = await parse(sql);
  const stmt = ast?.stmts?.[0]?.stmt;
  if (!stmt) return conservative(rowDesc, "libpg-query returned no statements");

  if ("SelectStmt" in stmt) {
    return await analyzeSelect(stmt.SelectStmt, rowDesc, schema);
  }
  if ("InsertStmt" in stmt) {
    return await analyzeDml(stmt.InsertStmt, rowDesc, schema, "insert");
  }
  if ("UpdateStmt" in stmt) {
    return await analyzeDml(stmt.UpdateStmt, rowDesc, schema, "update");
  }
  if ("DeleteStmt" in stmt) {
    return await analyzeDml(stmt.DeleteStmt, rowDesc, schema, "delete");
  }
  const kind = Object.keys(stmt)[0] ?? "unknown";
  return conservative(rowDesc, `unsupported statement type: ${kind}`);
}

function conservative(rowDesc: FieldDescription[], reason?: string): AnalysisResult {
  return {
    perColumnNullable: rowDesc.map(() => true),
    perColumnSources: rowDesc.map(() => null),
    perColumnArrayElementNullability: rowDesc.map(() => "unknown"),
    referencedTables: [],
    ...(reason && rowDesc.length > 0 ? { degraded: { reason } } : {}),
  };
}

async function analyzeSelect(
  select: any,
  rowDesc: FieldDescription[],
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo = new Map(),
): Promise<AnalysisResult> {
  if (isSetOperation(select)) {
    const ctes = await collectCteColumns(select.withClause, schema, inheritedCtes);
    const left = await analyzeSelect(select.larg, rowDesc, schema, ctes);
    const right = await analyzeSelect(select.rarg, rowDesc, schema, ctes);
    return combineSetOperation(select.op, left, right, rowDesc);
  }
  if (Array.isArray(select.valuesLists)) {
    return await analyzeValues(select, rowDesc, schema, inheritedCtes);
  }
  if (!select.targetList || !select.fromClause) {
    if (select.targetList && !select.fromClause) {
      const scope = await buildScope(select, schema, inheritedCtes);
      return await runTargets(select.targetList, rowDesc, scope);
    }
    return conservative(rowDesc, "SELECT without targetList");
  }
  const scope = await buildScope(select, schema, inheritedCtes);
  return await runTargets(select.targetList, rowDesc, scope);
}

async function analyzeValues(
  select: any,
  rowDesc: FieldDescription[],
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo,
): Promise<AnalysisResult> {
  const rows = select.valuesLists
    .map((row: any) => row?.List?.items)
    .filter((items: any): items is any[] => Array.isArray(items));
  if (rows.length === 0 || rows.some((row: any[]) => row.length !== rowDesc.length)) {
    return conservative(rowDesc, "VALUES rows do not match the described columns");
  }
  const scope = await buildScope(select, schema, inheritedCtes);
  const perColumnNullable: boolean[] = [];
  const perColumnArrayElementNullability: ArrayElementNullability[] = [];
  for (let index = 0; index < rowDesc.length; index++) {
    perColumnNullable.push(await anyExpressionNullable(rows.map((row: any[]) => row[index]), scope));
    const states: ArrayElementNullability[] = [];
    for (const row of rows) states.push(await expressionArrayElementNullability(row[index], scope));
    perColumnArrayElementNullability.push(mergeArrayElementNullability(states));
  }
  return {
    perColumnNullable,
    perColumnSources: rowDesc.map(() => null),
    perColumnArrayElementNullability,
    referencedTables: [],
  };
}

function isSetOperation(select: any): boolean {
  return !!select?.op && select.op !== "SETOP_NONE" && !!select.larg && !!select.rarg;
}

function combineSetOperation(
  operation: string,
  left: AnalysisResult,
  right: AnalysisResult,
  rowDesc: FieldDescription[],
): AnalysisResult {
  if (left.perColumnNullable.length !== rowDesc.length || right.perColumnNullable.length !== rowDesc.length) {
    return conservative(rowDesc, `${operation} branches do not match the described columns`);
  }

  let perColumnNullable: boolean[];
  if (operation === "SETOP_UNION") {
    perColumnNullable = left.perColumnNullable.map((nullable, index) => nullable || right.perColumnNullable[index]!);
  } else if (operation === "SETOP_INTERSECT") {
    perColumnNullable = left.perColumnNullable.map((nullable, index) => nullable && right.perColumnNullable[index]!);
  } else if (operation === "SETOP_EXCEPT") {
    perColumnNullable = left.perColumnNullable;
  } else {
    return conservative(rowDesc, `unsupported set operation: ${operation}`);
  }

  const degradedReasons = [left.degraded?.reason, right.degraded?.reason].filter((reason): reason is string => !!reason);
  return {
    perColumnNullable,
    perColumnSources: combineSetOperationSources(operation, left, right),
    perColumnArrayElementNullability: operation === "SETOP_EXCEPT"
      ? left.perColumnArrayElementNullability
      : left.perColumnArrayElementNullability.map((state, index) =>
        mergeArrayElementNullability([state, right.perColumnArrayElementNullability[index] ?? "unknown"])),
    referencedTables: mergeReferencedTables(left.referencedTables, right.referencedTables),
    ...(degradedReasons.length > 0 ? { degraded: { reason: degradedReasons.join("; ") } } : {}),
  };
}

function combineSetOperationSources(
  operation: string,
  left: AnalysisResult,
  right: AnalysisResult,
): (ColumnSource[] | null)[] {
  if (operation === "SETOP_EXCEPT") return left.perColumnSources;
  return left.perColumnSources.map((leftSources, index) => {
    const rightSources = right.perColumnSources[index];
    if (!leftSources || !rightSources) return null;
    return mergeColumnSources(leftSources, rightSources);
  });
}

function mergeColumnSources(...groups: ColumnSource[][]): ColumnSource[] {
  const merged = new Map<string, ColumnSource>();
  for (const source of groups.flat()) {
    const key = `${source.schema}\0${source.table}\0${source.column}`;
    if (!merged.has(key)) merged.set(key, source);
  }
  return [...merged.values()];
}

function mergeReferencedTables(
  ...groups: { schema?: string; name: string }[][]
): { schema?: string; name: string }[] {
  const merged = new Map<string, { schema?: string; name: string }>();
  for (const table of groups.flat()) {
    const key = `${table.schema ?? ""}\0${table.name}`;
    if (!merged.has(key)) merged.set(key, table.schema ? { schema: table.schema, name: table.name } : { name: table.name });
  }
  return [...merged.values()];
}

async function analyzeDml(
  stmt: any,
  rowDesc: FieldDescription[],
  schema: SchemaCache,
  kind: DmlKind,
): Promise<AnalysisResult> {
  const returningList = returningTargets(stmt);
  if (returningList.length === 0 && rowDesc.length === 0) {
    return {
      perColumnNullable: [],
      perColumnSources: [],
      perColumnArrayElementNullability: [],
      referencedTables: tablesFromRelation(stmt.relation),
    };
  }
  const scope = await buildDmlScope(stmt, kind, returningList, schema);
  return await runTargets(returningList, rowDesc, scope);
}

async function buildDmlScope(
  stmt: any,
  kind: DmlKind,
  targetList: any[],
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo = new Map(),
): Promise<Scope> {
  const scope = await buildScope(dmlAsSelect(stmt, kind, targetList), schema, inheritedCtes, stmt.relation);
  applyReturningScope(scope, stmt, kind);
  return scope;
}

async function buildScope(
  select: any,
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo = new Map(),
  tableTarget?: any,
): Promise<Scope> {
  const scope: Scope = {
    aliases: new Map(),
    aliasOidByName: new Map(),
    tableRefsByOid: new Map(),
    unqualifiedStarAlias: singleStarSourceAlias(select.fromClause),
    schema,
    forcedNonNull: narrowFromWhere(select.whereClause),
    cteColumnInfo: await collectCteColumns(select.withClause, schema, inheritedCtes),
  };

  for (const entry of select.fromClause ?? []) {
    walkFrom(entry, false, scope, entry.RangeVar === tableTarget);
  }

  const referencedTables: { schema?: string; name: string }[] = [];
  for (const a of scope.aliases.values()) {
    if (a.kind === "table") referencedTables.push({ schema: a.schema, name: a.relname });
  }
  await schema.loadTableNames(referencedTables);

  const allOids: number[] = [];
  for (const [aliasName, a] of scope.aliases) {
    if (a.kind !== "table") continue;
    const oid = schema.resolveTable(a.schema, a.relname);
    if (oid === undefined) continue;
    scope.aliasOidByName.set(aliasName, oid);
    allOids.push(oid);
    const arr = scope.tableRefsByOid.get(oid) ?? [];
    arr.push(a);
    scope.tableRefsByOid.set(oid, arr);
  }
  await schema.loadColumnsForTables(allOids);
  const columnTypeOids = allOids
    .flatMap((oid) => [...(schema.columnsOf(oid)?.values() ?? [])].map((column) => column.typeOid))
    .filter((oid) => oid > 0);
  await schema.loadCustomTypes(columnTypeOids);
  for (const entry of select.fromClause ?? []) {
    await loadRangeSubselects(entry, false, scope);
  }

  return scope;
}

async function loadRangeSubselects(node: any, joinNullable: boolean, scope: Scope): Promise<void> {
  if (!node) return;
  if (node.JoinExpr) {
    const join = node.JoinExpr;
    let leftNullable = joinNullable;
    let rightNullable = joinNullable;
    if (join.jointype === "JOIN_LEFT") rightNullable = true;
    else if (join.jointype === "JOIN_RIGHT") leftNullable = true;
    else if (join.jointype === "JOIN_FULL") {
      leftNullable = true;
      rightNullable = true;
    }
    await loadRangeSubselects(join.larg, leftNullable, scope);
    await loadRangeSubselects(join.rarg, rightNullable, scope);
    return;
  }
  const range = node.RangeSubselect;
  const aliasName = range?.alias?.aliasname;
  const select = range?.subquery?.SelectStmt;
  if (!aliasName || !select) return;
  const columns = await selectOutputColumns(select, scope.schema, scope.cteColumnInfo);
  scope.aliases.set(aliasName, {
    kind: "subquery", joinNullable, columns: columns ?? [], columnAliases: aliasColumnNames(range.alias),
  });
}

async function collectCteColumns(
  withClause: any,
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo,
): Promise<CteColumnInfo> {
  if (!Array.isArray(withClause?.ctes) || withClause.ctes.length === 0) return inheritedCtes;
  const collected: CteColumnInfo = new Map(inheritedCtes);
  if (withClause.recursive) {
    for (const entry of withClause.ctes) {
      const name = entry?.CommonTableExpr?.ctename;
      if (typeof name === "string") collected.set(name, []);
    }
  }
  for (const cteWrap of withClause.ctes) {
    const cte = cteWrap?.CommonTableExpr;
    const name: string | undefined = cte?.ctename;
    if (!cte || !name) continue;
    const visible = withClause.recursive ? new Map(collected) : collected;
    if (withClause.recursive) visible.set(name, []);
    collected.set(name, await analyzeCteColumns(cte, schema, visible));
  }
  return collected;
}

async function analyzeCteColumns(
  cte: any,
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo = new Map(),
): Promise<NamedColumn[]> {
  const explicitColNames: string[] | undefined = Array.isArray(cte.aliascolnames)
    ? cte.aliascolnames.map((n: any) => n?.String?.sval).filter((s: any) => typeof s === "string")
    : undefined;

  const inner = cte.ctequery?.SelectStmt
    ?? cte.ctequery?.InsertStmt
    ?? cte.ctequery?.UpdateStmt
    ?? cte.ctequery?.DeleteStmt;
  if (!inner) return [];

  let targetList: any[] | undefined;
  let dmlKind: DmlKind | undefined;
  if (cte.ctequery?.SelectStmt) {
    targetList = outputTargetList(inner);
  } else {
    targetList = returningTargets(inner);
    if (cte.ctequery?.InsertStmt) dmlKind = "insert";
    else if (cte.ctequery?.UpdateStmt) dmlKind = "update";
    else if (cte.ctequery?.DeleteStmt) dmlKind = "delete";
  }
  if (!Array.isArray(targetList) || targetList.length === 0) return [];

  const columns = cte.ctequery?.SelectStmt
    ? await selectOutputColumns(inner, schema, inheritedCtes)
    : await analyzeOutputTargets(targetList, await buildDmlScope(inner, dmlKind!, targetList, schema, inheritedCtes));
  return columns?.map(([name, column], index) => [explicitColNames?.[index] ?? name, column]) ?? [];
}

async function selectOutputColumns(
  select: any,
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo,
): Promise<NamedColumn[] | undefined> {
  if (isSetOperation(select)) {
    const ctes = await collectCteColumns(select.withClause, schema, inheritedCtes);
    const left = await selectOutputColumns(select.larg, schema, ctes);
    const right = await selectOutputColumns(select.rarg, schema, ctes);
    if (!left || !right || left.length !== right.length) return undefined;
    const fields = syntheticRowDescription(left.map(([name]) => ({ ResTarget: { name } })));
    const combined = combineSetOperation(select.op,
      columnAnalysis(left.map(([, column]) => column)), columnAnalysis(right.map(([, column]) => column)), fields);
    return left.map(([name], index) => [name, {
      nullable: combined.perColumnNullable[index]!,
      sources: combined.perColumnSources[index] ?? null,
      arrayElementNullability: combined.perColumnArrayElementNullability[index] ?? "unknown",
    }]);
  }
  const targets = outputTargetList(select);
  if (!targets) return undefined;
  if (Array.isArray(select.valuesLists)) {
    const analysis = await analyzeValues(select, syntheticRowDescription(targets), schema, inheritedCtes);
    return targets.map((target, index) => [targetName(target, index), {
      nullable: analysis.perColumnNullable[index] ?? true,
      sources: analysis.perColumnSources[index] ?? null,
      arrayElementNullability: analysis.perColumnArrayElementNullability[index] ?? "unknown",
    }]);
  }
  return await analyzeOutputTargets(targets, await buildScope(select, schema, inheritedCtes));
}

function targetName(target: any, index: number): string {
  return target?.ResTarget?.name ?? colNameOfColumnRef(target?.ResTarget?.val) ?? `?column?${index}`;
}

function singleStarSourceAlias(fromClause: any): string | undefined {
  if (!Array.isArray(fromClause) || fromClause.length !== 1) return undefined;
  const source = fromClause[0];
  if (source?.RangeVar) return relationAliasKey(source.RangeVar);
  return source?.RangeSubselect?.alias?.aliasname;
}

function outputTargetList(select: any): any[] | undefined {
  if (Array.isArray(select?.targetList)) return select.targetList;
  if (isSetOperation(select)) return outputTargetList(select.larg);
  const values = select?.valuesLists?.[0]?.List?.items;
  if (Array.isArray(values)) {
    return values.map((val: any, index: number) => ({ ResTarget: { name: `column${index + 1}`, val } }));
  }
  return undefined;
}

function syntheticRowDescription(targets: any[]): FieldDescription[] {
  return targets.map((target, index) => ({
    name: target?.ResTarget?.name ?? colNameOfColumnRef(target?.ResTarget?.val) ?? `?column?${index}`,
    tableOid: 0,
    columnAttr: 0,
    typeOid: 0,
    typeSize: -1,
    typeModifier: -1,
    format: 0,
  }));
}

async function runTargets(
  targets: any[],
  rowDesc: FieldDescription[],
  scope: Scope,
): Promise<AnalysisResult> {
  const referencedTables = mergeReferencedTables([...scope.aliases.values()]
    .filter((alias) => alias.kind === "table")
    .map((alias) => ({ schema: alias.schema, name: alias.relname })));
  const expanded = await analyzeOutputTargets(targets, scope, rowDesc);
  const columns = expanded?.length === rowDesc.length
    ? expanded.map(([, column]) => column)
    : rowDesc.map((field): AnalyzedColumn => ({
      nullable: nullableFromField(field, scope),
      sources: sourceFromField(field, scope.schema),
      arrayElementNullability: scope.schema.arrayElement?.(field.typeOid)?.nullability ?? "unknown",
    }));
  return columnAnalysis(columns, referencedTables);
}

function columnAnalysis(columns: AnalyzedColumn[], referencedTables: AnalysisResult["referencedTables"] = []): AnalysisResult {
  return {
    perColumnNullable: columns.map((column) => column.nullable),
    perColumnSources: columns.map((column) => column.sources),
    perColumnArrayElementNullability: columns.map((column) => column.arrayElementNullability),
    referencedTables,
  };
}

async function analyzeOutputTargets(
  targets: any[],
  scope: Scope,
  rowDesc?: FieldDescription[],
): Promise<NamedColumn[] | undefined> {
  const columns: NamedColumn[] = [];
  for (const target of targets) {
    const val = target?.ResTarget?.val;
    if (containsStar(val)) {
      const expanded = expandStarColumns(val, scope);
      if (!expanded) return undefined;
      columns.push(...expanded);
      continue;
    }
    const field = rowDesc?.[columns.length];
    const resolved = val?.ColumnRef ? resolveColumnRef(val.ColumnRef.fields, scope) : undefined;
    const nullable = val?.ColumnRef || val?.TypeCast
      ? await expressionNullable(val, scope)
      : field?.tableOid && field.columnAttr
        ? nullableFromField(field, scope)
        : await expressionNullable(val, scope);
    columns.push([targetName(target, columns.length), {
      nullable,
      sources: (field ? sourceFromField(field, scope.schema) : null) ?? resolved?.sources ?? null,
      arrayElementNullability: await expressionArrayElementNullability(val, scope),
    }]);
  }
  return columns;
}

function addForcedNonNull(scope: Scope, set: NonNullSet): void {
  for (const k of set) scope.forcedNonNull.add(k);
}

function walkFrom(node: any, joinNullable: boolean, scope: Scope, forceTable = false): void {
  if (!node) return;
  if (node.RangeVar) {
    const v = node.RangeVar;
    const alias = relationAliasKey(v);
    const cteCols = !forceTable && !v.schemaname ? scope.cteColumnInfo.get(v.relname) : undefined;
    if (cteCols) {
      scope.aliases.set(alias, { kind: "cte", joinNullable, columns: cteCols, columnAliases: aliasColumnNames(v.alias) });
      return;
    }
    const info: AliasInfo = {
      kind: "table",
      relname: v.relname,
      joinNullable,
      columnAliases: aliasColumnNames(v.alias),
    };
    if (v.schemaname) (info as { schema?: string }).schema = v.schemaname;
    scope.aliases.set(alias, info);
    return;
  }
  if (node.JoinExpr) {
    const j = node.JoinExpr;
    let leftNullable = joinNullable;
    let rightNullable = joinNullable;
    switch (j.jointype) {
      case "JOIN_LEFT":
        rightNullable = true;
        break;
      case "JOIN_RIGHT":
        leftNullable = true;
        break;
      case "JOIN_FULL":
        leftNullable = true;
        rightNullable = true;
        break;
    }
    walkFrom(j.larg, leftNullable, scope);
    walkFrom(j.rarg, rightNullable, scope);
    if (j.jointype === "JOIN_INNER" && !joinNullable) {
      addForcedNonNull(scope, narrowFromWhere(j.quals));
    }
    return;
  }
  if (node.RangeSubselect) {
    const alias = node.RangeSubselect.alias?.aliasname;
    if (alias) scope.aliases.set(alias, { kind: "subquery", joinNullable, columns: [] });
    return;
  }
  if (node.RangeFunction) {
    const alias = node.RangeFunction.alias?.aliasname;
    if (alias) scope.aliases.set(alias, { kind: "function", joinNullable });
    return;
  }
}

function funcName(call: any): string | null {
  const names = call?.funcname;
  if (!Array.isArray(names)) return null;
  const last = names[names.length - 1];
  return last?.String?.sval?.toLowerCase() ?? null;
}

const NON_NULL_FUNCS = new Set([
  "now",
  "current_timestamp",
  "current_date",
  "current_time",
  "localtime",
  "localtimestamp",
  "current_user",
  "session_user",
  "user",
  "current_database",
  "current_schema",
  "version",
  "pg_backend_pid",
  "txid_current",
  "random",
  "gen_random_uuid",
  "uuid_generate_v4",
  "length",
  "char_length",
  "character_length",
  "octet_length",
  "concat",
  "concat_ws",
]);

const COUNT_FUNCS = new Set(["count"]);

function mergeArrayElementNullability(states: ArrayElementNullability[]): ArrayElementNullability {
  if (states.length === 0) return "non-null";
  if (states.some((state) => state === "nullable")) return "nullable";
  if (states.every((state) => state === "non-null")) return "non-null";
  return "unknown";
}

async function expressionArrayElementNullability(val: any, scope: Scope): Promise<ArrayElementNullability> {
  if (!val) return "unknown";

  if (val.A_ArrayExpr) {
    const states: ArrayElementNullability[] = [];
    for (const element of val.A_ArrayExpr.elements ?? []) {
      const nested = await expressionArrayElementNullability(element, scope);
      states.push(nested === "unknown" ? (await expressionNullable(element, scope) ? "nullable" : "non-null") : nested);
    }
    return mergeArrayElementNullability(states);
  }

  if (val.ColumnRef) {
    const fields = val.ColumnRef.fields;
    if (!Array.isArray(fields) || fields.some((field: any) => field.A_Star !== undefined)) return "unknown";
    return resolveColumnRef(fields, scope)?.arrayElementNullability ?? "unknown";
  }

  if (val.FuncCall && funcName(val.FuncCall) === "array_agg") {
    const arg = val.FuncCall.args?.[0];
    if (!arg) return "unknown";
    const nested = await expressionArrayElementNullability(arg, scope);
    return nested === "unknown" ? (await expressionNullable(arg, scope) ? "nullable" : "non-null") : nested;
  }

  if (val.SubLink?.subLinkType === "ARRAY_SUBLINK") {
    const select = val.SubLink.subselect?.SelectStmt;
    const targets = outputTargetList(select);
    if (!select || !targets || targets.length !== 1) return "unknown";
    const analysis = await analyzeSelect(select, syntheticRowDescription(targets), scope.schema, scope.cteColumnInfo);
    if (analysis.degraded || analysis.perColumnNullable.length !== 1) return "unknown";
    const nested = analysis.perColumnArrayElementNullability[0] ?? "unknown";
    return nested === "unknown" ? (analysis.perColumnNullable[0] ? "nullable" : "non-null") : nested;
  }

  if (val.TypeCast) return await expressionArrayElementNullability(val.TypeCast.arg, scope);

  if (val.CoalesceExpr || val.MinMaxExpr) {
    const args = val.CoalesceExpr?.args ?? val.MinMaxExpr?.args ?? [];
    const states: ArrayElementNullability[] = [];
    for (const arg of args) states.push(await expressionArrayElementNullability(arg, scope));
    return mergeArrayElementNullability(states);
  }

  if (val.CaseExpr) {
    const c = val.CaseExpr;
    const branches = (c.args ?? []).map((arm: any) => arm.CaseWhen?.result);
    if (c.defresult !== undefined && c.defresult !== null) branches.push(c.defresult);
    else return "unknown";
    const states: ArrayElementNullability[] = [];
    for (const branch of branches) states.push(await expressionArrayElementNullability(branch, scope));
    return mergeArrayElementNullability(states);
  }

  return "unknown";
}

async function anyExpressionNullable(values: any[], scope: Scope): Promise<boolean> {
  for (const value of values) {
    if (await expressionNullable(value, scope)) return true;
  }
  return false;
}

async function everyExpressionNullable(values: any[], scope: Scope): Promise<boolean> {
  for (const value of values) {
    if (!await expressionNullable(value, scope)) return false;
  }
  return true;
}

async function expressionNullable(val: any, scope: Scope): Promise<boolean> {
  if (!val) return true;

  if (val.A_Const !== undefined) {
    const c = val.A_Const;
    if (c.isnull === true) return true;
    return false;
  }

  if (val.A_ArrayExpr) return false;

  if (val.ColumnRef) {
    const fields = val.ColumnRef.fields;
    if (!Array.isArray(fields)) return true;
    if (fields.some((f: any) => f.A_Star !== undefined)) return true;
    return resolveColumnRef(fields, scope)?.nullable ?? true;
  }

  if (val.FuncCall) {
    const name = funcName(val.FuncCall);
    if (name && COUNT_FUNCS.has(name)) return false;
    if (name && NON_NULL_FUNCS.has(name)) {
      const args = val.FuncCall.args ?? [];
      return await anyExpressionNullable(args, scope);
    }
    if (name === "greatest" || name === "least") {
      const args = val.FuncCall.args ?? [];
      if (args.length === 0) return true;
      return await everyExpressionNullable(args, scope);
    }
    return true;
  }

  if (val.CoalesceExpr) {
    const args = val.CoalesceExpr.args ?? [];
    if (args.length === 0) return true;
    return await everyExpressionNullable(args, scope);
  }

  if (val.MinMaxExpr) {
    const args = val.MinMaxExpr.args ?? [];
    if (args.length === 0) return true;
    return await everyExpressionNullable(args, scope);
  }

  if (val.NullIfExpr) {
    return true;
  }

  if (val.CaseExpr) {
    const c = val.CaseExpr;
    const branches = (c.args ?? []).map((arm: any) => arm.CaseWhen?.result);
    const hasElse = c.defresult !== undefined && c.defresult !== null;
    if (!hasElse) return true;
    const elseExpr = c.defresult;
    return await anyExpressionNullable([...branches, elseExpr], scope);
  }

  if (val.NullTest || val.BooleanTest) return false;

  if (val.A_Expr) {
    const e = val.A_Expr;
    if (e.kind === "AEXPR_DISTINCT" || e.kind === "AEXPR_NOT_DISTINCT") {
      return false;
    }
    return true;
  }

  if (val.SubLink) {
    const type = val.SubLink.subLinkType;
    return type !== "ARRAY_SUBLINK" && type !== "EXISTS_SUBLINK";
  }

  if (val.TypeCast) {
    return await expressionNullable(val.TypeCast.arg, scope);
  }

  if (val.BoolExpr) {
    const a = val.BoolExpr.args ?? [];
    return await anyExpressionNullable(a, scope);
  }

  return true;
}
