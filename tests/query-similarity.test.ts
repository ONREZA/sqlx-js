import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { buildQuerySimilarityReport } from "../src/commands/query-audit";
import { analyzeSimilarityUnits, type SimilarityUnit } from "../src/query-similarity";
import { extractSqlFunctionBodies } from "../src/sql-function-sources";

test("AST similarity ignores literals and parameter positions but preserves identifiers", async () => {
  const units: SimilarityUnit[] = [
    {
      id: "query:first",
      kind: "application-query",
      label: "first",
      sql: "SELECT id FROM users WHERE state = 'active' AND id = $1",
      sources: ["first.ts:1:1"],
    },
    {
      id: "query:second",
      kind: "application-query",
      label: "second",
      sql: "SELECT id FROM users WHERE state = 'pending' AND id = $2",
      sources: ["second.ts:1:1"],
    },
    {
      id: "query:other-relation",
      kind: "application-query",
      label: "other",
      sql: "SELECT id FROM accounts WHERE state = 'pending' AND id = $2",
      sources: ["other.ts:1:1"],
    },
  ];

  const report = await analyzeSimilarityUnits(units, { minNodes: 8, limit: 20 });
  expect(report.parseErrors).toEqual([]);
  const selectCandidates = report.candidates.filter((candidate) => candidate.nodeType === "SelectStmt");
  expect(selectCandidates.some((candidate) =>
    candidate.occurrences.map((occurrence) => occurrence.unitId).sort().join(",")
      === "query:first,query:second"
  )).toBe(true);
  expect(selectCandidates.some((candidate) =>
    candidate.occurrences.some((occurrence) => occurrence.unitId === "query:other-relation")
    && candidate.occurrences.some((occurrence) => occurrence.unitId === "query:first")
  )).toBe(false);
});

test("AST similarity maps SQL function parameters to application placeholders", async () => {
  const report = await analyzeSimilarityUnits([
    {
      id: "query:by-id",
      kind: "application-query",
      label: "users.byId",
      sql: "SELECT id FROM users WHERE id = $userId AND active = true",
      sources: ["users.ts:1:1"],
    },
    {
      id: "function:by-id",
      kind: "sql-function",
      label: "public.user_by_id",
      sql: "SELECT id FROM users WHERE id = p_user_id AND active = true",
      sources: ["functions/users.sql"],
      parameterNames: ["p_user_id"],
    },
  ], { minNodes: 8, limit: 20 });

  expect(report.candidates.some((candidate) => candidate.scope === "query-function")).toBe(true);
});

test("similarity inventories SQL functions and skips plpgsql bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-function-similarity-"));
  try {
    const functions = join(root, "functions");
    mkdirSync(functions);
    writeFileSync(join(functions, "users.sql"), `
      CREATE FUNCTION public.user_by_id(p_user_id bigint)
      RETURNS TABLE(id bigint)
      LANGUAGE sql
      AS $$ SELECT id FROM users WHERE id = p_user_id AND active = true $$;

      CREATE FUNCTION public.user_touch(p_user_id bigint)
      RETURNS void
      LANGUAGE plpgsql
      AS $$ BEGIN UPDATE users SET touched_at = now() WHERE id = p_user_id; END $$;
    `);
    const extraction = await extractSqlFunctionBodies(functions, root);
    expect(extraction.coverage).toMatchObject({
      files: 1,
      discovered: 2,
      sql: 1,
      plpgsql: 1,
      analyzedSqlBodies: 1,
      missingSqlBodies: 0,
      ddlParseErrors: [],
    });
    expect(extraction.units).toHaveLength(1);
    expect(extraction.units[0]).toMatchObject({
      kind: "sql-function",
      label: "public.user_by_id",
      parameterNames: ["p_user_id"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queries similarities scans configured sources and returns deterministic coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-similarity-command-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "functions"));
    writeFileSync(join(root, "src/queries.ts"), `
      import { defineQuery } from "@onreza/sqlx-js";
      export const first = defineQuery.one(
        "users.first",
        "SELECT id FROM users WHERE id = $userId AND state = 'active'",
      );
      export const second = defineQuery.one(
        "users.second",
        "SELECT id FROM users WHERE id = $id AND state = 'pending'",
      );
    `);
    writeFileSync(join(root, "sqlx-js.config.ts"), `
      export default {
        scan: { include: ["src/**/*.ts"] },
        schema: { provider: "pgschema", file: "functions/users.sql" },
      };
    `);
    writeFileSync(join(root, "functions/users.sql"), `
      CREATE FUNCTION public.user_by_id(p_user_id bigint)
      RETURNS TABLE(id bigint)
      LANGUAGE sql
      AS $$ SELECT id FROM users WHERE id = p_user_id AND state = 'ready' $$;
    `);

    const first = await buildQuerySimilarityReport({
      root,
      minNodes: 8,
      limit: 20,
    });
    const second = await buildQuerySimilarityReport({
      root,
      minNodes: 8,
      limit: 20,
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      formatVersion: 1,
      ok: true,
      kind: "ast-query-similarity",
      advisory: true,
      experimental: true,
      parameters: { functionSource: { path: "functions/users.sql", origin: "schema" } },
      coverage: {
        applicationQueries: { sourceSites: 2, uniqueQueries: 2 },
        functions: { sql: 1, analyzedSqlBodies: 1, plpgsql: 0 },
        parseErrors: [],
      },
    });
    expect(first.candidates.some((candidate) => candidate.scope === "query-function")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
