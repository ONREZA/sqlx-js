import { parse } from "libpg-query";
import type { FieldDescription } from "./wire";
import type { SchemaCache } from "./schema";
import type { ArrayElementNullability } from "./oids";
import { narrowFromWhere, isNarrowed, type NonNullSet } from "./narrow";

type AliasInfo =
  | { kind: "table"; schema?: string; relname: string; joinNullable: boolean }
  | { kind: "subquery"; joinNullable: boolean; columns: Map<string, AnalyzedColumn> }
  | { kind: "cte"; joinNullable: boolean; columns: Map<string, AnalyzedColumn> }
  | { kind: "function"; joinNullable: boolean };

export type ColumnSource = { schema: string; table: string; column: string };
type AnalyzedColumn = {
  nullable: boolean;
  sources: ColumnSource[] | null;
  arrayElementNullability: ArrayElementNullability;
};
type CteColumnInfo = Map<string, Map<string, AnalyzedColumn>>;

type Scope = {
  aliases: Map<string, AliasInfo>;
  aliasOidByName: Map<string, number>;
  tableRefsByOid: Map<number, AliasInfo[]>;
  unqualifiedStarAlias: string | undefined;
  hasStar: boolean;
  schema: SchemaCache;
  forcedNonNull: NonNullSet;
  cteColumnInfo: CteColumnInfo;
};

export type AnalysisResult = {
  perColumnNullable: boolean[];
  perColumnSources: (ColumnSource[] | null)[];
  perColumnArrayElementNullability: ArrayElementNullability[];
  referencedTables: { schema?: string; name: string }[];
  degraded?: { reason: string };
};

export async function analyzeQuery(
  sql: string,
  rowDesc: FieldDescription[],
  schema: SchemaCache,
): Promise<AnalysisResult> {
  const ast = await parse(sql);
  const stmt = ast?.stmts?.[0]?.stmt;
  if (!stmt) return conservative(rowDesc, "libpg-query returned no statements");

  if (stmt.SelectStmt) {
    return await analyzeSelect(stmt.SelectStmt, rowDesc, schema);
  }
  if (stmt.InsertStmt) {
    return await analyzeDml(stmt.InsertStmt, rowDesc, schema, "insert");
  }
  if (stmt.UpdateStmt) {
    return await analyzeDml(stmt.UpdateStmt, rowDesc, schema, "update");
  }
  if (stmt.DeleteStmt) {
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
  const perColumnArrayElementNullability: ArrayElementNullability[] = [];
  for (let index = 0; index < rowDesc.length; index++) {
    const states: ArrayElementNullability[] = [];
    for (const row of rows) states.push(await expressionArrayElementNullability(row[index], scope));
    perColumnArrayElementNullability.push(mergeArrayElementNullability(states));
  }
  return {
    perColumnNullable: rowDesc.map((_, index) => rows.some((row: any[]) => expressionNullable(row[index], scope))),
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
  kind: "insert" | "update" | "delete",
): Promise<AnalysisResult> {
  const returningList = stmt.returningList ?? [];
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
  kind: "insert" | "update" | "delete",
  targetList: any[],
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo = new Map(),
): Promise<Scope> {
  const scope = await buildScope(dmlAsSelect(stmt, kind, targetList), schema, inheritedCtes);
  if (kind === "update") discardUpdateTargetNarrowing(scope, stmt.relation);
  return scope;
}

function discardUpdateTargetNarrowing(scope: Scope, relation: any): void {
  const targetAlias = relation?.alias?.aliasname ?? relation?.relname;
  const targetOid = typeof targetAlias === "string" ? scope.aliasOidByName.get(targetAlias) : undefined;
  const targetColumns = targetOid === undefined ? undefined : scope.schema.columnsOf(targetOid);
  for (const key of scope.forcedNonNull) {
    const separator = key.indexOf("|");
    const alias = key.slice(0, separator);
    const column = key.slice(separator + 1);
    if (alias === targetAlias || (alias === "" && (!targetColumns || targetColumns.has(column)))) {
      scope.forcedNonNull.delete(key);
    }
  }
}

function dmlAsSelect(stmt: any, kind: "insert" | "update" | "delete", targetList: any[]): any {
  const fromClause = stmt.relation ? [{ RangeVar: stmt.relation }] : [];
  if (kind === "update" && Array.isArray(stmt.fromClause)) {
    fromClause.push(...stmt.fromClause);
  }
  if (kind === "delete" && Array.isArray(stmt.usingClause)) {
    fromClause.push(...stmt.usingClause);
  }
  return {
    targetList,
    fromClause,
    whereClause: kind === "update" || kind === "delete" ? stmt.whereClause : undefined,
    withClause: stmt.withClause,
  };
}

function tablesFromRelation(relation: any): { schema?: string; name: string }[] {
  if (!relation || typeof relation.relname !== "string") return [];
  const out: { schema?: string; name: string } = { name: relation.relname };
  if (relation.schemaname) out.schema = relation.schemaname;
  return [out];
}

async function buildScope(
  select: any,
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo = new Map(),
): Promise<Scope> {
  const scope: Scope = {
    aliases: new Map(),
    aliasOidByName: new Map(),
    tableRefsByOid: new Map(),
    unqualifiedStarAlias: singleStarSourceAlias(select.fromClause),
    hasStar: false,
    schema,
    forcedNonNull: narrowFromWhere(select.whereClause),
    cteColumnInfo: await collectCteColumns(select.withClause, schema, inheritedCtes),
  };

  for (const entry of select.fromClause ?? []) {
    walkFrom(entry, false, scope);
  }
  for (const t of select.targetList ?? []) {
    if (containsStar(t?.ResTarget?.val)) scope.hasStar = true;
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
  const targets = outputTargetList(select);
  if (!aliasName || !select || !targets) return;
  const analysis = await analyzeSelect(select, syntheticRowDescription(targets), scope.schema, scope.cteColumnInfo);
  const explicitNames: string[] = (range.alias?.colnames ?? [])
    .map((name: any) => name?.String?.sval)
    .filter((name: any): name is string => typeof name === "string");
  const hasStar = targets.some((target) => containsStar(target?.ResTarget?.val));
  const innerScope = hasStar
    ? await buildScope(select, scope.schema, scope.cteColumnInfo)
    : undefined;
  const columns = await analyzedOutputColumns(targets, analysis, innerScope, explicitNames);
  scope.aliases.set(aliasName, { kind: "subquery", joinNullable, columns });
}

async function collectCteColumns(
  withClause: any,
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo,
): Promise<CteColumnInfo> {
  if (!Array.isArray(withClause?.ctes) || withClause.ctes.length === 0) return inheritedCtes;
  const collected: CteColumnInfo = new Map(inheritedCtes);
  for (const cteWrap of withClause.ctes) {
    const cte = cteWrap?.CommonTableExpr;
    const name: string | undefined = cte?.ctename;
    if (!cte || !name) continue;
    const visible = withClause.recursive ? new Map(collected) : collected;
    if (withClause.recursive) visible.delete(name);
    collected.set(name, await analyzeCteColumns(cte, schema, visible));
  }
  return collected;
}

async function analyzeCteColumns(
  cte: any,
  schema: SchemaCache,
  inheritedCtes: CteColumnInfo = new Map(),
): Promise<Map<string, AnalyzedColumn>> {
  const explicitColNames: string[] | undefined = Array.isArray(cte.aliascolnames)
    ? cte.aliascolnames.map((n: any) => n?.String?.sval).filter((s: any) => typeof s === "string")
    : undefined;

  const inner = cte.ctequery?.SelectStmt
    ?? cte.ctequery?.InsertStmt
    ?? cte.ctequery?.UpdateStmt
    ?? cte.ctequery?.DeleteStmt;
  if (!inner) return new Map();

  let targetList: any[] | undefined;
  let dmlKind: "insert" | "update" | "delete" | undefined;
  if (cte.ctequery?.SelectStmt) {
    targetList = outputTargetList(inner);
  } else {
    targetList = inner.returningList ?? [];
    if (cte.ctequery?.InsertStmt) dmlKind = "insert";
    else if (cte.ctequery?.UpdateStmt) dmlKind = "update";
    else if (cte.ctequery?.DeleteStmt) dmlKind = "delete";
  }
  if (!Array.isArray(targetList) || targetList.length === 0) return new Map();

  const isSelect = !!cte.ctequery?.SelectStmt;
  const hasStar = targetList.some((target) => containsStar(target?.ResTarget?.val));
  const analysis = isSelect
    ? await analyzeSelect(inner, syntheticRowDescription(targetList), schema, inheritedCtes)
    : undefined;
  const scope = analysis && !hasStar
    ? undefined
    : isSelect
      ? await buildScope(inner, schema, inheritedCtes)
      : await buildDmlScope(inner, dmlKind!, targetList, schema, inheritedCtes);
  return await analyzedOutputColumns(targetList, analysis, scope, explicitColNames);
}

async function analyzedOutputColumns(
  targets: any[],
  analysis: AnalysisResult | undefined,
  scope: Scope | undefined,
  explicitNames?: string[],
): Promise<Map<string, AnalyzedColumn>> {
  const columns = new Map<string, AnalyzedColumn>();
  let outputIndex = 0;
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const target = targets[targetIndex];
    if (containsStar(target?.ResTarget?.val)) {
      const expanded = scope ? expandStarColumns(target.ResTarget.val, scope) : undefined;
      if (!expanded) {
        if (explicitNames?.length) return columns;
        continue;
      }
      for (const [name, column] of expanded) {
        columns.set(explicitNames?.[outputIndex] ?? name, column);
        outputIndex++;
      }
      continue;
    }
    const name = explicitNames?.[outputIndex]
      ?? target?.ResTarget?.name
      ?? colNameOfColumnRef(target?.ResTarget?.val)
      ?? `?column?${targetIndex}`;
    const nullable = scope
      ? computeTargetNullable(target, scope)
      : analysis?.perColumnNullable[targetIndex] ?? true;
    const sources = scope
      ? columnSourcesOfTarget(target, scope)
      : analysis?.perColumnSources[targetIndex] ?? null;
    const arrayElementNullability = scope
      ? await expressionArrayElementNullability(target?.ResTarget?.val, scope)
      : analysis?.perColumnArrayElementNullability[targetIndex] ?? "unknown";
    columns.set(name, { nullable, sources, arrayElementNullability });
    outputIndex++;
  }
  return columns;
}

function expandStarColumns(val: any, scope: Scope): [string, AnalyzedColumn][] | undefined {
  const fields = val?.ColumnRef?.fields;
  if (!Array.isArray(fields) || !fields.some((field: any) => field.A_Star !== undefined)) return undefined;
  const qualifiedAlias = columnRefAlias(fields, scope);
  const aliasNames = qualifiedAlias
    ? [qualifiedAlias]
    : fields.length === 1 && scope.unqualifiedStarAlias
      ? [scope.unqualifiedStarAlias]
      : undefined;
  if (!aliasNames) return undefined;

  const expanded: [string, AnalyzedColumn][] = [];
  for (const aliasName of aliasNames) {
    const alias = scope.aliases.get(aliasName);
    if (!alias) return undefined;
    if (alias.kind === "cte" || alias.kind === "subquery") {
      for (const [name, column] of alias.columns) {
        expanded.push([name, {
          ...column,
          nullable: column.nullable || alias.joinNullable,
        }]);
      }
      continue;
    }
    if (alias.kind !== "table") return undefined;
    const oid = scope.aliasOidByName.get(aliasName);
    const table = oid === undefined ? undefined : scope.schema.tableNameByOid(oid);
    const columns = oid === undefined ? undefined : scope.schema.columnsOf(oid);
    if (!table || !columns) return undefined;
    for (const [name, column] of [...columns].sort((left, right) => left[1].attnum - right[1].attnum)) {
      expanded.push([name, {
        nullable: !column.notNull || alias.joinNullable,
        sources: [{ schema: table.schema, table: table.name, column: name }],
        arrayElementNullability: scope.schema.arrayElement?.(column.typeOid)?.nullability ?? "unknown",
      }]);
    }
  }
  return expanded;
}

function singleStarSourceAlias(fromClause: any): string | undefined {
  if (!Array.isArray(fromClause) || fromClause.length !== 1) return undefined;
  const source = fromClause[0];
  if (source?.RangeVar) return source.RangeVar.alias?.aliasname ?? source.RangeVar.relname;
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
  const referencedTables: { schema?: string; name: string }[] = [];
  for (const a of scope.aliases.values()) {
    if (a.kind === "table") referencedTables.push({ schema: a.schema, name: a.relname });
  }

  const nullables = new Array<boolean>(rowDesc.length).fill(true);
  const sources = new Array<ColumnSource[] | null>(rowDesc.length).fill(null);
  const arrayElements = new Array<ArrayElementNullability>(rowDesc.length).fill("unknown");
  if (scope.hasStar || targets.length !== rowDesc.length) {
    for (let i = 0; i < rowDesc.length; i++) {
      const f = rowDesc[i]!;
      nullables[i] = nullableFromRowDescConservative(f, scope);
      sources[i] = sourceFromField(f, scope.schema);
      arrayElements[i] = scope.schema.arrayElement?.(f.typeOid)?.nullability ?? "unknown";
    }
    return {
      perColumnNullable: nullables,
      perColumnSources: sources,
      perColumnArrayElementNullability: arrayElements,
      referencedTables,
    };
  }

  for (let i = 0; i < rowDesc.length; i++) {
    const f = rowDesc[i]!;
    const target = targets[i]!;
    const val = target.ResTarget?.val;
    sources[i] = sourceFromField(f, scope.schema) ?? columnSourcesOfTarget(target, scope);
    arrayElements[i] = await expressionArrayElementNullability(val, scope);
    const fields = val?.ColumnRef?.fields;
    const scopedColumnRef = Array.isArray(fields)
      && !fields.some((field: any) => field.A_Star !== undefined)
      && (fields.length === 1 || columnRefAlias(fields, scope) !== undefined);
    if (scopedColumnRef) {
      nullables[i] = columnRefNullable(fields, scope);
    } else if (f.tableOid !== 0 && f.columnAttr !== 0) {
      const notNull = scope.schema.isNotNull(f.tableOid, f.columnAttr);
      const joinNullable = anyAliasNullableForOid(f.tableOid, scope);
      nullables[i] = !(notNull === true && !joinNullable);
    } else {
      nullables[i] = expressionNullable(val, scope);
    }
  }
  return {
    perColumnNullable: nullables,
    perColumnSources: sources,
    perColumnArrayElementNullability: arrayElements,
    referencedTables,
  };
}

function sourceFromField(f: FieldDescription, schema: SchemaCache): ColumnSource[] | null {
  if (f.tableOid === 0 || f.columnAttr === 0) return null;
  const table = schema.tableNameByOid(f.tableOid);
  const column = schema.columnNameByAttno(f.tableOid, f.columnAttr);
  if (!table || !column) return null;
  return [{ schema: table.schema, table: table.name, column }];
}

function columnSourcesOfTarget(target: any, scope: Scope): ColumnSource[] | null {
  const fields = target?.ResTarget?.val?.ColumnRef?.fields;
  if (!Array.isArray(fields) || fields.some((field: any) => field.A_Star !== undefined)) return null;
  let aliasName: string | undefined;
  let column: string | undefined;
  if (fields.length >= 2) {
    aliasName = columnRefAlias(fields, scope);
    column = fields[fields.length - 1]?.String?.sval;
  } else if (fields.length === 1) {
    column = fields[0]?.String?.sval;
  }
  if (typeof column !== "string") return null;

  if (aliasName) return columnSourcesForAlias(aliasName, column, scope);
  const matches: ColumnSource[][] = [];
  for (const name of scope.aliases.keys()) {
    const sources = columnSourcesForAlias(name, column, scope);
    if (sources) matches.push(sources);
  }
  return matches.length === 1 ? matches[0]! : null;
}

function columnSourcesForAlias(aliasName: string, column: string, scope: Scope): ColumnSource[] | null {
  const alias = scope.aliases.get(aliasName);
  if (!alias) return null;
  if (alias.kind === "cte" || alias.kind === "subquery") {
    return alias.columns.get(column)?.sources ?? null;
  }
  if (alias.kind !== "table") return null;
  const oid = scope.aliasOidByName.get(aliasName);
  if (oid === undefined || !scope.schema.columnsOf(oid)?.has(column)) return null;
  const table = scope.schema.tableNameByOid(oid);
  if (!table) return null;
  return [{ schema: table.schema, table: table.name, column }];
}

function addForcedNonNull(scope: Scope, set: NonNullSet): void {
  for (const k of set) scope.forcedNonNull.add(k);
}

function computeTargetNullable(target: any, scope: Scope): boolean {
  const val = target?.ResTarget?.val;
  return expressionNullable(val, scope);
}

function nullableFromRowDescConservative(f: FieldDescription, scope: Scope): boolean {
  if (f.tableOid === 0 || f.columnAttr === 0) return true;
  const notNull = scope.schema.isNotNull(f.tableOid, f.columnAttr);
  if (notNull !== true) return true;
  return anyAliasNullableForOid(f.tableOid, scope);
}

function anyAliasNullableForOid(tableOid: number, scope: Scope): boolean {
  const refs = scope.tableRefsByOid.get(tableOid);
  if (!refs || refs.length === 0) return true;
  return refs.some((r) => r.joinNullable);
}

function walkFrom(node: any, joinNullable: boolean, scope: Scope): void {
  if (!node) return;
  if (node.RangeVar) {
    const v = node.RangeVar;
    const alias = v.alias?.aliasname ?? v.relname;
    const cteCols = scope.cteColumnInfo.get(v.relname);
    if (cteCols) {
      scope.aliases.set(alias, { kind: "cte", joinNullable, columns: cteCols });
      return;
    }
    const info: AliasInfo = {
      kind: "table",
      relname: v.relname,
      joinNullable,
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
    if (alias) scope.aliases.set(alias, { kind: "subquery", joinNullable, columns: new Map() });
    return;
  }
  if (node.RangeFunction) {
    const alias = node.RangeFunction.alias?.aliasname;
    if (alias) scope.aliases.set(alias, { kind: "function", joinNullable });
    return;
  }
}

function colNameOfColumnRef(val: any): string | undefined {
  if (!val?.ColumnRef) return undefined;
  const fields = val.ColumnRef.fields;
  if (!Array.isArray(fields) || fields.length === 0) return undefined;
  if (fields.some((f: any) => f.A_Star !== undefined)) return undefined;
  return fields[fields.length - 1]?.String?.sval;
}

function containsStar(val: any): boolean {
  if (!val?.ColumnRef) return false;
  const fields = val.ColumnRef.fields;
  if (!Array.isArray(fields)) return false;
  return fields.some((f: any) => f.A_Star !== undefined);
}

function columnRefNullable(fields: any[], scope: Scope): boolean {
  let aliasName: string | undefined;
  let colName: string | undefined;
  if (fields.length >= 2) {
    aliasName = columnRefAlias(fields, scope);
    colName = fields[fields.length - 1]?.String?.sval;
  } else if (fields.length === 1) {
    colName = fields[0]?.String?.sval;
  }
  if (typeof colName !== "string") return true;

  if (isNarrowed(scope.forcedNonNull, aliasName, colName)) return false;

  if (aliasName) {
    const a = scope.aliases.get(aliasName);
    if (!a) return true;
    if (a.kind === "cte" || a.kind === "subquery") {
      const inner = a.columns.get(colName);
      if (inner === undefined) return true;
      return inner.nullable || a.joinNullable;
    }
    if (a.kind !== "table") return true;
    const oid = scope.aliasOidByName.get(aliasName);
    if (oid === undefined) return true;
    const cols = scope.schema.columnsOf(oid);
    const info = cols?.get(colName);
    if (!info) return true;
    return !info.notNull || a.joinNullable;
  }

  const matches: { alias: string; notNull: boolean; joinNullable: boolean }[] = [];
  for (const [name, a] of scope.aliases) {
    if (a.kind === "cte" || a.kind === "subquery") {
      const inner = a.columns.get(colName);
      if (inner === undefined) continue;
      matches.push({ alias: name, notNull: !inner.nullable, joinNullable: a.joinNullable });
      continue;
    }
    if (a.kind !== "table") continue;
    const oid = scope.aliasOidByName.get(name);
    if (oid === undefined) continue;
    const info = scope.schema.columnsOf(oid)?.get(colName);
    if (!info) continue;
    matches.push({ alias: name, notNull: info.notNull, joinNullable: a.joinNullable });
  }
  if (matches.length !== 1) return true;
  const m = matches[0]!;
  return !m.notNull || m.joinNullable;
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

function columnRefArrayElementNullability(fields: any[], scope: Scope): ArrayElementNullability {
  let aliasName: string | undefined;
  let colName: string | undefined;
  if (fields.length >= 2) {
    aliasName = columnRefAlias(fields, scope);
    colName = fields[fields.length - 1]?.String?.sval;
  } else if (fields.length === 1) {
    colName = fields[0]?.String?.sval;
  }
  if (typeof colName !== "string") return "unknown";

  const stateForAlias = (name: string, alias: AliasInfo): ArrayElementNullability | undefined => {
    if (alias.kind === "cte" || alias.kind === "subquery") {
      return alias.columns.get(colName!)?.arrayElementNullability;
    }
    if (alias.kind !== "table") return undefined;
    const oid = scope.aliasOidByName.get(name);
    if (oid === undefined) return undefined;
    const column = scope.schema.columnsOf(oid)?.get(colName!);
    if (!column) return undefined;
    return scope.schema.arrayElement?.(column.typeOid)?.nullability;
  };

  if (aliasName) {
    const alias = scope.aliases.get(aliasName);
    return alias ? stateForAlias(aliasName, alias) ?? "unknown" : "unknown";
  }
  const matches: ArrayElementNullability[] = [];
  for (const [name, alias] of scope.aliases) {
    const state = stateForAlias(name, alias);
    if (state !== undefined) matches.push(state);
  }
  return matches.length === 1 ? matches[0]! : "unknown";
}

function columnRefAlias(fields: any[], scope: Scope): string | undefined {
  for (let index = fields.length - 2; index >= 0; index--) {
    const name = fields[index]?.String?.sval;
    if (typeof name === "string" && scope.aliases.has(name)) return name;
  }
  return undefined;
}

async function expressionArrayElementNullability(val: any, scope: Scope): Promise<ArrayElementNullability> {
  if (!val) return "unknown";

  if (val.A_ArrayExpr) {
    const states: ArrayElementNullability[] = [];
    for (const element of val.A_ArrayExpr.elements ?? []) {
      const nested = await expressionArrayElementNullability(element, scope);
      states.push(nested === "unknown" ? (expressionNullable(element, scope) ? "nullable" : "non-null") : nested);
    }
    return mergeArrayElementNullability(states);
  }

  if (val.ColumnRef) {
    const fields = val.ColumnRef.fields;
    if (!Array.isArray(fields) || fields.some((field: any) => field.A_Star !== undefined)) return "unknown";
    return columnRefArrayElementNullability(fields, scope);
  }

  if (val.FuncCall && funcName(val.FuncCall) === "array_agg") {
    const arg = val.FuncCall.args?.[0];
    if (!arg) return "unknown";
    const nested = await expressionArrayElementNullability(arg, scope);
    return nested === "unknown" ? (expressionNullable(arg, scope) ? "nullable" : "non-null") : nested;
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

function expressionNullable(val: any, scope: Scope): boolean {
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
    return columnRefNullable(fields, scope);
  }

  if (val.FuncCall) {
    const name = funcName(val.FuncCall);
    if (name && COUNT_FUNCS.has(name)) return false;
    if (name && NON_NULL_FUNCS.has(name)) {
      const args = val.FuncCall.args ?? [];
      return args.some((a: any) => expressionNullable(a, scope));
    }
    if (name === "greatest" || name === "least") {
      const args = val.FuncCall.args ?? [];
      if (args.length === 0) return true;
      return args.every((a: any) => expressionNullable(a, scope));
    }
    return true;
  }

  if (val.CoalesceExpr) {
    const args = val.CoalesceExpr.args ?? [];
    if (args.length === 0) return true;
    return args.every((a: any) => expressionNullable(a, scope));
  }

  if (val.MinMaxExpr) {
    const args = val.MinMaxExpr.args ?? [];
    if (args.length === 0) return true;
    return args.every((a: any) => expressionNullable(a, scope));
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
    return [...branches, elseExpr].some((b: any) => expressionNullable(b, scope));
  }

  if (val.A_Expr) {
    const e = val.A_Expr;
    return expressionNullable(e.lexpr, scope) || expressionNullable(e.rexpr, scope);
  }

  if (val.SubLink) {
    const type = val.SubLink.subLinkType;
    return type !== "ARRAY_SUBLINK" && type !== "EXISTS_SUBLINK";
  }

  if (val.TypeCast) {
    return expressionNullable(val.TypeCast.arg, scope);
  }

  if (val.BoolExpr) {
    const a = val.BoolExpr.args ?? [];
    return a.some((x: any) => expressionNullable(x, scope));
  }

  return true;
}
