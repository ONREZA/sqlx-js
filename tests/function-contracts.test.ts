import { expect, test } from "bun:test";
import {
  functionContractDiagnostics,
  type FunctionEntry,
} from "../src/function-cache";

function functionEntry(overrides: Partial<FunctionEntry> = {}): FunctionEntry {
  return {
    schema: "public",
    name: "example",
    signature: "public.example()",
    kind: "function",
    params: [],
    returns: "boolean | null",
    returnsSet: false,
    volatility: "stable",
    securityDefiner: false,
    leakproof: false,
    parallelSafety: "unsafe",
    owner: "app_owner",
    ownerSuperuser: false,
    publicExecute: false,
    searchPath: null,
    extensionOwned: false,
    ...overrides,
  };
}

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
