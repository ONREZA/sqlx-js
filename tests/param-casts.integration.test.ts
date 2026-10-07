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
  test.skip("parameter casts require SQLX_JS_TEST_DATABASE_URL or Docker", () => {});
} else {
  const root = mkdtempSync("/var/tmp/sqlx-js-param-casts-");
  const schemaName = `param_casts_${process.pid}_${Date.now()}`;
  const table = `${schemaName}.probe`;
  const repoRoot = resolve(import.meta.dir, "..");
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = configuredUrl ?? "";
  let client: PgClient;

  const execute = `UPDATE ${table} SET payload = $payload::text::jsonb WHERE id = 1`;
  const update = `${execute} RETURNING id`;
  const nullable = `UPDATE ${table} SET maybe_payload = $payload::text::jsonb WHERE id = 1 RETURNING id`;
  const predicate = `SELECT id FROM ${table} WHERE payload = $payload::text::jsonb`;
  const insert = `INSERT INTO ${table} (id, payload) VALUES (2, $payload::text::jsonb) RETURNING id`;
  const select = `INSERT INTO ${table} (id, payload) SELECT 3, $payload::text::jsonb RETURNING id`;
  const cte = `WITH changed AS (UPDATE ${table} SET payload = $payload::text::jsonb WHERE id = 1 RETURNING id) SELECT id FROM changed`;
  const conflict = `INSERT INTO ${table} (id, payload) VALUES (1, '{}') ON CONFLICT (id) DO UPDATE SET payload = $payload::text::jsonb RETURNING id`;
  const direct = `UPDATE ${table} SET payload = $payload WHERE id = 1 RETURNING id`;
  const domainText = `UPDATE ${table} SET domain_payload = $payload::text::${schemaName}.document WHERE id = 1 RETURNING id`;
  const domainDirect = `UPDATE ${table} SET domain_payload = $payload::${schemaName}.document WHERE id = 1 RETURNING id`;
  const arrayText = `UPDATE ${table} SET items = $payload::text[]::jsonb[] WHERE id = 1 RETURNING id`;
  const arrayDirect = `UPDATE ${table} SET items = $payload::jsonb[] WHERE id = 1 RETURNING id`;
  const domainArrayCast = `UPDATE ${table} SET document_items = $payload::jsonb[]::${schemaName}.document[] WHERE id = 1 RETURNING id`;
  const arrayDomainDirect = `UPDATE ${table} SET domain_items = $payload::${schemaName}.document_list WHERE id = 1 RETURNING id`;
  const widened = `SELECT small_count AS value FROM ${table} EXCEPT SELECT big_count AS value FROM ${table}`;
  const widenedArray = `SELECT small_counts AS values FROM ${table} EXCEPT SELECT big_counts AS values FROM ${table}`;
  const domainArrayResult = `SELECT document_items, domain_items FROM ${table} WHERE id = 1`;
  const textQueries = [update, nullable, predicate, insert, select, cte, conflict, domainText];
  const queries = [...textQueries, direct, domainDirect, arrayText, arrayDirect,
    domainArrayCast, arrayDomainDirect, widened, widenedArray, domainArrayResult];
  const jsonType = 'import("@onreza/sqlx-js").SqlxJson<{ flag?: boolean }>';

  function prepare(args: string[] = []) {
    return spawnSync("bun", [join(repoRoot, "bin/sqlx-js.ts"), "prepare", "--root", root, ...args], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  }

  function entry(query: string): CacheEntry {
    return JSON.parse(readFileSync(join(root, ".sqlx-js", `${fingerprint(query)}.json`), "utf8"));
  }

  beforeAll(async () => {
    if (!databaseUrl) {
      container = await new PostgreSqlContainer(process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg17")
        .withDatabase("param_casts_test").withUsername("postgres").withPassword("postgres").start();
      databaseUrl = container.getConnectionUri();
    }
    client = new PgClient(parseDatabaseUrl(databaseUrl));
    await client.connect();
    await client.simpleQuery(`CREATE SCHEMA ${schemaName};
      CREATE DOMAIN ${schemaName}.document AS jsonb;
      CREATE DOMAIN ${schemaName}.document_list AS ${schemaName}.document[];
      CREATE TABLE ${table} (
        id integer PRIMARY KEY, payload jsonb NOT NULL, maybe_payload jsonb,
        domain_payload ${schemaName}.document NOT NULL DEFAULT '{}', items jsonb[] NOT NULL DEFAULT '{}',
        document_items ${schemaName}.document[] NOT NULL DEFAULT '{}',
        domain_items ${schemaName}.document_list NOT NULL DEFAULT '{}',
        small_count integer NOT NULL DEFAULT 1, big_count bigint NOT NULL DEFAULT 2,
        small_counts integer[] NOT NULL DEFAULT ARRAY[1], big_counts bigint[] NOT NULL DEFAULT ARRAY[2]
      ); INSERT INTO ${table} (id, payload) VALUES (1, '{}')`);
    writeFileSync(join(root, "package.json"), '{"name":"param-casts-test","type":"module"}');
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, target: "ES2025", module: "ESNext",
        moduleResolution: "bundler", types: ["bun"],
        typeRoots: [join(repoRoot, "node_modules/@types")],
        paths: { "@onreza/sqlx-js": [join(repoRoot, "src/index.ts")] },
      }, include: ["*.ts"],
    }));
    writeFileSync(join(root, "sqlx-js.config.ts"), `export default {
      schema: { schemas: [${JSON.stringify(schemaName)}] },
      columnTypes: {
        ${["payload", "maybe_payload", "domain_payload", "items", "document_items", "domain_items"].map((column) =>
          `${JSON.stringify(`${table}.${column}`)}: "{ flag?: boolean }"`).join(",\n")},
        ${JSON.stringify(`${table}.small_count`)}: "number & { readonly __brand: 'SmallCount' }"
      },
      arrayElementNullability: { ${JSON.stringify(`${table}.small_counts`)}: "non-null" },
    };`);
    writeFileSync(join(root, "queries.ts"), 'import { defineQuery } from "@onreza/sqlx-js";\n'
      + `export const probeUpdate = defineQuery.execute("probe.update", ${JSON.stringify(execute)});\n`
      + queries.map((query, index) => `export const q${index} = defineQuery(${JSON.stringify(query)});`).join("\n"));
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

  test("column assertions preserve the server input representation through casts", async () => {
    const before = await client.simpleQuery(`SELECT * FROM ${table}`);
    const prepared = prepare(["--strict-inference"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(await client.simpleQuery(`SELECT * FROM ${table}`)).toEqual(before);
    for (const query of [execute, ...textQueries]) {
      expect(entry(query), query).toMatchObject({
        paramOids: [25], paramNames: ["payload"], paramTsTypes: ["string"],
        paramNullable: [query === nullable], validation: "planned",
      });
    }
    expect(entry(direct)).toMatchObject({ paramOids: [3802], paramTsTypes: [jsonType], paramNullable: [false] });
    expect(entry(domainDirect)).toMatchObject({
      paramOids: [0], paramTypeIdentities: [{ schema: schemaName, name: "document" }], paramTsTypes: [jsonType],
    });
    expect(entry(arrayText)).toMatchObject({
      paramOids: [1009], paramTsTypes: ['import("@onreza/sqlx-js").PgArrayParameter<string, boolean>'],
    });
    expect(entry(arrayDirect)).toMatchObject({
      paramOids: [3807], paramTsTypes: [`import("@onreza/sqlx-js").PgArrayParameter<${jsonType}, boolean>`],
    });
    expect(entry(domainArrayCast)).toMatchObject({
      paramOids: [3807], paramTsTypes: [`import("@onreza/sqlx-js").PgArrayParameter<${jsonType}, boolean>`],
    });
    expect(entry(arrayDomainDirect)).toMatchObject({
      paramOids: [0], paramTypeIdentities: [{ schema: schemaName, name: "document_list" }],
      paramTsTypes: [`import("@onreza/sqlx-js").PgArrayParameter<${jsonType}, boolean>`],
    });
    expect(entry(widened).columns).toEqual([{ name: "value", typeOid: 20, tsType: "bigint", nullable: false }]);
    expect(entry(widenedArray).columns).toEqual([{ name: "values", typeOid: 1016, tsType: "(bigint | null)[]", nullable: false }]);
    expect(entry(domainArrayResult).columns.map((column) => column.tsType)).toEqual([
      `(${jsonType} | null)[]`, `(${jsonType} | null)[]`,
    ]);
    const declarations = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    for (const mode of ["--check", "--offline", "--verify"]) {
      const result = prepare([mode, "--strict-inference"]);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8")).toBe(declarations);
    }

    writeFileSync(join(root, "contracts.ts"), `
      import type { SqlExecutor } from "@onreza/sqlx-js";
      import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";
      import { probeUpdate } from "./queries";
      declare const sql: SqlExecutor<SqlxJsGeneratedRegistry>;
      probeUpdate.run(sql, { payload: '{"outside":"asserted shape"}' });
      sql.execute(${JSON.stringify(execute)}, { payload: '{"outside":"asserted shape"}' });
      ${textQueries.map((query) => `sql(${JSON.stringify(query)}, { payload: '{"outside":"asserted shape"}' });`).join("\n")}
      sql(${JSON.stringify(nullable)}, { payload: null });
      sql(${JSON.stringify(direct)}, { payload: sql.json({ flag: true }) });
      sql(${JSON.stringify(domainDirect)}, { payload: sql.json({ flag: false }) });
      sql(${JSON.stringify(arrayText)}, { payload: sql.array(['{"outside":1}', null]) });
      sql(${JSON.stringify(arrayDirect)}, { payload: sql.array([sql.json({ flag: true }), null]) });
      sql(${JSON.stringify(domainArrayCast)}, { payload: sql.array([sql.json({ flag: true }), null]) });
      sql(${JSON.stringify(arrayDomainDirect)}, { payload: sql.array([sql.json({ flag: false }), null]) });
      type Widened = SqlxJsGeneratedRegistry["queries"][${JSON.stringify(widened)}]["row"];
      type WidenedArray = SqlxJsGeneratedRegistry["queries"][${JSON.stringify(widenedArray)}]["row"];
      declare const widened: Widened;
      declare const widenedArray: WidenedArray;
      const count: bigint = widened.value;
      const counts: (bigint | null)[] = widenedArray.values;
      // @ts-expect-error EXCEPT resolves integer and bigint to bigint
      const smallCount: number = widened.value;
      // @ts-expect-error integer-array assertions do not prove bigint-array element nullability
      const requiredCounts: bigint[] = widenedArray.values;
      // @ts-expect-error text input accepts strings, not bare objects
      sql(${JSON.stringify(update)}, { payload: { flag: true } });
      // @ts-expect-error reusable execute definitions require the text wire input
      probeUpdate.run(sql, { payload: { flag: true } });
      // @ts-expect-error the NOT NULL DML target rejects SQL NULL
      sql(${JSON.stringify(update)}, { payload: null });
      // @ts-expect-error direct JSONB input requires sql.json
      sql(${JSON.stringify(direct)}, { payload: { flag: true } });
      // @ts-expect-error direct JSONB input retains the configured object shape
      sql(${JSON.stringify(direct)}, { payload: sql.json({ outside: 1 }) });
      // @ts-expect-error a text array cast requires text elements
      sql(${JSON.stringify(arrayText)}, { payload: sql.array([sql.json({ flag: true })]) });
      // @ts-expect-error domain-of-array inputs still require explicit JSON elements
      sql(${JSON.stringify(arrayDomainDirect)}, { payload: sql.array([{ flag: true }]) });
    `);
    const compiled = spawnSync("bun", [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", root], { encoding: "utf8" });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);

    const descriptors: RuntimeQueryDescriptors = JSON.parse(readFileSync(join(root, ".sqlx-js/runtime-descriptors.json"), "utf8"));
    const runtime = createSqlClient(databaseUrl, { temporalApi: Temporal, queryDescriptors: descriptors });
    const sql = runtime.sql;
    try {
      expect(await sql(widened)).toEqual([{ value: 1n }]);
      expect(await sql(widenedArray)).toEqual([{ values: [1n] }]);
      expect(await sql.execute(execute, { payload: '{"outside":"asserted shape"}' })).toEqual({ rowCount: 1, command: "UPDATE" });
      expect(await sql(update, { payload: '{"outside":"asserted shape"}' })).toEqual([{ id: 1 }]);
      expect(await sql(predicate, { payload: '{"outside":"asserted shape"}' })).toEqual([{ id: 1 }]);
      for (const query of [insert, select, cte, conflict]) {
        expect(await sql(query, { payload: '{"outside":"asserted shape"}' })).toHaveLength(1);
      }
      expect(await sql(nullable, { payload: null })).toEqual([{ id: 1 }]);
      await sql(domainText, { payload: '{"outside":"domain shape"}' });
      await sql(arrayText, { payload: sql.array(['{"outside":"array shape"}', null]) });
      const stored = await client.simpleQuery(`SELECT payload, maybe_payload, domain_payload, items[1], items[2] FROM ${table} WHERE id = 1`);
      expect(stored.rows[0]![1]).toBeNull();
      expect(stored.rows[0]![4]).toBeNull();
      const cells = stored.rows[0]!.map((cell) => cell === null ? null : JSON.parse(new TextDecoder().decode(cell)));
      expect(cells).toEqual([{ outside: "asserted shape" }, null, { outside: "domain shape" }, { outside: "array shape" }, null]);
      await sql(direct, { payload: sql.json({ flag: true }) });
      await sql(domainDirect, { payload: sql.json({ flag: false }) });
      await sql(arrayDirect, { payload: sql.array([sql.json({ flag: true }), null]) });
      const directStored = await client.simpleQuery(`SELECT payload, domain_payload, items[1], items[2] FROM ${table} WHERE id = 1`);
      expect(directStored.rows[0]!.map((cell) => cell === null ? null : JSON.parse(new TextDecoder().decode(cell))))
        .toEqual([{ flag: true }, { flag: false }, { flag: true }, null]);
      await sql(domainArrayCast, { payload: sql.array([sql.json({ flag: true }), null]) });
      await sql(arrayDomainDirect, { payload: sql.array([sql.json({ flag: false }), null]) });
      expect(await sql(domainArrayResult)).toEqual([{
        document_items: [sql.json({ flag: true }), null], domain_items: [sql.json({ flag: false }), null],
      }]);
      const domainArrays = await client.simpleQuery(`SELECT document_items[1], document_items[2], domain_items[1], domain_items[2] FROM ${table} WHERE id = 1`);
      expect(domainArrays.rows[0]![1]).toBeNull();
      expect(domainArrays.rows[0]![3]).toBeNull();
      expect(domainArrays.rows[0]!.map((cell) => cell === null ? null : JSON.parse(new TextDecoder().decode(cell))))
        .toEqual([{ flag: true }, null, { flag: false }, null]);
    } finally {
      await runtime.close();
    }
  });
}
