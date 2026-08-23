import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SqlxJsConfig } from "./config";
import { loadRoutineErrorSources, type PgRoutineErrorSourceRow } from "./pg/catalog";
import type { PgClient } from "./pg/wire";

export type RoutineErrorSource = PgRoutineErrorSourceRow;

export type ErrorCatalogEntry = {
  code: string;
  message: string;
  routines: string[];
};

export type ErrorCatalogCoverage = {
  routinesWithRaises: number;
  raiseExceptions: number;
  extractedOccurrences: number;
  skipped: number;
};

export type ErrorCatalog = {
  errors: ErrorCatalogEntry[];
  coverage: ErrorCatalogCoverage;
};

type ErrorCatalogCacheFile = ErrorCatalog & {
  version: 1;
};

type Token =
  | { kind: "string"; text: string; value: string }
  | { kind: "word" | "symbol" | "opaque"; text: string };

const SQLSTATE = /^[0-9A-Z]{5}$/;
const ERROR_MESSAGE = /^[A-Z][A-Z0-9_]*$/;
const DOLLAR_QUOTE_DELIMITER = /^\$(?:[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}]*)?\$/u;
const WORD_START = /[A-Za-z_\u0080-\u{10FFFF}]/u;
const WORD_CONTINUE = /[A-Za-z0-9_$\u0080-\u{10FFFF}]/u;
const NON_EXCEPTION_LEVELS = new Set(["DEBUG", "LOG", "INFO", "NOTICE", "WARNING"]);

export function errorCatalogOutputPath(
  root: string,
  config: SqlxJsConfig,
  override?: string,
): string | undefined {
  if (!config.errorCatalog) return undefined;
  return override ?? resolve(root, config.errorCatalog.output);
}

export function errorCatalogCachePath(cacheDir: string): string {
  return join(cacheDir, "errors", "errors.json");
}

export function errorCatalogCacheExists(cacheDir: string): boolean {
  return existsSync(errorCatalogCachePath(cacheDir));
}

export function readErrorCatalogCache(cacheDir: string): ErrorCatalog {
  const path = errorCatalogCachePath(cacheDir);
  const directory = dirname(path);
  if (
    (existsSync(directory) && lstatSync(directory).isSymbolicLink())
    || (existsSync(path) && lstatSync(path).isSymbolicLink())
  ) {
    throw new Error(`sqlx-js: error catalog cache must not be a symbolic link: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`sqlx-js: error catalog cache is malformed: ${path}: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(`sqlx-js: error catalog cache is malformed: ${path}`);
  }
  const file = raw as { version?: unknown; errors?: unknown; coverage?: unknown };
  if (file.version !== 1) {
    throw new Error(`sqlx-js: error catalog cache is stale: ${path}. Run \`sqlx-js prepare\`.`);
  }
  if (!isErrorCatalog(file)) {
    throw new Error(`sqlx-js: error catalog cache is malformed: ${path}`);
  }
  assertCatalog(file, `sqlx-js: error catalog cache is malformed: ${path}`);
  return { errors: file.errors, coverage: file.coverage };
}

export function writeErrorCatalogCache(cacheDir: string, catalog: ErrorCatalog): void {
  const path = errorCatalogCachePath(cacheDir);
  const stable = stableCatalog(catalog);
  assertCatalog(stable, "sqlx-js: cannot write error catalog cache");
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify({ version: 1, ...stable } satisfies ErrorCatalogCacheFile, null, 2) + "\n");
}

export function removeErrorCatalogCache(cacheDir: string): void {
  const path = errorCatalogCachePath(cacheDir);
  if (existsSync(path)) unlinkSync(path);
}

export async function introspectErrorCatalog(
  client: PgClient,
  schemas: readonly string[],
): Promise<ErrorCatalog> {
  return extractErrorCatalog(await loadRoutineErrorSources(client, schemas));
}

export function extractErrorCatalog(routines: readonly RoutineErrorSource[]): ErrorCatalog {
  const byMessage = new Map<string, ErrorCatalogEntry>();
  let routinesWithRaises = 0;
  let raiseExceptions = 0;
  let extractedOccurrences = 0;
  for (const routine of routines) {
    const statements = raiseStatements(tokenize(routine.source)).filter((statement) =>
      statement.exception && !(statement.valid && statement.tokens.length === 1)
    );
    if (statements.length > 0) routinesWithRaises++;
    for (const statement of statements) {
      raiseExceptions++;
      if (!statement.valid) continue;
      const identity = extractIdentity(statement.tokens);
      if (!identity) continue;
      extractedOccurrences++;
      const existing = byMessage.get(identity.message);
      if (existing && existing.code !== identity.code) {
        throw new Error(
          `sqlx-js: errorCatalog message ${JSON.stringify(identity.message)} maps to both SQLSTATE `
          + `${existing.code} and ${identity.code}`,
        );
      }
      const entry = existing ?? { ...identity, routines: [] };
      if (!entry.routines.includes(routine.signature)) entry.routines.push(routine.signature);
      byMessage.set(identity.message, entry);
    }
  }
  return stableCatalog({
    errors: [...byMessage.values()],
    coverage: {
      routinesWithRaises,
      raiseExceptions,
      extractedOccurrences,
      skipped: raiseExceptions - extractedOccurrences,
    },
  });
}

export function renderErrorCatalog(catalog: ErrorCatalog): string {
  assertCatalog(catalog, "sqlx-js: error catalog is malformed");
  const lines = [
    "// AUTO-GENERATED by sqlx-js. Do not edit.",
    "// Run `sqlx-js prepare` to regenerate.",
    "",
    "export const DbErrors = {",
  ];
  for (const error of stableCatalog(catalog).errors) {
    lines.push(
      `  ${error.message}: { code: ${JSON.stringify(error.code)}, message: ${JSON.stringify(error.message)} },`,
    );
  }
  lines.push("} as const;");
  lines.push("");
  lines.push("export type DbErrorName = keyof typeof DbErrors;");
  lines.push("");
  lines.push("export type DbError = (typeof DbErrors)[DbErrorName];");
  lines.push("");
  return lines.join("\n");
}

export function errorCatalogCoverageMessage(catalog: ErrorCatalog): string | undefined {
  const { raiseExceptions, skipped } = catalog.coverage;
  if (skipped === 0) return undefined;
  return `errorCatalog skipped ${skipped} of ${raiseExceptions} exception-level RAISE statement(s) because their SQLSTATE or symbolic MESSAGE is dynamic or unsupported`;
}

export function writeErrorCatalogModule(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, content);
}

function extractIdentity(tokens: readonly Token[]): { code: string; message: string } | null {
  let cursor = 1;
  if (word(tokens[cursor], "EXCEPTION")) cursor++;
  const first = tokens[cursor];
  if (!(first?.kind === "string" || word(first, "SQLSTATE") || word(first, "USING"))) return null;
  const usingIndex = findTopLevelWord(tokens, "USING", cursor);
  const options = splitTopLevel(usingIndex === -1 ? [] : tokens.slice(usingIndex + 1), ",");
  const hasOptionCode = optionPresent(options, "ERRCODE");
  const hasOptionMessage = optionPresent(options, "MESSAGE");
  const optionCode = optionLiteral(options, "ERRCODE");
  const optionMessage = optionLiteral(options, "MESSAGE");
  let code = optionCode;
  let message = optionMessage;

  if ((first?.kind === "string" && hasOptionMessage) || (word(first, "SQLSTATE") && hasOptionCode)) {
    return null;
  }

  if (word(first, "SQLSTATE")) {
    const state = tokens[cursor + 1];
    if (!code && state?.kind === "string" && (usingIndex === cursor + 2 || usingIndex === -1)) {
      code = state.value;
    }
  } else if (first?.kind === "string") {
    const staticFormat = usingIndex === cursor + 1
      || (usingIndex === -1 && tokens.length === cursor + 1);
    if (!message && staticFormat) message = first.value;
  } else if (word(first, "USING")) {
    if (!hasOptionCode) code ??= "P0001";
  }

  if (
    !code
    && !hasOptionCode
    && (first?.kind === "string" || word(first, "USING"))
  ) code = "P0001";
  if (!code || !message || !SQLSTATE.test(code) || code === "00000" || !ERROR_MESSAGE.test(message)) return null;
  return { code, message };
}

function optionLiteral(options: readonly Token[][], name: string): string | undefined {
  const matches = options.filter((segment) => word(segment[0], name));
  if (matches.length !== 1) return undefined;
  const segment = matches[0]!;
  return segment[1]?.kind === "symbol"
    && segment[1].text === "="
    && segment[2]?.kind === "string"
    && segment.length === 3
    ? segment[2].value
    : undefined;
}

function optionPresent(options: readonly Token[][], name: string): boolean {
  return options.some((segment) => word(segment[0], name));
}

function raiseStatements(tokens: readonly Token[]): Array<{ exception: boolean; valid: boolean; tokens: Token[] }> {
  const statements: Array<{ exception: boolean; valid: boolean; tokens: Token[] }> = [];
  for (let index = 0; index < tokens.length; index++) {
    if (!word(tokens[index], "RAISE") || !raiseStatementBoundary(tokens, index)) continue;
    const statement: Token[] = [tokens[index]!];
    const closings: string[] = [];
    let valid = true;
    let terminated = false;
    for (index++; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.kind === "symbol") {
        if (token.text === "(") closings.push(")");
        else if (token.text === "[") closings.push("]");
        else if (token.text === ")" || token.text === "]") {
          if (closings.pop() !== token.text) valid = false;
        } else if (token.text === ";" && closings.length === 0) {
          terminated = true;
          break;
        }
      }
      statement.push(token);
    }
    const level = statement[1]?.kind === "word" ? statement[1].text.toUpperCase() : undefined;
    statements.push({
      exception: !level || !NON_EXCEPTION_LEVELS.has(level),
      valid: valid && terminated && closings.length === 0,
      tokens: statement,
    });
  }
  return statements;
}

function raiseStatementBoundary(tokens: readonly Token[], index: number): boolean {
  if (index === 0) return true;
  const previous = tokens[index - 1];
  return (previous?.kind === "symbol" && previous.text === ";")
    || word(previous, "BEGIN")
    || word(previous, "THEN")
    || word(previous, "ELSE")
    || word(previous, "LOOP");
}

function findTopLevelWord(tokens: readonly Token[], expected: string, start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === "symbol") {
      if (token.text === "(" || token.text === "[") depth++;
      else if (token.text === ")" || token.text === "]") depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && word(token, expected)) return index;
  }
  return -1;
}

function splitTopLevel(tokens: readonly Token[], separator: string): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "symbol") {
      if (token.text === "(" || token.text === "[") depth++;
      else if (token.text === ")" || token.text === "]") depth = Math.max(0, depth - 1);
      else if (token.text === separator && depth === 0) {
        out.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  out.push(current);
  return out;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (source.startsWith("--", index)) {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index);
      continue;
    }
    const escapedString = (char === "E" || char === "e") && source[index + 1] === "'";
    if (escapedString || char === "'") {
      const string = readQuotedString(source, escapedString ? index + 1 : index);
      tokens.push(string.hasBackslashEscape
        ? { kind: "opaque", text: source.slice(index, string.end) }
        : { kind: "string", text: source.slice(index, string.end), value: string.value });
      index = string.end;
      continue;
    }
    if (char === '"') {
      const end = skipQuotedIdentifier(source, index);
      tokens.push({ kind: "opaque", text: source.slice(index, end) });
      index = end;
      continue;
    }
    if (char === "$") {
      const delimiter = source.slice(index).match(DOLLAR_QUOTE_DELIMITER)?.[0];
      if (delimiter) {
        const close = source.indexOf(delimiter, index + delimiter.length);
        const end = close === -1 ? source.length : close + delimiter.length;
        tokens.push({ kind: "opaque", text: source.slice(index, end) });
        index = end;
        continue;
      }
    }
    if (WORD_START.test(char)) {
      let end = index + 1;
      while (end < source.length && WORD_CONTINUE.test(source[end]!)) end++;
      tokens.push({ kind: "word", text: source.slice(index, end) });
      index = end;
      continue;
    }
    const kind = ",;=()[]".includes(char) ? "symbol" : "opaque";
    tokens.push({ kind, text: char });
    index++;
  }
  return tokens;
}

function skipBlockComment(source: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < source.length && depth > 0) {
    if (source.startsWith("/*", index)) {
      depth++;
      index += 2;
    } else if (source.startsWith("*/", index)) {
      depth--;
      index += 2;
    } else {
      index++;
    }
  }
  return index;
}

function readQuotedString(
  source: string,
  start: number,
): { value: string; end: number; hasBackslashEscape: boolean } {
  let value = "";
  let index = start + 1;
  let hasBackslashEscape = false;
  while (index < source.length) {
    if (source[index] === "\\" && index + 1 < source.length) {
      hasBackslashEscape = true;
      value += source[index + 1]!;
      index += 2;
      continue;
    }
    if (source[index] === "'") {
      if (source[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      return { value, end: index + 1, hasBackslashEscape };
    }
    value += source[index]!;
    index++;
  }
  return { value, end: source.length, hasBackslashEscape };
}

function skipQuotedIdentifier(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '"') {
      if (source[index + 1] === '"') index += 2;
      else return index + 1;
    } else {
      index++;
    }
  }
  return source.length;
}

function stableCatalog(catalog: ErrorCatalog): ErrorCatalog {
  return {
    errors: catalog.errors
      .map((entry) => ({ ...entry, routines: [...new Set(entry.routines)].sort(compareText) }))
      .sort((a, b) => compareText(a.message, b.message)),
    coverage: { ...catalog.coverage },
  };
}

function assertCatalog(catalog: ErrorCatalog, prefix: string): void {
  if (
    !isErrorCatalog(catalog)
    || catalog.coverage.extractedOccurrences + catalog.coverage.skipped !== catalog.coverage.raiseExceptions
    || (catalog.coverage.raiseExceptions === 0) !== (catalog.coverage.routinesWithRaises === 0)
    || catalog.coverage.routinesWithRaises > catalog.coverage.raiseExceptions
    || catalog.errors.length > catalog.coverage.extractedOccurrences
    || (catalog.coverage.extractedOccurrences > 0 && catalog.errors.length === 0)
  ) {
    throw new Error(prefix);
  }
  const messages = new Map<string, string>();
  for (const error of catalog.errors) {
    if (!SQLSTATE.test(error.code) || error.code === "00000" || !ERROR_MESSAGE.test(error.message)) {
      throw new Error(prefix);
    }
    const existing = messages.get(error.message);
    if (existing) {
      if (existing !== error.code) {
        throw new Error(`${prefix}: message ${JSON.stringify(error.message)} has conflicting SQLSTATE codes`);
      }
      throw new Error(`${prefix}: duplicate message ${JSON.stringify(error.message)}`);
    }
    if (error.routines.length > catalog.coverage.routinesWithRaises) {
      throw new Error(prefix);
    }
    if (new Set(error.routines).size !== error.routines.length) {
      throw new Error(`${prefix}: duplicate routines for ${JSON.stringify(error.message)}`);
    }
    messages.set(error.message, error.code);
  }
}

function isErrorCatalog(value: unknown): value is ErrorCatalog {
  if (!value || typeof value !== "object") return false;
  const catalog = value as { errors?: unknown; coverage?: unknown };
  if (!Array.isArray(catalog.errors) || !catalog.errors.every(isErrorCatalogEntry)) return false;
  if (!catalog.coverage || typeof catalog.coverage !== "object") return false;
  const coverage = catalog.coverage as Record<string, unknown>;
  return ["routinesWithRaises", "raiseExceptions", "extractedOccurrences", "skipped"]
    .every((key) => Number.isSafeInteger(coverage[key]) && (coverage[key] as number) >= 0);
}

function isErrorCatalogEntry(value: unknown): value is ErrorCatalogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.code === "string"
    && typeof entry.message === "string"
    && Array.isArray(entry.routines)
    && entry.routines.length > 0
    && entry.routines.every((routine) => typeof routine === "string" && routine.length > 0);
}

function word(token: Token | undefined, expected: string): boolean {
  return token?.kind === "word" && token.text.toUpperCase() === expected;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}
