export function aliasColumnNames(alias: any): string[] | undefined {
  const names = alias?.colnames?.map((node: any) => node?.String?.sval);
  return names?.length ? names : undefined;
}

export function relationAliasKey(relation: any): string {
  return relation.alias?.aliasname
    ?? (relation.schemaname ? `${relation.schemaname}\0${relation.relname}` : relation.relname);
}

export function visibleAliasName(key: string): string {
  return key.slice(key.lastIndexOf("\0") + 1);
}
