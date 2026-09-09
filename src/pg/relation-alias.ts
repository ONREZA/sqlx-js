export function aliasColumnNames(alias: any): string[] | undefined {
  const names = alias?.colnames?.map((node: any) => node?.String?.sval);
  return names?.length ? names : undefined;
}

export function relationAliasKey(relation: any): string {
  return relation.alias?.aliasname
    ?? (relation.schemaname ? `${relation.schemaname}\0${relation.relname}` : relation.relname);
}

export function rangeFunctionAlias(range: any): string | undefined {
  const call = range.functions?.[0]?.List?.items?.[0]?.FuncCall;
  return range.alias?.aliasname ?? call?.funcname?.at(-1)?.String?.sval;
}

export function visibleAliasName(key: string): string {
  return key.slice(key.lastIndexOf("\0") + 1);
}
