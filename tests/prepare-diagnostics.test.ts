import { expect, test } from "bun:test";
import {
  executionIntentDiagnostics,
  formatPrepareDiagnostic,
  formatPrepareDiagnosticCounts,
  reportQueryDiagnostics,
} from "../src/commands/prepare-diagnostics";
import type { CacheEntry } from "../src/cache";
import type { QueryCallSite } from "../src/scan/scanner";

const entry: CacheEntry = {
  query: "UPDATE users SET active = true",
  validation: "planned",
  hasInline: true,
  paramOids: [],
  paramTypeIdentities: [],
  paramTsTypes: [],
  paramNullable: [],
  columns: [],
  hasResultSet: false,
  inference: { columns: [], params: [] },
};

test("query diagnostics report the exact reused call site", () => {
  const sites: QueryCallSite[] = [
    {
      file: "first.ts",
      line: 3,
      column: 7,
      query: entry.query,
      paramCount: 0,
      kind: "inline",
      origin: "execution",
      cardinality: "execute",
    },
    {
      file: "second.ts",
      line: 11,
      column: 9,
      query: entry.query,
      paramCount: 0,
      kind: "inline",
      origin: "execution",
      cardinality: "one",
    },
  ];
  const diagnostics = executionIntentDiagnostics(entry, sites, false);
  const messages: string[] = [];

  expect(reportQueryDiagnostics(diagnostics, sites, (message) => messages.push(message))).toBe(true);
  expect(messages).toEqual([
    `  intent failed: second.ts:11:9 [query:${diagnostics[0]!.queryId}] — sql.one() requires a statement with a result set`
      + ". Hint: Use sql.execute() for statements without RETURNING",
  ]);
});

test("summary diagnostics expose query drill-down and aggregate phases", () => {
  const diagnostics = [
    {
      severity: "warning",
      phase: "inference",
      message: "result column resolved to unknown",
      file: "queries.ts",
      line: 4,
      column: 3,
      queryId: "0123456789abcdef",
      queryName: "find-users",
      profile: "api",
    },
    {
      severity: "warning",
      phase: "intent",
      message: "sql.execute() is discarding rows",
    },
    {
      severity: "error",
      phase: "cache",
      message: "generated declaration is stale",
    },
  ] as const;

  expect(formatPrepareDiagnostic(diagnostics[0])).toBe(
    "inference warning: queries.ts:4:3 [find-users] [profile:api] [query:0123456789abcdef] — "
      + "result column resolved to unknown",
  );
  expect(formatPrepareDiagnosticCounts(diagnostics)).toBe(
    "2 warnings (inference: 1, intent: 1), 1 error (cache: 1)",
  );
});
