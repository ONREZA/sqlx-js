import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Temporal } from "temporal-polyfill";
import { analyzeQuery } from "../src/pg/analyze";
import { SchemaCache } from "../src/pg/schema";
import { PgClient, parseDatabaseUrl } from "../src/pg/wire";
import { fingerprint, type CacheEntry } from "../src/cache";
import { createSqlClient } from "../src/postgres-runtime";
import type { RuntimeQueryDescriptors } from "../src/runtime-descriptors";

const configuredUrl = process.env.SQLX_JS_TEST_DATABASE_URL?.trim();
const available = Boolean(configuredUrl) || spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

if (!available) {
  test.skip("RETURNING integration requires SQLX_JS_TEST_DATABASE_URL or Docker", () => {});
} else {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-returning-"));
  const schemaName = `returning_${process.pid}_${Date.now()}`;
  const otherSchema = `${schemaName}_other`;
  const table = `${schemaName}.probe`;
  const repoRoot = resolve(import.meta.dir, "..");
  const cli = join(repoRoot, "bin/sqlx-js.ts");
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = configuredUrl ?? "";
  let client: PgClient;
  let version = 0;

  const insert = `INSERT INTO ${table} (id, value) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET value = EXCLUDED.value RETURNING WITH (OLD AS previous, NEW AS stored) previous.id AS previous_id, stored.id AS stored_id, previous.value AS previous_value, stored.value AS stored_value`;
  const update = `UPDATE ${table} p SET value = NULL WHERE p.id = $1 AND p.value IS NOT NULL RETURNING WITH (OLD AS previous, NEW AS stored) previous.value AS previous_value, stored.value AS stored_value, p.value AS value`;
  const remove = `DELETE FROM ${table} WHERE id = $1 RETURNING old.id AS old_id, new.id AS new_id, id`;
  const stars = `INSERT INTO ${table} (id, value) VALUES ($1, $2) RETURNING WITH (OLD AS previous, NEW AS stored) previous.*, 1 AS marker, stored.*`;
  const cte = `WITH changed(before_id, before_value, before_payload, before_labels, after_id, after_value, after_payload, after_labels) AS (INSERT INTO ${table} (id, value) VALUES ($1, $2) RETURNING WITH (OLD AS previous, NEW AS stored) previous.*, stored.*) SELECT before_id, after_id, before_payload, after_payload, before_labels, after_labels FROM changed`;
  const legacy = `INSERT INTO ${table} (id, value) VALUES ($1, $2) RETURNING id, value`;

  function prepare(queries: string[], args: string[] = []) {
    writeFileSync(join(root, "queries.ts"), 'import { defineQuery } from "@onreza/sqlx-js";\n'
      + queries.map((query, index) => `export const q${index} = defineQuery(${JSON.stringify(query)});`).join("\n"));
    return spawnSync("bun", [cli, "prepare", "--root", root, ...args], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  }

  function entry(query: string): CacheEntry {
    return JSON.parse(readFileSync(join(root, ".sqlx-js", `${fingerprint(query)}.json`), "utf8"));
  }

  beforeAll(async () => {
    if (!databaseUrl) {
      container = await new PostgreSqlContainer(process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg18")
        .withDatabase("returning_test").withUsername("postgres").withPassword("postgres").start();
      databaseUrl = container.getConnectionUri();
    }
    client = new PgClient(parseDatabaseUrl(databaseUrl));
    await client.connect();
    const result = await client.simpleQuery("SHOW server_version_num");
    version = Number(new TextDecoder().decode(result.rows[0]![0]!));
    await client.simpleQuery(`CREATE SCHEMA ${schemaName}; CREATE TABLE ${table} (
      id integer PRIMARY KEY, value integer,
      payload jsonb NOT NULL DEFAULT '{"kind":"probe"}',
      labels text[] NOT NULL DEFAULT ARRAY['probe']::text[]
    ); INSERT INTO ${table} (id, value) VALUES (1, 1);
    CREATE SCHEMA ${otherSchema};
    CREATE TABLE ${otherSchema}.probe (id integer PRIMARY KEY, value integer);
    INSERT INTO ${otherSchema}.probe VALUES (1, NULL)`);
    writeFileSync(join(root, "package.json"), '{"name":"returning-test","type":"module"}');
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, target: "ES2025", module: "ESNext",
        moduleResolution: "bundler", types: ["bun"],
        typeRoots: [join(repoRoot, "node_modules/@types")],
        paths: { "@onreza/sqlx-js": [join(repoRoot, "src/index.ts")] },
      },
      include: ["*.ts"],
    }));
    writeFileSync(join(root, "sqlx-js.config.ts"), `export default {
      schema: { schemas: [${JSON.stringify(schemaName)}] },
      columnTypes: { ${JSON.stringify(`${schemaName}.probe.payload`)}: "{ kind: string }" }
    };`);
  });

  afterAll(async () => {
    try {
      if (client) await client.simpleQuery(`DROP SCHEMA IF EXISTS ${schemaName}, ${otherSchema} CASCADE`);
    } finally {
      await client?.end();
      await container?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ordinary RETURNING retains contracts with the PostgreSQL 18 parser on every supported server", () => {
    const result = prepare([legacy], ["--strict-inference"]);
    expect(result.status, result.stderr).toBe(0);
    expect(entry(legacy).columns.map((column) => [column.name, column.tsType, column.nullable])).toEqual([
      ["id", "number", false], ["value", "number", true],
    ]);
    expect(entry(legacy).validation).toBe("planned");
  });

  test("RETURNING WITH validates against the target server and preserves generated offline contracts", async () => {
    if (version < 180000) {
      const result = prepare([insert]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("describe failed");
      expect(result.stderr).not.toContain("analyze failed");
      return;
    }
    const queries = [insert, update, remove, cte];
    const before = await client.simpleQuery(`SELECT id, value FROM ${table} ORDER BY id`);
    const result = prepare(queries, ["--strict-inference"]);
    expect(result.status, result.stderr).toBe(0);
    expect(await client.simpleQuery(`SELECT id, value FROM ${table} ORDER BY id`)).toEqual(before);
    for (const [query, nullable] of [
      [insert, [true, false, true, true]],
      [update, [false, true, true]],
      [remove, [false, true, false]],
      [cte, [true, false, true, false, true, false]],
    ] as const) {
      const cached = entry(query);
      expect(cached.validation).toBe("planned");
      expect(cached.degraded).toBeUndefined();
      expect(cached.columns.map((column) => column.nullable)).toEqual([...nullable]);
      expect(cached.paramOids).toEqual(query === remove || query === update ? [23] : [23, 23]);
    }
    expect(entry(cte).columns[2]?.tsType).toContain('SqlxJson<{ kind: string }>');
    expect(entry(cte).columns[3]?.tsType).toBe(entry(cte).columns[2]?.tsType);
    const declarations = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    expect(declarations).toContain('"previous_id": number | null; "stored_id": number');
    expect(declarations).toContain('"previous_value": number; "stored_value": number | null');
    for (const mode of ["--check", "--offline", "--verify"]) {
      const check = prepare(queries, [mode, "--strict-inference"]);
      expect(check.status, check.stderr).toBe(0);
      expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8")).toBe(declarations);
    }

    const manifestPath = join(root, ".sqlx-js/cache-manifest.json");
    const manifest = readFileSync(manifestPath, "utf8");
    const stale = JSON.parse(manifest);
    stale.generatorRevision--;
    try {
      writeFileSync(manifestPath, JSON.stringify(stale));
      const check = prepare(queries, ["--check"]);
      expect(check.status).not.toBe(0);
      expect(check.stderr).toContain("cache manifest is stale");
      expect(check.stderr).toContain("sqlx-js prepare");
    } finally {
      writeFileSync(manifestPath, manifest);
    }

    writeFileSync(join(root, "contracts.ts"), `
      import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";
      type InsertRow = SqlxJsGeneratedRegistry["queries"][${JSON.stringify(insert)}]["row"];
      type UpdateRow = SqlxJsGeneratedRegistry["queries"][${JSON.stringify(update)}]["row"];
      declare const inserted: InsertRow;
      declare const updated: UpdateRow;
      const storedId: number = inserted.stored_id;
      const previousId: number | null = inserted.previous_id;
      const previousValue: number = updated.previous_value;
      // @ts-expect-error the insert path has no previous row
      const requiredPrevious: number = inserted.previous_id;
      // @ts-expect-error UPDATE can replace a narrowed old value with NULL
      const requiredStored: number = updated.stored_value;
    `);
    const compiled = spawnSync("bun", [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", root], { encoding: "utf8" });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);

    const descriptors: RuntimeQueryDescriptors = JSON.parse(readFileSync(join(root, ".sqlx-js/runtime-descriptors.json"), "utf8"));
    const runtime = createSqlClient(databaseUrl, { temporalApi: Temporal, queryDescriptors: descriptors });
    const sql = runtime.sql;
    try {
      expect(await sql(insert, 2, 2)).toEqual([{ previous_id: null, stored_id: 2, previous_value: null, stored_value: 2 }]);
      expect(await sql(insert, 2, 3)).toEqual([{ previous_id: 2, stored_id: 2, previous_value: 2, stored_value: 3 }]);
      expect(await sql(update, 2)).toEqual([{ previous_value: 3, stored_value: null, value: null }]);
      expect(await sql(remove, 2)).toEqual([{ old_id: 2, new_id: null, id: 2 }]);
      const rows = await sql(cte, 3, 4);
      expect(rows[0]).toMatchObject({ before_id: null, after_id: 3, before_payload: null, before_labels: null, after_labels: ["probe"] });
    } finally {
      await runtime.close();
    }
  });

  test("wire metadata and star expansion distinguish OLD and NEW at each output position", async () => {
    if (version < 180000) return;
    const described = await client.describe(stars);
    const schema = new SchemaCache(client);
    const analysis = await analyzeQuery(stars, described.fields, schema);
    expect(described.fields.map((field) => field.name)).toEqual(["id", "value", "payload", "labels", "marker", "id", "value", "payload", "labels"]);
    expect(described.fields.map((field) => field.typeOid)).toEqual([23, 23, 3802, 1009, 23, 23, 23, 3802, 1009]);
    expect(analysis.perColumnNullable).toEqual([true, true, true, true, false, false, true, false, false]);
    expect(analysis.perColumnSources[0]).toEqual([{ schema: schemaName, table: "probe", column: "id" }]);
    expect(analysis.perColumnSources[5]).toEqual(analysis.perColumnSources[0]);
    const result = await client.execKnownParamsText(stars, described.paramOids, ["4", "5"]);
    expect(result.rows[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(new TextDecoder().decode(result.rows[0]![5]!)).toBe("4");
  });

  test("projection scopes preserve the same contract through prepare, PostgreSQL metadata, and execution", async () => {
    const cases = [
      { query: `WITH probe AS (SELECT 7 AS id, 8 AS value) UPDATE ${table} SET value = NULL WHERE id = $1 RETURNING value`, nullable: [true], row: [null], params: ["1"] },
      { query: `WITH changed AS (DELETE FROM ${table} WHERE id = $1 RETURNING *) SELECT p.id, p.value FROM changed AS p(value, id, payload, labels)`, nullable: [true, false], row: [null, "1"], params: ["1"] },
      { query: `WITH changed AS (SELECT p.* FROM ${table} AS p(value, id, payload, labels)) SELECT id, value FROM changed WHERE value = $1`, nullable: [true, false], row: [null, "1"], params: ["1"] },
      { query: `WITH combined AS (SELECT * FROM ${table} UNION ALL SELECT * FROM ${table}) SELECT id, value FROM combined WHERE id = $1`, nullable: [false, true], row: ["1", null], params: ["1"] },
      { query: `SELECT ${table}.id AS missing, ${otherSchema}.probe.id AS present FROM ${table} RIGHT JOIN ${otherSchema}.probe ON false WHERE ${otherSchema}.probe.id = $1`, nullable: [true, false], row: [null, "1"], params: ["1"] },
      { query: `SELECT p.id AS document FROM ${table} AS p(first, second, id, last) WHERE p.id = $1`, nullable: [false], row: ['{"kind": "probe"}'], params: ['{"kind":"probe"}'] },
      ...(version >= 180000 ? [
        { query: `DELETE FROM ${table} WHERE id = $1 RETURNING old.id::integer AS before, new.id::integer AS after`, nullable: [false, true], row: ["1", null], params: ["1"] },
        { query: `UPDATE ${table} AS "p|q" SET value = NULL WHERE "p|q".id = $1 RETURNING old.id AS before, new.value AS after`, nullable: [false, true], row: ["1", null], params: ["1"] },
        { query: `WITH changed AS (INSERT INTO ${table}(id) VALUES ($1) RETURNING old.*, new.*) SELECT p.before_id, p.after_id FROM changed AS p(before_id, before_value, before_payload, before_labels, after_id, after_value, after_payload, after_labels)`, nullable: [true, false], row: [null, "5"], params: ["5"] },
      ] : []),
    ];
    const prepared = prepare(cases.map((item) => item.query), ["--strict-inference"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    for (const item of cases) {
      await client.simpleQuery("BEGIN");
      try {
        await client.simpleQuery(`UPDATE ${table} SET value = NULL`);
        const described = await client.describe(item.query);
        const analysis = await analyzeQuery(item.query, described.fields, new SchemaCache(client));
        expect(analysis.perColumnNullable, item.query).toEqual(item.nullable);
        const cached = entry(item.query);
        expect(cached.columns.map((column) => column.nullable), item.query).toEqual(item.nullable);
        expect(cached.validation).toBe("planned");
        const result = await client.execKnownParamsText(item.query, described.paramOids, item.params);
        expect(result.rows.length).toBeGreaterThan(0);
        expect(result.rows[0]!.map((value) => value === null ? null : new TextDecoder().decode(value)), item.query).toEqual(item.row);
      } finally {
        await client.simpleQuery("ROLLBACK");
      }
    }
    const jsonQuery = entry(cases[5]!.query);
    expect(jsonQuery.paramTsTypes[0]).toContain("SqlxJson<{ kind: string }>");
    expect(jsonQuery.columns[0]?.tsType).toBe(jsonQuery.paramTsTypes[0]!);
  });
}
