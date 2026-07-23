import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ScanConfig } from "../config";
import { rewriteNamedParameters } from "../sql-params";

export type QueryCallSite = {
  file: string;
  line: number;
  column: number;
  query: string;
  paramCount: number;
  kind: "inline" | "file";
  cardinality?: "many" | "one" | "optional" | "execute";
  queryName?: string;
  sqlFilePath?: string;
  profiles?: string[];
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
  sqlAliases: Map<string, string | undefined>;
  namespaces: Set<string>;
  clientFactories: Set<string>;
  queryFactories: Set<string>;
  clients: Map<string, string | undefined>;
};

type Cardinality = "many" | "one" | "optional" | "execute";
type CalleeKind = "inline" | "file" | "transaction" | null;

function classifyCallee(
  callee: ts.LeftHandSideExpression,
  scope: ScopeState,
): { kind: Exclude<CalleeKind, null>; cardinality?: Cardinality; profiles?: string[] } | null {
  if (ts.isIdentifier(callee)) {
    if (!scope.sqlAliases.has(callee.text)) return null;
    const profile = scope.sqlAliases.get(callee.text);
    return { kind: "inline", cardinality: "many", ...(profile ? { profiles: [profile] } : {}) };
  }

  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.name)) return null;
  const methodName = callee.name.text;

  if (ts.isIdentifier(callee.expression)) {
    const id = callee.expression.text;
    if (scope.namespaces.has(id)) {
      if (methodName === "sql") return { kind: "inline", cardinality: "many" };
      return null;
    }
    if (scope.clients.has(id)) {
      const profile = scope.clients.get(id);
      if (methodName === "sql") {
        return { kind: "inline", cardinality: "many", ...(profile ? { profiles: [profile] } : {}) };
      }
      return null;
    }
    if (!scope.sqlAliases.has(id)) return null;
    const profile = scope.sqlAliases.get(id);
    const assigned = profile ? { profiles: [profile] } : {};
    if (methodName === "transaction") return { kind: "transaction", ...assigned };
    if (methodName === "file") return { kind: "file", cardinality: "many", ...assigned };
    if (methodName === "one" || methodName === "optional" || methodName === "execute") {
      return { kind: "inline", cardinality: methodName, ...assigned };
    }
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
      const profile = scope.clients.get(mid.expression.text);
      const assigned = profile ? { profiles: [profile] } : {};
      if (methodName === "one" || methodName === "optional" || methodName === "execute") {
        return { kind: "inline", cardinality: methodName, ...assigned };
      }
      if (methodName === "file") return { kind: "file", cardinality: "many", ...assigned };
      if (methodName === "transaction") return { kind: "transaction", ...assigned };
      return null;
    }

    // sqlAlias.file.X(...) — file.one / file.optional
    if (ts.isIdentifier(mid.expression)) {
      const root = mid.expression.text;
      if (!scope.sqlAliases.has(root)) return null;
      if (mid.name.text !== "file") return null;
      const profile = scope.sqlAliases.get(root);
      if (methodName === "one" || methodName === "optional" || methodName === "execute") {
        return { kind: "file", cardinality: methodName, ...(profile ? { profiles: [profile] } : {}) };
      }
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
      const profile = scope.clients.get(mid.expression.expression.text);
      return { kind: "file", cardinality: methodName, ...(profile ? { profiles: [profile] } : {}) };
    }
  }

  return null;
}

type DefinitionClassification = {
  cardinality: Cardinality;
  profileArgs?: ts.NodeArray<ts.Expression>;
};

function classifyDefinitionCallee(
  callee: ts.LeftHandSideExpression,
  scope: ScopeState,
): DefinitionClassification | null {
  if (ts.isIdentifier(callee)) return scope.queryFactories.has(callee.text) ? { cardinality: "many" } : null;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return null;
  const method = callee.name.text;
  if (ts.isIdentifier(callee.expression) && scope.queryFactories.has(callee.expression.text)) {
    return method === "one" || method === "optional" || method === "execute"
      ? { cardinality: method }
      : null;
  }
  if (
    method === "defineQuery" &&
    ts.isIdentifier(callee.expression) &&
    scope.namespaces.has(callee.expression.text)
  ) return { cardinality: "many" };
  if (
    (method === "one" || method === "optional" || method === "execute") &&
    ts.isPropertyAccessExpression(callee.expression) &&
    ts.isIdentifier(callee.expression.expression) &&
    scope.namespaces.has(callee.expression.expression.text) &&
    callee.expression.name.text === "defineQuery"
  ) return { cardinality: method };
  if (
    (method === "many" || method === "one" || method === "optional" || method === "execute") &&
    ts.isCallExpression(callee.expression) &&
    ts.isPropertyAccessExpression(callee.expression.expression) &&
    callee.expression.expression.name.text === "for"
  ) {
    const root = callee.expression.expression.expression;
    const imported = ts.isIdentifier(root) && scope.queryFactories.has(root.text);
    const namespaced = ts.isPropertyAccessExpression(root) &&
      root.name.text === "defineQuery" &&
      ts.isIdentifier(root.expression) &&
      scope.namespaces.has(root.expression.text);
    if (imported || namespaced) {
      return {
        cardinality: method === "many" ? "many" : method,
        profileArgs: callee.expression.arguments,
      };
    }
  }
  return null;
}

export function scanFile(
  absPath: string,
  root: string,
  modules: readonly string[] = DEFAULT_SQLX_MODULES,
  profileNames: readonly string[] = [],
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
  const importedQueryFactories = new Set<string>();
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
        if (orig === "defineQuery") importedQueryFactories.add(elem.name.text);
      }
    }
  }

  if (
    importedAliases.size === 0 &&
    importedNamespaces.size === 0 &&
    importedClientFactories.size === 0 &&
    importedQueryFactories.size === 0
  ) return [];

  const out: QueryCallSite[] = [];
  const configuredProfiles = new Set(profileNames);
  const here = (node: ts.Node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { line: line + 1, column: character + 1 };
  };
  const fileRel = relative(root, absPath).replace(/\\/g, "/");

  const recordInline = (
    first: ts.Node,
    args: ts.NodeArray<ts.Expression>,
    cardinality: Cardinality,
    profiles?: string[],
  ): boolean => {
    if (!ts.isStringLiteralLike(first)) {
      const pos = here(first);
      throw new ScanError(fileRel, pos.line, pos.column, "sql() requires a string literal as first argument");
    }
    const pos = here(first);
    let named: string[];
    try {
      named = rewriteNamedParameters(first.text).names;
    } catch (error) {
      throw new ScanError(fileRel, pos.line, pos.column, (error as Error).message.replace(/^sqlx-js: /, ""));
    }
    if (named.length > 0 && args.length !== 2) {
      throw new ScanError(fileRel, pos.line, pos.column, "a query with named parameters requires exactly one parameter object");
    }
    out.push({
      file: fileRel,
      line: pos.line,
      column: pos.column,
      query: first.text,
      paramCount: args.length - 1,
      kind: "inline",
      cardinality,
      ...(profiles && profiles.length > 0 ? { profiles } : {}),
    });
    return true;
  };

  const recordDefinition = (
    args: ts.NodeArray<ts.Expression>,
    callee: ts.Node,
    cardinality: Cardinality,
    profileArgs?: ts.NodeArray<ts.Expression>,
  ): boolean => {
    if (args.length < 1 || args.length > 2) {
      const pos = here(callee);
      throw new ScanError(fileRel, pos.line, pos.column, "defineQuery() requires a SQL literal and optional name");
    }
    const queryNode = args.length === 2 ? args[1]! : args[0]!;
    const nameNode = args.length === 2 ? args[0]! : undefined;
    if (!ts.isStringLiteralLike(queryNode) || (nameNode && !ts.isStringLiteralLike(nameNode))) {
      const pos = here(queryNode);
      throw new ScanError(fileRel, pos.line, pos.column, "defineQuery() requires string literals for its name and SQL");
    }
    if (nameNode && nameNode.text.trim() === "") {
      const pos = here(nameNode);
      throw new ScanError(fileRel, pos.line, pos.column, "defineQuery() name must not be empty");
    }
    const pos = here(queryNode);
    let profiles: string[] | undefined;
    if (profileArgs) {
      if (profileArgs.length === 0 || profileArgs.some((profile) => !ts.isStringLiteralLike(profile))) {
        const profileNode = profileArgs[0] ?? callee;
        const profilePos = here(profileNode);
        throw new ScanError(
          fileRel,
          profilePos.line,
          profilePos.column,
          "defineQuery.for() requires one or more profile name string literals",
        );
      }
      profiles = profileArgs.map((profile) => (profile as ts.StringLiteralLike).text);
      if (new Set(profiles).size !== profiles.length) {
        throw new ScanError(fileRel, pos.line, pos.column, "defineQuery.for() profile names must be unique");
      }
      const unknown = profiles.find((profile) => !configuredProfiles.has(profile));
      if (unknown) {
        throw new ScanError(fileRel, pos.line, pos.column, `defineQuery.for() references unknown profile ${JSON.stringify(unknown)}`);
      }
    }
    let paramNames: string[];
    try {
      paramNames = rewriteNamedParameters(queryNode.text).names;
    } catch (error) {
      throw new ScanError(fileRel, pos.line, pos.column, (error as Error).message.replace(/^sqlx-js: /, ""));
    }
    out.push({
      file: fileRel,
      line: pos.line,
      column: pos.column,
      query: queryNode.text,
      paramCount: paramNames.length,
      kind: "inline",
      cardinality,
      ...(nameNode ? { queryName: nameNode.text } : {}),
      ...(profiles ? { profiles } : {}),
    });
    return true;
  };

  const recordFile = (
    first: ts.Node,
    args: ts.NodeArray<ts.Expression>,
    callee: ts.Node,
    cardinality: Cardinality,
    profiles?: string[],
  ): boolean => {
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
    let named: string[];
    try {
      named = rewriteNamedParameters(query).names;
    } catch (error) {
      throw new ScanError(fileRel, pos.line, pos.column, (error as Error).message.replace(/^sqlx-js: /, ""));
    }
    if (named.length > 0 && args.length !== 2) {
      throw new ScanError(fileRel, pos.line, pos.column, "a SQL file with named parameters requires exactly one parameter object");
    }
    out.push({
      file: fileRel,
      line: pos.line,
      column: pos.column,
      query,
      paramCount: args.length - 1,
      kind: "file",
      cardinality,
      sqlFilePath: sqlPath,
      ...(profiles && profiles.length > 0 ? { profiles } : {}),
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
    const nextSql = new Map(scope.sqlAliases);
    const nextNs = new Set(scope.namespaces);
    const nextFactories = new Set(scope.clientFactories);
    const nextQueryFactories = new Set(scope.queryFactories);
    const nextClients = new Map(scope.clients);
    for (const binding of bindings) {
      for (const a of scope.sqlAliases.keys()) {
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
      for (const a of scope.queryFactories) {
        if (bindingDeclares(binding, a)) {
          nextQueryFactories.delete(a);
          changed = true;
        }
      }
      for (const a of scope.clients.keys()) {
        if (bindingDeclares(binding, a)) {
          nextClients.delete(a);
          changed = true;
        }
      }
    }
    return changed
      ? {
          sqlAliases: nextSql,
          namespaces: nextNs,
          clientFactories: nextFactories,
          queryFactories: nextQueryFactories,
          clients: nextClients,
        }
      : scope;
  };

  const unwrapExpression = (value: ts.Expression): ts.Expression => {
    let current = value;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };

  const clientFactoryProfile = (
    initializer: ts.Expression | undefined,
    scope: ScopeState,
  ): { client: boolean; profile?: string } => {
    if (!initializer) return { client: false };
    const expression = unwrapExpression(initializer);
    if (!ts.isCallExpression(expression)) return { client: false };
    const callee = unwrapExpression(expression.expression);
    const client = ts.isIdentifier(callee)
      ? scope.clientFactories.has(callee.text)
      : ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      scope.namespaces.has(callee.expression.text) &&
      callee.name.text === "createSqlClient";
    if (!client) return { client: false };
    const rawOptions = expression.arguments[1];
    if (!rawOptions) return { client: true };
    const options = unwrapExpression(rawOptions);
    if (!ts.isObjectLiteralExpression(options)) return { client: true };
    const property = options.properties.find((item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) &&
      ((ts.isIdentifier(item.name) && item.name.text === "profile") ||
        (ts.isStringLiteralLike(item.name) && item.name.text === "profile"))
    );
    if (!property) return { client: true };
    const value = unwrapExpression(property.initializer);
    let profile: string | undefined;
    if (ts.isPropertyAccessExpression(value)) {
      profile = value.name.text;
    } else if (
      ts.isElementAccessExpression(value) &&
      value.argumentExpression &&
      ts.isStringLiteralLike(value.argumentExpression)
    ) {
      profile = value.argumentExpression.text;
    } else if (ts.isObjectLiteralExpression(value)) {
      const name = value.properties.find((item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) &&
        ((ts.isIdentifier(item.name) && item.name.text === "name") ||
          (ts.isStringLiteralLike(item.name) && item.name.text === "name"))
      );
      if (name && ts.isStringLiteralLike(name.initializer)) profile = name.initializer.text;
    }
    if (!profile) {
      const pos = here(value);
      throw new ScanError(
        fileRel,
        pos.line,
        pos.column,
        "createSqlClient profile must be profiles.<name>, profiles[\"name\"], or an inline profile with a literal name",
      );
    }
    if (!configuredProfiles.has(profile)) {
      const pos = here(value);
      throw new ScanError(fileRel, pos.line, pos.column, `createSqlClient references unknown profile ${JSON.stringify(profile)}`);
    }
    return { client: true, profile };
  };

  const scopeWithClientDeclarations = (
    scope: ScopeState,
    declarations: readonly ts.VariableDeclaration[],
    constant: boolean,
  ): ScopeState => {
    const nextClients = new Map(scope.clients);
    let changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const resolved = clientFactoryProfile(declaration.initializer, scope);
      if (!resolved.client) continue;
      if (resolved.profile && !constant) {
        const pos = here(declaration.name);
        throw new ScanError(
          fileRel,
          pos.line,
          pos.column,
          "profiled createSqlClient bindings must use const so their profile cannot change",
        );
      }
      nextClients.set(declaration.name.text, resolved.profile);
      changed = true;
    }
    return changed ? { ...scope, clients: nextClients } : scope;
  };

  const visit = (node: ts.Node, scope: ScopeState) => {
    if (ts.isCallExpression(node)) {
      const definition = classifyDefinitionCallee(node.expression, scope);
      if (definition) {
        recordDefinition(node.arguments, node.expression, definition.cardinality, definition.profileArgs);
      }
      const classified = classifyCallee(node.expression, scope);
      if (classified) {
        if (classified.kind === "transaction") {
          const fn = node.arguments[node.arguments.length - 1];
          if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
            const param = fn.parameters[0];
            const shadowed = param ? scopeWithoutBindingShadows(scope, [param.name]) : scope;
            const innerSql = new Map(shadowed.sqlAliases);
            if (param && ts.isIdentifier(param.name)) {
              innerSql.set(param.name.text, classified.profiles?.[0]);
            }
            visit(fn.body, { ...shadowed, sqlAliases: innerSql });
            return;
          }
        } else if (classified.kind === "file") {
          const first = node.arguments[0];
          if (first) {
            recordFile(first, node.arguments, node.expression, classified.cardinality ?? "many", classified.profiles);
          }
        } else if (classified.kind === "inline") {
          const first = node.arguments[0];
          if (first) recordInline(first, node.arguments, classified.cardinality ?? "many", classified.profiles);
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
          current = scopeWithClientDeclarations(
            current,
            declarations,
            (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0,
          );
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
    sqlAliases: new Map([...importedAliases].map((name) => [name, undefined])),
    namespaces: importedNamespaces,
    clientFactories: importedClientFactories,
    queryFactories: importedQueryFactories,
    clients: new Map(),
  });
  if (configuredProfiles.size > 0) {
    const unassigned = out.find((site) => !site.profiles || site.profiles.length === 0);
    if (unassigned) {
      throw new ScanError(
        unassigned.file,
        unassigned.line,
        unassigned.column,
        "query has no connection profile; use a profiled createSqlClient or defineQuery.for(...)",
      );
    }
  }
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

export function scanProject(
  root: string,
  scan: ScanConfig = {},
  profileNames: readonly string[] = [],
): QueryCallSite[] {
  const files = findSourceFiles(root, scan);
  const out: QueryCallSite[] = [];
  for (const f of files) {
    for (const site of scanFile(f, root, scan.modules ?? DEFAULT_SQLX_MODULES, profileNames)) out.push(site);
  }
  return out;
}
