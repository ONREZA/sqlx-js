import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type FunctionKind = "function" | "procedure" | "aggregate" | "window";
export type FunctionParamMode = "in" | "out" | "inout" | "variadic" | "table";
export type FunctionVolatility = "immutable" | "stable" | "volatile";
export type FunctionParallelSafety = "unsafe" | "restricted" | "safe";

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
  volatility: FunctionVolatility;
  securityDefiner: boolean;
  leakproof: boolean;
  parallelSafety: FunctionParallelSafety;
  owner: string;
  ownerSuperuser: boolean;
  publicExecute: boolean;
  searchPath: string | null;
  extensionOwned: boolean;
};

type FunctionCacheFile = {
  version: 2;
  functions: FunctionEntry[];
};

export type FunctionContractDiagnostic = {
  code:
    | "security-definer-missing-search-path"
    | "security-definer-unsafe-search-path"
    | "security-definer-superuser-owner"
    | "security-definer-public-execute"
    | "leakproof"
    | "volatile-parallel-safe";
  functionSignature: string;
  message: string;
};

export function functionCachePath(cacheDir: string): string {
  return join(cacheDir, "functions", "functions.json");
}

export function functionCacheExists(cacheDir: string): boolean {
  return existsSync(functionCachePath(cacheDir));
}

function parseFunctionCache(raw: unknown, path: string): FunctionEntry[] {
  if (!raw || typeof raw !== "object") {
    throw new Error(`sqlx-js: function catalog cache is malformed: ${path}`);
  }
  const obj = raw as { version?: unknown; functions?: unknown };
  if (obj.version !== 2) {
    throw new Error(`sqlx-js: function catalog cache is stale: ${path}. Run \`sqlx-js prepare\`.`);
  }
  if (!Array.isArray(obj.functions) || !obj.functions.every(isFunctionEntry)) {
    throw new Error(`sqlx-js: function catalog cache is malformed: ${path}`);
  }
  return obj.functions;
}

export function readFunctionCache(cacheDir: string): FunctionEntry[] {
  const path = functionCachePath(cacheDir);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`sqlx-js: function catalog cache is malformed: ${path}: ${(error as Error).message}`);
  }
  return parseFunctionCache(raw, path);
}

export function writeFunctionCache(cacheDir: string, functions: FunctionEntry[]): void {
  const path = functionCachePath(cacheDir);
  mkdirSync(dirname(path), { recursive: true });
  const payload: FunctionCacheFile = { version: 2, functions };
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function functionContractDiagnostics(
  functions: readonly FunctionEntry[],
): FunctionContractDiagnostic[] {
  const diagnostics: FunctionContractDiagnostic[] = [];
  for (const fn of functions) {
    if (fn.extensionOwned) continue;
    if (fn.securityDefiner && fn.searchPath === null) {
      diagnostics.push({
        code: "security-definer-missing-search-path",
        functionSignature: fn.signature,
        message:
          "SECURITY DEFINER has no function-local search_path; add SET search_path with trusted schemas and pg_temp last",
      });
    } else if (fn.securityDefiner && fn.searchPath !== null && !searchPathEndsWithPgTemp(fn.searchPath)) {
      diagnostics.push({
        code: "security-definer-unsafe-search-path",
        functionSignature: fn.signature,
        message:
          `SECURITY DEFINER search_path ${JSON.stringify(fn.searchPath)} does not place pg_temp last`,
      });
    }
    if (fn.securityDefiner && fn.ownerSuperuser) {
      diagnostics.push({
        code: "security-definer-superuser-owner",
        functionSignature: fn.signature,
        message: `SECURITY DEFINER is owned by superuser ${JSON.stringify(fn.owner)}; prefer a least-privilege owner role`,
      });
    }
    if (fn.securityDefiner && fn.publicExecute) {
      diagnostics.push({
        code: "security-definer-public-execute",
        functionSignature: fn.signature,
        message: "SECURITY DEFINER is executable by PUBLIC; revoke PUBLIC access and grant EXECUTE only to intended roles",
      });
    }
    if (fn.leakproof) {
      diagnostics.push({
        code: "leakproof",
        functionSignature: fn.signature,
        message: "LEAKPROOF lets PostgreSQL evaluate the function ahead of security barriers; keep it only after a security audit",
      });
    }
    if (fn.volatility === "volatile" && fn.parallelSafety === "safe") {
      diagnostics.push({
        code: "volatile-parallel-safe",
        functionSignature: fn.signature,
        message: "VOLATILE PARALLEL SAFE is a high-risk planner contract; verify worker safety or mark the function PARALLEL UNSAFE",
      });
    }
  }
  return diagnostics;
}

function searchPathEndsWithPgTemp(searchPath: string): boolean {
  const last = searchPath.slice(searchPath.lastIndexOf(",") + 1).trim();
  return last === '"pg_temp"' || (!last.startsWith('"') && last.toLowerCase() === "pg_temp");
}

function isFunctionEntry(value: unknown): value is FunctionEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FunctionEntry>;
  return typeof entry.schema === "string"
    && entry.schema.length > 0
    && typeof entry.name === "string"
    && entry.name.length > 0
    && typeof entry.signature === "string"
    && isFunctionKind(entry.kind)
    && Array.isArray(entry.params)
    && entry.params.every(isFunctionParamEntry)
    && typeof entry.returns === "string"
    && typeof entry.returnsSet === "boolean"
    && isFunctionVolatility(entry.volatility)
    && typeof entry.securityDefiner === "boolean"
    && typeof entry.leakproof === "boolean"
    && isFunctionParallelSafety(entry.parallelSafety)
    && typeof entry.owner === "string"
    && entry.owner.length > 0
    && typeof entry.ownerSuperuser === "boolean"
    && typeof entry.publicExecute === "boolean"
    && (entry.searchPath === null || typeof entry.searchPath === "string")
    && typeof entry.extensionOwned === "boolean";
}

function isFunctionParamEntry(value: unknown): value is FunctionParamEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FunctionParamEntry>;
  return isFunctionParamMode(entry.mode)
    && typeof entry.tsType === "string"
    && (entry.name === undefined || typeof entry.name === "string");
}

function isFunctionKind(value: unknown): value is FunctionKind {
  return value === "function" || value === "procedure" || value === "aggregate" || value === "window";
}

function isFunctionParamMode(value: unknown): value is FunctionParamMode {
  return value === "in" || value === "out" || value === "inout" || value === "variadic" || value === "table";
}

function isFunctionVolatility(value: unknown): value is FunctionVolatility {
  return value === "immutable" || value === "stable" || value === "volatile";
}

function isFunctionParallelSafety(value: unknown): value is FunctionParallelSafety {
  return value === "unsafe" || value === "restricted" || value === "safe";
}
