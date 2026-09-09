import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Temporal } from "temporal-polyfill";
import { fingerprint, type CacheEntry } from "../src/cache";
import { createSqlClient } from "../src/postgres-runtime";
import { PgClient, parseDatabaseUrl } from "../src/pg/wire";
import type { RuntimeQueryDescriptors } from "../src/runtime-descriptors";

const configuredUrl = process.env.SQLX_JS_TEST_DATABASE_URL?.trim();
const available = Boolean(configuredUrl) || spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

if (!available) {
  test.skip("inference regressions require SQLX_JS_TEST_DATABASE_URL or Docker", () => {});
} else {
  const root = mkdtempSync("/var/tmp/sqlx-js-inference-");
  const schemaName = `inference_${process.pid}_${Date.now()}`;
  const table = `${schemaName}.probe`;
  const repoRoot = resolve(import.meta.dir, "..");
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = configuredUrl ?? "";
  let client: PgClient;

  const filtered = "SELECT ARRAY(SELECT u.value FROM unnest(ARRAY[1, NULL]::int[]) AS u(value) WHERE u.value IS NOT NULL) AS values";
  const unqualified = "SELECT ARRAY(SELECT value FROM unnest(ARRAY[1, NULL]::int[]) AS u(value) WHERE value IS NOT NULL) AS values";
  const nullable = "SELECT ARRAY(SELECT u.value FROM unnest(ARRAY[1, NULL]::int[]) AS u(value)) AS values";
  const explain = `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) INSERT INTO ${table} VALUES (1)`;
  const parameterizedExplain = `EXPLAIN (ANALYZE, FORMAT JSON) INSERT INTO ${schemaName}.documents (payload) VALUES ($payload)`;
  const correlatedExplain = `EXPLAIN (FORMAT JSON) SELECT d.payload FROM ${schemaName}.documents AS d WHERE EXISTS (SELECT 1 FROM unnest(ARRAY[1]) AS input(value) WHERE d.payload = $payload)`;
  const implicitFunction = "SELECT unnest.unnest AS value FROM pg_catalog.unnest(ARRAY[1,NULL]) WHERE unnest.unnest = $1";
  const implicitExpression = "SELECT coalesce.coalesce AS value FROM coalesce(NULL::int, 1) WHERE coalesce.coalesce = $1";
  const outerJoin = "SELECT ARRAY(SELECT u.value FROM (SELECT 1 AS id) AS p LEFT JOIN unnest(ARRAY[NULL]::int[]) AS u(value) ON u.value IS NOT NULL) AS values";
  const formats = ["TEXT", "JSON", "XML", "YAML"] as const;
  const explains = formats.map((format) => `EXPLAIN (FORMAT ${format}) SELECT NULL`);

  function prepare(args: string[] = []) {
    return spawnSync("bun", [join(repoRoot, "bin/sqlx-js.ts"), "prepare", "--root", root, ...args], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  }

  function entry(query: string): CacheEntry {
    return JSON.parse(readFileSync(join(root, ".sqlx-js", `${fingerprint(query)}.json`), "utf8"));
  }

  async function storedRows() {
    return await client.simpleQuery(`SELECT * FROM ${table}`);
  }

  beforeAll(async () => {
    if (!databaseUrl) {
      container = await new PostgreSqlContainer(process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg18")
        .withDatabase("inference_test").withUsername("postgres").withPassword("postgres").start();
      databaseUrl = container.getConnectionUri();
    }
    client = new PgClient(parseDatabaseUrl(databaseUrl));
    await client.connect();
    await client.simpleQuery(`CREATE SCHEMA ${schemaName}; CREATE TABLE ${table} (id integer);
      CREATE TABLE ${schemaName}.documents (payload jsonb NOT NULL);
      CREATE TABLE ${schemaName}.unnest (unnest integer);
      CREATE TABLE ${schemaName}."coalesce" ("coalesce" integer)`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c search_path=${schemaName},public`.trim());
    url.search = url.search.replaceAll("+", "%20");
    databaseUrl = url.toString();
    writeFileSync(join(root, "package.json"), '{"name":"inference-test","type":"module"}');
    writeFileSync(join(root, "sqlx-js.config.ts"), `export default {
      schema: { schemas: [${JSON.stringify(schemaName)}] },
      columnTypes: {
        ${JSON.stringify(`${schemaName}.documents.payload`)}: "{ kind: string }",
        ${JSON.stringify(`${schemaName}.unnest.unnest`)}: "string",
        ${JSON.stringify(`${schemaName}.coalesce.coalesce`)}: "string",
      },
    };`);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, target: "ES2025", module: "ESNext",
        moduleResolution: "bundler", types: ["bun"],
        typeRoots: [join(repoRoot, "node_modules/@types")],
        paths: { "@onreza/sqlx-js": [join(repoRoot, "src/index.ts")] },
      }, include: ["*.ts"],
    }));
    writeFileSync(join(root, "queries.ts"), 'import { defineQuery } from "@onreza/sqlx-js";\n'
      + [filtered, unqualified, nullable, implicitFunction, implicitExpression, outerJoin].map((query, i) => `export const q${i} = defineQuery.one(${JSON.stringify(query)});`).join("\n")
      + [explain, parameterizedExplain, correlatedExplain, ...explains].map((query, i) => `export const e${i} = defineQuery${i === 0 ? ".one" : ""}("explain.${i}", ${JSON.stringify(query)}, { expectedValidation: "parse-only" });`).join("\n"));
  });

  afterAll(async () => {
    try {
      if (client) await client.simpleQuery(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    } finally {
      await client?.end();
      await container?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("strict prepare preserves function narrowing and EXPLAIN contracts without executing ANALYZE", async () => {
    const before = await storedRows();
    expect(before.rows).toEqual([]);
    const prepared = prepare(["--strict-inference"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(await storedRows()).toEqual(before);
    for (const query of [filtered, unqualified]) {
      expect(entry(query).columns[0]).toMatchObject({ name: "values", tsType: "(number)[]", nullable: false });
    }
    expect(entry(nullable).columns[0]).toMatchObject({ tsType: "(number | null)[]", nullable: false });
    expect(entry(outerJoin).columns[0]).toMatchObject({ tsType: "(number | null)[]", nullable: false });
    expect(entry(implicitFunction)).toMatchObject({ paramOids: [23], paramTsTypes: ["number"], paramNullable: [false] });
    expect(entry(implicitExpression)).toMatchObject({ paramOids: [23], paramTsTypes: ["number"], paramNullable: [false] });
    expect(entry(implicitFunction).columns[0]).toMatchObject({ tsType: "number", nullable: false });
    expect(entry(parameterizedExplain)).toMatchObject({
      paramOids: [3802], paramNames: ["payload"], paramNullable: [false],
      paramTsTypes: ['import("@onreza/sqlx-js").SqlxJson<{ kind: string }>'],
    });
    expect(entry(correlatedExplain).paramTsTypes).toEqual(entry(parameterizedExplain).paramTsTypes);
    expect((await client.simpleQuery(`SELECT * FROM ${schemaName}.documents`)).rows).toEqual([]);
    for (const query of [explain, parameterizedExplain, correlatedExplain, ...explains]) {
      const cached = entry(query);
      expect(cached.validation).toBe("parse-only");
      expect(cached.degraded).toBeUndefined();
      expect(cached.columns[0]).toMatchObject({ name: "QUERY PLAN", nullable: false });
    }
    expect(entry(explain).columns[0]?.tsType).toContain('SqlxJson<import("@onreza/sqlx-js").JsonValue>');
    const declarations = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    for (const mode of ["--check", "--offline", "--verify"]) {
      const result = prepare([mode, "--strict-inference"]);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8")).toBe(declarations);
      expect(await storedRows()).toEqual(before);
      expect((await client.simpleQuery(`SELECT * FROM ${schemaName}.documents`)).rows).toEqual([]);
    }

    writeFileSync(join(root, "contracts.ts"), `
      import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";
      import type { SqlxJson } from "@onreza/sqlx-js";
      type Row<Q extends keyof SqlxJsGeneratedRegistry["queries"]> = SqlxJsGeneratedRegistry["queries"][Q]["row"];
      declare const filtered: Row<${JSON.stringify(filtered)}>;
      declare const unqualified: Row<${JSON.stringify(unqualified)}>;
      declare const nullable: Row<${JSON.stringify(nullable)}>;
      declare const explained: Row<${JSON.stringify(explain)}>;
      const values: number[] = filtered.values;
      const simple: number[] = unqualified.values;
      const plan: SqlxJson<unknown> = explained["QUERY PLAN"];
      declare const params: SqlxJsGeneratedRegistry["queries"][${JSON.stringify(parameterizedExplain)}]["params"];
      const payload: SqlxJson<{ kind: string }> = params.payload;
      declare const implicit: SqlxJsGeneratedRegistry["queries"][${JSON.stringify(implicitFunction)}]["params"];
      const numeric: number = implicit[0];
      // @ts-expect-error unfiltered elements can be null
      const required: number[] = nullable.values;
    `);
    const compiled = spawnSync("bun", [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", root], { encoding: "utf8" });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);

    const descriptors: RuntimeQueryDescriptors = JSON.parse(readFileSync(join(root, ".sqlx-js/runtime-descriptors.json"), "utf8"));
    const runtime = createSqlClient(databaseUrl, { temporalApi: Temporal, queryDescriptors: descriptors });
    try {
      expect(await runtime.sql(filtered)).toEqual([{ values: [1] }]);
      expect(await runtime.sql(unqualified)).toEqual([{ values: [1] }]);
      expect(await runtime.sql(nullable)).toEqual([{ values: [1, null] }]);
      expect(await runtime.sql(outerJoin)).toEqual([{ values: [null] }]);
      expect(await runtime.sql(implicitFunction, 1)).toEqual([{ value: 1 }]);
      expect(await runtime.sql(implicitExpression, 1)).toEqual([{ value: 1 }]);
      expect(await runtime.sql(parameterizedExplain, { payload: runtime.sql.json({ kind: "probe" }) })).toHaveLength(1);
      expect(await runtime.sql(correlatedExplain, { payload: runtime.sql.json({ kind: "probe" }) })).toHaveLength(1);
      const documents = await client.simpleQuery(`SELECT payload FROM ${schemaName}.documents`);
      expect(documents.rows).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(documents.rows[0]![0]!))).toEqual({ kind: "probe" });
      for (const query of explains) {
        const rows = await runtime.sql(query);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row["QUERY PLAN"]).not.toBeNull();
      }
      const rows = await runtime.sql(explain);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["QUERY PLAN"]).not.toBeNull();
      expect((await storedRows()).rows).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  test("EXPLAIN still requires source acknowledgment and stale inference requires live regeneration", () => {
    const prepared = prepare(["--strict-inference"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    const source = readFileSync(join(root, "queries.ts"), "utf8");
    try {
      writeFileSync(join(root, "queries.ts"), source.replaceAll('{ expectedValidation: "parse-only" }', '{}'));
      const check = prepare(["--check", "--strict-inference"]);
      expect(check.status).not.toBe(0);
      expect(check.stderr).toContain("parse-only");
    } finally {
      writeFileSync(join(root, "queries.ts"), source);
    }
    const declarations = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    for (const [definition, message] of [
      ['defineQuery.one("utility.show", "SHOW work_mem", { expectedValidation: "parse-only" })', "unsupported statement type"],
      [`defineQuery.one("explain.nullable", ${JSON.stringify(parameterizedExplain)}, { expectedValidation: "parse-only", nullableParams: ["payload"] })`, "maps to a NOT NULL stored target"],
    ]) {
      try {
        writeFileSync(join(root, "queries.ts"), `import { defineQuery } from "@onreza/sqlx-js"; export const rejected = ${definition};`);
        const result = prepare(["--strict-inference"]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(message!);
        expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8")).toBe(declarations);
      } finally {
        writeFileSync(join(root, "queries.ts"), source);
      }
    }
    const path = join(root, ".sqlx-js/cache-manifest.json");
    const manifest = readFileSync(path, "utf8");
    try {
      const stale = JSON.parse(manifest);
      stale.generatorRevision--;
      writeFileSync(path, JSON.stringify(stale));
      for (const mode of ["--check", "--offline"]) {
        const check = prepare([mode, "--strict-inference"]);
        expect(check.status).not.toBe(0);
        expect(check.stderr).toContain("sqlx-js prepare");
      }
    } finally {
      writeFileSync(path, manifest);
    }
  });
}
