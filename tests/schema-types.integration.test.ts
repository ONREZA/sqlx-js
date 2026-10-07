import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { arrayTsType } from "../src/pg/oids";
import { inputTsType, JSON_INPUT_TS, jsonScalarOid } from "../src/pg/input-types";
import { SchemaCache } from "../src/pg/schema";
import { PgClient, decodeText, parseDatabaseUrl } from "../src/pg/wire";

const configuredUrl = process.env.SQLX_JS_TEST_DATABASE_URL?.trim();
const available = Boolean(configuredUrl) || spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

if (!available) {
  test.skip("schema type integration requires SQLX_JS_TEST_DATABASE_URL or Docker", () => {});
} else {
  const schemaName = `schema_types_${process.pid}_${Date.now()}`;
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = configuredUrl ?? "";
  let client: PgClient;
  const types = new Map<string, number>();
  const oid = (name: string) => types.get(name)!;
  const entryInput = `{ body: ${JSON_INPUT_TS} | null; docs: ${arrayTsType(JSON_INPUT_TS, "non-null")} | null; status: "ready" | "done" | null }`;

  beforeAll(async () => {
    if (!databaseUrl) {
      container = await new PostgreSqlContainer(process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg17")
        .withDatabase("schema_types_test").withUsername("postgres").withPassword("postgres").start();
      databaseUrl = container.getConnectionUri();
    }
    client = new PgClient(parseDatabaseUrl(databaseUrl));
    await client.connect();
    await client.simpleQuery(`CREATE SCHEMA ${schemaName};
      CREATE TYPE ${schemaName}.state AS ENUM ('ready', 'done');
      CREATE DOMAIN ${schemaName}.document AS jsonb;
      CREATE DOMAIN ${schemaName}.required_document AS ${schemaName}.document NOT NULL;
      CREATE DOMAIN ${schemaName}.documents AS ${schemaName}.required_document[];
      CREATE TYPE ${schemaName}.entry AS (status ${schemaName}.state, docs ${schemaName}.documents, body ${schemaName}.document);
      CREATE DOMAIN ${schemaName}.entry_domain AS ${schemaName}.entry;
      CREATE DOMAIN ${schemaName}.entries AS ${schemaName}.entry_domain[];
      CREATE TYPE ${schemaName}.envelope AS (entry ${schemaName}.entry_domain, entries ${schemaName}.entries);
      CREATE DOMAIN ${schemaName}.envelope_domain AS ${schemaName}.envelope;
      CREATE DOMAIN ${schemaName}.nested_envelope AS ${schemaName}.envelope_domain;
      CREATE TYPE ${schemaName}.score_range AS RANGE (subtype = numeric);
      CREATE DOMAIN ${schemaName}.score_domain AS ${schemaName}.score_range`);
    const result = await client.simpleQueryAll(`SELECT typname, oid::int8 FROM pg_type WHERE typnamespace = '${schemaName}'::regnamespace ORDER BY oid`);
    for (const row of result.rows) types.set(decodeText(row[0]!)!, Number(decodeText(row[1]!)));
  });

  afterAll(async () => {
    try {
      if (client) await client.simpleQuery(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    } finally {
      await client?.end();
      await container?.stop();
    }
  });

  function assertContracts(schema: SchemaCache) {
    for (const [name, base] of [
      ["document", undefined], ["required_document", "document"], ["documents", "_required_document"],
      ["entry_domain", "entry"], ["entries", "_entry_domain"],
      ["envelope_domain", "envelope"], ["nested_envelope", "envelope_domain"],
    ] as const) {
      expect(schema.customType(oid(name)), name).toMatchObject({ kind: "scalar", baseOid: base ? oid(base) : 3802 });
      expect(schema.tsType(oid(name)), name).toBe(schema.tsType(base ? oid(base) : 3802));
      expect(inputTsType(oid(name), schema), name).toBe(inputTsType(base ? oid(base) : 3802, schema));
      expect(schema.typeIdentity(oid(name))).toEqual({ schema: schemaName, name });
    }
    expect(jsonScalarOid(oid("required_document"), schema)).toBe(3802);
    expect(schema.customType(oid("state"))).toMatchObject({ kind: "enum", values: ["ready", "done"] });
    expect(schema.arrayElement(oid("documents"))).toMatchObject({ typeOid: oid("required_document"), nullability: "non-null" });
    expect(inputTsType(oid("documents"), schema)).toBe(arrayTsType(JSON_INPUT_TS, "non-null"));
    expect(inputTsType(oid("entry_domain"), schema)).toBe(entryInput);
    expect(inputTsType(oid("entries"), schema)).toBe(arrayTsType(entryInput));
    expect(schema.customType(oid("score_domain"))).toMatchObject({ kind: "scalar", baseOid: oid("score_range"), tsType: "unknown" });
  }

  test("batch catalog loading materializes nested domains, composites, and arrays in dependency order", async () => {
    const schema = new SchemaCache(client);
    await schema.loadCustomTypes([...types.values()].reverse());
    assertContracts(schema);
    await schema.loadCustomTypes([...types.values()]);
    assertContracts(schema);
  });

  test("recursive and incremental catalog discovery produce the same input contracts", async () => {
    const schema = new SchemaCache(client);
    for (const name of ["state", "nested_envelope", "score_domain"]) await schema.loadCustomTypes([oid(name)]);
    assertContracts(schema);
  });

  test("custom type assertions survive dependent materialization and domain overrides remain rejected", async () => {
    const schema = new SchemaCache(client);
    schema.setTypeRegistry({}, { state: "AppState" });
    await schema.validateUserTypeRegistry();
    await schema.loadCustomTypes([...types.values()]);
    expect(schema.tsType(oid("state"))).toBe("AppState");
    expect(schema.tsType(oid("_state"))).toBe(arrayTsType("AppState"));
    expect(inputTsType(oid("entry_domain"), schema)).toBe(entryInput.replace('"ready" | "done"', "AppState"));
    const invalid = new SchemaCache(client);
    invalid.setTypeRegistry({}, { document: "ApplicationDocument" });
    await expect(invalid.validateUserTypeRegistry()).rejects.toThrow("cannot override PostgreSQL domain document");
  });

  test("failed catalog discovery can retry instead of retaining an incomplete probe", async () => {
    const retryClient = new PgClient(parseDatabaseUrl(databaseUrl));
    await retryClient.connect();
    const query = retryClient.simpleQueryAll.bind(retryClient);
    try {
      for (const failedQuery of ["FROM pg_attribute a", "FROM pg_enum"]) {
        const schema = new SchemaCache(retryClient);
        const requested = failedQuery === "FROM pg_enum"
          ? [oid("nested_envelope"), oid("score_domain")]
          : [...types.values()];
        retryClient.simpleQueryAll = async (sql) => {
          if (sql.includes(failedQuery)) throw new Error("interrupted type catalog discovery");
          return query(sql);
        };
        await expect(schema.loadCustomTypes(requested)).rejects.toThrow("interrupted type catalog discovery");
        retryClient.simpleQueryAll = query;
        await schema.loadCustomTypes(requested);
        assertContracts(schema);
      }
    } finally {
      await retryClient.end();
    }
  });
}
