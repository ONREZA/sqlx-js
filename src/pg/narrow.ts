export type NonNullSet = Set<string>;

const NULL_REJECTING_OPS = new Set(["=", "!=", "<>", "<", ">", "<=", ">="]);
type EqualityEdge = readonly [string, string];
type NarrowInfo = { forced: NonNullSet; equalities: EqualityEdge[] };

export function narrowFromWhere(whereClause: any): NonNullSet {
  if (!whereClause) return new Set();
  return walk(whereClause).forced;
}

function emptyInfo(): NarrowInfo {
  return { forced: new Set(), equalities: [] };
}

function forcedInfo(keys: Iterable<string>): NarrowInfo {
  return { forced: new Set(keys), equalities: [] };
}

function propagateEqualities(info: NarrowInfo): NarrowInfo {
  if (info.forced.size === 0 || info.equalities.length === 0) return info;

  const graph = new Map<string, Set<string>>();
  for (const [left, right] of info.equalities) {
    if (left === right) continue;
    const l = graph.get(left) ?? new Set<string>();
    l.add(right);
    graph.set(left, l);
    const r = graph.get(right) ?? new Set<string>();
    r.add(left);
    graph.set(right, r);
  }

  const forced = new Set(info.forced);
  const queue = [...forced];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const next of graph.get(current) ?? []) {
      if (forced.has(next)) continue;
      forced.add(next);
      queue.push(next);
    }
  }
  return { forced, equalities: info.equalities };
}

function walk(node: any): NarrowInfo {
  if (!node) return emptyInfo();

  if (node.NullTest) {
    if (node.NullTest.nulltesttype === "IS_NOT_NULL") {
      const k = keyOfColumnRef(node.NullTest.arg);
      return k ? forcedInfo([k]) : emptyInfo();
    }
    return emptyInfo();
  }

  if (node.BoolExpr) {
    const op = node.BoolExpr.boolop;
    const args = node.BoolExpr.args ?? [];
    if (op === "AND_EXPR") {
      const out: NarrowInfo = { forced: new Set(), equalities: [] };
      for (const a of args) {
        const child = walk(a);
        for (const k of child.forced) out.forced.add(k);
        out.equalities.push(...child.equalities);
      }
      return propagateEqualities(out);
    }
    if (op === "OR_EXPR") {
      if (args.length === 0) return emptyInfo();
      let acc: NonNullSet | undefined;
      for (const a of args) {
        const s = walk(a).forced;
        if (!acc) acc = new Set(s);
        else {
          const next = new Set<string>();
          for (const k of acc) if (s.has(k)) next.add(k);
          acc = next;
        }
      }
      return forcedInfo(acc ?? []);
    }
    if (op === "NOT_EXPR") {
      const arg = args[0];
      if (arg?.NullTest?.nulltesttype === "IS_NULL") {
        const k = keyOfColumnRef(arg.NullTest.arg);
        return k ? forcedInfo([k]) : emptyInfo();
      }
      return emptyInfo();
    }
    return emptyInfo();
  }

  if (node.A_Expr) {
    const e = node.A_Expr;
    const kind = e.kind;
    const opName = e.name?.[0]?.String?.sval;
    const lk = keyOfColumnRef(e.lexpr);
    const rk = keyOfColumnRef(e.rexpr);
    if (kind === "AEXPR_OP" && opName && NULL_REJECTING_OPS.has(opName)) {
      const out = new Set<string>();
      const lIsNull = isNullLiteral(e.lexpr);
      const rIsNull = isNullLiteral(e.rexpr);
      if (lk && !rIsNull) out.add(lk);
      if (rk && !lIsNull) out.add(rk);
      const equalities: EqualityEdge[] = opName === "=" && lk && rk ? [[lk, rk]] : [];
      return { forced: out, equalities };
    }
    if (kind === "AEXPR_NOT_DISTINCT" && opName === "=" && lk && rk) {
      return { forced: new Set(), equalities: [[lk, rk]] };
    }
    if (kind === "AEXPR_IN" || kind === "AEXPR_LIKE" || kind === "AEXPR_ILIKE" || kind === "AEXPR_BETWEEN") {
      const k = keyOfColumnRef(e.lexpr);
      return k ? forcedInfo([k]) : emptyInfo();
    }
    return emptyInfo();
  }

  return emptyInfo();
}

function keyOfColumnRef(node: any): string | null {
  if (!node?.ColumnRef) return null;
  const fields = node.ColumnRef.fields;
  if (!Array.isArray(fields) || fields.length === 0) return null;
  if (fields.some((f: any) => f.A_Star !== undefined)) return null;
  if (fields.length === 1) {
    const col = fields[0]?.String?.sval;
    return typeof col === "string" ? `|${col}` : null;
  }
  const alias = fields[0]?.String?.sval;
  const col = fields[fields.length - 1]?.String?.sval;
  if (typeof alias !== "string" || typeof col !== "string") return null;
  return `${alias}|${col}`;
}

function isNullLiteral(node: any): boolean {
  return node?.A_Const?.isnull === true;
}

export function isNarrowed(set: NonNullSet, alias: string | undefined, col: string): boolean {
  if (set.size === 0) return false;
  if (alias && set.has(`${alias}|${col}`)) return true;
  if (set.has(`|${col}`)) return true;
  if (!alias) {
    const suffix = `|${col}`;
    for (const k of set) if (k.endsWith(suffix)) return true;
  }
  return false;
}
