import { parse } from "libpg-query";

export type ParamTarget = { schema?: string; table: string; column?: string; columnIndex?: number };
export type ParamMap = Map<number, ParamTarget>;

export type ParamMapResult = {
  targets: ParamMap;
  forceNullable: Set<number>;
  dmlBound: Set<number>;
};

export async function buildParamMap(sql: string): Promise<ParamMapResult> {
  const targets: ParamMap = new Map();
  const forceNullable = new Set<number>();
  const dmlBound = new Set<number>();
  const ast = await parse(sql);
  const stmt = ast?.stmts?.[0]?.stmt;
  if (!stmt) return { targets, forceNullable, dmlBound };

  if (stmt.InsertStmt) walkInsert(stmt.InsertStmt, targets, dmlBound);
  else if (stmt.UpdateStmt) walkUpdate(stmt.UpdateStmt, targets, dmlBound);
  else if (stmt.SelectStmt) walkSelect(stmt.SelectStmt, targets, dmlBound);
  else if (stmt.DeleteStmt) walkDelete(stmt.DeleteStmt, targets, dmlBound);

  walkForceNullable(stmt, false, forceNullable);
  return { targets, forceNullable, dmlBound };
}

type Rel = { schema?: string; table: string };

type Scope = {
  aliases: Map<string, Rel>;
  relations: Rel[];
  defaultRel: Rel | null;
};

function walkInsert(ins: any, map: ParamMap, dmlBound: Set<number>): void {
  const rel = relOf(ins.relation);
  if (!rel) return;
  const scope = scopeFromRelationNode(ins.relation, rel);
  const cols: string[] = (ins.cols ?? [])
    .map((c: any) => c?.ResTarget?.name)
    .filter((n: any): n is string => typeof n === "string");
  const valuesLists = ins.selectStmt?.SelectStmt?.valuesLists ?? [];
  for (const row of valuesLists) {
    const items = row?.List?.items ?? [];
    for (let i = 0; i < items.length; i++) {
      const pn = paramNumber(items[i]);
      if (pn !== null) {
        bindParam(map, dmlBound, pn, insertTarget(rel, cols, i), true);
      }
    }
  }

  const select = ins.selectStmt?.SelectStmt;
  if (select && !select.valuesLists && Array.isArray(select.targetList)) {
    for (let i = 0; i < select.targetList.length; i++) {
      const pn = paramNumber(select.targetList[i]?.ResTarget?.val);
      if (pn !== null) {
        bindParam(map, dmlBound, pn, insertTarget(rel, cols, i), true);
      }
    }
    walkSelect(select, map, dmlBound);
  }
  if (ins.returningList) walkExpr(ins.returningList, scope, map, dmlBound);
  walkOnConflict(ins.onConflictClause, rel, scope, map, dmlBound);
  walkExpr(ins.whereClause, scope, map, dmlBound);
}

function walkOnConflict(conflict: any, rel: Rel, scope: Scope, map: ParamMap, dmlBound: Set<number>): void {
  if (!conflict || conflict.action !== "ONCONFLICT_UPDATE") return;
  for (const rt of conflict.targetList ?? []) {
    const colName = rt?.ResTarget?.name;
    if (typeof colName !== "string") continue;
    const pn = paramNumber(rt.ResTarget.val);
    if (pn !== null) {
      bindParam(map, dmlBound, pn, { ...rel, column: colName }, true);
    }
  }
  walkExpr(conflict.whereClause, scope, map, dmlBound);
}

function walkUpdate(upd: any, map: ParamMap, dmlBound: Set<number>): void {
  const rel = relOf(upd.relation);
  if (!rel) return;
  const scope = scopeFromRelationNode(upd.relation, rel);
  addRangeVars(upd.fromClause ?? [], scope);
  for (const rt of upd.targetList ?? []) {
    const colName = rt?.ResTarget?.name;
    if (typeof colName !== "string") continue;
    const pn = paramNumber(rt.ResTarget.val);
    if (pn !== null) {
      bindParam(map, dmlBound, pn, { ...rel, column: colName }, true);
    }
  }
  walkExpr(upd.whereClause, scope, map, dmlBound);
}

function walkDelete(del: any, map: ParamMap, dmlBound: Set<number>): void {
  const rel = relOf(del.relation);
  if (!rel) return;
  const scope = scopeFromRelationNode(del.relation, rel);
  addRangeVars(del.usingClause ?? [], scope);
  walkExpr(del.whereClause, scope, map, dmlBound);
}

function walkSelect(select: any, map: ParamMap, dmlBound: Set<number>): void {
  const scope = scopeFromSelect(select);
  walkJoinQuals(select.fromClause ?? [], scope, map, dmlBound);
  walkExpr(select.whereClause, scope, map, dmlBound);
}

function walkExpr(node: any, scope: Scope, map: ParamMap, dmlBound: Set<number>): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walkExpr(item, scope, map, dmlBound);
    return;
  }
  if (node.BoolExpr) {
    for (const a of node.BoolExpr.args ?? []) walkExpr(a, scope, map, dmlBound);
    return;
  }
  if (node.A_Expr) {
    collectFromExpr(node, scope, map, dmlBound);
    walkExpr(node.A_Expr.lexpr, scope, map, dmlBound);
    walkExpr(node.A_Expr.rexpr, scope, map, dmlBound);
    return;
  }
  if (node.TypeCast) {
    walkExpr(node.TypeCast.arg, scope, map, dmlBound);
    return;
  }
  if (node.NullTest) {
    walkExpr(node.NullTest.arg, scope, map, dmlBound);
    return;
  }
  if (node.CoalesceExpr) {
    walkExpr(node.CoalesceExpr.args ?? [], scope, map, dmlBound);
    return;
  }
  if (node.FuncCall) {
    walkExpr(node.FuncCall.args ?? [], scope, map, dmlBound);
    return;
  }
  if (node.CaseExpr) {
    walkExpr(node.CaseExpr.arg, scope, map, dmlBound);
    walkExpr(node.CaseExpr.args ?? [], scope, map, dmlBound);
    walkExpr(node.CaseExpr.defresult, scope, map, dmlBound);
    return;
  }
  if (node.CaseWhen) {
    walkExpr(node.CaseWhen.expr, scope, map, dmlBound);
    walkExpr(node.CaseWhen.result, scope, map, dmlBound);
    return;
  }
  if (node.SubLink) {
    const sub = node.SubLink.subselect?.SelectStmt;
    if (sub) walkSelect(sub, map, dmlBound);
    walkExpr(node.SubLink.testexpr, scope, map, dmlBound);
    return;
  }
}

function collectFromExpr(
  node: any,
  scope: Scope,
  map: ParamMap,
  dmlBound: Set<number>,
): void {
  if (!node) return;
  if (node.A_Expr) {
    const e = node.A_Expr;
    const opName = e.name?.[0]?.String?.sval;
    if (e.kind === "AEXPR_OP" && opName === "=") {
      tryBind(e.lexpr, e.rexpr, scope, map, dmlBound);
      tryBind(e.rexpr, e.lexpr, scope, map, dmlBound);
    }
    if (e.kind === "AEXPR_IN") {
      const target = targetOfColumnRef(e.lexpr, scope);
      if (target) {
        const list = Array.isArray(e.rexpr) ? e.rexpr : e.rexpr?.List?.items ?? [];
        for (const item of list) {
          const pn = paramNumber(item);
          if (pn !== null) bindParam(map, dmlBound, pn, target, false);
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
  dmlBound: Set<number>,
): void {
  const target = targetOfColumnRef(colSide, scope);
  const pn = paramNumber(valSide);
  if (target && pn !== null) bindParam(map, dmlBound, pn, target, false);
}

function bindParam(map: ParamMap, dmlBound: Set<number>, pn: number, target: ParamTarget, dml: boolean): void {
  if (!dml && dmlBound.has(pn)) return;
  map.set(pn, target);
  if (dml) dmlBound.add(pn);
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

function walkJoinQuals(nodes: any[], scope: Scope, map: ParamMap, dmlBound: Set<number>): void {
  for (const node of nodes) {
    if (!node?.JoinExpr) continue;
    walkExpr(node.JoinExpr.quals, scope, map, dmlBound);
    walkJoinQuals([node.JoinExpr.larg, node.JoinExpr.rarg], scope, map, dmlBound);
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
