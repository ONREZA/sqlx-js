import { existsSync } from "node:fs";
import { join } from "node:path";

export type SqlxJsConfig = {
  jsonbTypes?: Record<string, string>;
  customTypes?: Record<string, string>;
  schema?: {
    provider?: "builtin" | "pgschema";
    file?: string;
    schemas?: string[];
    command?: string;
  };
};

export async function loadConfig(root: string): Promise<SqlxJsConfig> {
  for (const name of ["sqlx-js.config.ts", "sqlx-js.config.js", "sqlx-js.config.mjs"]) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    const mod = await import(p);
    const cfg = (mod.default ?? mod) as SqlxJsConfig;
    if (typeof cfg !== "object" || cfg === null) {
      throw new Error(`sqlx-js: ${name} must default-export a config object`);
    }
    return cfg;
  }
  return {};
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
