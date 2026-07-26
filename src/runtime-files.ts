import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

type SqlFileCacheEntry = {
  mtimeMs: number;
  size: number;
  content: string;
};

const sqlFileCache = new Map<string, SqlFileCacheEntry>();

export function loadSqlFile(
  path: string,
  fileRoot = process.env.SQLX_JS_FILE_ROOT ?? process.cwd(),
  reload = false,
  embedded?: Readonly<Record<string, string>>,
): string {
  const root = resolve(fileRoot);
  if (isAbsolute(path)) {
    throw new Error(`sqlx-js.sql.file: path must be relative to fileRoot: ${path}`);
  }
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`sqlx-js.sql.file: path escapes fileRoot: ${path}`);
  }
  if (embedded && Object.hasOwn(embedded, path)) return embedded[path]!;
  try {
    const cached = sqlFileCache.get(full);
    if (cached && !reload) return cached.content;
    const st = statSync(full);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.content;
    }
    const content = readFileSync(full, "utf8");
    sqlFileCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, content });
    return content;
  } catch (error) {
    throw new Error(`sqlx-js.sql.file: cannot read ${path}: ${(error as Error).message}`);
  }
}

export function clearSqlFileCache(): void {
  sqlFileCache.clear();
}

type IdentifierWhitelist = {
  names: Set<string>;
  paths: Set<string>;
};

type IdentifierCacheEntry = {
  path: string;
  mtimeMs: number;
  size: number;
  whitelist: IdentifierWhitelist;
};

let identifierCache: IdentifierCacheEntry | null = null;

export function clearIdentifierCache(): void {
  identifierCache = null;
}

function identifierSnapshotPath(): string {
  return process.env.SQLX_JS_SCHEMA_PATH
    ? resolve(process.cwd(), process.env.SQLX_JS_SCHEMA_PATH)
    : resolve(process.cwd(), ".sqlx-js/schema/schema.json");
}

function addPath(whitelist: IdentifierWhitelist, parts: string[]): void {
  for (const part of parts) whitelist.names.add(part);
  whitelist.paths.add(parts.join("\0"));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function arrayProp(obj: Record<string, unknown> | null, key: string): unknown[] {
  const value = obj?.[key];
  return Array.isArray(value) ? value : [];
}

function stringProp(obj: Record<string, unknown> | null, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
}

function buildIdentifierWhitelist(snapshot: unknown): IdentifierWhitelist {
  const whitelist: IdentifierWhitelist = { names: new Set(), paths: new Set() };
  const root = asRecord(snapshot);
  for (const schema of arrayProp(root, "schemas")) {
    if (typeof schema === "string") whitelist.names.add(schema);
  }
  for (const relationRaw of arrayProp(root, "relations")) {
    const relation = asRecord(relationRaw);
    const schema = stringProp(relation, "schema");
    const name = stringProp(relation, "name");
    if (!schema || !name) continue;
    addPath(whitelist, [schema, name]);
    for (const columnRaw of arrayProp(relation, "columns")) {
      const columnName = stringProp(asRecord(columnRaw), "name");
      if (!columnName) continue;
      whitelist.names.add(columnName);
      addPath(whitelist, [name, columnName]);
      addPath(whitelist, [schema, name, columnName]);
    }
    for (const indexRaw of arrayProp(relation, "indexes")) {
      const indexName = stringProp(asRecord(indexRaw), "name");
      if (indexName) addPath(whitelist, [schema, indexName]);
    }
    for (const constraintRaw of arrayProp(relation, "constraints")) {
      const constraintName = stringProp(asRecord(constraintRaw), "name");
      if (!constraintName) continue;
      addPath(whitelist, [schema, constraintName]);
      addPath(whitelist, [name, constraintName]);
      addPath(whitelist, [schema, name, constraintName]);
    }
  }
  for (const typeRaw of arrayProp(root, "types")) {
    const type = asRecord(typeRaw);
    const schema = stringProp(type, "schema");
    const name = stringProp(type, "name");
    if (schema && name) addPath(whitelist, [schema, name]);
  }
  for (const functionRaw of arrayProp(root, "functions")) {
    const fn = asRecord(functionRaw);
    const schema = stringProp(fn, "schema");
    const name = stringProp(fn, "name");
    if (schema && name) addPath(whitelist, [schema, name]);
  }
  return whitelist;
}

function loadIdentifierWhitelist(): IdentifierWhitelist {
  const path = identifierSnapshotPath();
  if (!existsSync(path)) {
    throw new Error(`sqlx-js.id: schema snapshot not found at ${path}. Run \`sqlx-js snapshot dump\`.`);
  }
  const stat = statSync(path);
  if (
    identifierCache
    && identifierCache.path === path
    && identifierCache.mtimeMs === stat.mtimeMs
    && identifierCache.size === stat.size
  ) {
    return identifierCache.whitelist;
  }
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  const whitelist = buildIdentifierWhitelist(snapshot);
  identifierCache = {
    path,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    whitelist,
  };
  return whitelist;
}

function quoteIdentifier(part: string): string {
  if (part.length === 0) throw new Error("sqlx-js.id: identifier segment must not be empty");
  if (part.includes("\0")) throw new Error("sqlx-js.id: identifier segment must not contain NUL");
  return `"${part.replace(/"/g, '""')}"`;
}

export function id(...parts: string[]): string {
  if (parts.length === 0) throw new Error("sqlx-js.id: at least one identifier segment is required");
  if (parts.length > 3) throw new Error("sqlx-js.id: expected 1 to 3 identifier segments");
  const whitelist = loadIdentifierWhitelist();
  const allowed = parts.length === 1
    ? whitelist.names.has(parts[0]!)
    : whitelist.paths.has(parts.join("\0"));
  if (!allowed) {
    throw new Error(`sqlx-js.id: identifier is not present in schema snapshot: ${parts.join(".")}`);
  }
  return parts.map(quoteIdentifier).join(".");
}
