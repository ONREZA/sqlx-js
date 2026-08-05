import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { buildQuerySimilarityReport } from "../src/commands/query-audit";
import { analyzeSimilarityUnits, type SimilarityUnit } from "../src/query-similarity";
import { extractSqlFunctionBodies } from "../src/sql-function-sources";

const binPath = resolve(import.meta.dir, "../bin/sqlx-js.ts");

test("AST similarity ignores literals and alpha-renames parameters while preserving identifiers", async () => {
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

test("AST similarity alpha-renames parameters while preserving repeated-parameter identity", async () => {
  const report = await analyzeSimilarityUnits([
    {
      id: "query:repeated",
      kind: "application-query",
      label: "repeated",
      sql: "SELECT id FROM users WHERE owner_id = $1 OR reviewer_id = $1",
      sources: ["repeated.ts:1:1"],
    },
    {
      id: "query:renumbered",
      kind: "application-query",
      label: "renumbered",
      sql: "SELECT id FROM users WHERE owner_id = $2 OR reviewer_id = $2",
      sources: ["renumbered.ts:1:1"],
    },
    {
      id: "query:distinct",
      kind: "application-query",
      label: "distinct",
      sql: "SELECT id FROM users WHERE owner_id = $1 OR reviewer_id = $2",
      sources: ["distinct.ts:1:1"],
    },
  ], { minNodes: 8, limit: 20 });

  const selectCandidates = report.candidates.filter((candidate) => candidate.nodeType === "SelectStmt");
  expect(selectCandidates.map((candidate) =>
    candidate.occurrences.map((occurrence) => occurrence.unitId)
  )).toContainEqual(["query:renumbered", "query:repeated"]);
  expect(selectCandidates.some((candidate) =>
    candidate.occurrences.some((occurrence) => occurrence.unitId === "query:distinct")
  )).toBe(false);
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

      CREATE FUNCTION public.user_state(p_user_id bigint)
      RETURNS TABLE(id bigint)
      LANGUAGE sql
      BEGIN ATOMIC
        SELECT id FROM users WHERE id = p_user_id AND active = true;
      END;

      CREATE FUNCTION public.user_score(p_user_id bigint)
      RETURNS bigint
      LANGUAGE sql
      RETURN p_user_id + 1;

      CREATE PROCEDURE public.user_refresh(p_user_id bigint)
      LANGUAGE sql
      AS $$ SELECT p_user_id $$;
    `);
    const extraction = await extractSqlFunctionBodies(functions, root);
    expect(extraction.coverage).toMatchObject({
      files: 1,
      discovered: 4,
      proceduresSkipped: 1,
      sql: 3,
      plpgsql: 1,
      analyzedSqlBodies: 3,
      missingSqlBodies: 0,
      ddlParseErrors: [],
    });
    expect(extraction.units).toHaveLength(3);
    expect(extraction.units[0]).toMatchObject({
      kind: "sql-function",
      label: "public.user_by_id",
      parameterNames: ["p_user_id"],
    });
    const standardBody = extraction.units.find((unit) => unit.label === "public.user_state");
    expect(standardBody?.astStatements).toHaveLength(1);
    expect(standardBody?.sql).toStartWith("CREATE FUNCTION public.user_state");
    expect(extraction.units.find((unit) => unit.label === "public.user_score")?.astStatements).toHaveLength(1);
    const analysis = await analyzeSimilarityUnits([
      ...extraction.units,
      {
        id: "query:user-state",
        kind: "application-query",
        label: "users.state",
        sql: "SELECT id FROM users WHERE id = $userId AND active = true",
        sources: ["users.ts:1:1"],
      },
    ], { minNodes: 8, limit: 20 });
    expect(analysis.candidates.some((candidate) =>
      candidate.occurrences.some((occurrence) => occurrence.label === "public.user_state")
      && candidate.occurrences.some((occurrence) => occurrence.label === "users.state")
    )).toBe(true);
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

      CREATE FUNCTION public.user_touch(p_user_id bigint)
      RETURNS void
      LANGUAGE plpgsql
      AS $$ BEGIN PERFORM p_user_id; END $$;

      CREATE FUNCTION public.user_native(p_user_id bigint)
      RETURNS bigint
      LANGUAGE c
      AS 'user_native';

      CREATE PROCEDURE public.user_refresh(p_user_id bigint)
      LANGUAGE sql
      AS $$ SELECT p_user_id $$;
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
      complete: true,
      kind: "ast-query-similarity",
      advisory: true,
      experimental: true,
      parameters: { functionSource: { path: "functions/users.sql", origin: "schema" } },
      coverage: {
        applicationQueries: { sourceSites: 2, uniqueQueries: 2 },
        functions: {
          discovered: 3,
          proceduresSkipped: 1,
          sql: 1,
          analyzedSqlBodies: 1,
          plpgsql: 1,
          other: 1,
        },
        parseErrors: [],
      },
    });
    expect(first.candidates.some((candidate) => candidate.scope === "query-function")).toBe(true);

    const cli = spawnSync("bun", [
      binPath,
      "queries",
      "similarities",
      "--json",
      "--limit",
      "5",
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(cli.status).toBe(0);
    expect(cli.stderr).toBe("");
    expect(JSON.parse(cli.stdout)).toMatchObject({
      ok: true,
      complete: true,
      kind: "ast-query-similarity",
      parameters: { limit: 5 },
    });

    const emptyFunctions = spawnSync("bun", [
      binPath,
      "queries",
      "similarities",
      "--json",
      "--functions",
      "",
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(emptyFunctions.status).toBe(2);
    expect(JSON.parse(emptyFunctions.stdout)).toMatchObject({
      ok: false,
      diagnostics: [{ phase: "functions", message: expect.stringContaining("non-empty") }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queries similarities marks reports with unparsed SQL bodies as partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-similarity-partial-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/query.ts"), `
      import { defineQuery } from "@onreza/sqlx-js";
      export const query = defineQuery.one("users.list", "SELECT id FROM users");
    `);
    writeFileSync(join(root, "schema.sql"), `
      CREATE FUNCTION public.broken_query()
      RETURNS bigint
      LANGUAGE sql
      AS $$ SELECT FROM $$;
    `);
    writeFileSync(join(root, "sqlx-js.config.ts"), `
      export default {
        scan: { include: ["src/**/*.ts"] },
        schema: { provider: "pgschema", file: "schema.sql" },
      };
    `);

    const report = await buildQuerySimilarityReport({ root });
    expect(report).toMatchObject({
      ok: true,
      complete: false,
      coverage: {
        functions: { analyzedSqlBodies: 1, ddlParseErrors: [] },
        parseErrors: [{ label: "public.broken_query" }],
      },
    });
    const cli = spawnSync("bun", [
      binPath,
      "queries",
      "similarities",
      "--json",
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, complete: false });

    const functions = join(root, "functions");
    mkdirSync(functions);
    writeFileSync(join(functions, "missing.sql"), `
      CREATE FUNCTION public.missing_body()
      RETURNS bigint
      LANGUAGE sql;
    `);
    writeFileSync(join(functions, "invalid.sql"), "CREATE FUNCTION");
    const incompleteSources = await buildQuerySimilarityReport({
      root,
      functionsPath: "functions",
    });
    expect(incompleteSources).toMatchObject({
      ok: true,
      complete: false,
      coverage: {
        functions: {
          discovered: 1,
          sql: 1,
          analyzedSqlBodies: 0,
          missingSqlBodies: 1,
          ddlParseErrors: [{ source: "functions/invalid.sql" }],
        },
      },
    });
    await expect(buildQuerySimilarityReport({
      root,
      functionsPath: "../outside.sql",
    })).rejects.toMatchObject({ phase: "functions" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
