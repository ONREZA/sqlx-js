import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cache, writeCacheManifest } from "../src/cache";
import { buildQueryInventory, QueriesError } from "../src/commands/queries";
import { prepareConfigHash } from "../src/config";
import { queryId } from "../src/query-id";
import { _internal } from "../src/runtime";

const repoRoot = resolve(import.meta.dir, "..");
const binPath = join(repoRoot, "bin/sqlx-js.ts");

test("queries inventory and embedded module are deterministic and database-free", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-queries-"));
  try {
    mkdirSync(join(root, "queries"));
    writeFileSync(join(root, "queries/user.sql"), "SELECT id FROM users WHERE id = $id\n");
    writeFileSync(join(root, "queries.ts"), `
      import { defineQuery, sql } from "@onreza/sqlx-js";
      export const countUsers = defineQuery.one("users.count", "SELECT COUNT(*)::bigint AS count FROM users");
      export async function findUser(id: string) {
        return sql.file.optional("queries/user.sql", { id });
      }
    `);
    const embedded = join(root, "generated/embedded.ts");
    const result = spawnSync("bun", [
      binPath,
      "queries",
      "--json",
      "--embed",
      "generated/embedded.ts",
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
        cacheStatus: string;
        validation: string | null;
      }>;
      embeddedModule: string;
    };
    expect(inventory.formatVersion).toBe(1);
    expect(inventory.queries).toHaveLength(2);
    expect(inventory.queries.find((query) => query.queryNames.includes("users.count"))).toMatchObject({
      cardinalities: ["one"],
      sqlFilePaths: [],
      cacheStatus: "missing",
      validation: null,
    });
    expect(inventory.queries.find((query) => query.sqlFilePaths.length > 0)).toMatchObject({
      cardinalities: ["optional"],
      sqlFilePaths: ["queries/user.sql"],
    });
    expect(inventory.embeddedModule).toBe("generated/embedded.ts");
    const module = readFileSync(embedded, "utf8");
    expect(module).toContain('"queries/user.sql": "SELECT id FROM users WHERE id = $id\\n"');
    expect(module).not.toContain("COUNT(*)");

    const second = spawnSync("bun", [
      binPath,
      "queries",
      "--embed",
      "generated/embedded.ts",
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(embedded, "utf8")).toBe(module);

    const generated = await import(`${pathToFileURL(embedded).href}?test=${Date.now()}`) as {
      sqlxJsEmbeddedSql: Readonly<Record<string, string>>;
    };
    rmSync(join(root, "queries/user.sql"));
    expect(_internal.loadSqlFile("queries/user.sql", root, false, generated.sqlxJsEmbeddedSql))
      .toBe("SELECT id FROM users WHERE id = $id\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queries inventory distinguishes current and orphaned cache entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-query-cache-"));
  try {
    const query = "SELECT 1 AS value";
    writeFileSync(join(root, "query.ts"), `import { sql } from "@onreza/sqlx-js"; sql(${JSON.stringify(query)});\n`);
    const cacheDir = join(root, ".sqlx-js");
    const cache = new Cache(cacheDir);
    cache.write(queryId(query), {
      query,
      validation: "planned",
      paramOids: [],
      paramTsTypes: [],
      columns: [{ name: "value", typeOid: 23, tsType: "number", nullable: false }],
      hasResultSet: true,
    });
    cache.write("0000000000000000", {
      query: "SELECT 2",
      paramOids: [],
      paramTsTypes: [],
      columns: [],
      hasResultSet: false,
    });
    writeCacheManifest(cacheDir, prepareConfigHash({}));
    const inventory = await buildQueryInventory(root, cacheDir);
    expect(inventory.queries[0]).toMatchObject({
      queryId: queryId(query),
      cacheStatus: "current",
      validation: "planned",
    });
    expect(inventory.orphanedCacheIds).toEqual(["0000000000000000"]);

    cache.write(queryId(query), {
      query,
      paramOids: [],
      paramTsTypes: [],
      columns: [{ name: "value", typeOid: 23, tsType: "number", nullable: false }],
      hasResultSet: true,
    });
    const incomplete = await buildQueryInventory(root, cacheDir);
    expect(incomplete.queries[0]).toMatchObject({ cacheStatus: "stale", validation: null });
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

test("queries --json reports scan failures without writing an embedded module", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-query-error-"));
  try {
    writeFileSync(join(root, "query.ts"), `
      import { defineQuery } from "@onreza/sqlx-js";
      const text = "SELECT 1";
      export const query = defineQuery(text);
    `);
    const output = join(root, "embedded.ts");
    const result = spawnSync("bun", [
      binPath,
      "queries",
      "--json",
      "--embed",
      "embedded.ts",
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
    expect(() => readFileSync(output, "utf8")).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queries --json reports embedded-module write failures", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-query-embed-error-"));
  try {
    writeFileSync(join(root, "query.ts"), 'import { sql } from "@onreza/sqlx-js"; sql("SELECT 1");\n');
    mkdirSync(join(root, "generated"));
    const result = spawnSync("bun", [
      binPath,
      "queries",
      "--json",
      "--embed",
      "generated",
      "--root",
      root,
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      formatVersion: 1,
      ok: false,
      diagnostics: [{ severity: "error", phase: "embed" }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
