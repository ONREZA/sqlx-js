import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type FunctionKind = "function" | "procedure" | "aggregate" | "window";
export type FunctionParamMode = "in" | "out" | "inout" | "variadic" | "table";

export type FunctionParamEntry = {
  mode: FunctionParamMode;
  tsType: string;
  name?: string;
};

export type FunctionEntry = {
  schema: string;
  name: string;
  signature: string;
  kind: FunctionKind;
  params: FunctionParamEntry[];
  returns: string;
  returnsSet: boolean;
};

type FunctionCacheFile = {
  version: 1;
  functions: FunctionEntry[];
};

export function functionCachePath(cacheDir: string): string {
  return join(cacheDir, "functions", "functions.json");
}

export function functionCacheExists(cacheDir: string): boolean {
  return existsSync(functionCachePath(cacheDir));
}

function parseFunctionCache(raw: unknown): FunctionEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as { version?: unknown; functions?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.functions)) return [];
  return obj.functions as FunctionEntry[];
}

export function readFunctionCache(cacheDir: string): FunctionEntry[] {
  const path = functionCachePath(cacheDir);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return parseFunctionCache(JSON.parse(text));
}

export function writeFunctionCache(cacheDir: string, functions: FunctionEntry[]): void {
  const path = functionCachePath(cacheDir);
  mkdirSync(dirname(path), { recursive: true });
  const payload: FunctionCacheFile = { version: 1, functions };
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}
