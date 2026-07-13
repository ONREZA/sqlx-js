import { parse } from "libpg-query";

export type ParamTarget = { schema?: string; table: string; column?: string; columnIndex?: number };
export type DmlParamTarget = { target: ParamTarget; nullSafe: boolean };
export type ParamBinding = {
  dmlTargets: DmlParamTarget[];
  referenceTargets: ParamTarget[];
};
export type ParamMap = Map<number, ParamBinding>;

export type ParamMapResult = {
  bindings: ParamMap;
  forceNullable: Set<number>;
};

export async function buildParamMap(sql: string): Promise<ParamMapResult> {
  const bindings: ParamMap = new Map();
  const forceNullable = new Set<number>();
  const ast = await parse(sql);
  const stmt = ast?.stmts?.[0]?.stmt;
  if (!stmt) return { bindings, forceNullable };

  walkStatement(stmt, bindings);

  walkForceNullable(stmt, false, forceNullable);
  return { bindings, forceNullable };
}

export function effectiveParamTargets(binding: ParamBinding | undefined): ParamTarget[] {
  if (!binding) return [];
  return binding.dmlTargets.length > 0
    ? binding.dmlTargets.map((candidate) => candidate.target)
    : binding.referenceTargets;
}

type Rel = { schema?: string; table: string };

type Scope = {
  aliases: Map<string, Rel>;
  relations: Rel[];
  defaultRel: Rel | null;
};

function walkStatement(stmt: any, map: ParamMap): void {
  if (stmt?.InsertStmt) walkInsert(stmt.InsertStmt, map);
  else if (stmt?.UpdateStmt) walkUpdate(stmt.UpdateStmt, map);
  else if (stmt?.SelectStmt) walkSelect(stmt.SelectStmt, map);
  else if (stmt?.DeleteStmt) walkDelete(stmt.DeleteStmt, map);
}

function walkWithClause(withClause: any, map: ParamMap): void {
  for (const wrapper of withClause?.ctes ?? []) {
    walkStatement(wrapper?.CommonTableExpr?.ctequery, map);
  }
}

function walkInsert(ins: any, map: ParamMap): void {
  walkWithClause(ins.withClause, map);
  const rel = relOf(ins.relation);
  if (!rel) return;
  const scope = scopeFromRelationNode(ins.relation, rel);
  const cols: string[] = (ins.cols ?? [])
    .map((c: any) => c?.ResTarget?.name)
    .filter((n: any): n is string => typeof n === "string");
  const select = ins.selectStmt?.SelectStmt;
  if (select) {
    bindSelectValueParams(select, (index) => insertTarget(rel, cols, index), map);
    walkSelect(select, map);
  }
  if (ins.returningList) walkExpr(ins.returningList, scope, map);
  walkOnConflict(ins.onConflictClause, rel, scope, map);
  walkExpr(ins.whereClause, scope, map);
}

function walkOnConflict(conflict: any, rel: Rel, scope: Scope, map: ParamMap): void {
  if (!conflict || conflict.action !== "ONCONFLICT_UPDATE") return;
  const guards = nonNullGuardParams(conflict.whereClause);
  for (const rt of conflict.targetList ?? []) {
    const colName = rt?.ResTarget?.name;
    if (typeof colName !== "string") continue;
    bindAssignmentValueParams(rt.ResTarget.val, { ...rel, column: colName }, map, guards);
    walkExpr(rt.ResTarget.val, scope, map);
  }
  walkExpr(conflict.whereClause, scope, map);
}

function walkUpdate(upd: any, map: ParamMap): void {
  walkWithClause(upd.withClause, map);
  const rel = relOf(upd.relation);
  if (!rel) return;
  const scope = scopeFromRelationNode(upd.relation, rel);
  addRangeVars(upd.fromClause ?? [], scope);
  const guards = nonNullGuardParams(upd.whereClause);
  for (const rt of upd.targetList ?? []) {
    const colName = rt?.ResTarget?.name;
    if (typeof colName !== "string") continue;
    bindAssignmentValueParams(rt.ResTarget.val, { ...rel, column: colName }, map, guards);
    walkExpr(rt.ResTarget.val, scope, map);
  }
  walkExpr(upd.whereClause, scope, map);
}

function walkDelete(del: any, map: ParamMap): void {
  walkWithClause(del.withClause, map);
  const rel = relOf(del.relation);
  if (!rel) return;
  const scope = scopeFromRelationNode(del.relation, rel);
  addRangeVars(del.usingClause ?? [], scope);
  walkExpr(del.whereClause, scope, map);
}

function walkSelect(select: any, map: ParamMap): void {
  walkWithClause(select?.withClause, map);
  if (select?.larg) walkSelect(select.larg, map);
  if (select?.rarg) walkSelect(select.rarg, map);
  const scope = scopeFromSelect(select);
  walkJoinQuals(select.fromClause ?? [], scope, map);
  walkExpr(select.whereClause, scope, map);
}

function bindSelectValueParams(
  select: any,
  targetAt: (index: number) => ParamTarget | undefined,
  map: ParamMap,
  inheritedGuards: ReadonlySet<number> = new Set(),
): void {
  if (select?.larg || select?.rarg) {
    if (select.larg) bindSelectValueParams(select.larg, targetAt, map, inheritedGuards);
    if (select.rarg) bindSelectValueParams(select.rarg, targetAt, map, inheritedGuards);
    return;
  }
  const guards = unionParams(inheritedGuards, nonNullGuardParams(select?.whereClause));
  for (const row of select?.valuesLists ?? []) {
    const items = row?.List?.items ?? [];
    for (let i = 0; i < items.length; i++) {
      const target = targetAt(i);
      if (target) bindValueParams(items[i], target, map, false, guards);
    }
  }
  if (select?.valuesLists || !Array.isArray(select?.targetList)) return;
  for (let i = 0; i < select.targetList.length; i++) {
    const target = targetAt(i);
    if (target) bindValueParams(select.targetList[i]?.ResTarget?.val, target, map, false, guards);
  }
}

function bindAssignmentValueParams(
  node: any,
  target: ParamTarget,
  map: ParamMap,
  guards: ReadonlySet<number> = new Set(),
): void {
  const multi = node?.MultiAssignRef;
  if (!multi || typeof multi.colno !== "number") {
    bindValueParams(node, target, map, false, guards);
    return;
  }
  const index = multi.colno - 1;
  const rowValue = multi.source?.RowExpr?.args?.[index];
  if (rowValue) {
    bindValueParams(rowValue, target, map, false, guards);
    return;
  }
  const select = multi.source?.SubLink?.subselect?.SelectStmt;
  if (!select) return;
  bindSelectValueParams(select, (candidate) => candidate === index ? target : undefined, map, guards);
  walkSelect(select, map);
}

function walkExpr(node: any, scope: Scope, map: ParamMap): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walkExpr(item, scope, map);
    return;
  }
  if (node.BoolExpr) {
    for (const a of node.BoolExpr.args ?? []) walkExpr(a, scope, map);
    return;
  }
  if (node.A_Expr) {
    collectFromExpr(node, scope, map);
    walkExpr(node.A_Expr.lexpr, scope, map);
    walkExpr(node.A_Expr.rexpr, scope, map);
    return;
  }
  if (node.TypeCast) {
    walkExpr(node.TypeCast.arg, scope, map);
    return;
  }
  if (node.NullTest) {
    walkExpr(node.NullTest.arg, scope, map);
    return;
  }
  if (node.CoalesceExpr) {
    walkExpr(node.CoalesceExpr.args ?? [], scope, map);
    return;
  }
  if (node.FuncCall) {
    walkExpr(node.FuncCall.args ?? [], scope, map);
    return;
  }
  if (node.CaseExpr) {
    walkExpr(node.CaseExpr.arg, scope, map);
    walkExpr(node.CaseExpr.args ?? [], scope, map);
    walkExpr(node.CaseExpr.defresult, scope, map);
    return;
  }
  if (node.CaseWhen) {
    walkExpr(node.CaseWhen.expr, scope, map);
    walkExpr(node.CaseWhen.result, scope, map);
    return;
  }
  if (node.SubLink) {
    const sub = node.SubLink.subselect?.SelectStmt;
    if (sub) walkSelect(sub, map);
    walkExpr(node.SubLink.testexpr, scope, map);
    return;
  }
}

function collectFromExpr(
  node: any,
  scope: Scope,
  map: ParamMap,
): void {
  if (!node) return;
  if (node.A_Expr) {
    const e = node.A_Expr;
    const opName = e.name?.[0]?.String?.sval;
    if (e.kind === "AEXPR_OP" && opName === "=") {
      tryBind(e.lexpr, e.rexpr, scope, map);
      tryBind(e.rexpr, e.lexpr, scope, map);
    }
    if (e.kind === "AEXPR_IN") {
      const target = targetOfColumnRef(e.lexpr, scope);
      if (target) {
        const list = Array.isArray(e.rexpr) ? e.rexpr : e.rexpr?.List?.items ?? [];
        for (const item of list) {
          const pn = paramNumber(item);
          if (pn !== null) bindParam(map, pn, target, false);
        }
      }
    }
  }
}

function tryBind(
  colSide: any,
  valSide: any,
  scope: Scope,
  map: ParamMap,
): void {
  const target = targetOfColumnRef(colSide, scope);
  const pn = paramNumber(valSide);
  if (target && pn !== null) bindParam(map, pn, target, false);
}

function sameTarget(left: ParamTarget, right: ParamTarget): boolean {
  return left.schema === right.schema
    && left.table === right.table
    && left.column === right.column
    && left.columnIndex === right.columnIndex;
}

function bindParam(
  map: ParamMap,
  pn: number,
  target: ParamTarget,
  dml: boolean,
  nullSafe = false,
): void {
  let binding = map.get(pn);
  if (!binding) {
    binding = { dmlTargets: [], referenceTargets: [] };
    map.set(pn, binding);
  }
  if (!dml) {
    if (!binding.referenceTargets.some((candidate) => sameTarget(candidate, target))) {
      binding.referenceTargets.push(target);
    }
    return;
  }
  const existing = binding.dmlTargets.find((candidate) => sameTarget(candidate.target, target));
  if (existing) {
    existing.nullSafe = existing.nullSafe && nullSafe;
    return;
  }
  binding.dmlTargets.push({ target, nullSafe });
}

function bindValueParams(
  node: any,
  target: ParamTarget,
  map: ParamMap,
  nullSafe = false,
  guards: ReadonlySet<number> = new Set(),
): void {
  const pn = paramNumber(node);
  if (pn !== null) {
    bindParam(map, pn, target, true, nullSafe || guards.has(pn));
    return;
  }
  if (node?.TypeCast) {
    bindValueParams(node.TypeCast.arg, target, map, nullSafe, guards);
    return;
  }
  if (node?.CollateClause) {
    bindValueParams(node.CollateClause.arg, target, map, nullSafe, guards);
    return;
  }
  if (node?.CaseExpr) {
    for (const item of node.CaseExpr.args ?? []) {
      bindValueParams(item?.CaseWhen?.result, target, map, nullSafe, guards);
    }
    bindValueParams(node.CaseExpr.defresult, target, map, nullSafe, guards);
    return;
  }
  if (node?.CoalesceExpr) {
    for (const item of node.CoalesceExpr.args ?? []) bindValueParams(item, target, map, true, guards);
    return;
  }
  if (node?.MinMaxExpr) {
    for (const item of node.MinMaxExpr.args ?? []) bindValueParams(item, target, map, nullSafe, guards);
    return;
  }
  if (node?.A_Expr?.kind === "AEXPR_NULLIF") {
    bindValueParams(node.A_Expr.lexpr, target, map, nullSafe, guards);
  }
}

function unionParams(left: ReadonlySet<number>, right: ReadonlySet<number>): Set<number> {
  return new Set([...left, ...right]);
}

function intersectParams(sets: Set<number>[]): Set<number> {
  if (sets.length === 0) return new Set();
  return new Set([...sets[0]!].filter((param) => sets.slice(1).every((set) => set.has(param))));
}

function nonNullGuardParams(node: any): Set<number> {
  const nullTest = node?.NullTest;
  if (nullTest?.nulltesttype === "IS_NOT_NULL") {
    const pn = paramNumber(nullTest.arg);
    return pn === null ? new Set() : new Set([pn]);
  }
  const bool = node?.BoolExpr;
  if (!bool) return new Set();
  const args = bool.args ?? [];
  if (bool.boolop === "AND_EXPR") {
    return args.reduce(
      (guards: Set<number>, arg: any) => unionParams(guards, nonNullGuardParams(arg)),
      new Set<number>(),
    );
  }
  if (bool.boolop === "OR_EXPR") {
    return intersectParams(args.map((arg: any) => nonNullGuardParams(arg)));
  }
  const negated = args.length === 1 ? args[0]?.NullTest : undefined;
  if (bool.boolop === "NOT_EXPR" && negated?.nulltesttype === "IS_NULL") {
    const pn = paramNumber(negated.arg);
    return pn === null ? new Set() : new Set([pn]);
  }
  return new Set();
}

function stringFields(node: any): string[] | null {
  if (!node?.ColumnRef) return null;
  const fields = node.ColumnRef.fields;
  if (!Array.isArray(fields) || fields.length === 0) return null;
  if (fields.some((f: any) => f.A_Star !== undefined)) return null;
  const out = fields.map((f: any) => f.String?.sval);
  return out.every((s: any): s is string => typeof s === "string") ? out : null;
}

function targetOfColumnRef(node: any, scope: Scope): ParamTarget | null {
  const fields = stringFields(node);
  if (!fields) return null;
  const column = fields[fields.length - 1]!;
  if (fields.length === 1) {
    return scope.defaultRel ? { ...scope.defaultRel, column } : null;
  }
  if (fields.length === 2) {
    const qualifier = fields[0]!;
    const rel = scope.aliases.get(qualifier) ?? scope.relations.find((r) => r.table === qualifier);
    return rel ? { ...rel, column } : { table: qualifier, column };
  }
  const table = fields[fields.length - 2]!;
  const schema = fields[fields.length - 3]!;
  return { schema, table, column };
}

function paramNumber(node: any): number | null {
  if (node?.ParamRef && typeof node.ParamRef.number === "number") return node.ParamRef.number;
  if (node?.TypeCast) return paramNumber(node.TypeCast.arg);
  return null;
}

function relOf(relation: any): { schema?: string; table: string } | null {
  if (!relation) return null;
  const name = relation.relname;
  if (typeof name !== "string") return null;
  return { schema: relation.schemaname || undefined, table: name };
}

function insertTarget(rel: Rel, cols: string[], index: number): ParamTarget {
  const column = cols[index];
  return column ? { ...rel, column } : { ...rel, columnIndex: index + 1 };
}

function scopeFromSelect(select: any): Scope {
  const scope = scopeFromRelations([], null);
  addRangeVars(select?.fromClause ?? [], scope);
  if (scope.relations.length === 1) scope.defaultRel = scope.relations[0]!;
  return scope;
}

function scopeFromRelations(relations: Rel[], defaultRel: Rel | null): Scope {
  const scope: Scope = { aliases: new Map(), relations: [], defaultRel };
  for (const rel of relations) addRelation(scope, rel, rel.table);
  return scope;
}

function scopeFromRelationNode(relation: any, rel: Rel): Scope {
  const scope = scopeFromRelations([rel], rel);
  const alias = relation?.alias?.aliasname;
  if (typeof alias === "string") scope.aliases.set(alias, rel);
  return scope;
}

function addRelation(scope: Scope, rel: Rel, alias: string): void {
  scope.relations.push(rel);
  scope.aliases.set(alias, rel);
}

function addRangeVars(nodes: any[], scope: Scope): void {
  for (const node of nodes) {
    if (node?.RangeVar) {
      const rel = relOf(node.RangeVar);
      if (!rel) continue;
      const alias = node.RangeVar.alias?.aliasname ?? rel.table;
      addRelation(scope, rel, alias);
      continue;
    }
    if (node?.JoinExpr) {
      addRangeVars([node.JoinExpr.larg, node.JoinExpr.rarg], scope);
    }
  }
}

function walkJoinQuals(nodes: any[], scope: Scope, map: ParamMap): void {
  for (const node of nodes) {
    if (!node?.JoinExpr) continue;
    walkExpr(node.JoinExpr.quals, scope, map);
    walkJoinQuals([node.JoinExpr.larg, node.JoinExpr.rarg], scope, map);
  }
}

function walkForceNullable(node: any, forceContext: boolean, out: Set<number>): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForceNullable(item, forceContext, out);
    return;
  }
  if (typeof node !== "object") return;

  if (node.ParamRef && typeof node.ParamRef.number === "number") {
    if (forceContext) out.add(node.ParamRef.number);
    return;
  }
  if (node.TypeCast) {
    walkForceNullable(node.TypeCast.arg, forceContext, out);
    return;
  }
  if (node.CoalesceExpr) {
    for (const a of node.CoalesceExpr.args ?? []) walkForceNullable(a, true, out);
    return;
  }
  if (node.NullTest) {
    walkForceNullable(node.NullTest.arg, true, out);
    return;
  }
  if (node.A_Expr) {
    const kind = node.A_Expr.kind;
    if (kind === "AEXPR_NULLIF" || kind === "AEXPR_DISTINCT" || kind === "AEXPR_NOT_DISTINCT") {
      walkForceNullable(node.A_Expr.lexpr, true, out);
      walkForceNullable(node.A_Expr.rexpr, true, out);
      return;
    }
  }
  for (const key of Object.keys(node)) {
    walkForceNullable(node[key], forceContext, out);
  }
}
