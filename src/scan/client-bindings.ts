import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

export type ClientExecution = "descriptor" | "adaptive" | "unknown";

export type ClientBinding = {
  profile?: string;
  execution: ClientExecution;
};

export type ClientInitializer = {
  client: boolean;
  binding?: ClientBinding;
  invalidProfile?: ts.Expression;
};

export type LocalClientExport = {
  binding?: ClientBinding;
  error?: {
    file: string;
    line: number;
    column: number;
    message: string;
  };
};

export function unwrapExpression(value: ts.Expression): ts.Expression {
  let current = value;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(item: ts.ObjectLiteralElementLike): string | undefined {
  if (!("name" in item) || !item.name) return undefined;
  return ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)
    ? item.name.text
    : undefined;
}

export function resolveClientInitializer(
  initializer: ts.Expression | undefined,
  clientFactories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): ClientInitializer {
  if (!initializer) return { client: false };
  const expression = unwrapExpression(initializer);
  if (!ts.isCallExpression(expression)) return { client: false };
  const callee = unwrapExpression(expression.expression);
  const client = ts.isIdentifier(callee)
    ? clientFactories.has(callee.text)
    : ts.isPropertyAccessExpression(callee)
      && ts.isIdentifier(callee.expression)
      && namespaces.has(callee.expression.text)
      && callee.name.text === "createSqlClient";
  if (!client) return { client: false };

  const rawOptions = expression.arguments[1];
  if (!rawOptions) return { client: true, binding: { execution: "unknown" } };
  const options = unwrapExpression(rawOptions);
  if (!ts.isObjectLiteralExpression(options)) {
    return { client: true, binding: { execution: "unknown" } };
  }
  const namedProperty = (name: string) => options.properties.find((item): item is ts.PropertyAssignment =>
    ts.isPropertyAssignment(item) && propertyName(item) === name
  );
  const executionProperty = namedProperty("execution");
  const execution: ClientExecution = options.properties.some((item) =>
    propertyName(item) === "queryDescriptors"
  )
    ? "descriptor"
    : executionProperty
      && ts.isStringLiteralLike(executionProperty.initializer)
      && executionProperty.initializer.text === "adaptive"
      ? "adaptive"
      : "unknown";
  const profileProperty = namedProperty("profile");
  if (!profileProperty) return { client: true, binding: { execution } };

  const profileValue = unwrapExpression(profileProperty.initializer);
  let profile: string | undefined;
  if (ts.isPropertyAccessExpression(profileValue)) {
    profile = profileValue.name.text;
  } else if (
    ts.isElementAccessExpression(profileValue)
    && profileValue.argumentExpression
    && ts.isStringLiteralLike(profileValue.argumentExpression)
  ) {
    profile = profileValue.argumentExpression.text;
  } else if (ts.isObjectLiteralExpression(profileValue)) {
    const name = profileValue.properties.find((item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) && propertyName(item) === "name"
    );
    if (name && ts.isStringLiteralLike(name.initializer)) profile = name.initializer.text;
  }
  return profile
    ? { client: true, binding: { profile, execution } }
    : { client: true, binding: { execution }, invalidProfile: profileValue };
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".mts":
    case ".cts":
    default: return ts.ScriptKind.TS;
  }
}

function localModulePath(importer: string, root: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved = resolve(dirname(importer), specifier);
  const rel = relative(root, resolved);
  if (
    rel === ".."
    || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(rel)
  ) {
    return undefined;
  }
  const extension = extname(resolved).toLowerCase();
  const base = [".js", ".mjs", ".cjs"].includes(extension)
    ? resolved.slice(0, -extension.length)
    : resolved;
  const candidates = extension === ".js"
    ? [`${base}.ts`, `${base}.tsx`]
    : extension === ".mjs"
      ? [`${base}.mts`]
      : extension === ".cjs"
        ? [`${base}.cts`]
        : [".ts", ".tsx", ".mts", ".cts"].includes(extension)
          ? [resolved]
          : extension
            ? [
              `${resolved}.ts`,
              `${resolved}.tsx`,
              `${resolved}.mts`,
              `${resolved}.cts`,
            ]
            : [
            `${resolved}.ts`,
            `${resolved}.tsx`,
            `${resolved}.mts`,
            `${resolved}.cts`,
            resolve(resolved, "index.ts"),
            resolve(resolved, "index.tsx"),
            resolve(resolved, "index.mts"),
            resolve(resolved, "index.cts"),
          ];
  return candidates.find(existsSync);
}

export function resolveLocalClientExports(
  importer: string,
  root: string,
  specifier: string,
  sqlxModules: readonly string[],
  cache?: Map<string, Map<string, LocalClientExport>>,
): Map<string, LocalClientExport> {
  const path = localModulePath(importer, root, specifier);
  if (!path) return new Map();
  const cached = cache?.get(path);
  if (cached) return cached;
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ESNext,
    false,
    scriptKind(path),
  );
  const factories = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!sqlxModules.includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "createSqlClient") {
        factories.add(element.name.text);
      }
    }
  }
  if (factories.size === 0 && namespaces.size === 0) {
    const empty = new Map<string, LocalClientExport>();
    cache?.set(path, empty);
    return empty;
  }

  const exports = new Map<string, LocalClientExport>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const resolved = resolveClientInitializer(declaration.initializer, factories, namespaces);
      if (!resolved.client) continue;
      if (resolved.invalidProfile) {
        const { line, character } = source.getLineAndCharacterOfPosition(
          resolved.invalidProfile.getStart(source),
        );
        exports.set(declaration.name.text, {
          error: {
            file: relative(root, path).replace(/\\/g, "/"),
            line: line + 1,
            column: character + 1,
            message: "createSqlClient profile must be profiles.<name>, profiles[\"name\"], or an inline profile with a literal name",
          },
        });
      } else if (!constant) {
        const { line, character } = source.getLineAndCharacterOfPosition(
          declaration.name.getStart(source),
        );
        exports.set(declaration.name.text, {
          error: {
            file: relative(root, path).replace(/\\/g, "/"),
            line: line + 1,
            column: character + 1,
            message: "createSqlClient bindings must use const so their profile and execution mode cannot change",
          },
        });
      } else {
        exports.set(declaration.name.text, { binding: resolved.binding });
      }
    }
  }
  cache?.set(path, exports);
  return exports;
}
