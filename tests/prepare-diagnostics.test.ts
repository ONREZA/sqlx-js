import { expect, test } from "bun:test";
import {
  executionIntentDiagnostics,
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
    "  intent failed: second.ts:11:9 — sql.one() requires a statement with a result set"
      + ". Hint: Use sql.execute() for statements without RETURNING",
  ]);
});
