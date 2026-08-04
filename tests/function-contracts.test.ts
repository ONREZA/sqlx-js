import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  functionContractDiagnostics,
  functionSettingValue,
  normalizeFunctionSettings,
  readFunctionCache,
  type FunctionEntry,
  writeFunctionCache,
} from "../src/function-cache";

function functionEntry(overrides: Partial<FunctionEntry> = {}): FunctionEntry {
  return {
    schema: "public",
    name: "example",
    signature: "public.example()",
    kind: "function",
    language: "sql",
    params: [],
    returns: "boolean | null",
    returnsSet: false,
    volatility: "stable",
    strict: false,
    securityDefiner: false,
    leakproof: false,
    parallelSafety: "unsafe",
    owner: "app_owner",
    ownerSuperuser: false,
    publicExecute: false,
    settings: [],
    searchPath: null,
    extensionOwned: false,
    ...overrides,
  };
}

test("function cache preserves deterministic language, strictness, and all local settings", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "sqlx-js-function-cache-"));
  try {
    const settings = normalizeFunctionSettings(["TimeZone=UTC", "search_path=app, pg_temp"]);
    const entry = functionEntry({ language: "plpgsql", strict: true, settings, searchPath: "app, pg_temp" });
    writeFunctionCache(cacheDir, [entry]);
    expect(readFunctionCache(cacheDir)).toEqual([entry]);
    expect(settings).toEqual(["search_path=app, pg_temp", "TimeZone=UTC"]);
    expect(functionSettingValue(settings, "timezone")).toBe("UTC");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("function cache refuses non-canonical settings before writing", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "sqlx-js-function-cache-invalid-"));
  try {
    expect(() => writeFunctionCache(cacheDir, [functionEntry({
      settings: ["TimeZone=UTC", "search_path=app, pg_temp"],
      searchPath: "app, pg_temp",
    })])).toThrow(/refusing to write malformed function catalog cache/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("function contract diagnostics report reviewable security and planner risks", () => {
  const diagnostics = functionContractDiagnostics([
    functionEntry({
      signature: "public.missing_path()",
      securityDefiner: true,
      owner: "postgres",
      ownerSuperuser: true,
      publicExecute: true,
    }),
    functionEntry({
      signature: "public.unsafe_path()",
      securityDefiner: true,
      settings: ["search_path=app"],
      searchPath: "app",
    }),
    functionEntry({
      signature: "public.leaky()",
      leakproof: true,
    }),
    functionEntry({
      signature: "public.parallel_write()",
      volatility: "volatile",
      parallelSafety: "safe",
    }),
  ]);

  expect(diagnostics.map(({ code, functionSignature }) => ({ code, functionSignature }))).toEqual([
    {
      code: "security-definer-missing-search-path",
      functionSignature: "public.missing_path()",
    },
    {
      code: "security-definer-superuser-owner",
      functionSignature: "public.missing_path()",
    },
    {
      code: "security-definer-public-execute",
      functionSignature: "public.missing_path()",
    },
    {
      code: "security-definer-unsafe-search-path",
      functionSignature: "public.unsafe_path()",
    },
    {
      code: "leakproof",
      functionSignature: "public.leaky()",
    },
    {
      code: "volatile-parallel-safe",
      functionSignature: "public.parallel_write()",
    },
  ]);
});
