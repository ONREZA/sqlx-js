import type { AliasInfo, Scope } from "./analyze-types";
import { aliasQualifiers, isAliasNarrowed } from "./analyze-columns";
import { relationAliasKey, visibleAliasName } from "./relation-alias";
import { columnReference } from "./narrow";

export type DmlKind = "insert" | "update" | "delete";
type RowVersion = "old" | "new";

export function returningTargets(stmt: any): any[] {
  return stmt.returningClause?.exprs ?? [];
}

function returningAliases(stmt: any, existing: ReadonlySet<string>): Map<string, RowVersion> {
  const aliases = new Map<string, RowVersion>();
  const specified = new Set<RowVersion>();
  for (const entry of stmt.returningClause?.options ?? []) {
    const option = entry.ReturningOption;
    const version = option?.option === "RETURNING_OPTION_OLD" ? "old"
      : option?.option === "RETURNING_OPTION_NEW" ? "new" : undefined;
    if (version && typeof option.value === "string") {
      specified.add(version);
      aliases.set(option.value, version);
    }
  }
  for (const version of ["old", "new"] as const) {
    if (!specified.has(version) && !existing.has(version) && !aliases.has(version)) {
      aliases.set(version, version);
    }
  }
  return aliases;
}

export function applyReturningScope(scope: Scope, stmt: any, kind: DmlKind): void {
  const targetAlias = relationAliasKey(stmt.relation);
  const target = scope.aliases.get(targetAlias);
  const oid = scope.aliasOidByName.get(targetAlias);
  const columns = oid === undefined ? undefined : scope.schema.columnsOf(oid);
  const oldNonNull = new Set<string>();
  if (kind !== "insert") {
    for (const name of columns?.keys() ?? []) {
      if (isAliasNarrowed(targetAlias, name, scope)) oldNonNull.add(name);
    }
  }

  if (kind === "update") {
    const qualifiers = new Set(aliasQualifiers(targetAlias, scope));
    for (const key of scope.forcedNonNull) {
      const [alias, column] = columnReference(key);
      if (qualifiers.has(alias) || (alias === "" && (!columns || columns.has(column)))) {
        scope.forcedNonNull.delete(key);
      }
    }
  }

  // RETURNING * expands only the target, even with UPDATE FROM or DELETE USING.
  scope.unqualifiedStarAlias = targetAlias;
  if (target?.kind !== "table") return;
  const visibleNames = new Set([...scope.aliases.keys()].map(visibleAliasName));
  for (const [name, version] of returningAliases(stmt, visibleNames)) {
    const nullable = version === "old" ? kind === "insert" : kind === "delete";
    const info: AliasInfo = {
      ...target,
      joinNullable: nullable,
      returning: { nonNullColumns: version === "old" ? oldNonNull : new Set() },
    };
    scope.aliases.set(name, info);
    if (oid !== undefined) {
      scope.aliasOidByName.set(name, oid);
      scope.tableRefsByOid.get(oid)?.push(info);
    }
  }
}

export function dmlAsSelect(stmt: any, kind: DmlKind, targetList: any[]): any {
  const fromClause = stmt.relation ? [{ RangeVar: stmt.relation }] : [];
  if (kind === "update" && Array.isArray(stmt.fromClause)) fromClause.push(...stmt.fromClause);
  if (kind === "delete" && Array.isArray(stmt.usingClause)) fromClause.push(...stmt.usingClause);
  return {
    targetList,
    fromClause,
    whereClause: kind === "update" || kind === "delete" ? stmt.whereClause : undefined,
    withClause: stmt.withClause,
  };
}

export function tablesFromRelation(relation: any): { schema?: string; name: string }[] {
  if (!relation || typeof relation.relname !== "string") return [];
  return [{ name: relation.relname, ...(relation.schemaname ? { schema: relation.schemaname } : {}) }];
}
