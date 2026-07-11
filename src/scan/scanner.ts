import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ScanConfig } from "../config";

export type QueryCallSite = {
  file: string;
  line: number;
  column: number;
  query: string;
  paramCount: number;
  kind: "inline" | "file";
  sqlFilePath?: string;
};

export class ScanError extends Error {
  constructor(
    public readonly file: string,
    public readonly line: number,
    public readonly column: number,
    message: string,
  ) {
    super(`sqlx-js: ${file}:${line}:${column} — ${message}`);
    this.name = "ScanError";
  }
}

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.sqlx-js/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
];
const DEFAULT_SQLX_MODULES = ["@onreza/sqlx-js"];
const EXT = /\.(ts|tsx|mts|cts)$/;
const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

function formatConfigError(error: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(error.messageText, "\n");
}

function collectTsconfigFiles(configPath: string, out: Set<string>, visited: Set<string>): void {
  const resolved = resolve(configPath);
  if (visited.has(resolved)) return;
  visited.add(resolved);
  const read = ts.readConfigFile(resolved, ts.sys.readFile);
  if (read.error) throw new Error(`sqlx-js scan: ${resolved}: ${formatConfigError(read.error)}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, resolve(resolved, ".."), undefined, resolved);
  if (parsed.errors.length > 0) {
    throw new Error(`sqlx-js scan: ${resolved}: ${parsed.errors.map(formatConfigError).join("; ")}`);
  }
  for (const file of parsed.fileNames) {
    if (EXT.test(file)) out.add(resolve(file));
  }
  for (const reference of parsed.projectReferences ?? []) {
    collectTsconfigFiles(ts.resolveProjectReferencePath(reference), out, visited);
  }
}

export function findSourceFiles(root: string, scan: ScanConfig = {}): string[] {
  const excludes = [...DEFAULT_EXCLUDES, ...(scan.exclude ?? [])];
  if (scan.include !== undefined) {
    if (scan.include.length === 0) return [];
    return ts.sys.readDirectory(root, TS_EXTENSIONS, excludes, scan.include).map((file) => resolve(file)).sort();
  }

  const configPath = join(root, "tsconfig.json");
  if (!ts.sys.fileExists(configPath)) {
    return ts.sys.readDirectory(root, TS_EXTENSIONS, excludes, ["**/*"]).map((file) => resolve(file)).sort();
  }

  const configured = new Set<string>();
  collectTsconfigFiles(configPath, configured, new Set());
  const allowed = new Set(
    ts.sys.readDirectory(root, TS_EXTENSIONS, excludes, ["**/*"]).map((file) => resolve(file)),
  );
  return [...configured].filter((file) => allowed.has(file)).sort();
}

type ScopeState = {
  sqlAliases: Set<string>;
  namespaces: Set<string>;
  clientFactories: Set<string>;
  clients: Set<string>;
};

type CalleeKind = "inline" | "file" | "transaction" | null;

function classifyCallee(
  callee: ts.LeftHandSideExpression,
  scope: ScopeState,
): { kind: Exclude<CalleeKind, null> } | null {
  if (ts.isIdentifier(callee)) {
    if (!scope.sqlAliases.has(callee.text)) return null;
    return { kind: "inline" };
  }

  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.name)) return null;
  const methodName = callee.name.text;

  if (ts.isIdentifier(callee.expression)) {
    const id = callee.expression.text;
    if (scope.namespaces.has(id) || scope.clients.has(id)) {
      if (methodName === "sql") return { kind: "inline" };
      return null;
    }
    if (!scope.sqlAliases.has(id)) return null;
    if (methodName === "transaction") return { kind: "transaction" };
    if (methodName === "file") return { kind: "file" };
    if (methodName === "one" || methodName === "optional" || methodName === "execute") return { kind: "inline" };
    return null;
  }

  if (ts.isPropertyAccessExpression(callee.expression)) {
    const mid = callee.expression;
    if (!ts.isIdentifier(mid.name)) return null;

    // ns.sql.X(...) and client.sql.X(...) chains
    if (
      ts.isIdentifier(mid.expression) &&
      (scope.namespaces.has(mid.expression.text) || scope.clients.has(mid.expression.text))
    ) {
      if (mid.name.text !== "sql") return null;
      if (methodName === "one" || methodName === "optional" || methodName === "execute") return { kind: "inline" };
      if (methodName === "file") return { kind: "file" };
      if (methodName === "transaction") return { kind: "transaction" };
      return null;
    }

    // sqlAlias.file.X(...) — file.one / file.optional
    if (ts.isIdentifier(mid.expression)) {
      const root = mid.expression.text;
      if (!scope.sqlAliases.has(root)) return null;
      if (mid.name.text !== "file") return null;
      if (methodName === "one" || methodName === "optional" || methodName === "execute") return { kind: "file" };
      return null;
    }

    // ns.sql.file.X(...) and client.sql.file.X(...) chains
    if (
      ts.isPropertyAccessExpression(mid.expression) &&
      ts.isIdentifier(mid.expression.expression) &&
      ts.isIdentifier(mid.expression.name) &&
      (scope.namespaces.has(mid.expression.expression.text) || scope.clients.has(mid.expression.expression.text)) &&
      mid.expression.name.text === "sql" &&
      mid.name.text === "file" &&
      (methodName === "one" || methodName === "optional" || methodName === "execute")
    ) {
      return { kind: "file" };
    }
  }

  return null;
}

export function scanFile(
  absPath: string,
  root: string,
  modules: readonly string[] = DEFAULT_SQLX_MODULES,
): QueryCallSite[] {
  const text = readFileSync(absPath, "utf8");
  const source = ts.createSourceFile(absPath, text, ts.ScriptTarget.ESNext, false, scriptKind(absPath));
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const parseError = parseDiagnostics.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (parseError) {
    const start = parseError.start ?? 0;
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    const file = relative(root, absPath).replace(/\\/g, "/");
    throw new ScanError(file, line + 1, character + 1, ts.flattenDiagnosticMessageText(parseError.messageText, "\n"));
  }

  const importedAliases = new Set<string>();
  const importedNamespaces = new Set<string>();
  const importedClientFactories = new Set<string>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (!modules.includes(mod.text)) continue;
    const ic = stmt.importClause;
    if (!ic) continue;
    const nb = ic.namedBindings;
    if (!nb) continue;
    if (ts.isNamespaceImport(nb)) {
      importedNamespaces.add(nb.name.text);
    } else if (ts.isNamedImports(nb)) {
      for (const elem of nb.elements) {
        const orig = (elem.propertyName ?? elem.name).text;
        if (orig === "sql") importedAliases.add(elem.name.text);
        if (orig === "createSqlClient") importedClientFactories.add(elem.name.text);
      }
    }
  }

  if (importedAliases.size === 0 && importedNamespaces.size === 0 && importedClientFactories.size === 0) return [];

  const out: QueryCallSite[] = [];
  const here = (node: ts.Node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { line: line + 1, column: character + 1 };
  };
  const fileRel = relative(root, absPath).replace(/\\/g, "/");

  const recordInline = (first: ts.Node, args: ts.NodeArray<ts.Expression>): boolean => {
    if (!ts.isStringLiteralLike(first)) {
      const pos = here(first);
      throw new ScanError(fileRel, pos.line, pos.column, "sql() requires a string literal as first argument");
    }
    const pos = here(first);
    out.push({
      file: fileRel,
      line: pos.line,
      column: pos.column,
      query: first.text,
      paramCount: args.length - 1,
      kind: "inline",
    });
    return true;
  };

  const recordFile = (first: ts.Node, args: ts.NodeArray<ts.Expression>, callee: ts.Node): boolean => {
    if (!ts.isStringLiteralLike(first)) {
      const pos = first ? here(first) : here(callee);
      throw new ScanError(fileRel, pos.line, pos.column, "sql.file() requires a string literal path");
    }
    const sqlPath = first.text;
    if (isAbsolute(sqlPath)) {
      const pos = here(first);
      throw new ScanError(fileRel, pos.line, pos.column, `sql.file path must be relative to --root: ${sqlPath}`);
    }
    const abs = resolve(root, sqlPath);
    const rel = relative(root, abs);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      const pos = here(first);
      throw new ScanError(fileRel, pos.line, pos.column, `sql.file path escapes --root: ${sqlPath}`);
    }
    if (!existsSync(abs)) {
      const pos = here(first);
      throw new ScanError(fileRel, pos.line, pos.column, `sql.file path not found: ${sqlPath}`);
    }
    const query = readFileSync(abs, "utf8");
    const pos = here(first);
    out.push({
      file: fileRel,
      line: pos.line,
      column: pos.column,
      query,
      paramCount: args.length - 1,
      kind: "file",
      sqlFilePath: sqlPath,
    });
    return true;
  };

  const bindingDeclares = (binding: ts.BindingName, name: string): boolean => {
    if (ts.isIdentifier(binding)) return binding.text === name;
    for (const el of binding.elements) {
      if (ts.isOmittedExpression(el)) continue;
      if (bindingDeclares(el.name, name)) return true;
    }
    return false;
  };

  const scopeWithoutBindingShadows = (scope: ScopeState, bindings: readonly ts.BindingName[]): ScopeState => {
    let changed = false;
    const nextSql = new Set(scope.sqlAliases);
    const nextNs = new Set(scope.namespaces);
    const nextFactories = new Set(scope.clientFactories);
    const nextClients = new Set(scope.clients);
    for (const binding of bindings) {
      for (const a of scope.sqlAliases) {
        if (bindingDeclares(binding, a)) {
          nextSql.delete(a);
          changed = true;
        }
      }
      for (const a of scope.namespaces) {
        if (bindingDeclares(binding, a)) {
          nextNs.delete(a);
          changed = true;
        }
      }
      for (const a of scope.clientFactories) {
        if (bindingDeclares(binding, a)) {
          nextFactories.delete(a);
          changed = true;
        }
      }
      for (const a of scope.clients) {
        if (bindingDeclares(binding, a)) {
          nextClients.delete(a);
          changed = true;
        }
      }
    }
    return changed
      ? { sqlAliases: nextSql, namespaces: nextNs, clientFactories: nextFactories, clients: nextClients }
      : scope;
  };

  const isClientFactoryCall = (initializer: ts.Expression | undefined, scope: ScopeState): boolean => {
    if (!initializer || !ts.isCallExpression(initializer)) return false;
    const callee = initializer.expression;
    if (ts.isIdentifier(callee)) return scope.clientFactories.has(callee.text);
    return ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      scope.namespaces.has(callee.expression.text) &&
      callee.name.text === "createSqlClient";
  };

  const scopeWithClientDeclarations = (
    scope: ScopeState,
    declarations: readonly ts.VariableDeclaration[],
  ): ScopeState => {
    const nextClients = new Set(scope.clients);
    let changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !isClientFactoryCall(declaration.initializer, scope)) continue;
      nextClients.add(declaration.name.text);
      changed = true;
    }
    return changed ? { ...scope, clients: nextClients } : scope;
  };

  const visit = (node: ts.Node, scope: ScopeState) => {
    if (ts.isCallExpression(node)) {
      const classified = classifyCallee(node.expression, scope);
      if (classified) {
        if (classified.kind === "transaction") {
          const fn = node.arguments[node.arguments.length - 1];
          if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
            const param = fn.parameters[0];
            const shadowed = param ? scopeWithoutBindingShadows(scope, [param.name]) : scope;
            const innerSql = new Set(shadowed.sqlAliases);
            if (param && ts.isIdentifier(param.name)) {
              innerSql.add(param.name.text);
            }
            visit(fn.body, { ...shadowed, sqlAliases: innerSql });
            return;
          }
        } else if (classified.kind === "file") {
          const first = node.arguments[0];
          if (first) recordFile(first, node.arguments, node.expression);
        } else if (classified.kind === "inline") {
          const first = node.arguments[0];
          if (first) recordInline(first, node.arguments);
        }
      }
    }
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      let current = scope;
      const stmts = (node as { statements: ts.NodeArray<ts.Statement> }).statements;
      for (const stmt of stmts) {
        if (ts.isVariableStatement(stmt)) {
          const declarations = stmt.declarationList.declarations;
          current = scopeWithoutBindingShadows(current, declarations.map((d) => d.name));
          visit(stmt, current);
          current = scopeWithClientDeclarations(current, declarations);
          continue;
        } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
          current = scopeWithoutBindingShadows(current, [stmt.name]);
        }
        visit(stmt, current);
      }
      return;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration?.name) {
      const next = scopeWithoutBindingShadows(scope, [node.variableDeclaration.name]);
      if (next !== scope) {
        visit(node.block, next);
        return;
      }
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      node.body
    ) {
      const bindings = node.parameters.map((p) => p.name);
      if (ts.isFunctionExpression(node) && node.name) bindings.push(node.name);
      const next = scopeWithoutBindingShadows(scope, bindings);
      for (const param of node.parameters) {
        if (param.initializer) visit(param.initializer, next);
      }
      visit(node.body, next);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(source, {
    sqlAliases: importedAliases,
    namespaces: importedNamespaces,
    clientFactories: importedClientFactories,
    clients: new Set(),
  });
  return out;
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".mts":
    case ".cts":
    default: return ts.ScriptKind.TS;
  }
}

export function scanProject(root: string, scan: ScanConfig = {}): QueryCallSite[] {
  const files = findSourceFiles(root, scan);
  const out: QueryCallSite[] = [];
  for (const f of files) {
    for (const site of scanFile(f, root, scan.modules ?? DEFAULT_SQLX_MODULES)) out.push(site);
  }
  return out;
}
