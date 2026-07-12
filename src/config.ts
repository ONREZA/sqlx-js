import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export type ScanConfig = {
  include?: string[];
  exclude?: string[];
  modules?: string[];
};

export type SqlxJsConfig = {
  jsonbTypes?: Record<string, string>;
  columnTypes?: Record<string, string>;
  arrayElementNullability?: Record<string, "non-null">;
  customTypes?: Record<string, string>;
  functionCatalog?: false | {
    includeExtensionOwned?: boolean;
  };
  scan?: ScanConfig;
  schema?: {
    provider?: "builtin" | "pgschema";
    file?: string;
    schemas?: string[];
    command?: string;
  };
};

export function defineConfig<T extends SqlxJsConfig>(config: T): T {
  return config;
}

export function loadRootEnv(root: string): string | undefined {
  const path = join(root, ".env");
  if (!existsSync(path)) return undefined;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return path;
}

export function configPath(root: string): string | undefined {
  for (const name of ["sqlx-js.config.mts", "sqlx-js.config.ts", "sqlx-js.config.mjs", "sqlx-js.config.js"]) {
    const p = join(root, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export async function loadConfig(root: string): Promise<SqlxJsConfig> {
  const path = configPath(root);
  if (!path) return {};
  const url = pathToFileURL(path);
  url.searchParams.set("mtime", String(statSync(path).mtimeMs));
  const mod = await import(url.href);
  if (!("default" in mod)) {
    throw new Error(`sqlx-js: ${path} must default-export a config object`);
  }
  return validateConfig(mod.default, path);
}

function validateStringRecord(value: unknown, name: string, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`sqlx-js: ${path} ${name} must be an object of string values`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`sqlx-js: ${path} ${name}.${key} must be a string`);
    }
  }
}

function validateArrayElementNullability(value: unknown, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`sqlx-js: ${path} arrayElementNullability must be an object`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (item !== "non-null") {
      throw new Error(`sqlx-js: ${path} arrayElementNullability.${key} must be non-null`);
    }
  }
}

function validateStringArray(value: unknown, name: string, path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`sqlx-js: ${path} ${name} must be an array of strings`);
  }
}

function validateModuleArray(value: unknown, path: string): void {
  validateStringArray(value, "scan.modules", path);
  if ((value as string[]).length === 0 || (value as string[]).some((item) => item.trim() === "")) {
    throw new Error(`sqlx-js: ${path} scan.modules must contain at least one non-empty module name`);
  }
}

function validateConfig(value: unknown, path: string): SqlxJsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`sqlx-js: ${path} must default-export a config object`);
  }
  const config = value as Record<string, unknown>;
  if (config.jsonbTypes !== undefined) validateStringRecord(config.jsonbTypes, "jsonbTypes", path);
  if (config.columnTypes !== undefined) validateStringRecord(config.columnTypes, "columnTypes", path);
  if (config.arrayElementNullability !== undefined) validateArrayElementNullability(config.arrayElementNullability, path);
  if (config.customTypes !== undefined) validateStringRecord(config.customTypes, "customTypes", path);
  if (config.jsonbTypes && config.columnTypes) {
    const jsonKeys = Object.keys(config.jsonbTypes as Record<string, string>);
    const columnKeys = Object.keys(config.columnTypes as Record<string, string>);
    const conflicts = jsonKeys.filter((jsonKey) => columnKeys.some((columnKey) =>
      jsonKey === columnKey || jsonKey.endsWith(`.${columnKey}`) || columnKey.endsWith(`.${jsonKey}`)
    ));
    if (conflicts.length > 0) {
      throw new Error(`sqlx-js: ${path} maps the same column in jsonbTypes and columnTypes: ${conflicts.join(", ")}`);
    }
  }
  if (config.functionCatalog !== undefined && config.functionCatalog !== false) {
    if (!config.functionCatalog || typeof config.functionCatalog !== "object" || Array.isArray(config.functionCatalog)) {
      throw new Error(`sqlx-js: ${path} functionCatalog must be false or an object`);
    }
    const functionCatalog = config.functionCatalog as Record<string, unknown>;
    if (functionCatalog.includeExtensionOwned !== undefined && typeof functionCatalog.includeExtensionOwned !== "boolean") {
      throw new Error(`sqlx-js: ${path} functionCatalog.includeExtensionOwned must be a boolean`);
    }
  }
  if (config.scan !== undefined) {
    if (!config.scan || typeof config.scan !== "object" || Array.isArray(config.scan)) {
      throw new Error(`sqlx-js: ${path} scan must be an object`);
    }
    const scan = config.scan as Record<string, unknown>;
    if (scan.include !== undefined) validateStringArray(scan.include, "scan.include", path);
    if (scan.exclude !== undefined) validateStringArray(scan.exclude, "scan.exclude", path);
    if (scan.modules !== undefined) validateModuleArray(scan.modules, path);
  }
  if (config.schema !== undefined) {
    if (!config.schema || typeof config.schema !== "object" || Array.isArray(config.schema)) {
      throw new Error(`sqlx-js: ${path} schema must be an object`);
    }
    const schema = config.schema as Record<string, unknown>;
    if (schema.provider !== undefined && schema.provider !== "builtin" && schema.provider !== "pgschema") {
      throw new Error(`sqlx-js: ${path} schema.provider must be builtin or pgschema`);
    }
    for (const key of ["file", "command"] as const) {
      if (schema[key] !== undefined && typeof schema[key] !== "string") {
        throw new Error(`sqlx-js: ${path} schema.${key} must be a string`);
      }
    }
    if (schema.schemas !== undefined) validateStringArray(schema.schemas, "schema.schemas", path);
  }
  return value as SqlxJsConfig;
}

export function prepareConfigHash(cfg: SqlxJsConfig): string {
  const value = stableValue({
    jsonbTypes: cfg.jsonbTypes ?? {},
    columnTypes: cfg.columnTypes ?? {},
    arrayElementNullability: cfg.arrayElementNullability ?? {},
    customTypes: cfg.customTypes ?? {},
    functionCatalog: cfg.functionCatalog === false
      ? false
      : { includeExtensionOwned: cfg.functionCatalog?.includeExtensionOwned === true },
  });
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function configHash(cfg: SqlxJsConfig): string {
  return createHash("sha256").update(JSON.stringify(stableValue(cfg))).digest("hex").slice(0, 16);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export async function loadConfigInfo(root: string): Promise<{ config: SqlxJsConfig; path?: string }> {
  const path = configPath(root);
  if (!path) return { config: {} };
  return { config: await loadConfig(root), path };
}

export function assertSupportedRuntime(): void {
  const bun = process.versions.bun;
  if (bun) {
    if (majorMinorLessThan(bun, 1, 3)) {
      throw new Error(`sqlx-js requires Bun >=1.3, current ${bun}`);
    }
    return;
  }
  const node = process.versions.node;
  if (majorMinorLessThan(node, 24, 0)) {
    throw new Error(`sqlx-js requires Node.js >=24, current ${node}`);
  }
}

function majorMinorLessThan(version: string, minMajor: number, minMinor: number): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major < minMajor || (major === minMajor && minor < minMinor);
}

export function runtimeVersion(): { runtime: "node" | "bun"; version: string } {
  if (process.versions.bun) return { runtime: "bun", version: process.versions.bun };
  return { runtime: "node", version: process.versions.node };
}

export function nativeTypeScriptEnabled(): boolean | string {
  if (process.versions.bun) return true;
  return process.features.typescript;
}

export function envFilePath(root: string): string {
  return join(root, ".env");
}


export function lookupJsonbType(
  cfg: SqlxJsConfig,
  schema: string,
  table: string,
  column: string,
): string | undefined {
  const types = cfg.jsonbTypes;
  if (!types) return undefined;
  return (
    types[`${schema}.${table}.${column}`] ??
    types[`${table}.${column}`]
  );
}

export function lookupColumnType(
  cfg: SqlxJsConfig,
  schema: string,
  table: string,
  column: string,
): string | undefined {
  const types = cfg.columnTypes;
  if (!types) return undefined;
  return types[`${schema}.${table}.${column}`] ?? types[`${table}.${column}`];
}

export function lookupArrayElementNullability(
  cfg: SqlxJsConfig,
  schema: string,
  table: string,
  column: string,
): "non-null" | undefined {
  const assertions = cfg.arrayElementNullability;
  if (!assertions) return undefined;
  return assertions[`${schema}.${table}.${column}`] ?? assertions[`${table}.${column}`];
}
