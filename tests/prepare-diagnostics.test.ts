import { expect, test } from "bun:test";
import {
  executionIntentDiagnostics,
  formatPrepareDiagnostic,
  formatPrepareDiagnosticCounts,
  planningDiagnostics,
  planningValidationTag,
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
  nullableParamOverrides: [],
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
  expect(formatPrepareDiagnostic({
    severity: "error",
    phase: "describe",
    message: "relation does not exist",
    file: "queries.ts",
    line: 8,
    column: 5,
    query: "SELECT *\nFROM missing_relation",
    queryId: "fedcba9876543210",
    code: "42P01",
    position: 15,
  })).toBe(
    "describe failed: queries.ts:8:5 [query:fedcba9876543210] — relation does not exist (pos 15, code 42P01)\n"
      + "  query: SELECT * FROM missing_relation",
  );
  expect(formatPrepareDiagnosticCounts(diagnostics)).toBe(
    "2 warnings (inference: 1, intent: 1), 1 error (cache: 1)",
  );
});

test("expected parse-only validation remains visible without a warning", () => {
  const site: QueryCallSite = {
    file: "maintenance.ts",
    line: 4,
    column: 3,
    query: "ANALYZE users",
    paramCount: 0,
    kind: "inline",
    origin: "definition",
    cardinality: "execute",
    expectedValidation: "parse-only",
  };
  expect(planningDiagnostics("parse-only", [site])).toEqual([]);
  expect(planningValidationTag("parse-only", [site])).toBe(" [parse-only acknowledged]");

  expect(planningDiagnostics("planned", [site])).toEqual([
    expect.objectContaining({
      severity: "warning",
      phase: "plan",
      message: 'statement is now planned; remove the stale expectedValidation: "parse-only" source contract',
    }),
  ]);

  const unacknowledged = { ...site, file: "runner.ts", expectedValidation: undefined };
  expect(planningDiagnostics("parse-only", [site, unacknowledged])).toEqual([
    expect.objectContaining({ file: "runner.ts", phase: "plan" }),
  ]);
  expect(planningDiagnostics("parse-only", [site, unacknowledged], true)).toEqual([
    expect.objectContaining({ file: "runner.ts", phase: "plan", severity: "error" }),
  ]);
  expect(planningValidationTag("parse-only", [site, unacknowledged])).toBe(" [parse-only]");
});
