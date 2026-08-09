import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cache, profileFingerprint, type CacheEntry, writeCacheManifest } from "../src/cache";
import { buildQueryExplanation, buildQueryInventory, QueriesError } from "../src/commands/queries";
import { prepareConfigHash } from "../src/config";
import { queryId } from "../src/query-id";

const repoRoot = resolve(import.meta.dir, "..");
const binPath = join(repoRoot, "bin/sqlx-js.ts");

function cacheEntry(query: string, overrides: Partial<CacheEntry> = {}): CacheEntry {
  const paramTsTypes = overrides.paramTsTypes ?? [];
  const columns = overrides.columns ?? [];
  return {
    query,
    paramOids: [],
    paramTypeIdentities: [],
    paramTsTypes,
    paramNullable: paramTsTypes.map(() => false),
    nullableParamOverrides: [],
    resultElementNonNullOverrides: [],
    columns,
    hasResultSet: columns.length > 0,
    usesTimestampWithoutTimeZone: false,
    inference: {
      columns: columns.map(() => ({ sources: null, reason: "test fixture" })),
      params: paramTsTypes.map(() => ({ targets: [], reason: "test fixture" })),
    },
    ...overrides,
  };
}

test("queries inventory is deterministic and database-free", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-queries-"));
  try {
    mkdirSync(join(root, "queries"));
    writeFileSync(join(root, "queries/user.sql"), "SELECT id FROM users WHERE id = $id\n");
    writeFileSync(join(root, "queries.ts"), `
      import { defineQuery, sql } from "@onreza/sqlx-js";
      export const countUsers = defineQuery.one(
        "users.count",
        "SELECT $scope::text AS scope",
        {
          nullableParams: ["scope"],
          expectedValidation: "parse-only",
          resultAssertions: { capabilities: { elements: "non-null" } },
          temporal: {
            timestampWithoutTimeZone: {
              allow: true,
              reason: "The query intentionally uses civil time",
            },
          },
        },
      );
      export async function findUser(id: string) {
        return sql.file.optional("queries/user.sql", { id });
      }
    `);
    const result = spawnSync("bun", [
      binPath,
      "queries",
      "--json",
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const inventory = JSON.parse(result.stdout) as {
      formatVersion: number;
      queries: Array<{
        queryNames: string[];
        cardinalities: string[];
        sqlFilePaths: string[];
        nullableParamOverrides: number[];
        resultAssertions: Record<string, { elements: "non-null" }>;
        expectedValidation: string | null;
        callSites: Array<{
          nullableParams?: number[];
          resultAssertions?: Record<string, { elements: "non-null" }>;
          expectedValidation?: string;
          timestampWithoutTimeZone?: string;
          temporalReason?: string;
        }>;
        cacheStatus: string;
        validation: string | null;
      }>;
    };
    expect(inventory.formatVersion).toBe(1);
    expect(inventory.queries).toHaveLength(2);
    expect(inventory.queries.find((query) => query.queryNames.includes("users.count"))).toMatchObject({
      cardinalities: ["one"],
      sqlFilePaths: [],
      nullableParamOverrides: [1],
      resultAssertions: { capabilities: { elements: "non-null" } },
      expectedValidation: "parse-only",
      callSites: [expect.objectContaining({
        nullableParams: [1],
        resultAssertions: { capabilities: { elements: "non-null" } },
        expectedValidation: "parse-only",
        timestampWithoutTimeZone: "allow",
        temporalReason: "The query intentionally uses civil time",
      })],
      cacheStatus: "missing",
      validation: null,
    });
    expect(inventory.queries.find((query) => query.sqlFilePaths.length > 0)).toMatchObject({
      cardinalities: ["optional"],
      sqlFilePaths: ["queries/user.sql"],
    });
    const second = spawnSync("bun", [
      binPath,
      "queries",
      "--json",
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queries inventory distinguishes current and orphaned cache entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-query-cache-"));
  try {
    const query = `SELECT ARRAY['x']::text[] AS value, 1 AS "toString"`;
    const orphanQuery = "SELECT 2";
    const orphanId = queryId(orphanQuery);
    writeFileSync(join(root, "query.ts"), `
      import { defineQuery } from "@onreza/sqlx-js";
      defineQuery(${JSON.stringify(query)}, {
        resultAssertions: { value: { elements: "non-null" } },
      });
    `);
    const cacheDir = join(root, ".sqlx-js");
    const cache = new Cache(cacheDir);
    cache.write(queryId(query), cacheEntry(query, {
      validation: "planned",
      resultElementNonNullOverrides: ["value"],
      columns: [
        { name: "value", typeOid: 1009, tsType: "(string)[]", nullable: false },
        { name: "toString", typeOid: 23, tsType: "number", nullable: false },
      ],
      hasResultSet: true,
      inference: {
        columns: [
          { sources: null, reason: "test fixture" },
          { sources: null, reason: "test fixture" },
        ],
        params: [],
      },
    }));
    cache.write(orphanId, cacheEntry(orphanQuery));
    writeCacheManifest(cacheDir, prepareConfigHash({}));
    const inventory = await buildQueryInventory(root, cacheDir);
    expect(inventory.queries[0]).toMatchObject({
      queryId: queryId(query),
      resultAssertions: { value: { elements: "non-null" } },
      cacheStatus: "current",
      validation: "planned",
    });
    expect(inventory.orphanedCacheIds).toEqual([orphanId]);

    const explained = spawnSync("bun", [
      binPath,
      "queries",
      "explain",
      queryId(query),
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(explained.status, explained.stderr).toBe(0);
    expect(explained.stdout.match(/assertion: elements non-null/g)).toHaveLength(1);

    cache.write(queryId(query), cacheEntry(query, {
      resultElementNonNullOverrides: ["value"],
      columns: [
        { name: "value", typeOid: 1009, tsType: "(string)[]", nullable: false },
        { name: "toString", typeOid: 23, tsType: "number", nullable: false },
      ],
      hasResultSet: true,
      inference: {
        columns: [
          { sources: null, reason: "test fixture" },
          { sources: null, reason: "test fixture" },
        ],
        params: [],
      },
    }));
    const incomplete = await buildQueryInventory(root, cacheDir);
    expect(incomplete.queries[0]).toMatchObject({ cacheStatus: "stale", validation: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queries explain reports committed provenance and parameter targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-query-explain-"));
  try {
    const query = "SELECT users.id FROM users WHERE users.id = $1";
    writeFileSync(
      join(root, "query.ts"),
      `import { sql } from "@onreza/sqlx-js"; sql.one(${JSON.stringify(query)}, 1);\n`,
    );
    const cacheDir = join(root, ".sqlx-js");
    const cache = new Cache(cacheDir);
    cache.write(queryId(query), cacheEntry(query, {
      validation: "planned",
      paramOids: [23],
      paramTypeIdentities: [23],
      paramTsTypes: ["number"],
      paramNullable: [false],
      columns: [{ name: "id", typeOid: 23, tsType: "number", nullable: false }],
      hasResultSet: true,
      inference: {
        params: [{
          targets: [{ kind: "predicate", table: "users", column: "id" }],
          reason: "a predicate reference requires a non-null value",
        }],
        columns: [{
          sources: [{ schema: "public", table: "users", column: "id", notNull: true }],
          reason: "all source columns are NOT NULL",
        }],
      },
    }));
    writeCacheManifest(cacheDir, prepareConfigHash({}));

    const explanation = await buildQueryExplanation(root, cacheDir, queryId(query));
    expect(explanation.contracts[0]).toMatchObject({
      profile: null,
      params: [{
        name: "$1",
        targets: [{ kind: "predicate", table: "users", column: "id" }],
      }],
      columns: [{
        name: "id",
        sources: [{ schema: "public", table: "users", column: "id", notNull: true }],
      }],
    });

    const result = spawnSync("bun", [
      binPath,
      "queries",
      "explain",
      queryId(query),
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("source: public.users.id NOT NULL");
    expect(result.stdout).toContain("predicate: users.id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queries inventory aggregates profile-specific cache contracts", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-profile-queries-"));
  try {
    const query = "SELECT $scope::text AS value, ARRAY['x']::text[] AS capabilities";
    const profiles = {
      api: { name: "api", role: "app_api" },
      worker: { name: "worker", role: "app_worker" },
    } as const;
    writeFileSync(join(root, "sqlx-js.config.mjs"), `export default {
      profiles: ${JSON.stringify(profiles)},
    };\n`);
    writeFileSync(join(root, "query.ts"), `
      import { defineQuery } from "@onreza/sqlx-js";
      defineQuery.for("api").one(${JSON.stringify(query)}, {
        nullableParams: ["scope"],
        resultAssertions: { capabilities: { elements: "non-null" } },
      });
      defineQuery.for("worker").one(${JSON.stringify(query)});
    `);
    const cacheDir = join(root, ".sqlx-js");
    const cache = new Cache(cacheDir);
    for (const profile of ["api", "worker"] as const) {
      cache.write(profileFingerprint(profile, query), cacheEntry(query, {
        profile,
        validation: "planned",
        paramOids: [25],
        paramTypeIdentities: [25],
        paramTsTypes: ["string"],
        paramNullable: [profile === "api"],
        nullableParamOverrides: profile === "api" ? [1] : [],
        resultElementNonNullOverrides: profile === "api" ? ["capabilities"] : [],
        paramNames: ["scope"],
        columns: [
          { name: "value", typeOid: 25, tsType: "string", nullable: profile === "api" },
          {
            name: "capabilities",
            typeOid: 1009,
            tsType: "(string)[]",
            nullable: false,
          },
        ],
        hasResultSet: true,
        inference: {
          columns: [
            { sources: null, reason: "test fixture" },
            { sources: null, reason: "test fixture" },
          ],
          params: [{ targets: [], reason: "test fixture" }],
        },
      }));
    }
    writeCacheManifest(cacheDir, prepareConfigHash({ profiles }));

    const inventory = await buildQueryInventory(root, cacheDir);
    expect(inventory.queries).toEqual([
      expect.objectContaining({
        query,
        profiles: ["api", "worker"],
        nullableParamOverrides: [1],
        resultAssertions: { capabilities: { elements: "non-null" } },
        cacheStatus: "current",
        validation: "planned",
        callSites: [
          expect.objectContaining({ profiles: ["api"], nullableParams: [1] }),
          expect.objectContaining({ profiles: ["worker"] }),
        ],
      }),
    ]);
    const explanation = await buildQueryExplanation(root, cacheDir, queryId(query));
    expect(explanation.contracts).toEqual([
      expect.objectContaining({
        profile: "api",
        resultAssertions: { capabilities: { elements: "non-null" } },
      }),
      expect.objectContaining({ profile: "worker", resultAssertions: {} }),
    ]);
    expect(inventory.orphanedCacheIds).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queries inventory classifies config and cache failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-query-failures-"));
  try {
    writeFileSync(join(root, "sqlx-js.config.ts"), "export default { functionCatalog: 'all' };\n");
    await expect(buildQueryInventory(root, join(root, ".sqlx-js")))
      .rejects.toMatchObject({ name: "QueriesError", phase: "config" });

    rmSync(join(root, "sqlx-js.config.ts"));
    mkdirSync(join(root, ".sqlx-js"));
    writeFileSync(join(root, ".sqlx-js/cache-manifest.json"), "{broken");
    await expect(buildQueryInventory(root, join(root, ".sqlx-js")))
      .rejects.toMatchObject({ name: "QueriesError", phase: "cache" } satisfies Partial<QueriesError>);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queries --json reports scan failures", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-query-error-"));
  try {
    writeFileSync(join(root, "query.ts"), `
      import { defineQuery } from "@onreza/sqlx-js";
      const text = "SELECT 1";
      export const query = defineQuery(text);
    `);
    const result = spawnSync("bun", [
      binPath,
      "queries",
      "--json",
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      formatVersion: 1,
      ok: false,
      diagnostics: [{ severity: "error", phase: "scan", file: "query.ts", line: 4 }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
