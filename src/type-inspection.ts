import ts from "typescript";

const unknownTypeCache = new Map<string, boolean>();

export function containsUnknownType(type: string): boolean {
  const cached = unknownTypeCache.get(type);
  if (cached !== undefined) return cached;
  const source = ts.createSourceFile("sqlx-js-type.ts", `type SqlxJsType = ${type};`, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.UnknownKeyword) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  unknownTypeCache.set(type, found);
  return found;
}
