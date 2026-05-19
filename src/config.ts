import { existsSync } from "node:fs";
import { join } from "node:path";

export type BunSqlxConfig = {
  jsonbTypes?: Record<string, string>;
  customTypes?: Record<string, string>;
};

export async function loadConfig(root: string): Promise<BunSqlxConfig> {
  for (const name of ["bun-sqlx.config.ts", "bun-sqlx.config.js", "bun-sqlx.config.mjs"]) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    const mod = await import(p);
    const cfg = (mod.default ?? mod) as BunSqlxConfig;
    if (typeof cfg !== "object" || cfg === null) {
      throw new Error(`bun-sqlx: ${name} must default-export a config object`);
    }
    return cfg;
  }
  return {};
}

export function lookupJsonbType(
  cfg: BunSqlxConfig,
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
