import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseProfiles, ScanConfig } from "../config";
import type { QueryResultAssertions } from "../query";
import { rewriteNamedParameters } from "../sql-params";
import {
  resolveClientInitializer,
  resolveLocalClientExports,
  unwrapExpression,
  type ClientBinding,
  type ClientExecution,
} from "./client-bindings";
import { parseQueryDefinitionOptions } from "./query-options";
import { createLexicalScopes, type LexicalScope } from "./scopes";

export type QueryCallSite = {
  file: string;
  line: number;
  column: number;
  query: string;
  paramCount: number;
  kind: "inline" | "file";
  origin: "definition" | "execution";
  cardinality?: "many" | "one" | "optional" | "execute";
  queryName?: string;
  sqlFilePath?: string;
  profiles?: string[];
  execution?: ClientExecution;
  nullableParams?: number[];
  expectedValidation?: "parse-only";
  resultAssertions?: QueryResultAssertions;
  timestampWithoutTimeZone?: "allow" | "reject";
  temporalReason?: string;
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

type SqlBinding = {
  kind: "sql";
  profile?: string;
  transactionScoped?: boolean;
  execution?: ClientExecution;
};
type ScannerBinding = SqlBinding
  | { kind: "namespace" | "clientFactory" | "queryFactory" }
  | { kind: "client"; binding: ClientBinding };
type ScopeState = LexicalScope<ScannerBinding>;
type Cardinality = "many" | "one" | "optional" | "execute";
type CalleeClassification = {
  kind: "inline" | "file" | "transaction";
  cardinality?: Cardinality;
  profiles?: string[];
  transactionScoped?: boolean;
  execution?: ClientExecution;
};

function classifySqlRoot(expression: ts.Expression, scope: ScopeState): CalleeClassification | null {
  const callee = unwrapExpression(expression);
  let binding: SqlBinding | ClientBinding | undefined;
  if (ts.isIdentifier(callee)) {
    const resolved = scope.get(callee.text);
    if (resolved?.kind === "sql") binding = resolved;
  } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "sql") {
    const receiver = unwrapExpression(callee.expression);
    if (ts.isIdentifier(receiver)) {
      const resolved = scope.get(receiver.text);
      if (resolved?.kind === "namespace") binding = { execution: "adaptive" };
      if (resolved?.kind === "client") binding = resolved.binding;
    }
  }
  if (!binding) return null;
  return {
    kind: "inline",
    cardinality: "many",
    ...(binding.profile ? { profiles: [binding.profile] } : {}),
    ...("transactionScoped" in binding && binding.transactionScoped ? { transactionScoped: true } : {}),
    ...(binding.execution ? { execution: binding.execution } : {}),
  };
}

function classifyWithCall(callee: ts.CallExpression, scope: ScopeState): CalleeClassification | null {
  const expression = unwrapExpression(callee.expression);
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "with") return null;
  const classified = classifyCallee(expression.expression, scope);
  return classified?.kind === "inline" ? classified : null;
}

function classifyCallee(expression: ts.Expression, scope: ScopeState): CalleeClassification | null {
  const callee = unwrapExpression(expression);
  if (ts.isCallExpression(callee)) return classifyWithCall(callee, scope);
  const root = classifySqlRoot(callee, scope);
  if (root) return root;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const receiver = unwrapExpression(callee.expression);
  const method = callee.name.text;
  const cardinality = method === "one" || method === "optional" || method === "execute" ? method : undefined;
  const direct = classifySqlRoot(receiver, scope);
  const withOptions = ts.isCallExpression(receiver) ? classifyWithCall(receiver, scope) : null;
  const base = direct ?? withOptions;
  if (base) {
    if (cardinality) return { ...base, kind: "inline", cardinality };
    if (method === "file") return { ...base, kind: "file", cardinality: "many" };
    if (direct && (method === "transaction" || (method === "savepoint" && ts.isIdentifier(receiver)))) {
      return { ...direct, kind: "transaction" };
    }
  }
  if (cardinality && ts.isPropertyAccessExpression(receiver) && receiver.name.text === "file") {
    const fileRoot = unwrapExpression(receiver.expression);
    const file = classifySqlRoot(fileRoot, scope)
      ?? (ts.isCallExpression(fileRoot) ? classifyWithCall(fileRoot, scope) : null);
    if (file) return { ...file, kind: "file", cardinality };
  }
  return null;
}

type DefinitionClassification = {
  cardinality: Cardinality;
  profileArgs?: ts.NodeArray<ts.Expression>;
};

function isDefinitionFactory(expression: ts.Expression, scope: ScopeState): boolean {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee)) return scope.get(callee.text)?.kind === "queryFactory";
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "defineQuery") return false;
  const receiver = unwrapExpression(callee.expression);
  return ts.isIdentifier(receiver) && scope.get(receiver.text)?.kind === "namespace";
}

function classifyDefinitionCallee(expression: ts.Expression, scope: ScopeState): DefinitionClassification | null {
  const callee = unwrapExpression(expression);
  if (isDefinitionFactory(callee, scope)) return { cardinality: "many" };
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (method !== "many" && method !== "one" && method !== "optional" && method !== "execute") return null;
  const receiver = unwrapExpression(callee.expression);
  if (method !== "many" && isDefinitionFactory(receiver, scope)) return { cardinality: method };
  if (!ts.isCallExpression(receiver)) return null;
  const profiled = unwrapExpression(receiver.expression);
  return ts.isPropertyAccessExpression(profiled) && profiled.name.text === "for"
    && isDefinitionFactory(profiled.expression, scope)
    ? { cardinality: method, profileArgs: receiver.arguments }
    : null;
}

export function scanFile(
  absPath: string,
  root: string,
  modules: readonly string[] = DEFAULT_SQLX_MODULES,
  profileNames: readonly string[] = [],
  transactionOnlyProfileNames: readonly string[] = [],
  localClientCache?: Map<string, ReturnType<typeof resolveLocalClientExports>>,
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

  const configuredProfiles = new Set(profileNames);
  const transactionOnlyProfiles = new Set(transactionOnlyProfileNames);
  const here = (node: ts.Node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { line: line + 1, column: character + 1 };
  };
  const fileRel = relative(root, absPath).replace(/\\/g, "/");
  const imports = new Map<string, ScannerBinding>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    const ic = stmt.importClause;
    if (!ic || ic.isTypeOnly) continue;
    const nb = ic.namedBindings;
    if (!nb) continue;
    const localClients = resolveLocalClientExports(
      absPath,
      root,
      mod.text,
      modules,
      localClientCache,
    );
    if (localClients.size > 0 && ts.isNamedImports(nb)) {
      for (const elem of nb.elements) {
        if (elem.isTypeOnly) continue;
        const imported = (elem.propertyName ?? elem.name).text;
        const resolved = localClients.get(imported);
        if (!resolved) continue;
        if (resolved.error) {
          throw new ScanError(
            resolved.error.file,
            resolved.error.line,
            resolved.error.column,
            resolved.error.message,
          );
        }
        const binding = resolved.binding!;
        if (binding.profile && !configuredProfiles.has(binding.profile)) {
          const pos = here(elem);
          throw new ScanError(
            fileRel,
            pos.line,
            pos.column,
            `createSqlClient references unknown profile ${JSON.stringify(binding.profile)}`,
          );
        }
        imports.set(elem.name.text, { kind: "client", binding });
      }
    }
    if (!modules.includes(mod.text)) continue;
    if (ts.isNamespaceImport(nb)) {
      imports.set(nb.name.text, { kind: "namespace" });
    } else if (ts.isNamedImports(nb)) {
      for (const elem of nb.elements) {
        if (elem.isTypeOnly) continue;
        const orig = (elem.propertyName ?? elem.name).text;
        if (orig === "sql") imports.set(elem.name.text, { kind: "sql", execution: "adaptive" });
        if (orig === "createSqlClient") imports.set(elem.name.text, { kind: "clientFactory" });
        if (orig === "defineQuery") imports.set(elem.name.text, { kind: "queryFactory" });
      }
    }
  }

  if (imports.size === 0) return [];

  const out: QueryCallSite[] = [];

  const recordInline = (
    first: ts.Node,
    args: ts.NodeArray<ts.Expression>,
    cardinality: Cardinality,
    profiles?: string[],
    execution?: ClientExecution,
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
      origin: "execution",
      cardinality,
      ...(profiles && profiles.length > 0 ? { profiles } : {}),
      ...(execution ? { execution } : {}),
    });
    return true;
  };

  const recordDefinition = (
    args: ts.NodeArray<ts.Expression>,
    callee: ts.Node,
    cardinality: Cardinality,
    profileArgs?: ts.NodeArray<ts.Expression>,
  ): boolean => {
    if (args.length < 1 || args.length > 3) {
      const pos = here(callee);
      throw new ScanError(
        fileRel,
        pos.line,
        pos.column,
        "defineQuery() requires a SQL literal, optional name, and optional options object",
      );
    }
    const named = args.length === 3 || (args.length === 2 && (
      ts.isStringLiteralLike(args[1]!) || ts.isTemplateExpression(unwrapExpression(args[1]!))
    ));
    const optionsNode = args.length === 3 || (args.length === 2 && !named)
      ? args[args.length - 1]
      : undefined;
    const queryNode = named ? args[1]! : args[0]!;
    const nameNode = named ? args[0]! : undefined;
    if (ts.isTemplateExpression(unwrapExpression(queryNode))) {
      const pos = here(queryNode);
      throw new ScanError(
        fileRel,
        pos.line,
        pos.column,
        "defineQuery() SQL must be a string literal; template interpolation is not supported",
      );
    }
    if (nameNode && !ts.isStringLiteralLike(nameNode)) {
      const pos = here(nameNode);
      throw new ScanError(fileRel, pos.line, pos.column, "defineQuery() name must be a string literal");
    }
    if (!ts.isStringLiteralLike(queryNode)) {
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
      const invalidLiteral = profileArgs.find((profile) => !ts.isStringLiteralLike(profile));
      if (profileArgs.length === 0 || invalidLiteral) {
        const profileNode = invalidLiteral ?? callee;
        const profilePos = here(profileNode);
        throw new ScanError(
          fileRel,
          profilePos.line,
          profilePos.column,
          "defineQuery.for() requires one or more profile name string literals",
        );
      }
      const profileNodes = profileArgs.filter(ts.isStringLiteralLike);
      const seenProfiles = new Set<string>();
      for (const profileNode of profileNodes) {
        const profilePos = here(profileNode);
        if (profileNode.text.trim() === "") {
          throw new ScanError(fileRel, profilePos.line, profilePos.column, "defineQuery.for() profile names must not be empty");
        }
        if (seenProfiles.has(profileNode.text)) {
          throw new ScanError(fileRel, profilePos.line, profilePos.column, "defineQuery.for() profile names must be unique");
        }
        seenProfiles.add(profileNode.text);
      }
      const unknown = profileNodes.find((profile) => !configuredProfiles.has(profile.text));
      if (unknown !== undefined) {
        const profilePos = here(unknown);
        throw new ScanError(fileRel, profilePos.line, profilePos.column, `defineQuery.for() references unknown profile ${JSON.stringify(unknown.text)}`);
      }
      profiles = profileNodes.map((profile) => profile.text);
    }
    let rewritten: ReturnType<typeof rewriteNamedParameters>;
    try {
      rewritten = rewriteNamedParameters(queryNode.text);
    } catch (error) {
      throw new ScanError(fileRel, pos.line, pos.column, (error as Error).message.replace(/^sqlx-js: /, ""));
    }
    const options = parseQueryDefinitionOptions(
      optionsNode,
      rewritten.names,
      rewritten.positionalCount,
      nameNode?.text,
      (node, message) => {
        const optionPos = here(node);
        throw new ScanError(fileRel, optionPos.line, optionPos.column, message);
      },
    );
    out.push({
      file: fileRel,
      line: pos.line,
      column: pos.column,
      query: queryNode.text,
      paramCount: rewritten.names.length || rewritten.positionalCount,
      kind: "inline",
      origin: "definition",
      cardinality,
      ...(nameNode ? { queryName: nameNode.text } : {}),
      ...(profiles ? { profiles } : {}),
      ...(options.nullableParams ? { nullableParams: options.nullableParams } : {}),
      ...(options.expectedValidation ? { expectedValidation: options.expectedValidation } : {}),
      ...(options.resultAssertions ? { resultAssertions: options.resultAssertions } : {}),
      ...(options.timestampWithoutTimeZone ? { timestampWithoutTimeZone: options.timestampWithoutTimeZone } : {}),
      ...(options.temporalReason ? { temporalReason: options.temporalReason } : {}),
    });
    return true;
  };

  const recordFile = (
    first: ts.Node,
    args: ts.NodeArray<ts.Expression>,
    callee: ts.Node,
    cardinality: Cardinality,
    profiles?: string[],
    execution?: ClientExecution,
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
      origin: "execution",
      cardinality,
      sqlFilePath: sqlPath,
      ...(profiles && profiles.length > 0 ? { profiles } : {}),
      ...(execution ? { execution } : {}),
    });
    return true;
  };

  const scopes = createLexicalScopes(source, imports, (declaration, constant, scope): ScannerBinding | undefined => {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined;
    const initializer = unwrapExpression(declaration.initializer);
    if (!ts.isCallExpression(initializer)) return undefined;
    const resolved = resolveClientInitializer(
      declaration.initializer,
      { has: (name) => scope.get(name)?.kind === "clientFactory" },
      { has: (name) => scope.get(name)?.kind === "namespace" },
    );
    if (resolved.client) {
      if (resolved.invalidProfile) {
        const pos = here(resolved.invalidProfile);
        throw new ScanError(fileRel, pos.line, pos.column,
          "createSqlClient profile must be profiles.<name>, profiles[\"name\"], or an inline profile with a literal name");
      }
      const binding = resolved.binding!;
      if (binding.profile && !configuredProfiles.has(binding.profile)) {
        const pos = here(declaration.name);
        throw new ScanError(fileRel, pos.line, pos.column,
          `createSqlClient references unknown profile ${JSON.stringify(binding.profile)}`);
      }
      if (!constant) {
        const pos = here(declaration.name);
        throw new ScanError(fileRel, pos.line, pos.column,
          "createSqlClient bindings must use const so their profile and execution mode cannot change");
      }
      return { kind: "client", binding };
    }
    const classified = classifyWithCall(initializer, scope);
    if (!classified) return undefined;
    if (!constant) {
      const pos = here(declaration.name);
      throw new ScanError(fileRel, pos.line, pos.column,
        "sql.with() bindings must use const so their query ownership cannot change");
    }
    return {
      kind: "sql",
      ...(classified.profiles?.[0] ? { profile: classified.profiles[0] } : {}),
      ...(classified.transactionScoped ? { transactionScoped: true } : {}),
      ...(classified.execution ? { execution: classified.execution } : {}),
    };
  });

  const visit = (node: ts.Node) => {
    const scope = scopes.at(node);
    if (ts.isVariableDeclaration(node)) scopes.resolveDeclaration(node);
    if (ts.isCallExpression(node)) {
      const definition = classifyDefinitionCallee(node.expression, scope);
      if (definition) {
        recordDefinition(node.arguments, node.expression, definition.cardinality, definition.profileArgs);
      }
      const classified = classifyCallee(node.expression, scope);
      if (classified?.kind === "transaction") {
        const argument = node.arguments[node.arguments.length - 1];
        const fn = argument ? unwrapExpression(argument) : undefined;
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          const param = fn.parameters[0];
          if (param) scopes.setParameter(param, {
            kind: "sql",
            ...(classified.profiles?.[0] ? { profile: classified.profiles[0] } : {}),
            transactionScoped: true,
            ...(classified.execution ? { execution: classified.execution } : {}),
          });
        }
      } else if (classified) {
        const contextualProfile = classified.profiles?.find((profile) => transactionOnlyProfiles.has(profile));
        if (contextualProfile && !classified.transactionScoped) {
          const pos = here(node.expression);
          throw new ScanError(fileRel, pos.line, pos.column,
            `profile ${JSON.stringify(contextualProfile)} requires transaction settings; `
            + "execute its queries inside sql.transaction({ settings }, callback)");
        }
        const first = node.arguments[0];
        if (first) {
          if (classified.kind === "file") {
            recordFile(first, node.arguments, node.expression, classified.cardinality ?? "many",
              classified.profiles, classified.execution);
          } else {
            recordInline(first, node.arguments, classified.cardinality ?? "many",
              classified.profiles, classified.execution);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
  profiles: readonly string[] | DatabaseProfiles = [],
): QueryCallSite[] {
  const profileMap = Array.isArray(profiles) ? undefined : profiles as DatabaseProfiles;
  const profileNames = profileMap ? Object.keys(profileMap) : profiles as readonly string[];
  const transactionOnlyProfileNames = profileMap
    ? Object.values(profileMap)
      .filter((profile) => profile.transactionSettings !== undefined)
      .map((profile) => profile.name)
    : [];
  const files = findSourceFiles(root, scan);
  const out: QueryCallSite[] = [];
  const localClientCache = new Map<string, ReturnType<typeof resolveLocalClientExports>>();
  for (const f of files) {
    for (const site of scanFile(
      f,
      root,
      scan.modules ?? DEFAULT_SQLX_MODULES,
      profileNames,
      transactionOnlyProfileNames,
      localClientCache,
    )) out.push(site);
  }
  return out;
}
