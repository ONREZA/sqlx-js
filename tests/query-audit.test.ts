import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { buildExactQueryAuditReport } from "../src/commands/query-audit";
import { loadConfig } from "../src/config";
import { buildExactQueryAudit } from "../src/query-audit";
import { queryId } from "../src/query-id";
import type { QueryCallSite } from "../src/scan/scanner";

const binPath = resolve(import.meta.dir, "../bin/sqlx-js.ts");

function site(
  file: string,
  query: string,
  overrides: Partial<QueryCallSite> = {},
): QueryCallSite {
  return {
    file,
    line: 1,
    column: 1,
    query,
    paramCount: 1,
    kind: "inline",
    origin: "definition",
    cardinality: "one",
    ...overrides,
  };
}

test("exact query audit keeps reviewed duplicates visible and reports contract drift", () => {
  const query = "SELECT id FROM users WHERE id = $1";
  const id = queryId(query);
  const sites = [
    site("src/a.ts", query, {
      queryName: "users.byId",
      profiles: ["api"],
      nullableParams: [1],
      resultAssertions: { tags: { elements: "non-null" } },
      expectedValidation: "parse-only",
      timestampWithoutTimeZone: "allow",
      temporalReason: "Legacy reporting value",
    }),
    site("src/b.ts", `  ${query} -- same fingerprint`, {
      line: 2,
      queryName: "users.byId",
      cardinality: "optional",
      profiles: ["worker"],
      timestampWithoutTimeZone: "reject",
    }),
    site("src/c.ts", query, {
      line: 3,
      origin: "execution",
      cardinality: "many",
    }),
    site("src/d.ts", "SELECT email FROM users WHERE id = $1", {
      queryName: "users.byId",
    }),
  ];
  const report = buildExactQueryAudit(sites, {
    exactDuplicates: {
      ignore: [{ queryId: id, occurrences: 3, reason: "Separate read paths retain their identities" }],
    },
  });

  expect(report.summary).toMatchObject({
    sourceSites: 4,
    uniqueQueries: 2,
    possibleDuplicates: 1,
    activePossibleDuplicates: 0,
    ignoredPossibleDuplicates: 1,
    contractDivergences: 1,
    queryNameCollisions: 1,
    staleIgnores: 0,
    reviewRequired: true,
  });
  expect(report.candidates[0]).toMatchObject({
    queryId: id,
    classification: "mixed",
    occurrenceCount: 3,
    duplicateStatus: "ignored",
    reviewRequired: true,
    ignore: { reason: "Separate read paths retain their identities" },
    divergences: [
      "cardinality",
      "profiles",
      "nullable-parameters",
      "result-assertions",
      "expected-validation",
      "temporal-policy",
    ],
  });
  expect(report.candidates[0]!.sourceTextVariants).toHaveLength(2);
  expect(report.candidates[0]!.contracts).toHaveLength(3);
  expect(report.queryNameCollisions[0]).toMatchObject({
    queryName: "users.byId",
    queryIds: expect.arrayContaining([id, queryId("SELECT email FROM users WHERE id = $1")]),
  });
});

test("exact query audit resurfaces changed duplicates and classifies stale ignores", () => {
  const duplicate = "SELECT id FROM teams WHERE id = $1";
  const single = "SELECT id FROM users WHERE id = $1";
  const report = buildExactQueryAudit(
    [site("src/a.ts", duplicate), site("src/b.ts", duplicate), site("src/c.ts", single)],
    {
      exactDuplicates: {
        ignore: [
          { queryId: queryId(duplicate), occurrences: 3, reason: "Previously reviewed" },
          { queryId: queryId(single), occurrences: 2, reason: "Previously duplicated" },
          { queryId: "0000000000000000", occurrences: 2, reason: "Removed query" },
        ],
      },
    },
  );

  expect(report.candidates[0]).toMatchObject({
    duplicateStatus: "active",
    reviewRequired: true,
    occurrenceCount: 2,
  });
  expect(report.staleIgnores).toEqual([
    {
      queryId: "0000000000000000",
      occurrences: 2,
      reason: "Removed query",
      actualOccurrences: null,
      staleReason: "query-not-found",
    },
    {
      queryId: queryId(single),
      occurrences: 2,
      reason: "Previously duplicated",
      actualOccurrences: 1,
      staleReason: "no-longer-duplicate",
    },
    {
      queryId: queryId(duplicate),
      occurrences: 3,
      reason: "Previously reviewed",
      actualOccurrences: 2,
      staleReason: "occurrence-count-changed",
    },
  ].sort((left, right) => left.queryId.localeCompare(right.queryId)));
});

test("an exact duplicate ignore does not acknowledge divergent source contracts", () => {
  const query = "SELECT id FROM users";
  const report = buildExactQueryAudit([
    site("src/one.ts", query, { cardinality: "one" }),
    site("src/many.ts", query, { cardinality: "many" }),
  ], {
    exactDuplicates: {
      ignore: [{ queryId: queryId(query), occurrences: 2, reason: "Intentional reuse" }],
    },
  });

  expect(report.summary).toMatchObject({
    activePossibleDuplicates: 0,
    ignoredPossibleDuplicates: 1,
    contractDivergences: 1,
    reviewRequired: true,
  });
  expect(report.candidates[0]).toMatchObject({
    duplicateStatus: "ignored",
    reviewRequired: true,
    divergences: ["cardinality"],
  });
});

test("queries audit loads config ignores and emits advisory JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-query-audit-"));
  try {
    mkdirSync(join(root, "src"));
    const query = "SELECT id FROM users WHERE id = $1";
    const id = queryId(query);
    writeFileSync(join(root, "src/a.ts"), `
      import { defineQuery } from "@onreza/sqlx-js";
      export const first = defineQuery.one("users.first", ${JSON.stringify(query)});
      export const second = defineQuery.one("users.second", ${JSON.stringify(query)});
    `);
    writeFileSync(join(root, "sqlx-js.config.ts"), `
      export default {
        scan: { include: ["src/**/*.ts"] },
        queryAudit: {
          exactDuplicates: {
            ignore: [{
              queryId: ${JSON.stringify(id)},
              occurrences: 2,
              reason: "Intentional public and internal reads",
            }],
          },
        },
      };
    `);

    const config = await loadConfig(root);
    expect(config.queryAudit?.exactDuplicates?.ignore?.[0]).toMatchObject({ queryId: id, occurrences: 2 });
    const report = await buildExactQueryAuditReport(root);
    expect(report.candidates[0]).toMatchObject({
      queryId: id,
      duplicateStatus: "ignored",
      reviewRequired: false,
    });

    const cli = spawnSync("bun", [binPath, "queries", "audit", "--json", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(cli.status).toBe(0);
    expect(cli.stderr).toBe("");
    expect(JSON.parse(cli.stdout)).toMatchObject({
      formatVersion: 1,
      ok: true,
      kind: "exact-query-reuse",
      advisory: true,
      summary: { ignoredPossibleDuplicates: 1, reviewRequired: false },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
