import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isTypeScriptExportName, type EnumCatalogConfig, type SqlxJsConfig } from "./config";
import { decodeText, type PgClient } from "./pg/wire";

export type EnumCatalogEntry = {
  schema: string;
  name: string;
  values: string[];
};

type EnumCatalogCacheFile = {
  version: 1;
  enums: EnumCatalogEntry[];
};

export function enumCatalogOutputPath(
  root: string,
  config: SqlxJsConfig,
  override?: string,
): string | undefined {
  if (!config.enumCatalog) return undefined;
  return override ?? resolve(root, config.enumCatalog.output);
}

export function assertDistinctEnumCatalogOutput(
  root: string,
  config: SqlxJsConfig,
  dtsPath: string,
  override?: string,
): void {
  const output = enumCatalogOutputPath(root, config, override);
  if (!output || comparablePath(output) !== comparablePath(dtsPath)) return;
  throw new Error("sqlx-js: enumCatalog.output must differ from the declaration output configured by --dts");
}

export function enumCatalogCachePath(cacheDir: string): string {
  return join(cacheDir, "enums", "enums.json");
}

export function enumCatalogCacheExists(cacheDir: string): boolean {
  return existsSync(enumCatalogCachePath(cacheDir));
}

export function readEnumCatalogCache(cacheDir: string): EnumCatalogEntry[] {
  const path = enumCatalogCachePath(cacheDir);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`sqlx-js: enum catalog cache is malformed: ${path}: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(`sqlx-js: enum catalog cache is malformed: ${path}`);
  }
  const file = raw as { version?: unknown; enums?: unknown };
  if (file.version !== 1 || !Array.isArray(file.enums) || !file.enums.every(isEnumCatalogEntry)) {
    throw new Error(`sqlx-js: enum catalog cache is malformed: ${path}`);
  }
  assertUniqueCatalog(file.enums, `sqlx-js: enum catalog cache is malformed: ${path}`);
  return file.enums;
}

export function writeEnumCatalogCache(cacheDir: string, enums: EnumCatalogEntry[]): void {
  const path = enumCatalogCachePath(cacheDir);
  mkdirSync(dirname(path), { recursive: true });
  const stable = [...enums].sort(compareEntries);
  assertUniqueCatalog(stable, "sqlx-js: cannot write enum catalog cache");
  const payload: EnumCatalogCacheFile = { version: 1, enums: stable };
  writeAtomic(path, JSON.stringify(payload, null, 2) + "\n");
}

export function removeEnumCatalogCache(cacheDir: string): void {
  const path = enumCatalogCachePath(cacheDir);
  if (existsSync(path)) unlinkSync(path);
}

export async function introspectEnumCatalog(
  client: PgClient,
  schemas: readonly string[],
): Promise<EnumCatalogEntry[]> {
  const schemaList = schemas.map(quoteLiteral).join(", ");
  const result = await client.simpleQueryAll(`
    SELECT n.nspname, t.typname, e.enumlabel
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE t.typtype = 'e'
      AND n.nspname IN (${schemaList})
    ORDER BY n.nspname, t.typname, e.enumsortorder
  `);
  const entries = new Map<string, EnumCatalogEntry>();
  for (const row of result.rows) {
    const schema = decodeText(row[0]!)!;
    const name = decodeText(row[1]!)!;
    const key = `${schema}\0${name}`;
    const entry = entries.get(key) ?? { schema, name, values: [] };
    const value = decodeText(row[2] ?? null);
    if (value !== null) entry.values.push(value);
    entries.set(key, entry);
  }
  return [...entries.values()];
}

export function renderEnumCatalog(
  enums: readonly EnumCatalogEntry[],
  options: Pick<EnumCatalogConfig, "aliases" | "exclude" | "include" | "registry"> = {},
): string {
  const { selected, selectedEntries } = selectEnumCatalogEntries(enums, options);
  for (const [type, exportName] of Object.entries(options.aliases ?? {}).sort(([a], [b]) => compareText(a, b))) {
    if (!selectedEntries.has(type)) {
      throw new Error(`sqlx-js: enumCatalog alias ${type} does not match a selected enum`);
    }
    if (!isTypeScriptExportName(exportName)) {
      throw new Error(`sqlx-js: enumCatalog alias ${type} must use a valid TypeScript export name`);
    }
  }
  const names = new Map<string, EnumCatalogEntry>();
  const exportNames = new Map<string, string>();
  for (const entry of selected) {
    const type = qualifiedName(entry);
    const exportName = options.aliases?.[type] ?? enumExportName(entry.name);
    if (options.registry && REGISTRY_EXPORTS.has(exportName)) {
      throw new Error(
        `sqlx-js: enumCatalog export ${exportName} for ${type} conflicts with the generated registry; `
        + "configure an alias",
      );
    }
    const existing = names.get(exportName);
    if (existing) {
      throw new Error(
        `sqlx-js: enumCatalog export ${exportName} is ambiguous between `
        + `${qualifiedName(existing)} and ${qualifiedName(entry)}; configure enumCatalog.aliases`,
      );
    }
    names.set(exportName, entry);
    exportNames.set(type, exportName);
  }

  const lines = [
    "// AUTO-GENERATED by sqlx-js. Do not edit.",
    "// Run `sqlx-js prepare` to regenerate.",
    "",
  ];
  for (const [exportName, entry] of names) {
    lines.push(`export const ${exportName} = {`);
    for (const value of entry.values) lines.push(`  [${JSON.stringify(value)}]: ${JSON.stringify(value)},`);
    lines.push("} as const;");
    lines.push("");
    lines.push(`export type ${exportName} = (typeof ${exportName})[keyof typeof ${exportName}];`);
    lines.push("");
  }
  if (options.registry) {
    lines.push("export const DbEnums = {");
    for (const entry of selected) {
      const type = qualifiedName(entry);
      lines.push(`  [${JSON.stringify(type)}]: ${exportNames.get(type)!},`);
    }
    lines.push("} as const;");
    lines.push("");
    lines.push("export type DbEnumName = keyof typeof DbEnums;");
    lines.push("");
    lines.push("export type DbEnumValue<Name extends DbEnumName> =");
    lines.push("  Name extends DbEnumName");
    lines.push("    ? (typeof DbEnums)[Name][keyof (typeof DbEnums)[Name]]");
    lines.push("    : never;");
    lines.push("");
  }
  return lines.join("\n");
}

export function selectedEnumCatalogCount(
  enums: readonly EnumCatalogEntry[],
  options: Pick<EnumCatalogConfig, "exclude" | "include"> = {},
): number {
  return selectEnumCatalogEntries(enums, options).selected.length;
}

export function writeEnumCatalogModule(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, content);
}

function enumExportName(name: string): string {
  const words = name.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) {
    throw new Error(`sqlx-js: enumCatalog cannot derive a TypeScript export name from PostgreSQL enum ${JSON.stringify(name)}`);
  }
  const identifier = words
    .map((word) => {
      const tail = word === word.toUpperCase() || word === word.toLowerCase()
        ? word.slice(1).toLowerCase()
        : word.slice(1);
      return word[0]!.toUpperCase() + tail;
    })
    .join("");
  return /^[\p{L}_$]/u.test(identifier) ? identifier : `Pg${identifier}`;
}

const REGISTRY_EXPORTS = new Set(["DbEnums", "DbEnumName", "DbEnumValue"]);

function qualifiedName(entry: EnumCatalogEntry): string {
  return `${entry.schema}.${entry.name}`;
}

function selectEnumCatalogEntries(
  enums: readonly EnumCatalogEntry[],
  options: Pick<EnumCatalogConfig, "exclude" | "include">,
): { selected: EnumCatalogEntry[]; selectedEntries: Map<string, EnumCatalogEntry> } {
  if (options.include && options.exclude) {
    throw new Error("sqlx-js: enumCatalog include and exclude cannot be used together");
  }
  const sorted = [...enums].sort(compareEntries);
  const entries = assertUniqueCatalog(sorted, "sqlx-js: enum catalog contains duplicate schema-qualified names");
  const selection = options.include ?? options.exclude ?? [];
  for (const type of selection) {
    if (!entries.has(type)) {
      const option = options.include ? "include" : "exclude";
      throw new Error(`sqlx-js: enumCatalog ${option} ${type} does not match an enum in the configured schemas`);
    }
  }
  const selectedNames = new Set(selection);
  const selected = options.include
    ? sorted.filter((entry) => selectedNames.has(qualifiedName(entry)))
    : options.exclude
      ? sorted.filter((entry) => !selectedNames.has(qualifiedName(entry)))
      : sorted;
  return {
    selected,
    selectedEntries: new Map(selected.map((entry) => [qualifiedName(entry), entry])),
  };
}

function assertUniqueCatalog(
  enums: readonly EnumCatalogEntry[],
  prefix: string,
): Map<string, EnumCatalogEntry> {
  const entries = new Map<string, EnumCatalogEntry>();
  for (const entry of enums) {
    const type = qualifiedName(entry);
    if (entries.has(type)) throw new Error(`${prefix}: ambiguous key ${JSON.stringify(type)}`);
    if (new Set(entry.values).size !== entry.values.length) {
      throw new Error(`${prefix}: duplicate labels for ${JSON.stringify(type)}`);
    }
    entries.set(type, entry);
  }
  return entries;
}

function compareEntries(a: EnumCatalogEntry, b: EnumCatalogEntry): number {
  return compareText(a.schema, b.schema) || compareText(a.name, b.name);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparablePath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  const absolute = resolve(realpathSync.native(current), ...missing);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isEnumCatalogEntry(value: unknown): value is EnumCatalogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<EnumCatalogEntry>;
  return typeof entry.schema === "string"
    && entry.schema.length > 0
    && typeof entry.name === "string"
    && entry.name.length > 0
    && Array.isArray(entry.values)
    && entry.values.every((item) => typeof item === "string");
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
