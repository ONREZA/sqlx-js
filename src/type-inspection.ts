import ts from "typescript";

const unknownTypeCache = new Map<string, boolean>();

function isExistentialSqlxJson(node: ts.Node): boolean {
  if (!ts.isImportTypeNode(node)) return false;
  if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) return false;
  if (node.argument.literal.text !== "@onreza/sqlx-js") return false;
  if (!node.qualifier || !ts.isIdentifier(node.qualifier) || node.qualifier.text !== "SqlxJson") return false;
  return node.typeArguments?.length === 1 && node.typeArguments[0]?.kind === ts.SyntaxKind.UnknownKeyword;
}

export function containsUnknownType(type: string): boolean {
  const cached = unknownTypeCache.get(type);
  if (cached !== undefined) return cached;
  const source = ts.createSourceFile("sqlx-js-type.ts", `type SqlxJsType = ${type};`, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (isExistentialSqlxJson(node)) return;
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
