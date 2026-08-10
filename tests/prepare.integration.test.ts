import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { decodeText, PgClient, parseDatabaseUrl } from "../src/pg/wire";
import { validateAll } from "../src/commands/prepare";
import { inputTsType } from "../src/pg/input-types";
import { SchemaCache, compositeLiteral } from "../src/pg/schema";
import { mergeExtensionTypes } from "../src/pg/extensions";
import { fingerprint, readCacheManifest } from "../src/cache";
import { createSqlClient as createRuntimeSqlClient, type PostgresClient } from "../src/postgres-runtime";
import { array, json, QueryTimeoutError, ResultDecodeError, type OnQueryEvent } from "../src/runtime";
import { JsonNumber, SqlxJson } from "../src/json-value";
import { queryId } from "../src/query-id";
import type { RuntimeQueryDescriptors } from "../src/runtime-descriptors";
import { Temporal } from "temporal-polyfill";
import { inspectJsonAudit } from "../src/commands/json-audit";
import {
  renderCanonicalJsonbNumberAnalysis,
  renderCanonicalJsonNumberAnalysis,
} from "../src/commands/json-audit-number";
import { canonicalJsonNumberBytes, JSON_NUMBER_LIMITS } from "../src/json-number";

const repoRoot = resolve(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "sqlx-js-integration-"));
const IMAGE = process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg17";
const configuredDbUrl = process.env.SQLX_JS_TEST_DATABASE_URL?.trim() || undefined;

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { encoding: "utf8" });
  return r.status === 0;
}

const haveIntegrationDatabase = Boolean(configuredDbUrl) || dockerAvailable();

if (!haveIntegrationDatabase) {
  test.skip("integration suite requires SQLX_JS_TEST_DATABASE_URL or Docker", () => {});
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
} else {
  let container: StartedPostgreSqlContainer | undefined;
  let dbUrl = configuredDbUrl ?? "";

  function writeFile(rel: string, content: string) {
    const full = join(tmp, rel);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  function writeRootFile(root: string, rel: string, content: string) {
    const full = join(root, rel);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  function isolatedRoot(name: string): string {
    const root = join(tmp, name);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeRootFile(root, "package.json", `{"name":"${name}","type":"module"}`);
    return root;
  }

  function queryCacheFiles(root = tmp): string[] {
    return readdirSync(join(root, ".sqlx-js")).filter((name) => /^[0-9a-f]{16}\.json$/.test(name));
  }

  function prepare(args: string[] = []): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), "prepare", "--root", tmp, ...args],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
    );
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function prepareRoot(root: string, args: string[] = []): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), "prepare", "--root", root, ...args],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
    );
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function migrate(): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), "migrate", "run", "--root", tmp],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
    );
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function migrateCommand(args: string[], root = tmp, databaseUrl = dbUrl): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), "migrate", ...args, "--root", root],
      { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" },
    );
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function workflowCommand(
    command: "dev" | "verify",
    root = tmp,
    databaseUrl = dbUrl,
    args: string[] = [],
  ): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), command, ...args, "--root", root],
      { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" },
    );
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function databaseUrlWithDatabase(databaseUrl: string, database: string): string {
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    return url.toString();
  }

  function quoteIdent(ident: string): string {
    return `"${ident.replace(/"/g, '""')}"`;
  }

  async function createShadowDatabase(name: string): Promise<string> {
    const admin = new PgClient(parseDatabaseUrl(databaseUrlWithDatabase(dbUrl, "postgres")));
    await admin.connect();
    try {
      await admin.simpleQuery(`CREATE DATABASE ${quoteIdent(name)}`);
    } finally {
      await admin.end();
    }
    return databaseUrlWithDatabase(dbUrl, name);
  }

  async function dropDatabase(databaseUrl: string): Promise<void> {
    const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    const admin = new PgClient(parseDatabaseUrl(databaseUrlWithDatabase(dbUrl, "postgres")));
    await admin.connect();
    try {
      await admin.simpleQuery(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`);
    } finally {
      await admin.end();
    }
  }

  function snapshot(
    args: string[] = [],
    root = tmp,
  ): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), "snapshot", ...args, "--root", root],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
    );
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function doctor(args: string[] = []): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), "doctor", "--root", tmp, ...args],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
    );
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function resetWorkspace() {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    writeFile("package.json", '{"name":"tmp-integration","type":"module"}');
    writeFile("migrations/0001_init.up.sql",
      "CREATE TABLE IF NOT EXISTS tmp_users (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  name TEXT NOT NULL,\n" +
      "  email TEXT NOT NULL\n" +
      ");\n" +
      "CREATE TABLE IF NOT EXISTS tmp_join_users (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  external_id TEXT\n" +
      ");\n" +
      "CREATE TABLE IF NOT EXISTS tmp_join_posts (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  user_external_id TEXT,\n" +
      "  title TEXT NOT NULL\n" +
      ");\n" +
      "CREATE TABLE IF NOT EXISTS tmp_narrow_values (\n" +
      "  a TEXT,\n" +
      "  b TEXT\n" +
      ");\n",
    );
    writeFile("migrations/0001_init.down.sql",
      "DROP TABLE IF EXISTS tmp_narrow_values;\n" +
      "DROP TABLE IF EXISTS tmp_join_posts;\n" +
      "DROP TABLE IF EXISTS tmp_join_users;\n" +
      "DROP TABLE IF EXISTS tmp_users;\n",
    );
  }

  beforeAll(async () => {
    if (!configuredDbUrl) {
      container = await new PostgreSqlContainer(IMAGE)
        .withDatabase("sqlx_js_it")
        .withUsername("postgres")
        .withPassword("postgres")
        .start();
      dbUrl = `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/sqlx_js_it`;
    }

    resetWorkspace();
    const r = migrate();
    if (r.code !== 0) throw new Error(`integration migrate failed: ${r.stderr}\n${r.stdout}`);
  });

  afterAll(async () => {
    rmSync(tmp, { recursive: true, force: true });
    if (container) await container.stop();
  });

  test("prepare emits file:line:column on PG describe error", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT * FROM totally_made_up_relation\");\n",
    );
    const r = prepare();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/a\.ts:2:11/);
    expect(r.stderr).toMatch(/describe failed/);
    expect(r.stderr).toMatch(/relation .* does not exist/i);
  });

  test("live prepare validates every configured column assertion", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP TABLE IF EXISTS tmp_config_assertions;
        CREATE TABLE tmp_config_assertions (
          payload jsonb,
          labels text[],
          state text
        )
      `);
    } finally {
      await setup.end();
    }

    const root = isolatedRoot("config-assertions");
    writeRootFile(root, "a.ts", 'import { sql } from "@onreza/sqlx-js";\nawait sql("SELECT 1 AS value");\n');
    writeRootFile(root, "sqlx-js.config.ts", `export default {
      columnTypes: {
        "public.tmp_config_assertions.missing": "MissingPayload",
        "public.tmp_config_assertions.state": '"ready" | "done"',
      },
      arrayElementNullability: { "public.tmp_config_assertions.labels": "non-null" },
    };\n`);

    const result = prepareRoot(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sqlx-js.config.ts columnTypes.public.tmp_config_assertions.missing");
    expect(result.stderr).toContain("does not resolve to a PostgreSQL column");

    const diagnosis = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), "doctor", "--root", root, "--json"],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
    );
    const report = JSON.parse(diagnosis.stdout) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    expect(report.checks.find((check) => check.name === "columnAssertions")).toMatchObject({
      status: "error",
      message: expect.stringContaining("columnTypes.public.tmp_config_assertions.missing"),
    });

    const invalidShapes = [
      {
        config: 'columnTypes: { "public.tmp_config_assertions.labels": "Labels" }',
        message: "does not support non-JSON PostgreSQL array columns",
      },
      {
        config: 'arrayElementNullability: { "public.tmp_config_assertions.state": "non-null" }',
        message: "must reference a PostgreSQL array column",
      },
    ];
    for (const invalid of invalidShapes) {
      writeRootFile(root, "sqlx-js.config.ts", `export default { ${invalid.config} };\n`);
      const shapeResult = prepareRoot(root);
      expect(shapeResult.code).toBe(1);
      expect(shapeResult.stderr).toContain(invalid.message);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("unqualified column assertions reject cross-schema ambiguity", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    const root = isolatedRoot("config-assertion-ambiguity");
    try {
      await setup.simpleQuery(`
        DROP SCHEMA IF EXISTS tmp_assertion_a CASCADE;
        DROP SCHEMA IF EXISTS tmp_assertion_b CASCADE;
        CREATE SCHEMA tmp_assertion_a;
        CREATE SCHEMA tmp_assertion_b;
        CREATE TABLE tmp_assertion_a.shared_state (value text);
        CREATE TABLE tmp_assertion_b.shared_state (value text)
      `);
      writeRootFile(root, "a.ts", 'import { sql } from "@onreza/sqlx-js";\nawait sql("SELECT 1 AS value");\n');
      writeRootFile(root, "sqlx-js.config.ts", `export default {
        columnTypes: { "shared_state.value": '"ready" | "done"' },
      };\n`);

      const result = prepareRoot(root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("columnTypes.shared_state.value is ambiguous across");
      expect(result.stderr).toContain("tmp_assertion_a.shared_state.value");
      expect(result.stderr).toContain("tmp_assertion_b.shared_state.value");
    } finally {
      await setup.simpleQuery(`
        DROP SCHEMA IF EXISTS tmp_assertion_a CASCADE;
        DROP SCHEMA IF EXISTS tmp_assertion_b CASCADE
      `).catch(() => {});
      await setup.end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("column assertions reject shadowed duplicate keys", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    const root = isolatedRoot("config-assertion-duplicates");
    try {
      await setup.simpleQuery(`
        DROP TABLE IF EXISTS tmp_assertion_duplicate;
        CREATE TABLE tmp_assertion_duplicate (value text)
      `);
      writeRootFile(root, "a.ts", 'import { sql } from "@onreza/sqlx-js";\nawait sql("SELECT 1 AS value");\n');
      writeRootFile(root, "sqlx-js.config.ts", `export default {
        columnTypes: {
          "tmp_assertion_duplicate.value": '"ready" | "done"',
          "public.tmp_assertion_duplicate.value": '"ready" | "done"',
        },
      };\n`);

      const result = prepareRoot(root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("columnTypes.tmp_assertion_duplicate.value duplicates");
      expect(result.stderr).toContain("columnTypes.public.tmp_assertion_duplicate.value");
    } finally {
      await setup.simpleQuery("DROP TABLE IF EXISTS tmp_assertion_duplicate").catch(() => {});
      await setup.end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("focused prepare preserves reusable contracts and marks artifacts incomplete", () => {
    const root = isolatedRoot("focused-prepare");
    writeRootFile(root, "a.ts", 'import { sql } from "@onreza/sqlx-js";\nawait sql("SELECT 1::int AS retained");\n');
    writeRootFile(root, "b.ts", 'import { sql } from "@onreza/sqlx-js";\nawait sql("SELECT 2::int AS existing");\n');
    const initial = prepareRoot(root);
    expect(initial.code, initial.stderr).toBe(0);

    writeRootFile(root, "b.ts", 'import { sql } from "@onreza/sqlx-js";\nawait sql("SELECT * FROM missing_focused_relation");\n');
    writeRootFile(root, "c.ts", 'import { defineQuery } from "@onreza/sqlx-js";\nexport const selected = defineQuery("focus.selected", "SELECT 3::int AS selected");\n');
    const focused = prepareRoot(root, ["--include", "c.ts", "--json"]);
    expect(focused.code, focused.stderr).toBe(0);
    const payload = JSON.parse(focused.stdout) as {
      artifactState: string;
      projectSites: number;
      selectedSites: number;
      omittedSites: number;
      omittedContracts: number;
    };
    expect(payload).toMatchObject({
      artifactState: "incomplete",
      projectSites: 3,
      selectedSites: 1,
      omittedSites: 1,
      omittedContracts: 1,
    });
    const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("SELECT 1::int AS retained");
    expect(dts).toContain("SELECT 3::int AS selected");
    expect(dts).not.toContain("missing_focused_relation");
    expect(readCacheManifest(join(root, ".sqlx-js"))?.complete).toBe(false);

    const repeated = prepareRoot(root, ["--query", "focus.selected", "--json"]);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      artifactState: "incomplete",
      selectedSites: 1,
    });

    const byId = prepareRoot(root, ["--query", queryId("SELECT 3::int AS selected"), "--json"]);
    expect(byId.code, byId.stderr).toBe(0);
    expect(JSON.parse(byId.stdout)).toMatchObject({
      artifactState: "incomplete",
      selectedSites: 1,
    });

    const incompleteCheck = prepareRoot(root, ["--check", "--json"]);
    expect(incompleteCheck.code).toBe(1);
    expect(incompleteCheck.stdout).toContain("incomplete after focused prepare");

    writeRootFile(root, "b.ts", 'import { sql } from "@onreza/sqlx-js";\nawait sql("SELECT 2::int AS existing");\n');
    const completed = prepareRoot(root);
    expect(completed.code, completed.stderr).toBe(0);
    expect(readCacheManifest(join(root, ".sqlx-js"))?.complete).toBe(true);
    const completedCheck = prepareRoot(root, ["--check"]);
    expect(completedCheck.code, completedCheck.stderr).toBe(0);

    rmSync(join(root, ".sqlx-js", "functions", "functions.json"));
    const missingCatalog = prepareRoot(root, ["--include", "a.ts"]);
    expect(missingCatalog.code).toBe(1);
    expect(missingCatalog.stderr).toContain("function catalog cache is missing");
    rmSync(root, { recursive: true, force: true });
  });

  test("prepare succeeds for a valid query and emits .d.ts and cache", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id, name FROM tmp_users WHERE id = $1\", 1);\n",
    );
    const r = prepare(["--verbose"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.ts:2:11/);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("interface SqlxJsGeneratedQueries");
    expect(dts).toContain("SELECT id, name FROM tmp_users WHERE id = $1");
    expect(queryCacheFiles().length).toBeGreaterThan(0);
  });

  test("Temporal types and policy are coupled to runtime descriptors", () => {
    const root = isolatedRoot("temporal-reject");
    try {
      writeRootFile(root, "sqlx-js.config.ts", `export default {
        temporal: { infinity: "reject" },
      };\n`);
      writeRootFile(root, "queries.ts", `
        import { defineQuery } from "@onreza/sqlx-js";
        export const at = defineQuery.one(
          "SELECT $1::timestamptz AS value, $2::timestamptz[] AS values",
        );
      `);

      const prepared = prepareRoot(root);
      expect(prepared.code, prepared.stderr).toBe(0);
      const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
      expect(dts).toContain(
        '"SELECT $1::timestamptz AS value, $2::timestamptz[] AS values": '
        + '{ params: [import("@onreza/sqlx-js").PgTimestamptz<TemporalProvider>, '
        + 'import("@onreza/sqlx-js").PgArrayParameter<import("@onreza/sqlx-js").PgTimestamptz<TemporalProvider>, boolean>]; '
        + 'row: { "value": import("@onreza/sqlx-js").PgTimestamptz<TemporalProvider> | null; '
        + '"values": (import("@onreza/sqlx-js").PgTimestamptz<TemporalProvider> | null)[] | null } }',
      );
      expect(dts).toContain('temporal: { readonly infinity: "reject"; readonly timestampWithoutTimeZone: "reject"; readonly sessionTimeZone: "UTC" };');
      const descriptors = JSON.parse(
        readFileSync(join(root, ".sqlx-js/runtime-descriptors.json"), "utf8"),
      ) as RuntimeQueryDescriptors;
      expect(descriptors.temporal).toEqual({
        infinity: "reject",
        timestampWithoutTimeZone: "reject",
        sessionTimeZone: "UTC",
      });
      expect(descriptors.queries[
        fingerprint("SELECT $1::timestamptz AS value, $2::timestamptz[] AS values")
      ]).toEqual({ params: [1184, 1185] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("timestamp without time zone requires a source-local named exception", () => {
    const query = "SELECT $1::timestamp AS value";
    writeFile("a.ts", `
      import { sql } from "@onreza/sqlx-js";
      await sql(${JSON.stringify(query)}, {} as never);
    `);
    const rejected = prepare();
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("temporal failed");
    expect(rejected.stderr).toContain("timestamp without time zone");

    writeFile("a.ts", `
      import { defineQuery } from "@onreza/sqlx-js";
      export const wallClock = defineQuery.one(
        "schedule.readWallClock",
        ${JSON.stringify(query)},
        { temporal: { timestampWithoutTimeZone: { allow: true, reason: "Civil schedule time" } } },
      );
    `);
    const allowed = prepare();
    expect(allowed.code, allowed.stderr).toBe(0);

    writeFile("b.ts", `
      import { sql } from "@onreza/sqlx-js";
      await sql(${JSON.stringify(query)}, {} as never);
    `);
    const mixed = prepare();
    expect(mixed.code).not.toBe(0);
    expect(mixed.stderr).toMatch(/b\.ts:\d+:\d+/);
    expect(mixed.stderr).toContain("temporal failed");
  });

  test("timestamp policy detects PostgreSQL container types", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP TYPE IF EXISTS tmp_wall_record CASCADE;
        DROP TYPE IF EXISTS tmp_wall_nested CASCADE;
        DROP TYPE IF EXISTS tmp_wall_custom_range CASCADE;
        DROP TABLE IF EXISTS tmp_wall_target CASCADE;
        DROP DOMAIN IF EXISTS tmp_wall_range_domain CASCADE;
        DROP DOMAIN IF EXISTS tmp_wall_domain CASCADE;
        CREATE DOMAIN tmp_wall_domain AS timestamp;
        CREATE DOMAIN tmp_wall_range_domain AS tsrange;
        CREATE TYPE tmp_wall_custom_range AS RANGE (
          subtype = timestamp,
          multirange_type_name = tmp_wall_custom_multirange
        );
        CREATE TYPE tmp_wall_record AS (at tmp_wall_domain);
        CREATE TYPE tmp_wall_nested AS (records tmp_wall_record[], span tmp_wall_range_domain);
        CREATE TABLE tmp_wall_target (at timestamp);
      `);
    } finally {
      await setup.end();
    }
    writeFile("a.ts", `
      import { sql } from "@onreza/sqlx-js";
      await sql("SELECT $1::timestamp[]", {} as never);
      await sql("SELECT $1::tsrange", {} as never);
      await sql("SELECT $1::tsmultirange", {} as never);
      await sql("SELECT $1::tmp_wall_domain", {} as never);
      await sql("SELECT $1::tmp_wall_record", {} as never);
      await sql("SELECT $1::tmp_wall_range_domain", {} as never);
      await sql("SELECT $1::tmp_wall_nested", {} as never);
      await sql("SELECT $1::tmp_wall_custom_range", {} as never);
      await sql("SELECT $1::tmp_wall_custom_multirange", {} as never);
      await sql("SELECT $1::tmp_wall_custom_range[]", {} as never);
      await sql("INSERT INTO tmp_wall_target (at) VALUES ($1::text::timestamp)", {} as never);
    `);
    writeFile("b.ts", "");
    const result = prepare();
    expect(result.code).not.toBe(0);
    expect(result.stderr.match(/temporal failed/g)).toHaveLength(11);
  });

  test("known parameter OIDs execute through the extended protocol", async () => {
    const client = new PgClient(parseDatabaseUrl(dbUrl));
    await client.connect();
    try {
      const result = await client.execKnownParamsText(
        "SELECT $1::int4 AS value",
        [23],
        ["42"],
      );
      const value = result.rows[0]?.[0];
      if (!value) throw new Error("expected one non-null value");
      expect(new TextDecoder().decode(value)).toBe("42");
      expect(result.fields[0]?.typeOid).toBe(23);
    } finally {
      await client.end();
    }
  });

  test("PostgreSQL json, jsonb, and jsonb arrays use the Extended JSON protocol", async () => {
    const runtime = createRuntimeSqlClient(dbUrl, { temporalApi: Temporal });
    const payload = json({
      id: 9_007_199_254_740_993n,
      amount: JsonNumber.from("12345678901234567890.125"),
      occurredAt: Temporal.Instant.from("2026-08-04T10:15:30.123456789Z"),
      collision: { $sqlx: "application" },
    });
    try {
      const rows = await runtime.unsafe(
        "SELECT $1::json AS raw, $2::jsonb AS binary, $3::jsonb[] AS items",
        payload,
        payload,
        array([payload, null]),
      ) as Array<{ raw: SqlxJson; binary: SqlxJson; items: Array<SqlxJson | null> }>;
      const row = rows[0]!;

      expect(row.raw).toBeInstanceOf(SqlxJson);
      expect(row.binary).toBeInstanceOf(SqlxJson);
      expect(row.raw.value).toEqual(payload.value);
      expect(row.binary.value).toEqual(payload.value);
      expect(row.items[0]?.value).toEqual(payload.value);
      expect(row.items[1]).toBeNull();
      expect(String((row.binary.value as { occurredAt: unknown }).occurredAt))
        .toBe("2026-08-04T10:15:30.123456789Z");

      const legacy = await runtime.unsafe(
        `SELECT '{"safe":1,"large":9007199254740993}'::jsonb AS payload`,
      ) as Array<{ payload: SqlxJson<{ safe: number; large: JsonNumber }> }>;
      expect(legacy[0]?.payload.value.large).toEqual(JsonNumber.from("9007199254740993"));

      const invalidTagError = await runtime.unsafe(
        `SELECT '{"$sqlx":{"type":"future","v":1},"value":1}'::jsonb AS payload`,
      ).catch((error) => error);
      expect(invalidTagError).toBeInstanceOf(ResultDecodeError);
      expect(invalidTagError).toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining('unknown Extended JSON tag type "future"'),
        }),
      });
      await expect(runtime.unsafe("SELECT $1::jsonb", 1)).rejects.toThrow(
        "PostgreSQL JSON values require a SqlxJson document",
      );
      await expect(runtime.unsafe(
        "SELECT $1::jsonb[]",
        array([payload, "raw"]),
      )).rejects.toThrow("PostgreSQL JSON arrays must contain only SqlxJson documents or null");
    } finally {
      await runtime.close();
    }
  });

  test("Extended JSON audit inventories collisions, duplicate keys, and dependent usage", async () => {
    const root = isolatedRoot("extended-json-audit");
    writeRootFile(root, "tsconfig.json", JSON.stringify({ include: ["app.ts"] }));
    writeRootFile(
      root,
      "app.ts",
      'import { sql } from "@onreza/sqlx-js";\n'
      + 'await sql("SELECT document->>\'kind\' FROM tmp_extended_json_audit");\n',
    );
    const client = new PgClient(parseDatabaseUrl(dbUrl));
    await client.connect();
    try {
      await client.simpleQuery(`
        DROP VIEW IF EXISTS tmp_extended_json_audit_view;
        DROP TABLE IF EXISTS tmp_extended_json_audit_child;
        DROP TABLE IF EXISTS tmp_extended_json_audit_parent;
        DROP TABLE IF EXISTS tmp_extended_json_audit;
        DROP TYPE IF EXISTS tmp_extended_json_audit_record CASCADE;
        DROP DOMAIN IF EXISTS tmp_extended_json_audit_domain CASCADE;
        CREATE DOMAIN tmp_extended_json_audit_domain AS jsonb;
        CREATE TYPE tmp_extended_json_audit_record AS (
          payload tmp_extended_json_audit_domain,
          raw_items json[]
        );
        CREATE TABLE tmp_extended_json_audit (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          raw json NOT NULL,
          document jsonb NOT NULL,
          domain_document tmp_extended_json_audit_domain,
          documents jsonb[],
          records tmp_extended_json_audit_record[],
          kind text GENERATED ALWAYS AS (document ->> 'kind') STORED
        );
        CREATE INDEX tmp_extended_json_audit_kind_idx
          ON tmp_extended_json_audit ((document ->> 'kind'));
        CREATE INDEX tmp_extended_json_audit_domain_kind_idx
          ON tmp_extended_json_audit (((domain_document::jsonb) ->> 'kind'));
        CREATE VIEW tmp_extended_json_audit_view AS
          SELECT document ->> 'kind' AS kind FROM tmp_extended_json_audit;
        CREATE TABLE tmp_extended_json_audit_parent (payload json);
        CREATE TABLE tmp_extended_json_audit_child ()
          INHERITS (tmp_extended_json_audit_parent);
        INSERT INTO tmp_extended_json_audit_child (payload)
          VALUES ('{"nested":{"$sqlx":"child"}}'::json);
        INSERT INTO tmp_extended_json_audit (
          raw,
          document,
          domain_document,
          documents,
          records
        ) VALUES (
          '{"duplicate":1,"duplicate":2,"outside":1e200000}'::json,
          '{"nested":{"$sqlx":"legacy"}}'::jsonb,
          '{"nested":{"$sqlx":"domain"}}'::tmp_extended_json_audit_domain,
          ARRAY['{"nested":{"$sqlx":"array"}}'::jsonb],
          ARRAY[
            ROW(
              '{"nested":{"$sqlx":"composite"}}'::tmp_extended_json_audit_domain,
              ARRAY['{"duplicate":1,"duplicate":2,"$sqlx":"raw"}'::json]
            )::tmp_extended_json_audit_record
          ]
        );
        INSERT INTO tmp_extended_json_audit (raw, document)
          VALUES (
            ('[' || pg_catalog.rtrim(pg_catalog.repeat('1e131071,', 129), ',') || ']')::json,
            '{}'::jsonb
          );
        INSERT INTO tmp_extended_json_audit (raw, document)
          VALUES (
            ('[' || pg_catalog.rtrim(pg_catalog.repeat('1e131071,', 128), ',') || ']')::json,
            '{}'::jsonb
          );
        INSERT INTO tmp_extended_json_audit (raw, document)
          VALUES ('[1e131071,1e-16383,-0e000001,123.4500e-2]'::json, '{}'::jsonb);
        INSERT INTO tmp_extended_json_audit (raw, document)
          VALUES ('[0e200000,1e-16384]'::json, '{}'::jsonb);
        INSERT INTO tmp_extended_json_audit (raw, document)
          VALUES (
            '{}'::json,
            ('[' || pg_catalog.rtrim(pg_catalog.repeat('1e131071,', 129), ',') || ']')::jsonb
          );
        INSERT INTO tmp_extended_json_audit (raw, document)
          VALUES (
            '{}'::json,
            ('[' || pg_catalog.rtrim(pg_catalog.repeat('1e131071,', 128), ',') || ']')::jsonb
          );
        INSERT INTO tmp_extended_json_audit (raw, document, records)
          VALUES (
            '{}'::json,
            '{}'::jsonb,
            ARRAY[
              ROW(
                NULL::tmp_extended_json_audit_domain,
                ARRAY[
                  ('[' || pg_catalog.rtrim(pg_catalog.repeat('1e131071,', 128), ',') || ']')::json,
                  ('[' || pg_catalog.rtrim(pg_catalog.repeat('1e131071,', 128), ',') || ']')::json
                ]
              )::tmp_extended_json_audit_record
            ]
          );
        INSERT INTO tmp_extended_json_audit (raw, document, records)
          VALUES (
            '{}'::json,
            '{}'::jsonb,
            ARRAY[
              ROW(
                NULL::tmp_extended_json_audit_domain,
                ARRAY[
                  ('[' || pg_catalog.rtrim(pg_catalog.repeat('1e131071,', 129), ',') || ']')::json
                ]
              )::tmp_extended_json_audit_record
            ]
          );
      `);

      const report = await inspectJsonAudit({
        root,
        databaseUrl: dbUrl,
        config: {},
      });
      const raw = report.columns.find((column) =>
        column.relation === "tmp_extended_json_audit" && column.column === "raw");
      const document = report.columns.find((column) =>
        column.relation === "tmp_extended_json_audit" && column.column === "document");
      const domainDocument = report.columns.find((column) =>
        column.relation === "tmp_extended_json_audit" && column.column === "domain_document");
      const documents = report.columns.find((column) =>
        column.relation === "tmp_extended_json_audit" && column.column === "documents");
      const records = report.columns.find((column) =>
        column.relation === "tmp_extended_json_audit" && column.column === "records");
      const parent = report.columns.find((column) =>
        column.relation === "tmp_extended_json_audit_parent" && column.column === "payload");
      const child = report.columns.find((column) =>
        column.relation === "tmp_extended_json_audit_child" && column.column === "payload");

      expect(raw).toMatchObject({ duplicateKeyRows: 1, invalidNumberRows: 3 });
      expect(document).toMatchObject({ collisionRows: 1, invalidNumberRows: 1 });
      expect(domainDocument).toMatchObject({
        collisionRows: 1,
        jsonLeaves: [{ path: "$", type: "jsonb" }],
      });
      expect(documents).toMatchObject({
        collisionRows: 1,
        jsonLeaves: [{ path: "$[]", type: "jsonb" }],
      });
      expect(records).toMatchObject({
        collisionRows: 1,
        duplicateKeyRows: 1,
        invalidNumberRows: 1,
      });
      expect(records?.jsonLeaves).toEqual([
        { path: "$[].payload", type: "jsonb" },
        { path: "$[].raw_items[]", type: "json" },
      ]);
      expect(parent).toMatchObject({ collisionRows: 0 });
      expect(child).toMatchObject({ collisionRows: 1 });
      expect(report.summary).toMatchObject({ invalidNumberRows: 5 });
      expect(report.dependencies).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "index", name: "tmp_extended_json_audit_kind_idx" }),
        expect.objectContaining({ kind: "index", name: "tmp_extended_json_audit_domain_kind_idx" }),
        expect.objectContaining({ kind: "generated", name: "kind" }),
        expect.objectContaining({ kind: "view", name: "tmp_extended_json_audit_view" }),
      ]));
      expect(report.sourceUsages).toEqual([
        expect.objectContaining({ file: "app.ts", indicators: ["->>"] }),
      ]);
      expect(report.ok).toBeFalse();
    } finally {
      await client.simpleQuery(`
        DROP VIEW IF EXISTS tmp_extended_json_audit_view;
        DROP TABLE IF EXISTS tmp_extended_json_audit_child;
        DROP TABLE IF EXISTS tmp_extended_json_audit_parent;
        DROP TABLE IF EXISTS tmp_extended_json_audit;
        DROP TYPE IF EXISTS tmp_extended_json_audit_record CASCADE;
        DROP DOMAIN IF EXISTS tmp_extended_json_audit_domain CASCADE;
      `).catch(() => {});
      await client.end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Extended JSON audit number sizing matches the runtime contract", async () => {
    const tokens = [
      "0",
      "-0",
      "0.000",
      "-0e147455",
      "0e147456",
      "1",
      "-1",
      "123.4500",
      "0.00100",
      "1e400",
      "1e-4000",
      "1e131071",
      "-1e131071",
      "1e131072",
      "1e-16383",
      "1e-16384",
      "1e147455",
      "1e00000000000000000001",
      "1e+000001",
      "1e-000001",
      "01",
      "nan",
      "1".repeat(JSON_NUMBER_LIMITS.tokenLength + 1),
    ];
    const client = new PgClient(parseDatabaseUrl(dbUrl));
    await client.connect();
    try {
      await client.simpleQuery("SET jit = off");
      const values = tokens.map((token) => `'${token}'`).join(", ");
      const result = await client.simpleQuery(`
SELECT input.ordinality::text, number_analysis.canonical_bytes::text
FROM pg_catalog.unnest(ARRAY[${values}]::text[]) WITH ORDINALITY AS input(token, ordinality)
CROSS JOIN LATERAL (
${renderCanonicalJsonNumberAnalysis("input.token")}
) AS number_analysis
ORDER BY input.ordinality
      `);

      expect(result.rows).toHaveLength(tokens.length);
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        let expected: number | null;
        try {
          expected = canonicalJsonNumberBytes(token);
        } catch {
          expected = null;
        }
        const actual = result.rows[index]?.[1];
        expect(actual === null ? null : Number(decodeText(actual)), token).toBe(expected);
      }

      const jsonbTokens = [
        "0",
        "-0",
        "0.000",
        "-0e147455",
        "1",
        "-1",
        "123.4500",
        "0.00100",
        "1e400",
        "1e-4000",
        "1e131071",
        "-1e131071",
        "1e-16383",
        "1e+000001",
        "1e-000001",
      ];
      const jsonbValues = jsonbTokens.map((token) => `'${token}'`).join(", ");
      const jsonbResult = await client.simpleQuery(`
SELECT input.ordinality::text, number_analysis.canonical_bytes::text
FROM pg_catalog.unnest(ARRAY[${jsonbValues}]::text[]) WITH ORDINALITY AS input(token, ordinality)
CROSS JOIN LATERAL (
${renderCanonicalJsonbNumberAnalysis("input.token::pg_catalog.jsonb")}
) AS number_analysis
ORDER BY input.ordinality
      `);

      expect(jsonbResult.rows).toHaveLength(jsonbTokens.length);
      for (let index = 0; index < jsonbTokens.length; index++) {
        const token = jsonbTokens[index]!;
        const actual = jsonbResult.rows[index]?.[1];
        expect(actual === null ? null : Number(decodeText(actual)), token).toBe(
          canonicalJsonNumberBytes(token),
        );
      }
    } finally {
      await client.end();
    }
  });

  test("generated runtime descriptors execute built-in and database-local parameter types", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP TYPE IF EXISTS tmp_runtime_descriptor_status;
        CREATE TYPE tmp_runtime_descriptor_status AS ENUM ('ready', 'done')
      `);
      writeFile("a.ts",
        "import { sql } from \"@onreza/sqlx-js\";\n"
        + "await sql(\"SELECT $value::int4 AS value\", { value: 42 });\n"
        + "await sql(\"SELECT $1::tmp_runtime_descriptor_status AS value\", \"ready\");\n",
      );
      const prepared = prepare();
      expect(prepared.code, prepared.stderr).toBe(0);
      const descriptorPath = join(tmp, ".sqlx-js", "runtime-descriptors.json");
      const descriptors = JSON.parse(readFileSync(descriptorPath, "utf8")) as RuntimeQueryDescriptors;
      expect(descriptors.queries[fingerprint("SELECT $value::int4 AS value")]).toEqual({
        params: [23],
      });
      expect(Object.values(descriptors.types)).toContainEqual({
        schema: "public",
        name: "tmp_runtime_descriptor_status",
      });

      const runtime = createRuntimeSqlClient(dbUrl, { queryDescriptors: descriptors });
      try {
        expect(await runtime.unsafe("SELECT $value::int4 AS value", { value: 42 })).toEqual([
          { value: 42 },
        ]);
        expect(await runtime.unsafe(
          "SELECT $1::tmp_runtime_descriptor_status AS value",
          "ready",
        )).toEqual([{ value: "ready" }]);
      } finally {
        await runtime.close();
      }
      expect(prepare(["--check"]).code).toBe(0);
      expect(prepare(["--offline"]).code).toBe(0);
      expect(prepare(["--verify"]).code).toBe(0);
      await setup.simpleQuery("DROP TYPE tmp_runtime_descriptor_status");
      const observedQueries: string[] = [];
      const staleRuntime = createRuntimeSqlClient(dbUrl, {
        queryDescriptors: descriptors,
        onQuery: ({ query }) => observedQueries.push(query),
      });
      try {
        await expect(staleRuntime.ready()).rejects.toThrow(
          /queryDescriptors type public\.tmp_runtime_descriptor_status does not exist/,
        );
        expect(observedQueries).toEqual([]);
      } finally {
        await staleRuntime.close();
      }

      await setup.simpleQuery(
        "CREATE TYPE tmp_runtime_descriptor_status AS ENUM ('ready', 'done')",
      );
      const recreatedRuntime = createRuntimeSqlClient(dbUrl, { queryDescriptors: descriptors });
      try {
        await recreatedRuntime.ready();
        expect(await recreatedRuntime.unsafe(
          "SELECT $1::tmp_runtime_descriptor_status AS value",
          "ready",
        )).toEqual([{ value: "ready" }]);
      } finally {
        await recreatedRuntime.close();
      }
    } finally {
      await setup.simpleQuery("DROP TYPE IF EXISTS tmp_runtime_descriptor_status").catch(() => {});
      await setup.end();
    }
  });

  test("prepare describes named parameters and emits an object contract", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id, name FROM tmp_users WHERE id = $id OR name = $name\", { name: \"a\", id: 1 });\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("WHERE id = $id OR name = $name");
    expect(dts).toContain('params: { "id": bigint; "name": string }');
    const cacheFiles = queryCacheFiles();
    const entries = cacheFiles.map((file) => JSON.parse(readFileSync(join(tmp, ".sqlx-js", file), "utf8")));
    expect(entries).toContainEqual(expect.objectContaining({
      query: "SELECT id, name FROM tmp_users WHERE id = $id OR name = $name",
      paramNames: ["id", "name"],
    }));
    for (const [index, entry] of entries.entries()) {
      expect(cacheFiles[index]).toBe(`${fingerprint(entry.query)}.json`);
    }
  });

  test("prepare discovers named query definitions", () => {
    writeFile("a.ts",
      "import { defineQuery } from \"@onreza/sqlx-js\";\n" +
      "export const findUser = defineQuery.optional(\"users.findById\", \"SELECT id, name FROM tmp_users WHERE id = $id\");\n",
    );
    const r = prepare();
    expect(r.code, r.stderr).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("SELECT id, name FROM tmp_users WHERE id = $id");
    expect(dts).toContain('params: { "id": bigint }');
  });

  test("named and positional forms keep independent generated contracts", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users WHERE id = $id\", { id: 1 });\n" +
      "await sql(\"SELECT id FROM tmp_users WHERE id = $1\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('WHERE id = $id": { params: { "id": bigint }');
    expect(dts).toContain('WHERE id = $1": { params: [bigint]');
    expect(queryCacheFiles()).toHaveLength(2);
  });

  test("prepare includes queries issued through createSqlClient", () => {
    writeFile("a.ts",
      "import { createSqlClient } from \"@onreza/sqlx-js\";\n" +
      "const db = createSqlClient();\n" +
      "await db.sql.one(\"SELECT id, name FROM tmp_users WHERE id = $1\", 1);\n",
    );
    const r = prepare(["--verbose"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.ts:3:18/);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("SELECT id, name FROM tmp_users WHERE id = $1");
  });

  test("connection profiles bind queries to PostgreSQL roles", async () => {
    if (configuredDbUrl) return;
    const root = isolatedRoot("connection-profiles");
    const suffix = String(process.pid);
    const apiRole = `sqlx_js_api_${suffix}`;
    const workerRole = `sqlx_js_worker_${suffix}`;
    const client = new PgClient(parseDatabaseUrl(dbUrl));
    await client.connect();
    try {
      const currentUserResult = await client.simpleQuery("SELECT current_user");
      const currentUser = new TextDecoder().decode(currentUserResult.rows[0]![0]!);
      await client.simpleQuery(`
        CREATE ROLE ${quoteIdent(apiRole)};
        CREATE ROLE ${quoteIdent(workerRole)};
        GRANT ${quoteIdent(apiRole)}, ${quoteIdent(workerRole)} TO ${quoteIdent(currentUser)};
        CREATE SCHEMA ${quoteIdent(apiRole)} AUTHORIZATION ${quoteIdent(apiRole)};
        CREATE SCHEMA ${quoteIdent(workerRole)} AUTHORIZATION ${quoteIdent(workerRole)};
        CREATE TABLE ${quoteIdent(apiRole)}.profile_target (value integer NOT NULL);
        CREATE TABLE ${quoteIdent(workerRole)}.profile_target (value text NOT NULL);
        GRANT SELECT ON ${quoteIdent(apiRole)}.profile_target TO ${quoteIdent(apiRole)};
        GRANT SELECT ON ${quoteIdent(workerRole)}.profile_target TO ${quoteIdent(workerRole)};
        INSERT INTO ${quoteIdent(apiRole)}.profile_target VALUES (42);
        INSERT INTO ${quoteIdent(workerRole)}.profile_target VALUES ('worker');
      `);
      writeRootFile(root, "sqlx-js.config.ts", `export const databaseProfiles = {
  api: { name: "api", role: ${JSON.stringify(apiRole)} },
  worker: { name: "worker", role: ${JSON.stringify(workerRole)} },
} as const;

export default {
  profiles: databaseProfiles,
};
`);
      writeRootFile(root, "a.ts",
        "import { createSqlClient } from \"@onreza/sqlx-js\";\n" +
        "import { databaseProfiles } from \"./sqlx-js.config\";\n" +
        "const api = createSqlClient(undefined, { profile: databaseProfiles.api });\n" +
        "const worker = createSqlClient(undefined, { profile: databaseProfiles.worker });\n" +
        "await api.sql.one(\"SELECT value FROM profile_target WHERE $1::boolean\", true);\n" +
        "await worker.sql.one(\"SELECT value FROM profile_target WHERE $1::boolean\", true);\n",
      );

      const prepared = prepareRoot(root);
      expect(prepared.code, prepared.stderr).toBe(0);
      expect(prepareRoot(root, ["--check"]).code).toBe(0);
      expect(prepareRoot(root, ["--offline"]).code).toBe(0);
      expect(prepareRoot(root, ["--verify"]).code).toBe(0);
      const entries = queryCacheFiles(root)
        .map((file) => JSON.parse(readFileSync(join(root, ".sqlx-js", file), "utf8")))
        .filter((entry) => entry.query === "SELECT value FROM profile_target WHERE $1::boolean");
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.profile).sort()).toEqual(["api", "worker"]);
      const queryDescriptors = JSON.parse(
        readFileSync(join(root, ".sqlx-js/runtime-descriptors.json"), "utf8"),
      ) as RuntimeQueryDescriptors;

      const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
      expect(dts).toMatch(
        /"api": \{\n\s+"SELECT value FROM profile_target WHERE \$1::boolean": \{ params: \[boolean\]; row: \{ "value": number \} \};/,
      );
      expect(dts).toMatch(
        /"worker": \{\n\s+"SELECT value FROM profile_target WHERE \$1::boolean": \{ params: \[boolean\]; row: \{ "value": string \} \};/,
      );

      const doctorResult = spawnSync(
        "bun",
        [join(repoRoot, "bin/sqlx-js.ts"), "doctor", "--root", root, "--json"],
        { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
      );
      const doctorReport = JSON.parse(doctorResult.stdout) as {
        checks: Array<{ name: string; status: string; details?: { roles?: Record<string, string> } }>;
      };
      expect(doctorReport.checks.find((check) => check.name === "profiles")).toMatchObject({
        status: "ok",
        details: { roles: { api: apiRole, worker: workerRole } },
      });

      const api = createRuntimeSqlClient(dbUrl, {
        profile: { name: "api", role: apiRole },
        operationTimeoutMs: 200,
        queryDescriptors,
      });
      const worker = createRuntimeSqlClient(dbUrl, {
        profile: { name: "worker", role: workerRole },
        queryDescriptors,
      });
      try {
        expect(await api.unsafe(
          "SELECT value FROM profile_target WHERE $1::boolean",
          true,
        )).toEqual([{ value: 42 }]);
        expect(await worker.unsafe(
          "SELECT value FROM profile_target WHERE $1::boolean",
          true,
        )).toEqual([{ value: "worker" }]);
        expect(await api.unsafe("SELECT current_user AS role, value FROM profile_target"))
          .toEqual([expect.objectContaining({ role: apiRole, value: 42 })]);
        expect(await worker.unsafe("SELECT current_user AS role, value FROM profile_target"))
          .toEqual([expect.objectContaining({ role: workerRole, value: "worker" })]);
        await expect(api.unsafe("SELECT pg_sleep(1)")).rejects.toBeInstanceOf(QueryTimeoutError);
        expect(api.snapshot().recycleCount).toBe(1);
        expect(await api.unsafe("SELECT current_user AS role, value FROM profile_target"))
          .toEqual([expect.objectContaining({ role: apiRole, value: 42 })]);
      } finally {
        await Promise.all([api.close(), worker.close()]);
      }
    } finally {
      await client.simpleQuery(`
        DROP SCHEMA IF EXISTS ${quoteIdent(apiRole)} CASCADE;
        DROP SCHEMA IF EXISTS ${quoteIdent(workerRole)} CASCADE;
        DROP ROLE IF EXISTS ${quoteIdent(apiRole)};
        DROP ROLE IF EXISTS ${quoteIdent(workerRole)};
      `).catch(() => {});
      await client.end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("profile transaction settings enforce PostgreSQL RLS without pool leakage", async () => {
    if (configuredDbUrl) return;
    const root = isolatedRoot("rls-profile-context");
    const suffix = String(process.pid);
    const apiRole = `sqlx_js_rls_api_${suffix}`;
    const noinheritRole = `sqlx_js_rls_noinherit_${suffix}`;
    const ownerRole = `sqlx_js_rls_owner_${suffix}`;
    const policyRole = `sqlx_js_rls_policy_${suffix}`;
    const schema = `sqlx_js_rls_${suffix}`;
    const tenantA = "00000000-0000-0000-0000-000000000001";
    const tenantB = "00000000-0000-0000-0000-000000000002";
    const documentA = "10000000-0000-0000-0000-000000000001";
    const documentB = "10000000-0000-0000-0000-000000000002";
    const client = new PgClient(parseDatabaseUrl(dbUrl));
    await client.connect();
    try {
      const currentUserResult = await client.simpleQuery("SELECT current_user");
      const currentUser = new TextDecoder().decode(currentUserResult.rows[0]![0]!);
      await client.simpleQuery(`
        CREATE ROLE ${quoteIdent(apiRole)};
        CREATE ROLE ${quoteIdent(noinheritRole)} NOINHERIT;
        CREATE ROLE ${quoteIdent(ownerRole)};
        CREATE ROLE ${quoteIdent(policyRole)};
        GRANT ${quoteIdent(apiRole)} TO ${quoteIdent(currentUser)};
        GRANT ${quoteIdent(noinheritRole)} TO ${quoteIdent(currentUser)};
        GRANT ${quoteIdent(ownerRole)} TO ${quoteIdent(apiRole)};
        GRANT ${quoteIdent(policyRole)} TO ${quoteIdent(apiRole)};
        GRANT ${quoteIdent(policyRole)} TO ${quoteIdent(noinheritRole)};
        CREATE SCHEMA ${quoteIdent(schema)};
        CREATE TABLE ${quoteIdent(schema)}.documents (
          id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL,
          title text NOT NULL
        );
        INSERT INTO ${quoteIdent(schema)}.documents (id, tenant_id, title) VALUES
          ('${documentA}', '${tenantA}', 'Tenant A'),
          ('${documentB}', '${tenantB}', 'Tenant B');
        ALTER TABLE ${quoteIdent(schema)}.documents ENABLE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON ${quoteIdent(schema)}.documents
          AS PERMISSIVE
          FOR ALL
          TO ${quoteIdent(policyRole)}
          USING (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          )
          WITH CHECK (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          );
        GRANT USAGE ON SCHEMA ${quoteIdent(schema)}
          TO ${quoteIdent(apiRole)}, ${quoteIdent(noinheritRole)};
        GRANT SELECT, INSERT, UPDATE, DELETE
          ON ${quoteIdent(schema)}.documents
          TO ${quoteIdent(apiRole)};
      `);
      writeRootFile(root, "sqlx-js.config.ts", `export const databaseProfiles = {
  api: {
    name: "api",
    role: ${JSON.stringify(apiRole)},
    transactionSettings: ["app.tenant_id"],
  },
  noinherit: {
    name: "noinherit",
    role: ${JSON.stringify(noinheritRole)},
  },
} as const;

export default {
  profiles: databaseProfiles,
};
`);
      const selectQuery = `SELECT id, tenant_id, title FROM ${schema}.documents ORDER BY id`;
      const findQuery = `SELECT id, tenant_id, title FROM ${schema}.documents WHERE id = $1`;
      const insertQuery = `INSERT INTO ${schema}.documents (id, tenant_id, title) VALUES ($1, $2, $3)`;
      writeRootFile(root, "a.ts",
        "import { createSqlClient } from \"@onreza/sqlx-js\";\n" +
        "import { databaseProfiles } from \"./sqlx-js.config\";\n" +
        "const api = createSqlClient(undefined, { profile: databaseProfiles.api });\n" +
        `await api.sql.transaction({ settings: { "app.tenant_id": ${JSON.stringify(tenantA)} } }, async (tx) => {\n` +
        `  await tx(${JSON.stringify(selectQuery)});\n` +
        `  await tx.optional(${JSON.stringify(findQuery)}, ${JSON.stringify(documentA)});\n` +
        `  await tx.execute(${JSON.stringify(insertQuery)}, ${JSON.stringify(documentA)}, ${JSON.stringify(tenantA)}, "Tenant A");\n` +
        "});\n",
      );
      writeRootFile(root, "tsconfig.json", JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "Preserve",
          moduleResolution: "Bundler",
          target: "ESNext",
          types: ["bun-types"],
          paths: { "@onreza/sqlx-js": [join(repoRoot, "src/index.ts")] },
        },
        files: ["a.ts", "sqlx-js-env.d.ts"],
      }));

      const prepared = prepareRoot(root);
      expect(prepared.code, prepared.stderr).toBe(0);
      const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
      expect(dts).toContain('readonly transactionSettings: readonly ["app.tenant_id"]');

      const inspectRls = () => {
        const result = spawnSync(
          "bun",
          [join(repoRoot, "bin/sqlx-js.ts"), "doctor", "--root", root, "--json"],
          { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as {
          checks: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
        };
        return report.checks.find((check) => check.name === "rls");
      };
      expect(inspectRls()).toMatchObject({
        status: "ok",
        details: {
          profiles: {
            api: {
              role: apiRole,
              superuser: false,
              bypassRls: false,
              tables: [{
                schema,
                table: "documents",
                forced: false,
                ownerBypass: false,
                privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
                missingPermissivePolicies: [],
                policies: [{
                  name: "tenant_isolation",
                  command: "ALL",
                  permissive: true,
                  roles: [policyRole],
                }],
              }],
            },
          },
          issues: [],
        },
      });

      const profile = {
        name: "api",
        role: apiRole,
        transactionSettings: ["app.tenant_id"],
      } as const;
      const api = createRuntimeSqlClient(dbUrl, { profile });
      try {
        await api.ready();
        await api.ping();
        const rowsA = await api.sql.transaction({
          settings: { "app.tenant_id": tenantA },
        }, async (tx) => {
          const rows = await tx(selectQuery);
          const hidden = await tx.optional(findQuery, documentB);
          expect(hidden).toBeNull();
          return rows;
        });
        expect(rowsA).toEqual([{ id: documentA, tenant_id: tenantA, title: "Tenant A" }]);

        await expect(api.unsafe(selectQuery)).rejects.toThrow(/requires transaction settings/);

        const rowsB = await api.sql.transaction({
          readOnly: true,
          settings: { "app.tenant_id": tenantB },
        }, async (tx) => await tx(selectQuery));
        expect(rowsB).toEqual([{ id: documentB, tenant_id: tenantB, title: "Tenant B" }]);

        await expect(api.sql.transaction({
          settings: { "app.tenant_id": tenantA },
        }, async (tx) => {
          await tx.execute(
            insertQuery,
            "10000000-0000-0000-0000-000000000003",
            tenantB,
            "Wrong tenant",
          );
        })).rejects.toMatchObject({ code: "42501" });

        const rowsAfterRollback = await api.sql.transaction({
          settings: { "app.tenant_id": tenantA },
        }, async (tx) => await tx(selectQuery));
        expect(rowsAfterRollback).toEqual([{ id: documentA, tenant_id: tenantA, title: "Tenant A" }]);
      } finally {
        await api.close();
      }

      await client.simpleQuery(`
        GRANT SELECT ON ${quoteIdent(schema)}.documents TO ${quoteIdent(noinheritRole)};
      `);
      expect(inspectRls()).toMatchObject({
        status: "warning",
        details: {
          issues: [{
            kind: "missing-permissive-policy",
            profile: "noinherit",
            role: noinheritRole,
            schema,
            table: "documents",
            commands: ["SELECT"],
          }],
        },
      });
      await client.simpleQuery(`
        REVOKE SELECT ON ${quoteIdent(schema)}.documents FROM ${quoteIdent(noinheritRole)};
      `);

      await client.simpleQuery(`
        GRANT CREATE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(ownerRole)};
        ALTER TABLE ${quoteIdent(schema)}.documents OWNER TO ${quoteIdent(ownerRole)};
      `);
      expect(inspectRls()).toMatchObject({
        status: "warning",
        details: {
          issues: [{
            kind: "table-owner-bypasses-rls",
            profile: "api",
            role: apiRole,
            schema,
            table: "documents",
          }],
        },
      });

      await client.simpleQuery(`
        ALTER TABLE ${quoteIdent(schema)}.documents OWNER TO ${quoteIdent(currentUser)};
        DROP POLICY tenant_isolation ON ${quoteIdent(schema)}.documents;
        GRANT SELECT, INSERT, UPDATE, DELETE
          ON ${quoteIdent(schema)}.documents
          TO ${quoteIdent(apiRole)};
      `);
      expect(inspectRls()).toMatchObject({
        status: "warning",
        details: {
          issues: [{
            kind: "missing-permissive-policy",
            profile: "api",
            role: apiRole,
            schema,
            table: "documents",
            commands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
          }],
        },
      });

      await client.simpleQuery(`ALTER ROLE ${quoteIdent(apiRole)} BYPASSRLS`);
      expect(inspectRls()).toMatchObject({
        status: "warning",
        details: {
          issues: [{
            kind: "role-bypasses-rls",
            profile: "api",
            role: apiRole,
            reason: "bypassrls",
          }],
        },
      });
    } finally {
      await client.simpleQuery(`
        DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE;
        DROP ROLE IF EXISTS ${quoteIdent(apiRole)};
        DROP ROLE IF EXISTS ${quoteIdent(noinheritRole)};
        DROP ROLE IF EXISTS ${quoteIdent(ownerRole)};
        DROP ROLE IF EXISTS ${quoteIdent(policyRole)};
      `).catch(() => {});
      await client.end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepare publishes no partial artifacts when any query fails", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    let r = prepare();
    expect(r.code).toBe(0);
    const dtsPath = join(tmp, "sqlx-js-env.d.ts");
    const beforeDts = readFileSync(dtsPath, "utf8");
    const beforeCache = readdirSync(join(tmp, ".sqlx-js"))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => [name, readFileSync(join(tmp, ".sqlx-js", name), "utf8")]);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT name FROM tmp_users\");\n" +
      "await sql(\"SELECT * FROM tmp_missing_atomic_relation\");\n",
    );
    r = prepare();
    expect(r.code).toBe(1);
    expect(readFileSync(dtsPath, "utf8")).toBe(beforeDts);
    expect(readdirSync(join(tmp, ".sqlx-js"))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => [name, readFileSync(join(tmp, ".sqlx-js", name), "utf8")]))
      .toEqual(beforeCache);
  });

  test("prepare --verify compares live generated artifacts without writing", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id, name FROM tmp_users WHERE id = $1\", 1);\n",
    );
    let r = prepare();
    expect(r.code).toBe(0);
    const before = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    r = prepare(["--verify"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("generated artifacts are current");
    expect(readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8")).toBe(before);
  });

  test("enum catalog generates all configured schema enums across prepare modes", async () => {
    const root = isolatedRoot("enum-catalog");
    const client = new PgClient(parseDatabaseUrl(dbUrl));
    await client.connect();
    try {
      await client.simpleQuery(`
        DROP SCHEMA IF EXISTS tmp_enum_catalog CASCADE;
        DROP SCHEMA IF EXISTS tmp_enum_billing CASCADE;
        CREATE SCHEMA tmp_enum_catalog;
        CREATE SCHEMA tmp_enum_billing;
        CREATE TYPE tmp_enum_catalog.empty_state AS ENUM ();
        CREATE TYPE tmp_enum_catalog.user_role AS ENUM ('admin', 'in-progress');
        CREATE TYPE tmp_enum_catalog.status AS ENUM ('active', 'disabled');
        CREATE TYPE tmp_enum_billing.status AS ENUM ('pending', 'paid')
      `);
      writeRootFile(root, "a.ts", "export {};\n");
      const fullCatalogConfig = `export default {
        functionCatalog: false,
        enumCatalog: {
          output: "src/db-enums.ts",
          schemas: ["tmp_enum_catalog", "tmp_enum_billing"],
          aliases: {
            "tmp_enum_catalog.status": "AccountStatus",
            "tmp_enum_billing.status": "BillingStatus",
          },
          registry: true,
        },
      };\n`;
      writeRootFile(root, "sqlx-js.config.ts", fullCatalogConfig);

      let prepared = prepareRoot(root);
      expect(prepared.code, prepared.stderr).toBe(0);
      const outputPath = join(root, "src/db-enums.ts");
      const cachePath = join(root, ".sqlx-js/enums/enums.json");
      const initial = readFileSync(outputPath, "utf8");
      expect(initial).toContain("export const EmptyState = {\n} as const;");
      expect(initial).toContain("export const UserRole = {");
      expect(initial).toContain("export const AccountStatus = {");
      expect(initial).toContain("export const BillingStatus = {");
      expect(initial).toContain('["in-progress"]: "in-progress"');
      expect(initial).toContain("export type UserRole = (typeof UserRole)[keyof typeof UserRole];");
      expect(initial).toContain('["tmp_enum_catalog.status"]: AccountStatus');
      expect(initial).toContain('["tmp_enum_billing.status"]: BillingStatus');
      expect(initial).toContain("export type DbEnumValue<Name extends DbEnumName> =");
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({
        version: 1,
        enums: [
          {
            schema: "tmp_enum_billing",
            name: "status",
            values: ["pending", "paid"],
          },
          {
            schema: "tmp_enum_catalog",
            name: "empty_state",
            values: [],
          },
          {
            schema: "tmp_enum_catalog",
            name: "status",
            values: ["active", "disabled"],
          },
          {
            schema: "tmp_enum_catalog",
            name: "user_role",
            values: ["admin", "in-progress"],
          },
        ],
      });
      expect(prepareRoot(root, ["--check"]).code).toBe(0);

      const beforeCollision = {
        output: readFileSync(outputPath, "utf8"),
        cache: readFileSync(cachePath, "utf8"),
        dts: readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8"),
        manifest: readFileSync(join(root, ".sqlx-js/cache-manifest.json"), "utf8"),
      };
      writeRootFile(root, "sqlx-js.config.ts", `export default {
        functionCatalog: false,
        enumCatalog: {
          output: "src/db-enums.ts",
          schemas: ["tmp_enum_catalog", "tmp_enum_billing"],
          aliases: {
            "tmp_enum_catalog.status": "Status",
            "tmp_enum_billing.status": "Status",
          },
        },
      };\n`);
      const collision = prepareRoot(root, ["--json"]);
      expect(collision.code).toBe(1);
      expect(JSON.parse(collision.stdout).diagnostics).toEqual([
        expect.objectContaining({
          phase: "introspect",
          message: expect.stringContaining("Status is ambiguous"),
        }),
      ]);
      expect({
        output: readFileSync(outputPath, "utf8"),
        cache: readFileSync(cachePath, "utf8"),
        dts: readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8"),
        manifest: readFileSync(join(root, ".sqlx-js/cache-manifest.json"), "utf8"),
      }).toEqual(beforeCollision);

      writeRootFile(root, "sqlx-js.config.ts", `export default {
        functionCatalog: false,
        enumCatalog: {
          output: "src/db-enums.ts",
          schemas: ["tmp_enum_catalog", "tmp_enum_billing"],
          include: ["tmp_enum_billing.status", "tmp_enum_catalog.user_role"],
          aliases: {
            "tmp_enum_billing.status": "BillingStatus",
          },
          registry: true,
        },
      };\n`);
      const filteredOffline = prepareRoot(root, ["--offline", "--json"]);
      expect(filteredOffline.code).toBe(0);
      expect(JSON.parse(filteredOffline.stdout).enums).toBe(2);
      const filtered = readFileSync(outputPath, "utf8");
      expect([...filtered.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual([
        "BillingStatus",
        "UserRole",
        "DbEnums",
      ]);
      expect(prepareRoot(root, ["--check"]).code).toBe(0);

      writeRootFile(root, "sqlx-js.config.ts", fullCatalogConfig);
      expect(prepareRoot(root, ["--offline"]).code).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toBe(initial);

      writeRootFile(root, "src/db-enums.ts", "export {};\n");
      const stale = prepareRoot(root, ["--check", "--json"]);
      expect(stale.code).toBe(1);
      expect(JSON.parse(stale.stdout).diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: "generated enum catalog is stale or missing",
          file: "src/db-enums.ts",
        }),
      ]));
      expect(prepareRoot(root, ["--offline"]).code).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toBe(initial);

      await client.simpleQuery("ALTER TYPE tmp_enum_catalog.user_role ADD VALUE 'viewer'");
      const verified = prepareRoot(root, ["--verify", "--json"]);
      expect(verified.code).toBe(1);
      expect(JSON.parse(verified.stdout).changed).toEqual([
        "cache/enums/enums.json",
        "src/db-enums.ts",
      ]);
      expect(readFileSync(outputPath, "utf8")).toBe(initial);

      prepared = prepareRoot(root);
      expect(prepared.code, prepared.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toContain('["viewer"]: "viewer"');
      expect(prepareRoot(root, ["--verify"]).code).toBe(0);
      expect(prepareRoot(root, ["--check"]).code).toBe(0);

      const generatedBeforeDisable = readFileSync(outputPath, "utf8");
      writeRootFile(root, "sqlx-js.config.ts", "export default { functionCatalog: false };\n");
      const disabled = prepareRoot(root, ["--warnings"]);
      expect(disabled.code, disabled.stderr).toBe(0);
      expect(disabled.stderr).toContain("enum catalog disabled: removed its cache");
      expect(existsSync(cachePath)).toBe(false);
      expect(readFileSync(outputPath, "utf8")).toBe(generatedBeforeDisable);
      expect(prepareRoot(root, ["--check"]).code).toBe(0);
    } finally {
      await client.simpleQuery("DROP SCHEMA IF EXISTS tmp_enum_catalog CASCADE").catch(() => {});
      await client.simpleQuery("DROP SCHEMA IF EXISTS tmp_enum_billing CASCADE").catch(() => {});
      await client.end();
    }
  });

  test("generated outputs cannot overwrite each other in any prepare mode", () => {
    const root = isolatedRoot("enum-output-collision");
    const output = join(root, "generated/types.ts");
    writeRootFile(root, "a.ts", "export {};\n");
    writeRootFile(root, "generated/types.ts", "export const sentinel = true;\n");
    writeRootFile(root, "sqlx-js.config.ts", `export default {
      functionCatalog: false,
      enumCatalog: { output: "generated/types.ts", schemas: ["public"] },
    };\n`);

    for (const args of [[], ["--check"], ["--offline"], ["--verify"]]) {
      const result = prepareRoot(root, [...args, "--dts", "generated/types.ts", "--json"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).diagnostics).toEqual([
        expect.objectContaining({
          phase: "config",
          message: expect.stringContaining("generated declaration, enum catalog, and embedded SQL outputs must be distinct"),
        }),
      ]);
      expect(readFileSync(output, "utf8")).toBe("export const sentinel = true;\n");
    }
  });

  test("configured embedded SQL participates in every artifact mode and doctor", () => {
    const root = isolatedRoot("embedded-sql-artifact-modes");
    const output = join(root, "src/sql-files.generated.ts");
    try {
      writeRootFile(root, "queries/value.sql", "SELECT 42::int4 AS value\n");
      writeRootFile(
        root,
        "a.ts",
        'import { sql } from "@onreza/sqlx-js";\nawait sql.file.one("queries/value.sql");\n',
      );
      writeRootFile(root, "tsconfig.json", JSON.stringify({
        include: ["a.ts", "sqlx-js-env.d.ts", "src/**/*.ts"],
      }));
      writeRootFile(root, "sqlx-js.config.ts", `export default {
        functionCatalog: false,
        sqlFiles: { output: "src/sql-files.generated.ts" },
      };\n`);

      const prepared = prepareRoot(root);
      expect(prepared.code, prepared.stderr).toBe(0);
      expect(prepared.stdout).toContain(output);
      let generated = readFileSync(output, "utf8");
      expect(generated).toContain('["queries/value.sql"]: "SELECT 42::int4 AS value\\n"');
      expect(prepareRoot(root, ["--check"]).code).toBe(0);

      const diagnosis = spawnSync(
        "bun",
        [join(repoRoot, "bin/sqlx-js.ts"), "doctor", "--root", root, "--json"],
        { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
      );
      const doctorPayload = JSON.parse(diagnosis.stdout) as {
        checks: Array<{ name: string; status: string }>;
      };
      expect(doctorPayload.checks.find((check) => check.name === "embeddedSql")).toMatchObject({
        status: "ok",
      });

      writeRootFile(root, "queries/value.sql", "-- preserve this comment\nSELECT 42::int4 AS value\n");
      const sourceStaleCheck = prepareRoot(root, ["--check", "--json"]);
      expect(sourceStaleCheck.code).toBe(1);
      expect(JSON.parse(sourceStaleCheck.stdout).diagnostics).toContainEqual(expect.objectContaining({
        message: "generated embedded SQL module is stale or missing",
        file: "src/sql-files.generated.ts",
      }));
      expect(prepareRoot(root, ["--offline"]).code).toBe(0);
      generated = readFileSync(output, "utf8");
      expect(generated).toContain("-- preserve this comment\\nSELECT 42::int4 AS value\\n");
      expect(prepareRoot(root, ["--check"]).code).toBe(0);
      expect(prepareRoot(root).code).toBe(0);

      writeRootFile(root, "src/sql-files.generated.ts", "export const stale = true;\n");
      const staleCheck = prepareRoot(root, ["--check", "--json"]);
      expect(staleCheck.code).toBe(1);
      expect(JSON.parse(staleCheck.stdout).diagnostics).toContainEqual(expect.objectContaining({
        message: "generated embedded SQL module is stale or missing",
        file: "src/sql-files.generated.ts",
      }));
      const staleVerify = prepareRoot(root, ["--verify", "--json"]);
      expect(staleVerify.code).toBe(1);
      expect(JSON.parse(staleVerify.stdout).changed).toEqual(["src/sql-files.generated.ts"]);

      expect(prepareRoot(root, ["--offline"]).code).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(generated);
      expect(prepareRoot(root, ["--verify"]).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepare --verify rejects planner-only ON CONFLICT errors without executing DML", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP TABLE IF EXISTS tmp_plan_outbox;
        CREATE TABLE tmp_plan_outbox (
          id bigserial PRIMARY KEY,
          transition_id text NOT NULL,
          idempotency_key text NOT NULL
        );
        CREATE UNIQUE INDEX tmp_plan_outbox_idempotency_key
          ON tmp_plan_outbox (idempotency_key)
      `);
    } finally {
      await setup.end();
    }

    const root = isolatedRoot("planner-validation");
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.execute(\"INSERT INTO tmp_plan_outbox (transition_id, idempotency_key) SELECT $1, $2 ON CONFLICT (idempotency_key) DO NOTHING\", \"transition\", \"key\");\n",
    );
    const prepared = prepareRoot(root);
    expect(prepared.code, prepared.stderr).toBe(0);

    const mutateSchema = new PgClient(parseDatabaseUrl(dbUrl));
    await mutateSchema.connect();
    try {
      await mutateSchema.simpleQuery(`
        DROP INDEX tmp_plan_outbox_idempotency_key;
        CREATE UNIQUE INDEX tmp_plan_outbox_transition_key
          ON tmp_plan_outbox (transition_id, idempotency_key)
      `);
    } finally {
      await mutateSchema.end();
    }

    const verified = prepareRoot(root, ["--verify", "--strict-inference", "--json"]);
    expect(verified.code).toBe(1);
    expect(verified.stderr).toBe("");
    const payload = JSON.parse(verified.stdout) as {
      ok: boolean;
      diagnostics: { phase: string; file: string; line: number; code?: string; message: string }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics[0]).toMatchObject({
      phase: "plan",
      file: "a.ts",
      line: 2,
      code: "42P10",
    });

    const inspect = new PgClient(parseDatabaseUrl(dbUrl));
    await inspect.connect();
    try {
      const rows = await inspect.simpleQueryAll("SELECT count(*)::int4 FROM tmp_plan_outbox");
      expect(Number(new TextDecoder().decode(rows.rows[0]![0]!))).toBe(0);
    } finally {
      await inspect.end();
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("prepare uses a generic plan independent of parameter values", () => {
    const root = isolatedRoot("generic-planner-validation");
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.one(\"SELECT CASE WHEN $1::boolean THEN 1 / 0 ELSE 1 END AS value\", false);\n",
    );
    const result = prepareRoot(root, ["--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      diagnostics: { phase: string; file: string; line: number; code?: string; message: string }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics[0]).toMatchObject({
      phase: "plan",
      file: "a.ts",
      line: 2,
      code: "22012",
      message: "division by zero",
    });
    rmSync(root, { recursive: true, force: true });
  });

  test("prepare reports statements outside generic planning as parse-only", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP PROCEDURE IF EXISTS tmp_parse_only_procedure();
        CREATE PROCEDURE tmp_parse_only_procedure() LANGUAGE SQL AS 'SELECT 1'
      `);
    } finally {
      await setup.end();
    }
    const root = isolatedRoot("parse-only-validation");
    writeRootFile(root, "a.ts",
      "import { defineQuery, sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.execute(\"SET statement_timeout = '1s'\");\n" +
      "await sql.execute(\"CALL tmp_parse_only_procedure()\");\n" +
      "export const analyze = defineQuery.execute(\"maintenance.analyze\", \"ANALYZE\", " +
      "{ expectedValidation: \"parse-only\" });\n",
    );
    const result = prepareRoot(root, ["--json"]);
    expect(result.code, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      diagnostics: { severity: string; phase: string; message: string }[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.diagnostics).toHaveLength(2);
    expect(payload.diagnostics).toContainEqual(expect.objectContaining({
      severity: "warning",
      phase: "plan",
      message: expect.stringContaining("parse-only"),
    }));
    const verbose = prepareRoot(root, ["--verbose"]);
    expect(verbose.code, verbose.stderr).toBe(0);
    expect(verbose.stderr.match(/plan warning:/g)).toHaveLength(2);
    expect(verbose.stderr).toContain(
      "statement is outside PostgreSQL's generic planning surface; validation is parse-only",
    );
    expect(verbose.stdout).toContain("[parse-only acknowledged]");
    const entries = queryCacheFiles(root).map((cacheFile) =>
      JSON.parse(readFileSync(join(root, ".sqlx-js", cacheFile), "utf8")) as { validation?: string });
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.validation === "parse-only")).toBe(true);
    const strict = prepareRoot(root, ["--check", "--strict-inference", "--json"]);
    expect(strict.code).toBe(1);
    const strictPayload = JSON.parse(strict.stdout) as {
      diagnostics: { severity: string; phase: string; message: string }[];
    };
    expect(strictPayload.diagnostics.filter((diagnostic) =>
      diagnostic.severity === "error" && diagnostic.phase === "plan"
    )).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
    const cleanup = new PgClient(parseDatabaseUrl(dbUrl));
    await cleanup.connect();
    try {
      await cleanup.simpleQuery("DROP PROCEDURE tmp_parse_only_procedure()");
    } finally {
      await cleanup.end();
    }
  });

  test("prepare --check rejects cache generated with a different type config", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    expect(prepare().code).toBe(0);
    writeFile("sqlx-js.config.ts", "export default { customTypes: { geometry: \"GeoJSON.Geometry\" } };\n");
    try {
      const result = prepare(["--check", "--json"]);
      expect(result.code).toBe(1);
      const payload = JSON.parse(result.stdout) as { ok: boolean; diagnostics: { message: string }[] };
      expect(payload.ok).toBe(false);
      expect(payload.diagnostics[0]!.message).toContain("different type-affecting config");
    } finally {
      rmSync(join(tmp, "sqlx-js.config.ts"), { force: true });
    }
  });

  test("prepare --check rejects cache entries without planner metadata", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    expect(prepare().code).toBe(0);
    const cachePath = join(tmp, ".sqlx-js", queryCacheFiles()[0]!);
    const entry = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    delete entry.validation;
    writeFileSync(cachePath, JSON.stringify(entry, null, 2) + "\n");

    const result = prepare(["--check", "--json"]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      diagnostics: { phase: string; message: string }[];
    };
    expect(payload.diagnostics).toContainEqual(expect.objectContaining({
      phase: "cache",
      message: expect.stringContaining("missing planner validation metadata"),
    }));
  });

  test("doctor checks runtime, config, cache, tsconfig, database, permissions, and schema provider", () => {
    writeFile("tsconfig.json", JSON.stringify({ include: ["a.ts", "sqlx-js-env.d.ts"] }));
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    expect(prepare().code).toBe(0);
    const result = doctor(["--json"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { name: string; status: string; details?: Record<string, unknown> }[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.checks.map((check) => check.name)).toEqual([
      "runtime",
      "packageIdentity",
      "config",
      "env",
      "cache",
      "gitAttributes",
      "tsconfig",
      "descriptorCoverage",
      "database",
      "permissions",
      "runtimeTypes",
      "columnAssertions",
      "pgschema",
    ]);
    expect(payload.checks.every((check) => check.status !== "error")).toBe(true);
    expect(payload.checks.find((check) => check.name === "packageIdentity")).toMatchObject({
      status: "warning",
      details: { runningVersion: expect.any(String), targetVersion: null },
    });
    expect(payload.checks.find((check) => check.name === "permissions")?.details).toMatchObject({
      schemaUsage: true,
      createDatabase: true,
    });
    expect(payload.checks.find((check) => check.name === "gitAttributes")).toMatchObject({
      status: "warning",
      fixable: true,
    });

    const fixed = doctor(["--json", "--fix"]);
    expect(fixed.code).toBe(0);
    const fixedPayload = JSON.parse(fixed.stdout) as {
      ok: boolean;
      checks: { name: string; status: string; details?: Record<string, unknown> }[];
    };
    expect(fixedPayload.ok).toBe(true);
    expect(fixedPayload.checks.find((check) => check.name === "gitAttributes")).toMatchObject({
      status: "ok",
      details: {
        fixed: [
          ".sqlx-js/** linguist-generated",
          "/sqlx-js-env.d.ts linguist-generated",
        ],
      },
    });
  });

  test("prepare --json emits structured PostgreSQL diagnostics", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT * FROM tmp_json_diagnostic_missing\");\n",
    );
    const result = prepare(["--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      diagnostics: { phase: string; file: string; line: number; queryId?: string; code?: string }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics[0]).toMatchObject({ phase: "describe", file: "a.ts", line: 2, code: "42P01" });
    expect(payload.diagnostics[0]!.queryId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("prepare defaults to summary and exposes explicit detail levels", () => {
    const root = isolatedRoot("prepare-summary");
    writeRootFile(root, "sqlx-js.config.mjs", "export default { functionCatalog: false };\n");
    writeRootFile(root, "queries.ts", `
      import { sql } from "@onreza/sqlx-js";
      await sql.execute("SELECT $1::int4", 1);
    `);

    for (const args of [
      [],
      ["--check"],
      ["--offline"],
      ["--verify"],
    ]) {
      const result = prepareRoot(root, args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("✓");
      expect(result.stdout).not.toContain("scanned: found");
      expect(result.stdout).toContain("1 unique query, 1 source site");
      expect(result.stdout).toContain("1 warning (intent: 1), 0 errors");
      expect(result.stdout).toContain("use --warnings to show warning details");
      expect(result.stdout).toContain("use --verbose for per-query progress");
      expect(result.stderr).not.toMatch(
        /intent warning: queries\.ts:3:\d+ \[query:[0-9a-f]{16}\] — sql\.execute\(\) is discarding rows/,
      );
    }

    const warnings = prepareRoot(root, ["--warnings"]);
    expect(warnings.code, warnings.stderr).toBe(0);
    expect(warnings.stdout).not.toContain("scanned: found");
    expect(warnings.stdout).not.toContain("use --warnings to show warning details");
    expect(warnings.stderr).toMatch(
      /intent warning: queries\.ts:3:\d+ \[query:[0-9a-f]{16}\] — sql\.execute\(\) is discarding rows/,
    );

    const verbose = prepareRoot(root, ["--verbose"]);
    expect(verbose.code, verbose.stderr).toBe(0);
    expect(verbose.stdout).toContain("scanned: found");
    expect(verbose.stdout).toContain("✓");
    expect(verbose.stderr).toMatch(
      /intent warning: queries\.ts:3:\d+ \[query:[0-9a-f]{16}\] — sql\.execute\(\) is discarding rows/,
    );

    writeRootFile(root, "sqlx-js-env.d.ts", "export {};\n");
    const stale = prepareRoot(root, ["--verify"]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("sqlx-js prepare --verify: generated artifacts are stale:");
    expect(stale.stderr).toContain("sqlx-js-env.d.ts");
    expect(stale.stderr).toContain("verify failed — prepared 1 unique query");
    expect(stale.stderr).not.toContain("verified 1 unique query");

    writeRootFile(root, "queries.ts", `
      import { sql } from "@onreza/sqlx-js";
      await sql.execute("SELECT $1::text", "new");
    `);
    const missing = prepareRoot(root, ["--check"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(
      /cache failed: queries\.ts:3:\d+ \[query:[0-9a-f]{16}\] — query is not in the offline cache/,
    );
    expect(missing.stderr).toContain("check failed — 0 unique queries");

    writeRootFile(root, "queries.ts", `
      import { sql } from "@onreza/sqlx-js";
      await sql("SELECT * FROM tmp_summary_missing_relation");
    `);
    const failed = prepareRoot(root);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(
      /describe failed: queries\.ts:3:\d+ \[query:[0-9a-f]{16}\] — relation "tmp_summary_missing_relation" does not exist/,
    );
    expect(failed.stderr).toContain("code 42P01");
    expect(failed.stderr).toContain("query: SELECT * FROM tmp_summary_missing_relation");
    expect(failed.stderr).toContain("prepare failed — 0 unique queries");
  });

  test("prepare emits generated functions from pg_proc and keeps them in --check", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        CREATE EXTENSION IF NOT EXISTS hstore;
        DROP FUNCTION IF EXISTS tmp_catalog_slug(text);
        DROP FUNCTION IF EXISTS tmp_catalog_pair(text);
        DROP FUNCTION IF EXISTS tmp_catalog_json_table(jsonb);
        DROP FUNCTION IF EXISTS tmp_catalog_json_out(text);
        DROP FUNCTION IF EXISTS tmp_catalog_json_inout(jsonb);
        DROP FUNCTION IF EXISTS tmp_catalog_json_array(jsonb[]);
        DROP TYPE IF EXISTS tmp_catalog_json_record CASCADE;
        DROP DOMAIN IF EXISTS tmp_catalog_json_domain CASCADE;
        CREATE DOMAIN tmp_catalog_json_domain AS jsonb;
        CREATE TYPE tmp_catalog_json_record AS (payload jsonb, payloads jsonb[]);
        CREATE FUNCTION tmp_catalog_slug(value text) RETURNS text
        LANGUAGE sql IMMUTABLE STRICT SET TimeZone = 'UTC'
        AS $$ SELECT lower(value) $$;
        CREATE FUNCTION tmp_catalog_pair(value text) RETURNS TABLE(slug text, score integer)
        LANGUAGE sql STABLE AS $$ SELECT lower(value), length(value)::int $$;
        CREATE FUNCTION tmp_catalog_json_table(value jsonb) RETURNS TABLE(payload jsonb)
        LANGUAGE sql STABLE AS $$ SELECT value $$;
        CREATE FUNCTION tmp_catalog_json_out(value text, OUT payload jsonb)
        LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('value', value) $$;
        CREATE FUNCTION tmp_catalog_json_inout(INOUT payload jsonb)
        LANGUAGE sql STABLE AS $$ SELECT payload $$;
        CREATE FUNCTION tmp_catalog_json_array(value jsonb[]) RETURNS jsonb[]
        LANGUAGE sql IMMUTABLE AS $$ SELECT value $$;
        CREATE FUNCTION tmp_catalog_json_nested(
          value tmp_catalog_json_domain,
          record_value tmp_catalog_json_record
        ) RETURNS jsonb
        LANGUAGE sql IMMUTABLE AS $$ SELECT value::jsonb $$;
      `);
    } finally {
      await setup.end();
    }

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT tmp_catalog_slug($1) AS slug\", \"Hello\");\n",
    );
    let r = prepare();
    expect(r.code).toBe(0);
    let dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("interface SqlxJsGeneratedFunctions");
    expect(dts).toContain('"public.tmp_catalog_slug(value text)": { kind: "function"; language: "sql"; params: [string | null]; returns: string | null; returnsSet: false;');
    expect(dts).toContain('"public.tmp_catalog_pair(value text)": { kind: "function"; language: "sql"; params: [string | null]; returns: { score: number | null; slug: string | null }; returnsSet: true;');
    expect(dts).toContain('"public.tmp_catalog_json_table(value jsonb)": { kind: "function"; language: "sql"; params: [import("@onreza/sqlx-js").SqlxJson<unknown> | null]; returns: { payload: import("@onreza/sqlx-js").SqlxJson<import("@onreza/sqlx-js").JsonValue> | null }; returnsSet: true;');
    expect(dts).toContain('"public.tmp_catalog_json_out(value text, OUT payload jsonb)": { kind: "function"; language: "sql"; params: [string | null]; returns: { payload: import("@onreza/sqlx-js").SqlxJson<import("@onreza/sqlx-js").JsonValue> | null }; returnsSet: false;');
    expect(dts).toMatch(/"public\.tmp_catalog_json_inout\([^"]*jsonb\)": \{ kind: "function"; language: "sql"; params: \[import\("@onreza\/sqlx-js"\)\.SqlxJson<unknown> \| null\]; returns: \{ payload: import\("@onreza\/sqlx-js"\)\.SqlxJson<import\("@onreza\/sqlx-js"\)\.JsonValue> \| null \}; returnsSet: false;/);
    expect(dts).toContain('"public.tmp_catalog_json_array(value jsonb[])": { kind: "function"; language: "sql"; params: [(import("@onreza/sqlx-js").SqlxJson<unknown> | null)[] | null]; returns: (import("@onreza/sqlx-js").SqlxJson<import("@onreza/sqlx-js").JsonValue> | null)[] | null; returnsSet: false;');
    expect(dts).toContain('params: [import("@onreza/sqlx-js").SqlxJson<unknown> | null, { payload: import("@onreza/sqlx-js").SqlxJson<unknown> | null; payloads: (import("@onreza/sqlx-js").SqlxJson<unknown> | null)[] | null } | null]; returns: import("@onreza/sqlx-js").SqlxJson<import("@onreza/sqlx-js").JsonValue> | null;');
    expect(dts).toMatch(/"public\.tmp_catalog_slug\(value text\)".*volatility: "immutable"; strict: true; securityDefiner: false; leakproof: false; parallelSafety: "unsafe"; owner: "[^"]+"; ownerSuperuser: (?:true|false); publicExecute: true; settings: readonly \["TimeZone=UTC"\]; searchPath: null; extensionOwned: false/);
    const functionCache = JSON.parse(readFileSync(join(tmp, ".sqlx-js/functions/functions.json"), "utf8")) as {
      version: number;
      functions: Array<{
        signature: string;
        strict: boolean;
        settings: string[];
        returns: string;
        params: { name?: string }[];
      }>;
    };
    expect(functionCache.version).toBe(3);
    expect(functionCache.functions.find((fn) => fn.signature === "public.tmp_catalog_slug(value text)"))
      .toMatchObject({ strict: true, settings: ["TimeZone=UTC"] });
    const pair = functionCache.functions.find((fn) => fn.signature === "public.tmp_catalog_pair(value text)");
    expect(pair?.returns).toBe("{ score: number | null; slug: string | null }");
    expect(pair?.params.map((param) => param.name)).toEqual(["value", "slug", "score"]);
    expect(snapshot(["dump"]).code).toBe(0);
    const schemaSnapshot = JSON.parse(readFileSync(join(tmp, ".sqlx-js/schema/schema.json"), "utf8")) as {
      functions: { name: string; returnType: string }[];
    };
    expect(schemaSnapshot.functions.find((fn) => fn.name === "tmp_catalog_pair")?.returnType)
      .toBe("TABLE(slug text, score integer)");
    expect(dts).not.toContain('"public.hstore(');

    r = prepare(["--check"]);
    expect(r.code).toBe(0);
    dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"public.tmp_catalog_slug(value text)":');

    const fullCatalogRoot = isolatedRoot("function-catalog-extensions");
    writeRootFile(fullCatalogRoot, "sqlx-js.config.ts", `export default {
      functionCatalog: { includeExtensionOwned: true },
    };\n`);
    writeRootFile(fullCatalogRoot, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT tmp_catalog_slug($1) AS slug\", \"Hello\");\n",
    );
    r = prepareRoot(fullCatalogRoot);
    expect(r.code, r.stderr).toBe(0);
    dts = readFileSync(join(fullCatalogRoot, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"public.hstore(');

    const disabledCatalogRoot = isolatedRoot("function-catalog-disabled");
    writeRootFile(disabledCatalogRoot, "sqlx-js.config.ts", "export default { functionCatalog: false };\n");
    writeRootFile(disabledCatalogRoot, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT tmp_catalog_slug($1) AS slug\", \"Hello\");\n",
    );
    r = prepareRoot(disabledCatalogRoot);
    expect(r.code, r.stderr).toBe(0);
    dts = readFileSync(join(disabledCatalogRoot, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).not.toContain('"public.tmp_catalog_slug(value text)":');
    r = prepareRoot(disabledCatalogRoot, ["--check"]);
    expect(r.code, r.stderr).toBe(0);
  });

  test("function contract warnings survive the offline cache boundary", async () => {
    const root = isolatedRoot("function-contract-diagnostics");
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT tmp_contract_unsafe()\");\n",
    );
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        CREATE OR REPLACE FUNCTION tmp_contract_unsafe() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT true $$;
        CREATE OR REPLACE FUNCTION tmp_contract_safe() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = public, pg_temp
        SET TimeZone = 'UTC'
        AS $$ SELECT true $$;
        REVOKE ALL ON FUNCTION tmp_contract_safe() FROM PUBLIC;
      `);

      let result = prepareRoot(root, ["--json"]);
      expect(result.code, result.stderr).toBe(0);
      let payload = JSON.parse(result.stdout) as {
        diagnostics: { phase: string; code?: string; functionSignature?: string }[];
      };
      expect(payload.diagnostics).toContainEqual(expect.objectContaining({
        phase: "function-contract",
        code: "security-definer-missing-search-path",
        functionSignature: "public.tmp_contract_unsafe()",
      }));
      expect(payload.diagnostics).toContainEqual(expect.objectContaining({
        phase: "function-contract",
        code: "security-definer-public-execute",
        functionSignature: "public.tmp_contract_unsafe()",
      }));
      expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8")).toMatch(
        /"public\.tmp_contract_safe\(\)".*securityDefiner: true;.*publicExecute: false; settings: readonly \["search_path=public, pg_temp", "TimeZone=UTC"\]; searchPath: "public, pg_temp"/,
      );

      result = prepareRoot(root, ["--check", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      payload = JSON.parse(result.stdout) as {
        diagnostics: { phase: string; code?: string; functionSignature?: string }[];
      };
      expect(payload.diagnostics).toContainEqual(expect.objectContaining({
        phase: "function-contract",
        code: "security-definer-missing-search-path",
        functionSignature: "public.tmp_contract_unsafe()",
      }));

      writeRootFile(root, "sqlx-js-env.d.ts", "export {};\n");
      result = prepareRoot(root, ["--check", "--warnings"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "function-contract warning: public.tmp_contract_unsafe() — SECURITY DEFINER has no function-local search_path",
      );
    } finally {
      await setup.simpleQuery(`
        DROP FUNCTION IF EXISTS tmp_contract_unsafe();
        DROP FUNCTION IF EXISTS tmp_contract_safe();
      `).catch(() => {});
      await setup.end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("columnTypes override direct scalar results and mapped parameters only", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        CREATE TABLE IF NOT EXISTS tmp_column_types (
          id bigint PRIMARY KEY,
          action text NOT NULL,
          previous_action text
        )
      `);
    } finally {
      await setup.end();
    }
    const root = isolatedRoot("column-types");
    writeRootFile(root, "sqlx-js.config.ts", `export default {
      columnTypes: {
        "public.tmp_column_types.action": '\"created\" | \"deleted\"',
        "public.tmp_column_types.previous_action": '\"created\" | \"deleted\"',
      },
    };\n`);
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT action, upper(action) AS derived FROM tmp_column_types WHERE action = $action\", { action: \"created\" });\n" +
      "await sql(\"INSERT INTO tmp_column_types (id, action) VALUES ($id, $action) RETURNING action\", { id: 1n, action: \"created\" });\n" +
      "await sql(\"UPDATE tmp_column_types SET action = CASE WHEN $preserve THEN action ELSE $action END WHERE id = $id\", { preserve: false, action: \"created\", id: 1n });\n" +
      "await sql(\"UPDATE tmp_column_types SET previous_action = NULLIF($action, $sentinel) WHERE id = $id\", { action: \"created\", sentinel: \"\", id: 1n });\n" +
      "await sql(\"UPDATE tmp_column_types SET action = GREATEST($minimumAction, action) WHERE id = $id\", { minimumAction: \"created\", id: 1n });\n",
    );
    const r = prepareRoot(root);
    expect(r.code, r.stderr).toBe(0);
    const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"action": "created" | "deleted"');
    expect(dts).toContain('"derived": string');
    expect(dts).toContain('"action": "created" | "deleted" }');
    expect(dts).toMatch(
      /UPDATE tmp_column_types SET action = CASE.*"preserve": boolean; "action": "created" \| "deleted"; "id": bigint/,
    );
    expect(dts).toMatch(
      /UPDATE tmp_column_types SET previous_action = NULLIF.*"action": "created" \| "deleted" \| null; "sentinel": string \| null; "id": bigint/,
    );
    expect(dts).toMatch(
      /UPDATE tmp_column_types SET action = GREATEST.*"minimumAction": "created" \| "deleted"; "id": bigint/,
    );
  });

  test("JSON-backed domain assertions preserve the SqlxJson boundary", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP TABLE IF EXISTS tmp_json_domain_columns;
        DROP DOMAIN IF EXISTS tmp_json_domain_payload;
        CREATE DOMAIN tmp_json_domain_payload AS jsonb;
        CREATE TABLE tmp_json_domain_columns (
          id bigint PRIMARY KEY,
          payload tmp_json_domain_payload NOT NULL
        )
      `);
    } finally {
      await setup.end();
    }
    const root = isolatedRoot("json-domain-column-types");
    writeRootFile(root, "types.ts", "export type DomainPayload = { kind: string };\n");
    writeRootFile(root, "sqlx-js.config.ts", `export default {
      columnTypes: {
        "public.tmp_json_domain_columns.payload": 'import("./types").DomainPayload',
      },
    };\n`);
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"INSERT INTO tmp_json_domain_columns (id, payload) VALUES ($id, $payload) RETURNING payload\", { id: 1n, payload: sql.json({ kind: \"created\" }) });\n",
    );
    const result = prepareRoot(root);
    expect(result.code, result.stderr).toBe(0);
    const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    const asserted = 'import("@onreza/sqlx-js").SqlxJson<import("./types").DomainPayload>';
    expect(dts).toContain(`"payload": ${asserted}`);
    expect(dts).toContain(`"payload": ${asserted} }`);
  });

  test("set operations preserve compatible application-owned column types", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        CREATE TABLE IF NOT EXISTS tmp_union_types (
          payload_a jsonb NOT NULL,
          payload_b jsonb NOT NULL,
          action_a text NOT NULL,
          action_b text NOT NULL
        )
      `);
    } finally {
      await setup.end();
    }
    const root = isolatedRoot("union-column-types");
    writeRootFile(root, "types.ts", "export type UnionPayload = { kind: string };\n");
    writeRootFile(root, "sqlx-js.config.ts", `export default {
      columnTypes: {
        "public.tmp_union_types.payload_a": 'import("./types").UnionPayload',
        "public.tmp_union_types.payload_b": 'import("./types").UnionPayload',
        "public.tmp_union_types.action_a": '"created" | "deleted"',
        "public.tmp_union_types.action_b": '"created" | "deleted"',
      },
    };\n`);
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"WITH left_source AS (SELECT payload_a AS payload, action_a AS action FROM tmp_union_types), right_source AS (SELECT payload_b AS payload, action_b AS action FROM tmp_union_types) SELECT payload, action FROM left_source UNION ALL SELECT payload, action FROM right_source\");\n",
    );
    const result = prepareRoot(root, ["--strict-inference"]);
    expect(result.code, result.stderr).toBe(0);
    const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain(
      '"payload": import("@onreza/sqlx-js").SqlxJson<import("./types").UnionPayload>',
    );
    expect(dts).toContain('"action": "created" | "deleted"');
  });

  test("validateAll describes and plans every query across a connection pool", async () => {
    const cfg = parseDatabaseUrl(dbUrl);
    const session = new PgClient(cfg);
    await session.connect();
    try {
      const queries = [
        { fp: "q1", query: "SELECT id, name FROM tmp_users WHERE id = $1" },
        { fp: "q2", query: "SELECT email FROM tmp_users" },
        { fp: "q3", query: "SELECT title FROM tmp_join_posts" },
        { fp: "q4", query: "SELECT external_id FROM tmp_join_users" },
        { fp: "qzero", query: "SELECT FROM tmp_users LIMIT 1" },
        {
          fp: "qmerge",
          query: "MERGE INTO tmp_users AS target USING (SELECT $1::bigint AS id) AS source ON target.id = source.id WHEN MATCHED THEN UPDATE SET name = target.name",
        },
        { fp: "qbad", query: "SELECT * FROM no_such_relation_xyz" },
      ];
      const results = await validateAll(cfg, session, queries, 4);
      expect(results.size).toBe(7);
      const q1 = results.get("q1")!;
      expect(q1.ok).toBe(true);
      if (q1.ok) expect(q1.fields.map((f) => f.name)).toEqual(["id", "name"]);
      const q2 = results.get("q2")!;
      if (q2.ok) expect(q2.fields.map((f) => f.name)).toEqual(["email"]);
      expect(results.get("qzero")).toMatchObject({ ok: true, fields: [], hasResultSet: true });
      expect(results.get("qmerge")).toMatchObject({ ok: true, validation: "planned" });
      expect(results.get("qbad")!.ok).toBe(false);
      // session connection stays usable after the pool drains
      const after = await session.describe("SELECT 1 AS one");
      expect(after.fields.length).toBe(1);
    } finally {
      await session.end();
    }
  });

  test("validateAll cleans up generic planning after a PostgreSQL error", async () => {
    const cfg = parseDatabaseUrl(dbUrl);
    const session = new PgClient(cfg);
    await session.connect();
    try {
      const results = await validateAll(cfg, session, [
        { fp: "bad", query: "SELECT CASE WHEN $1::boolean THEN 1 / 0 ELSE 1 END" },
        { fp: "good", query: "SELECT 1 AS value" },
      ], 1);
      expect(results.get("bad")).toMatchObject({
        ok: false,
        phase: "plan",
        error: expect.objectContaining({ code: "22012" }),
      });
      expect(results.get("good")).toMatchObject({ ok: true, validation: "planned" });
      const after = await session.simpleQuery("SELECT current_setting('plan_cache_mode')");
      expect(new TextDecoder().decode(after.rows[0]![0]!)).toBe("auto");
    } finally {
      await session.end();
    }
  });

  test("validateAll degrades to the session connection when extra workers cannot connect", async () => {
    const session = new PgClient(parseDatabaseUrl(dbUrl));
    await session.connect();
    try {
      // cfg points at a non-existent database, so every extra-worker connect fails;
      // the already-open session connection must still drain the whole queue.
      const badCfg = parseDatabaseUrl(databaseUrlWithDatabase(dbUrl, "sqlx_js_no_such_db"));
      const queries = [
        { fp: "d1", query: "SELECT 1 AS a" },
        { fp: "d2", query: "SELECT 2 AS b" },
        { fp: "d3", query: "SELECT 3 AS c" },
      ];
      const results = await validateAll(badCfg, session, queries, 4);
      expect(results.size).toBe(3);
      expect([...results.values()].every((r) => r.ok)).toBe(true);
    } finally {
      await session.end();
    }
  });

  test("composite types resolve to struct literals via SchemaCache", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery("DROP TABLE IF EXISTS tmp_comp CASCADE");
      await setup.simpleQuery("DROP TYPE IF EXISTS tmp_addr CASCADE");
      await setup.simpleQuery("DROP TYPE IF EXISTS tmp_location CASCADE");
      await setup.simpleQuery("CREATE TYPE tmp_location AS (zip int, street text)");
      await setup.simpleQuery("CREATE TYPE tmp_addr AS (zip int, street text, location tmp_location)");
      await setup.simpleQuery("CREATE TABLE tmp_comp (id bigserial primary key, addr tmp_addr)");
      const d = await setup.describe("SELECT addr FROM tmp_comp");
      const addrOid = d.fields[0]!.typeOid;
      const schema = new SchemaCache(setup);
      schema.setTypeRegistry(mergeExtensionTypes());
      await schema.loadCustomTypes([addrOid]);
      const info = schema.customType(addrOid);
      expect(info?.kind).toBe("composite");
      if (info?.kind === "composite") {
        const expected = "{ location: { street: string | null; zip: number | null } | null; street: string | null; zip: number | null }";
        expect(info.fields.map((field) => field.name)).toEqual(["zip", "street", "location"]);
        expect(compositeLiteral(info)).toBe(expected);
        expect(inputTsType(addrOid, schema)).toBe(expected);
      }
    } finally {
      await setup.simpleQuery("DROP TABLE IF EXISTS tmp_comp CASCADE").catch(() => {});
      await setup.simpleQuery("DROP TYPE IF EXISTS tmp_addr CASCADE").catch(() => {});
      await setup.simpleQuery("DROP TYPE IF EXISTS tmp_location CASCADE").catch(() => {});
      await setup.end();
    }
  });

  test("domains resolve enum labels when both types are loaded together", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP DOMAIN IF EXISTS tmp_catalog_enum_domain;
        DROP TYPE IF EXISTS tmp_catalog_enum;
        CREATE TYPE tmp_catalog_enum AS ENUM ('created', 'deleted');
        CREATE DOMAIN tmp_catalog_enum_domain AS tmp_catalog_enum NOT NULL
      `);
      const rows = await setup.simpleQueryAll(`
        SELECT 'tmp_catalog_enum_domain'::regtype::oid::int8, 'tmp_catalog_enum'::regtype::oid::int8
      `);
      const domainOid = Number(new TextDecoder().decode(rows.rows[0]![0]!));
      const enumOid = Number(new TextDecoder().decode(rows.rows[0]![1]!));
      const schema = new SchemaCache(setup);
      schema.setTypeRegistry(mergeExtensionTypes());
      await schema.loadCustomTypes([domainOid, enumOid]);
      expect(schema.customType(domainOid)).toMatchObject({
        kind: "scalar",
        tsType: '"created" | "deleted"',
        notNull: true,
      });
    } finally {
      await setup.simpleQuery("DROP DOMAIN IF EXISTS tmp_catalog_enum_domain").catch(() => {});
      await setup.simpleQuery("DROP TYPE IF EXISTS tmp_catalog_enum").catch(() => {});
      await setup.end();
    }
  });

  test("prepare prunes orphaned cache entries by default", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    let r = prepare();
    expect(r.code).toBe(0);
    const firstFiles = queryCacheFiles();
    expect(firstFiles.length).toBe(1);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT name FROM tmp_users\");\n",
    );
    r = prepare(["--verbose"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pruned 1 orphaned/);
    const second = queryCacheFiles();
    expect(second.length).toBe(1);
    expect(second[0]).not.toBe(firstFiles[0]);
  });

  test("live prepare replaces a legacy orphaned cache entry", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    let result = prepare();
    expect(result.code).toBe(0);
    const [legacyFile] = queryCacheFiles();
    expect(legacyFile).toBeDefined();
    const legacyPath = join(tmp, ".sqlx-js", legacyFile!);
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
    delete legacy.resultElementNonNullOverrides;
    writeFileSync(legacyPath, JSON.stringify(legacy));

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT name FROM tmp_users\");\n",
    );
    result = prepare(["--verbose"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/pruned 1 orphaned/);
    expect(existsSync(legacyPath)).toBe(false);
    expect(queryCacheFiles()).toHaveLength(1);
  });

  test("prepare --no-prune retains orphaned cache entries", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    let r = prepare();
    expect(r.code).toBe(0);
    const first = queryCacheFiles();

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT name FROM tmp_users\");\n",
    );
    r = prepare(["--no-prune"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/pruned/);
    const second = queryCacheFiles();
    expect(second.length).toBe(first.length + 1);

    r = prepare(["--check"]);
    expect(r.code).toBe(0);
  });

  test("prepare --check is read-only and --offline regenerates inline variants", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users WHERE id = $1\", 1);\n",
    );
    let r = prepare();
    expect(r.code).toBe(0);
    expect(queryCacheFiles()).toHaveLength(1);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users WHERE id = $1\", 1);\n" +
      "await sql(\"SELECT  id  FROM tmp_users WHERE id = $1\", 1);\n",
    );
    r = prepare(["--check"]);
    expect(r.code).toBe(1);
    let dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).not.toContain('"SELECT  id  FROM tmp_users WHERE id = $1":');

    r = prepare(["--offline"]);
    expect(r.code).toBe(0);
    dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"SELECT id FROM tmp_users WHERE id = $1":');
    expect(dts).toContain('"SELECT  id  FROM tmp_users WHERE id = $1":');
  });

  test("prepare --check reports a stale declaration without replacing it", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    expect(prepare().code).toBe(0);
    writeFile("sqlx-js-env.d.ts", "export {};\n");

    const checked = prepare(["--check", "--json"]);
    expect(checked.code).toBe(1);
    expect(readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8")).toBe("export {};\n");
    expect(JSON.parse(checked.stdout).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "generated declaration is stale or missing",
        file: "sqlx-js-env.d.ts",
      }),
    ]));

    expect(prepare(["--offline"]).code).toBe(0);
    expect(readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8")).toContain("SELECT id FROM tmp_users");
  });

  test("unqualified DML parameters follow the prepare session search_path", async () => {
    const root = isolatedRoot("search-path");
    const client = new PgClient(parseDatabaseUrl(dbUrl));
    await client.connect();
    try {
      await client.simpleQuery(`
        DROP TABLE IF EXISTS public.tmp_search_path_target;
        DROP SCHEMA IF EXISTS tmp_search_path CASCADE;
        CREATE TABLE public.tmp_search_path_target (payload jsonb NOT NULL);
        CREATE SCHEMA tmp_search_path;
        CREATE TABLE tmp_search_path.tmp_search_path_target (payload jsonb);
      `);
      writeRootFile(root, "a.ts",
        "import { sql } from \"@onreza/sqlx-js\";\n" +
        "await sql(\"INSERT INTO tmp_search_path_target (payload) VALUES ($1)\", sql.json({ ok: true }));\n" +
        "await sql(\"SELECT payload FROM tmp_search_path_target\");\n",
      );
      writeRootFile(root, "sqlx-js.config.ts", `export default {
  columnTypes: { "tmp_search_path.tmp_search_path_target.payload": "SearchPathPayload" },
};
`);
      const url = new URL(dbUrl);
      url.searchParams.set("options", "-c search_path=tmp_search_path,public");
      const result = spawnSync(
        "bun",
        [join(repoRoot, "bin/sqlx-js.ts"), "prepare", "--root", root],
        { env: { ...process.env, DATABASE_URL: url.toString() }, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
      expect(dts).toContain('SqlxJson<SearchPathPayload> | null');
      expect(dts).toContain('"payload": import("@onreza/sqlx-js").SqlxJson<SearchPathPayload> | null');
    } finally {
      await client.simpleQuery("DROP TABLE IF EXISTS public.tmp_search_path_target; DROP SCHEMA IF EXISTS tmp_search_path CASCADE");
      await client.end();
    }
  });

  test("sql.file produces a generated file-query entry keyed by path", () => {
    writeFile("queries/by_id.sql", "SELECT id, name FROM tmp_users WHERE id = $1\n");
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.file(\"./queries/by_id.sql\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("interface SqlxJsGeneratedFileQueries");
    expect(dts).toContain('"./queries/by_id.sql":');
  });

  test("sql.file with missing path errors at scan time with file:line:column", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.file(\"./nope.sql\");\n",
    );
    const r = prepare();
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/a\.ts:2:16.*nope\.sql/s);
  });

  test("snapshot dump/check writes schema contract and LLM manifest", () => {
    writeFile("migrations/0008_schema_contract.up.sql",
      "CREATE TABLE IF NOT EXISTS tmp_contract_posts (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  user_id BIGINT NOT NULL REFERENCES tmp_users(id) ON DELETE CASCADE,\n" +
      "  rating INT CHECK (rating >= 0),\n" +
      "  title TEXT NOT NULL UNIQUE\n" +
      ");\n" +
      "CREATE INDEX IF NOT EXISTS tmp_contract_posts_user_id_idx ON tmp_contract_posts(user_id);\n" +
      "CREATE OR REPLACE FUNCTION tmp_contract_slug(value text) RETURNS text\n" +
      "LANGUAGE sql IMMUTABLE STRICT SET TimeZone = 'UTC' AS $$ SELECT lower(value) $$;\n" +
      "CREATE SCHEMA IF NOT EXISTS pgx;\n" +
      "CREATE TABLE IF NOT EXISTS pgx.keep_me (id INT PRIMARY KEY);\n",
    );
    writeFile("migrations/0008_schema_contract.down.sql",
      "DROP FUNCTION IF EXISTS tmp_contract_slug(text);\n" +
      "DROP TABLE IF EXISTS tmp_contract_posts;\n" +
      "DROP SCHEMA IF EXISTS pgx CASCADE;\n",
    );
    const mig = migrate();
    expect(mig.code).toBe(0);

    const dump = snapshot(["dump"]);
    expect(dump.code).toBe(0);
    const raw = readFileSync(join(tmp, ".sqlx-js/schema/schema.json"), "utf8");
    const schemaSnapshot = JSON.parse(raw) as {
      relations: { schema: string; name: string; constraints: { kind: string; references?: { table: string } }[]; indexes: { name: string }[] }[];
      functions: {
        name: string;
        language: string;
        volatility: string;
        strict: boolean;
        publicExecute: boolean;
        settings: string[];
        searchPath: string | null;
      }[];
    };
    const rel = schemaSnapshot.relations.find((r) => r.name === "tmp_contract_posts");
    expect(rel).toBeTruthy();
    expect(schemaSnapshot.relations.some((r) => r.name === "keep_me" && r.schema === "pgx")).toBe(true);
    expect(rel!.constraints.some((c) => c.kind === "foreign_key" && c.references?.table === "tmp_users")).toBe(true);
    expect(rel!.constraints.some((c) => c.kind === "check")).toBe(true);
    expect(rel!.indexes.some((i) => i.name === "tmp_contract_posts_user_id_idx")).toBe(true);
    expect(schemaSnapshot.functions.find((f) => f.name === "tmp_contract_slug")).toMatchObject({
      language: "sql",
      volatility: "immutable",
      strict: true,
      publicExecute: true,
      settings: ["TimeZone=UTC"],
      searchPath: null,
    });

    const manifest = readFileSync(join(tmp, ".sqlx-js/schema/schema.md"), "utf8");
    expect(manifest).toContain("tmp_contract_posts");
    expect(manifest).toContain("tmp_contract_slug(value text) -> text");
    expect(manifest).toContain("language sql");
    expect(manifest).toContain('settings ["TimeZone=UTC"]');

    const check = snapshot(["check"]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("snapshot: ok");
  });

  test("migrate revert --dry-run validates reversible down on an automatic shadow database", () => {
    const root = isolatedRoot("revert-dry-run-ok");
    writeRootFile(root, "migrations/0001_base.up.sql",
      "CREATE TABLE tmp_revert_dry_run_ok_users (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  name TEXT NOT NULL\n" +
      ");\n",
    );
    writeRootFile(root, "migrations/0001_base.down.sql", "DROP TABLE IF EXISTS tmp_revert_dry_run_ok_users;\n");
    writeRootFile(root, "migrations/0002_add_email.up.sql",
      "ALTER TABLE tmp_revert_dry_run_ok_users ADD COLUMN email TEXT;\n",
    );
    writeRootFile(root, "migrations/0002_add_email.down.sql",
      "ALTER TABLE tmp_revert_dry_run_ok_users DROP COLUMN email;\n",
    );

    const r = migrateCommand(["revert", "--dry-run"], root);

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("shadow: created");
    expect(r.stdout).toContain("revert dry-run: 0002_add_email restores schema");
    expect(r.stdout).toContain("shadow: dropped");
  });

  test("migrate revert --dry-run --json keeps stdout machine-readable with automatic shadow", () => {
    const root = isolatedRoot("revert-dry-run-json");
    writeRootFile(root, "migrations/0001_base.up.sql",
      "CREATE TABLE tmp_revert_dry_run_json_users (id BIGSERIAL PRIMARY KEY);\n",
    );
    writeRootFile(root, "migrations/0001_base.down.sql",
      "DROP TABLE IF EXISTS tmp_revert_dry_run_json_users;\n",
    );

    const r = migrateCommand(["revert", "--dry-run", "--json"], root);

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).not.toContain("shadow:");
    expect(JSON.parse(r.stdout)).toEqual({
      kind: "passed",
      version: 1,
      name: "base",
    });
  });

  test("migrate revert --dry-run fails when down leaves schema drift", () => {
    const root = isolatedRoot("revert-dry-run-bad");
    writeRootFile(root, "migrations/0001_base.up.sql",
      "CREATE TABLE tmp_revert_dry_run_bad_users (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  name TEXT NOT NULL\n" +
      ");\n",
    );
    writeRootFile(root, "migrations/0001_base.down.sql", "DROP TABLE IF EXISTS tmp_revert_dry_run_bad_users;\n");
    writeRootFile(root, "migrations/0002_add_email.up.sql",
      "ALTER TABLE tmp_revert_dry_run_bad_users ADD COLUMN email TEXT;\n",
    );
    writeRootFile(root, "migrations/0002_add_email.down.sql", "SELECT 1;\n");

    const r = migrateCommand(["revert", "--dry-run"], root);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("revert dry-run: 0002_add_email down did not restore schema");
    expect(r.stderr).toContain("relations changed: public.tmp_revert_dry_run_bad_users");
    expect(r.stdout).toContain("shadow: created");
    expect(r.stdout).toContain("shadow: dropped");
  });

  test("migrate revert --dry-run respects squash adoption in review mode", () => {
    const root = isolatedRoot("revert-dry-run-squash");
    const baseSql = "CREATE TABLE tmp_revert_dry_run_squash_users (id BIGSERIAL PRIMARY KEY);\n";
    const metadata = {
      format: 1,
      replaces: [{ version: 1, name: "base", upHash: hash(baseSql) }],
    };
    writeRootFile(root, "migrations/0001_base.up.sql", baseSql);
    writeRootFile(root, "migrations/0001_base.down.sql", "DROP TABLE IF EXISTS tmp_revert_dry_run_squash_users;\n");
    writeRootFile(root, "migrations/0002_baseline.up.sql",
      `-- sqlx-js-squash: ${JSON.stringify(metadata)}\n` +
      "CREATE TABLE tmp_revert_dry_run_squash_users (id BIGSERIAL PRIMARY KEY);\n",
    );
    writeRootFile(root, "migrations/0003_add_name.up.sql",
      "ALTER TABLE tmp_revert_dry_run_squash_users ADD COLUMN name TEXT;\n",
    );
    writeRootFile(root, "migrations/0003_add_name.down.sql",
      "ALTER TABLE tmp_revert_dry_run_squash_users DROP COLUMN name;\n",
    );

    const r = migrateCommand(["revert", "--dry-run"], root);

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("shadow: created");
    expect(r.stdout).toContain("revert dry-run: 0003_add_name restores schema");
    expect(r.stdout).toContain("shadow: dropped");
  });

  test("migrate run resets pg_dump session state before later migrations", () => {
    const root = isolatedRoot("migrate-session-reset");
    writeRootFile(root, "migrations/0201_baseline.up.sql",
      "SELECT pg_catalog.set_config('search_path', '', false);\n" +
      "CREATE TABLE public.tmp_migrate_session_reset_users (id BIGSERIAL PRIMARY KEY);\n",
    );
    writeRootFile(root, "migrations/0202_add_name.up.sql",
      "ALTER TABLE tmp_migrate_session_reset_users ADD COLUMN name TEXT;\n",
    );

    const r = migrateCommand(["run"], root);

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("applying 201_baseline");
    expect(r.stdout).toContain("applying 202_add_name");
  });

  test("migrate revert --dry-run isolates an already-used shadow database", async () => {
    const root = isolatedRoot("revert-dry-run-reused-shadow");
    writeRootFile(root, "migrations/0211_base.up.sql",
      "CREATE TABLE tmp_revert_dry_run_reused_shadow_users (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  name TEXT NOT NULL\n" +
      ");\n",
    );
    writeRootFile(root, "migrations/0211_base.down.sql",
      "DROP TABLE IF EXISTS tmp_revert_dry_run_reused_shadow_users;\n",
    );
    writeRootFile(root, "migrations/0212_add_email.up.sql",
      "ALTER TABLE tmp_revert_dry_run_reused_shadow_users ADD COLUMN email TEXT;\n",
    );
    writeRootFile(root, "migrations/0212_add_email.down.sql",
      "ALTER TABLE tmp_revert_dry_run_reused_shadow_users DROP COLUMN email;\n",
    );

    const shadowDatabaseUrl = await createShadowDatabase("sqlx_js_reused_shadow");
    const applied = migrateCommand(["run"], root, shadowDatabaseUrl);
    expect(applied.code).toBe(0);

    const r = migrateCommand(["revert", "--dry-run", "--shadow-url", shadowDatabaseUrl], root);

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("revert dry-run: 0212_add_email restores schema");
  });

  test("verify uses built-in migrations in a shadow database", () => {
    const root = isolatedRoot("migrate-verify-auto-shadow");
    try {
      writeRootFile(root, "migrations/0301_base.up.sql",
        "CREATE TABLE tmp_migrate_verify_auto_shadow_users (\n" +
        "  id BIGSERIAL PRIMARY KEY,\n" +
        "  email TEXT NOT NULL\n" +
        ");\n" +
        "\n" +
        "CREATE FUNCTION tmp_migrate_verify_auto_shadow_normalize(value text)\n" +
        "RETURNS text\n" +
        "LANGUAGE sql\n" +
        "IMMUTABLE\n" +
        "STRICT\n" +
        "AS $$\n" +
        "  SELECT lower(value)\n" +
        "$$;\n",
      );
      writeRootFile(root, "migrations/0301_base.down.sql",
        "DROP FUNCTION IF EXISTS tmp_migrate_verify_auto_shadow_normalize(text);\n" +
        "DROP TABLE IF EXISTS tmp_migrate_verify_auto_shadow_users;\n",
      );
      writeRootFile(root, "a.ts",
        "import { sql } from \"@onreza/sqlx-js\";\n" +
        "await sql(\"SELECT id, email FROM tmp_migrate_verify_auto_shadow_users WHERE email = $1\", \"x\");\n",
      );

      const generated = workflowCommand("dev", root);
      expect(generated.code).toBe(0);
      const beforeDts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
      expect(beforeDts).toContain("\"public.tmp_migrate_verify_auto_shadow_normalize(value text)\"");
      expect(beforeDts).toContain("publicExecute: true");
      const beforeCache = queryCacheFiles(root)
        .sort()
        .map((name) => [name, readFileSync(join(root, ".sqlx-js", name), "utf8")]);

      const r = workflowCommand("verify", root);

      expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
      expect(r.stdout).toContain("shadow: created");
      expect(r.stdout).toContain("generated artifacts are current");
      expect(r.stdout).toContain("shadow: dropped");
      expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8")).toBe(beforeDts);
      expect(queryCacheFiles(root)
        .sort()
        .map((name) => [name, readFileSync(join(root, ".sqlx-js", name), "utf8")]))
        .toEqual(beforeCache);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verify rejects a committed snapshot expanded beyond the schema source", async () => {
    const root = isolatedRoot("verify-snapshot-source");
    const shadowDatabaseUrl = await createShadowDatabase(
      `sqlx_js_verify_snapshot_${process.pid}_${Date.now().toString(36)}`,
    );
    try {
      writeRootFile(root, "migrations/0302_base.up.sql",
        "CREATE TABLE tmp_verify_snapshot_users (\n"
        + "  id BIGSERIAL PRIMARY KEY,\n"
        + "  email TEXT NOT NULL\n"
        + ");\n",
      );
      writeRootFile(root, "migrations/0302_base.down.sql",
        "DROP TABLE IF EXISTS tmp_verify_snapshot_users;\n",
      );
      writeRootFile(root, "a.ts",
        "import { sql } from \"@onreza/sqlx-js\";\n"
        + "await sql(\"SELECT id, email FROM tmp_verify_snapshot_users WHERE id = $1\", 1);\n",
      );

      const generated = workflowCommand("dev", root, dbUrl, ["--shadow-url", shadowDatabaseUrl]);
      expect({ code: generated.code, stderr: generated.stderr }).toEqual({ code: 0, stderr: "" });
      const dumped = snapshot(["dump", "--shadow-url", shadowDatabaseUrl], root);
      expect({ code: dumped.code, stderr: dumped.stderr }).toEqual({ code: 0, stderr: "" });

      const current = workflowCommand("verify", root, dbUrl, ["--shadow-url", shadowDatabaseUrl]);
      expect({ code: current.code, stderr: current.stderr }).toEqual({ code: 0, stderr: "" });
      expect(current.stdout).toContain("snapshot: ok");

      const snapshotPath = join(root, ".sqlx-js/schema/schema.json");
      const poisoned = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
        relations: { name: string; columns: Record<string, unknown>[] }[];
      };
      const users = poisoned.relations.find((relation) => relation.name === "tmp_verify_snapshot_users")!;
      users.columns.push({
        ...users.columns[0],
        name: "forbidden_secret",
        ordinal: users.columns.length + 1,
      });
      writeFileSync(snapshotPath, JSON.stringify(poisoned, null, 2) + "\n");

      const rejected = workflowCommand("verify", root, dbUrl, ["--shadow-url", shadowDatabaseUrl]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("snapshot is stale");
    } finally {
      await dropDatabase(shadowDatabaseUrl);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dev uses built-in migrations and writes prepare artifacts", () => {
    const root = isolatedRoot("migrate-dev-auto-shadow");
    try {
      writeRootFile(root, "migrations/0311_base.up.sql",
        "CREATE TABLE tmp_migrate_dev_auto_shadow_users (\n" +
        "  id BIGSERIAL PRIMARY KEY,\n" +
        "  name TEXT NOT NULL\n" +
        ");\n",
      );
      writeRootFile(root, "migrations/0311_base.down.sql",
        "DROP TABLE IF EXISTS tmp_migrate_dev_auto_shadow_users;\n",
      );
      writeRootFile(root, "a.ts",
        "import { sql } from \"@onreza/sqlx-js\";\n" +
        "await sql(\"SELECT id, name FROM tmp_migrate_dev_auto_shadow_users WHERE id = $1\", 1);\n",
      );

      const r = workflowCommand("dev", root);

      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("shadow: created");
      expect(r.stdout).toContain("prepared 1 unique query");
      expect(r.stdout).toContain("shadow: dropped");
      const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
      expect(dts).toContain("tmp_migrate_dev_auto_shadow_users");
      expect(queryCacheFiles(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pgschema dev materializer owns only the disposable shadow", async () => {
    const root = isolatedRoot("pgschema-materializer-dev");
    try {
      const materializer = join(root, "materialize.ts");
      writeRootFile(root, "sqlx-js.config.ts", `export default {
        schema: {
          provider: "pgschema",
          materializer: { command: "bun", args: [${JSON.stringify(materializer)}] },
        },
      };\n`);
      writeRootFile(root, "materialize.ts", `
        import { PgClient, parseDatabaseUrl } from ${JSON.stringify(join(repoRoot, "src/pg/wire.ts"))};
        const client = new PgClient(parseDatabaseUrl(process.env.SQLX_JS_SHADOW_DATABASE_URL!));
        await client.connect();
        try {
          await client.simpleQuery("CREATE TABLE tmp_custom_materializer (id bigint PRIMARY KEY)");
        } finally {
          await client.end();
        }
      `);
      writeRootFile(root, "query.ts",
        'import { sql } from "@onreza/sqlx-js";\nawait sql("SELECT id FROM tmp_custom_materializer");\n',
      );

      const result = workflowCommand("dev", root, dbUrl, ["--strict-inference"]);
      expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8"))
        .toContain("SELECT id FROM tmp_custom_materializer");

      const target = new PgClient(parseDatabaseUrl(dbUrl));
      await target.connect();
      try {
        const relation = await target.simpleQueryAll(
          "SELECT to_regclass('public.tmp_custom_materializer')",
        );
        expect(relation.rows[0]![0]).toBeNull();
      } finally {
        await target.end();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("built-in extension types resolve via the registry", () => {
    writeFile("migrations/0002_ext.up.sql",
      "CREATE EXTENSION IF NOT EXISTS vector;\n" +
      "CREATE EXTENSION IF NOT EXISTS hstore;\n" +
      "CREATE EXTENSION IF NOT EXISTS citext;\n" +
      "CREATE EXTENSION IF NOT EXISTS ltree;\n" +
      "CREATE TABLE IF NOT EXISTS tmp_ext (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  embedding vector(3),\n" +
      "  tags hstore,\n" +
      "  slug citext NOT NULL,\n" +
      "  path ltree NOT NULL\n" +
      ");\n",
    );
    writeFile("migrations/0002_ext.down.sql", "DROP TABLE IF EXISTS tmp_ext;\n");
    const mig = migrate();
    expect(mig.code).toBe(0);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id, embedding, tags, slug, path FROM tmp_ext WHERE id = $1\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"embedding": number[] | null');
    expect(dts).toContain('"tags": Record<string, string | null> | null');
    expect(dts).toContain('"slug": string');
    expect(dts).toContain('"path": string');
  });

  test("user customTypes override built-in defaults", () => {
    writeFile("sqlx-js.config.ts",
      "import type { SqlxJsConfig } from \"@onreza/sqlx-js\";\n" +
      "const c: SqlxJsConfig = { customTypes: { vector: \"Float32Array\" } };\n" +
      "export default c;\n",
    );
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id, embedding FROM tmp_ext WHERE id = $1\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"embedding": Float32Array | null');
    expect(dts).toContain('"vector": Float32Array;');
    expect(dts).toContain("runtimeTypes: SqlxJsGeneratedRuntimeTypes;");
    rmSync(join(tmp, "sqlx-js.config.ts"), { force: true });
  });

  test("user customTypes override enum and composite contracts but reject domains", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP TYPE IF EXISTS tmp_custom_payload CASCADE;
        DROP DOMAIN IF EXISTS tmp_custom_code CASCADE;
        DROP DOMAIN IF EXISTS tmp_custom_status_domain CASCADE;
        DROP TYPE IF EXISTS tmp_custom_status CASCADE;
        CREATE TYPE tmp_custom_status AS ENUM ('active', 'disabled');
        CREATE DOMAIN tmp_custom_code AS text;
        CREATE DOMAIN tmp_custom_status_domain AS tmp_custom_status;
        CREATE TYPE tmp_custom_payload AS (label text, count integer);
      `);
    } finally {
      await setup.end();
    }
    writeFile("sqlx-js.config.ts",
      "export default { customTypes: {\n" +
      "  tmp_custom_status: \"RuntimeStatus\",\n" +
      "  tmp_custom_payload: \"RuntimePayload\",\n" +
      "} };\n",
    );
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT $1::tmp_custom_status AS status, $2::tmp_custom_payload AS payload, $3::tmp_custom_status[] AS statuses, $4::tmp_custom_payload[] AS payloads, $5::tmp_custom_status_domain AS domain_status\", null, null, null, null, null);\n",
    );
    try {
      const r = prepare();
      expect(r.code, r.stderr).toBe(0);
      const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
      expect(dts).toContain("params: [RuntimeStatus, RuntimePayload, import(\"@onreza/sqlx-js\").PgArrayParameter<RuntimeStatus, boolean>, import(\"@onreza/sqlx-js\").PgArrayParameter<RuntimePayload, boolean>, RuntimeStatus]");
      expect(dts).toContain('"status": RuntimeStatus | null');
      expect(dts).toContain('"payload": RuntimePayload | null');
      expect(dts).toContain('"statuses": (RuntimeStatus | null)[] | null');
      expect(dts).toContain('"payloads": (RuntimePayload | null)[] | null');
      expect(dts).toContain('"domain_status": RuntimeStatus | null');
      expect(dts).toContain('"tmp_custom_status": RuntimeStatus;');
      expect(dts).toContain('"tmp_custom_payload": RuntimePayload;');
      expect(prepare(["--check"]).code).toBe(0);
      writeFile("sqlx-js-env.d.ts", "export {};\n");
      expect(prepare(["--offline"]).code).toBe(0);
      expect(readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8")).toContain(
        '"tmp_custom_payload": RuntimePayload;',
      );
      expect(prepare(["--verify"]).code).toBe(0);

      writeFile("sqlx-js.config.ts",
        "export default { customTypes: { tmp_custom_code: \"RuntimeCode\" } };\n",
      );
      writeFile("a.ts",
        "import { sql } from \"@onreza/sqlx-js\";\n" +
        "await sql(\"SELECT $1::tmp_custom_code AS code\", null);\n",
      );
      const domain = prepare();
      expect(domain.code).toBe(1);
      expect(domain.stderr).toContain(
        "customTypes cannot override PostgreSQL domain tmp_custom_code because PostgreSQL reports domain results as the base type",
      );

      writeFile("sqlx-js.config.ts",
        "export default { customTypes: { text: \"RuntimeText\" } };\n",
      );
      const system = prepare();
      expect(system.code).toBe(1);
      expect(system.stderr).toContain("customTypes cannot override PostgreSQL system type text");

      writeFile("sqlx-js.config.ts",
        "export default { customTypes: { tmp_missing_type: \"MissingType\" } };\n",
      );
      const missing = prepare();
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain(
        "customTypes type tmp_missing_type does not exist in the prepare database",
      );
      const diagnosis = doctor(["--json"]);
      expect(diagnosis.code).toBe(1);
      const doctorPayload = JSON.parse(diagnosis.stdout) as {
        checks: { name: string; status: string; message: string }[];
      };
      expect(doctorPayload.checks.find((check) => check.name === "runtimeTypes")).toMatchObject({
        status: "error",
        message: expect.stringContaining("customTypes type tmp_missing_type does not exist"),
      });
    } finally {
      rmSync(join(tmp, "sqlx-js.config.ts"), { force: true });
    }
  });

  test("domain types resolve to their base TS type", () => {
    writeFile("migrations/0003_domain.up.sql",
      "CREATE DOMAIN tmp_positive_int AS integer CHECK (VALUE > 0);\n" +
      "CREATE TABLE IF NOT EXISTS tmp_counters (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  value tmp_positive_int NOT NULL\n" +
      ");\n",
    );
    writeFile("migrations/0003_domain.down.sql",
      "DROP TABLE IF EXISTS tmp_counters;\n" +
      "DROP DOMAIN IF EXISTS tmp_positive_int;\n",
    );
    const mig = migrate();
    expect(mig.code).toBe(0);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id, value FROM tmp_counters\");\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"value": number');
  });

  test("COALESCE($N, col) makes the param nullable in emitted .d.ts", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"UPDATE tmp_users SET name = COALESCE($1, name) WHERE id = $2\", null, 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/COALESCE\(\$1, name\).*params: \[string \| null, bigint\]/);
  });

  test("defineQuery nullableParams widens direct PostgreSQL function inputs", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        CREATE OR REPLACE FUNCTION tmp_nullable_input(at timestamptz, operation_id text)
        RETURNS text
        LANGUAGE SQL
        AS $$ SELECT COALESCE(operation_id, at::text, 'none') $$
      `);
      writeFile("a.ts",
        "import { defineQuery } from \"@onreza/sqlx-js\";\n" +
        "export const call = defineQuery.one(\n" +
        "  \"tmp.nullableInput\",\n" +
        "  \"SELECT tmp_nullable_input($at::timestamptz, $operationId::text) AS value\",\n" +
        "  { nullableParams: [\"at\", \"operationId\"] },\n" +
        ");\n",
      );
      const result = prepare();
      expect(result.code, result.stderr).toBe(0);
      const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
      expect(dts).toMatch(/"at": import\("@onreza\/sqlx-js"\)\.PgTimestamptz<TemporalProvider> \| null; "operationId": string \| null/);
      const entry = queryCacheFiles().map((file) =>
        JSON.parse(readFileSync(join(tmp, ".sqlx-js", file), "utf8")) as {
          nullableParamOverrides: number[];
          inference: { params: { reason: string }[] };
        }
      ).find((candidate) => candidate.nullableParamOverrides.length === 2);
      expect(entry?.nullableParamOverrides).toEqual([1, 2]);
      expect(entry?.inference.params[0]?.reason).toContain("defineQuery source contract");

      writeFile("a.ts",
        "import { defineQuery } from \"@onreza/sqlx-js\";\n" +
        "export const call = defineQuery.one(\n" +
        "  \"tmp.nullableInput\",\n" +
        "  \"SELECT tmp_nullable_input($at::timestamptz, $operationId::text) AS value\",\n" +
        ");\n",
      );
      const stale = prepareRoot(tmp, ["--check", "--json"]);
      expect(stale.code).toBe(1);
      expect(JSON.parse(stale.stdout).diagnostics).toContainEqual(expect.objectContaining({
        phase: "cache",
        message: expect.stringContaining("source nullable parameter contract changed"),
      }));

      writeFile("a.ts",
        "import { defineQuery } from \"@onreza/sqlx-js\";\n" +
        "export const insert = defineQuery.execute(\n" +
        "  \"tmp.invalidNullableInsert\",\n" +
        "  \"INSERT INTO tmp_users (name, email) VALUES ($name, $email)\",\n" +
        "  { nullableParams: [\"name\"] },\n" +
        ");\n",
      );
      const invalid = prepareRoot(tmp, ["--json"]);
      expect(invalid.code).toBe(1);
      expect(JSON.parse(invalid.stdout).diagnostics).toContainEqual(expect.objectContaining({
        phase: "param-map",
        message: expect.stringContaining("maps to a NOT NULL stored target"),
      }));
    } finally {
      await setup.simpleQuery("DROP FUNCTION IF EXISTS tmp_nullable_input(timestamptz, text)");
      await setup.end();
    }
  });

  test("defineQuery resultAssertions narrows array elements across function outputs", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP FUNCTION IF EXISTS tmp_result_assertion();
        DROP TYPE IF EXISTS tmp_result_assertion_role;
        CREATE TYPE tmp_result_assertion_role AS ENUM ('admin', 'member');
        CREATE FUNCTION tmp_result_assertion()
        RETURNS TABLE(capabilities tmp_result_assertion_role[])
        LANGUAGE SQL
        STABLE
        AS $$ SELECT ARRAY['admin'::tmp_result_assertion_role] $$
      `);
      const root = isolatedRoot("result-assertions");
      const query = 'SELECT capabilities AS "capabilities!" FROM tmp_result_assertion()';
      const nullableValueQuery = "SELECT capabilities FROM tmp_result_assertion()";
      const filteredAggregateQuery = 'SELECT array_agg(value) FILTER (WHERE value IS NOT NULL) AS "values!" FROM (VALUES (1), (NULL)) AS source(value)';
      writeRootFile(root, "a.ts",
        "import { defineQuery } from \"@onreza/sqlx-js\";\n" +
        "export const claim = defineQuery.one(\n" +
        "  \"delivery.claim\",\n" +
        `  ${JSON.stringify(query)},\n` +
        "  { resultAssertions: { capabilities: { elements: \"non-null\" } } },\n" +
        ");\n" +
        "export const nullableValue = defineQuery.one(\n" +
        `  "delivery.nullableValue", ${JSON.stringify(nullableValueQuery)},\n` +
        "  { resultAssertions: { capabilities: { elements: \"non-null\" } } },\n" +
        ");\n" +
        "export const filteredAggregate = defineQuery.one(\n" +
        `  "delivery.filteredAggregate", ${JSON.stringify(filteredAggregateQuery)},\n` +
        "  { resultAssertions: { values: { elements: \"non-null\" } } },\n" +
        ");\n",
      );
      const result = prepareRoot(root, ["--strict-inference"]);
      expect(result.code, result.stderr).toBe(0);
      const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
      expect(dts).toContain('"capabilities": ("admin" | "member")[]');
      const entry = JSON.parse(
        readFileSync(join(root, ".sqlx-js", `${fingerprint(query)}.json`), "utf8"),
      ) as { resultElementNonNullOverrides: string[] };
      expect(entry.resultElementNonNullOverrides).toEqual(["capabilities"]);
      const nullableValueEntry = JSON.parse(
        readFileSync(join(root, ".sqlx-js", `${fingerprint(nullableValueQuery)}.json`), "utf8"),
      ) as { columns: { name: string; tsType: string; nullable: boolean; override?: string }[] };
      expect(nullableValueEntry.columns[0]).toMatchObject({
        name: "capabilities",
        tsType: '("admin" | "member")[]',
        nullable: true,
      });
      expect(nullableValueEntry.columns[0]?.override).toBeUndefined();
      const filteredAggregateEntry = JSON.parse(
        readFileSync(join(root, ".sqlx-js", `${fingerprint(filteredAggregateQuery)}.json`), "utf8"),
      ) as { columns: { name: string; tsType: string; nullable: boolean; override?: string }[] };
      expect(filteredAggregateEntry.columns[0]).toMatchObject({
        name: "values",
        tsType: "(number)[]",
        nullable: true,
        override: "non-null",
      });
      const verified = prepareRoot(root, ["--verify", "--strict-inference"]);
      expect(verified.code, verified.stderr).toBe(0);
      const checked = prepareRoot(root, ["--check", "--strict-inference"]);
      expect(checked.code, checked.stderr).toBe(0);
      const offline = prepareRoot(root, ["--offline", "--strict-inference"]);
      expect(offline.code, offline.stderr).toBe(0);

      writeRootFile(root, "a.ts",
        "import { defineQuery } from \"@onreza/sqlx-js\";\n" +
        `export const claim = defineQuery.one("delivery.claim", ${JSON.stringify(query)});\n`,
      );
      const stale = prepareRoot(root, ["--check", "--json"]);
      expect(stale.code).toBe(1);
      expect(JSON.parse(stale.stdout).diagnostics).toContainEqual(expect.objectContaining({
        phase: "cache",
        message: expect.stringContaining("source result assertion contract changed"),
      }));
      const staleOffline = prepareRoot(root, ["--offline", "--json"]);
      expect(staleOffline.code).toBe(1);
      expect(JSON.parse(staleOffline.stdout).diagnostics).toContainEqual(expect.objectContaining({
        phase: "cache",
        message: expect.stringContaining("source result assertion contract changed"),
      }));

      writeRootFile(root, "a.ts",
        "import { defineQuery } from \"@onreza/sqlx-js\";\n" +
        "export const claim = defineQuery.one(\n" +
        `  "delivery.claim", ${JSON.stringify(query)},\n` +
        "  { resultAssertions: { missing: { elements: \"non-null\" } } },\n" +
        ");\n",
      );
      const missing = prepareRoot(root, ["--json"]);
      expect(missing.code).toBe(1);
      expect(JSON.parse(missing.stdout).diagnostics).toContainEqual(expect.objectContaining({
        phase: "result-shape",
        message: expect.stringContaining('references unknown result column "missing"'),
      }));

      writeRootFile(root, "a.ts",
        "import { defineQuery } from \"@onreza/sqlx-js\";\n" +
        "export const scalar = defineQuery.one(\n" +
        "  \"delivery.scalar\", \"SELECT 1 AS count\",\n" +
        "  { resultAssertions: { count: { elements: \"non-null\" } } },\n" +
        ");\n",
      );
      const scalar = prepareRoot(root, ["--json"]);
      expect(scalar.code).toBe(1);
      expect(JSON.parse(scalar.stdout).diagnostics).toContainEqual(expect.objectContaining({
        phase: "result-shape",
        message: expect.stringContaining('column "count" must have a PostgreSQL array type'),
      }));

      expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8")).toBe(dts);
    } finally {
      await setup.simpleQuery(
        "DROP FUNCTION IF EXISTS tmp_result_assertion(); DROP TYPE IF EXISTS tmp_result_assertion_role",
      );
      await setup.end();
    }
  });

  test("INSERT into nullable column emits nullable param type", () => {
    writeFile("migrations/0004_bio.up.sql",
      "ALTER TABLE tmp_users ADD COLUMN IF NOT EXISTS bio TEXT;\n",
    );
    writeFile("migrations/0004_bio.down.sql",
      "ALTER TABLE tmp_users DROP COLUMN IF EXISTS bio;\n",
    );
    const mig = migrate();
    expect(mig.code).toBe(0);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"INSERT INTO tmp_users (name, email, bio) VALUES ($1, $2, $3)\", \"n\", \"e\", null);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/INSERT INTO tmp_users.*params: \[string, string, string \| null\]/);
  });

  test("data-modifying CTEs preserve nullable target parameter contracts", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        CREATE TABLE IF NOT EXISTS tmp_cte_params (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          name text NOT NULL,
          note text
        );
        CREATE TABLE IF NOT EXISTS tmp_cte_param_a (
          value text,
          payload jsonb,
          payloads jsonb[],
          labels text[]
        );
        CREATE TABLE IF NOT EXISTS tmp_cte_param_b (
          value text,
          payload jsonb,
          payloads jsonb[],
          labels text[]
        );
        CREATE TABLE IF NOT EXISTS tmp_cte_param_required (value text NOT NULL)
      `);
    } finally {
      await setup.end();
    }
    const root = isolatedRoot("cte-param-nullability");
    writeRootFile(root, "types.ts", "export type CtePayload = { state: string };\n");
    writeRootFile(root, "sqlx-js.config.ts", `export default {
      columnTypes: {
        "public.tmp_cte_param_a.payload": 'import("./types").CtePayload',
        "public.tmp_cte_param_b.payload": 'import("./types").CtePayload',
        "public.tmp_cte_param_a.payloads": 'import("./types").CtePayload',
        "public.tmp_cte_param_b.payloads": 'import("./types").CtePayload',
        "public.tmp_cte_param_a.value": '"ready" | "done"',
        "public.tmp_cte_param_b.value": '"ready" | "done"',
        "public.tmp_cte_param_required.value": '"ready" | "done"',
      },
      arrayElementNullability: {
        "public.tmp_cte_param_a.payloads": "non-null",
        "public.tmp_cte_param_a.labels": "non-null",
      },
    };\n`);
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(`WITH inserted AS MATERIALIZED (\n" +
      "  INSERT INTO tmp_cte_params (name, note) VALUES ($name, $note)\n" +
      "  RETURNING id, name, note\n" +
      ") SELECT id, name, note FROM inserted`, { name: \"ready\", note: null });\n" +
      "await sql(`WITH first AS (\n" +
      "  INSERT INTO tmp_cte_param_a (value, payload, payloads, labels)\n" +
      "  VALUES ($value, $payload::jsonb, $payloads::jsonb[], $labels::text[]) RETURNING value\n" +
      "), second AS (\n" +
      "  INSERT INTO tmp_cte_param_b (value, payload, payloads, labels)\n" +
      "  VALUES ($value, $payload::jsonb, $payloads::jsonb[], $labels::text[]) RETURNING value\n" +
      ") SELECT first.value FROM first CROSS JOIN second`,\n" +
      "  { value: null, payload: null, payloads: null, labels: null });\n" +
      "await sql(`WITH first AS (\n" +
      "  INSERT INTO tmp_cte_param_a (value) VALUES ($value) RETURNING value\n" +
      "), second AS (\n" +
      "  INSERT INTO tmp_cte_param_required (value) VALUES ($value) RETURNING value\n" +
      ") SELECT first.value FROM first CROSS JOIN second`, { value: \"ready\" });\n" +
      "await sql.execute(`INSERT INTO tmp_cte_param_required (value)\n" +
      "  VALUES ($value), (COALESCE($value, 'ready'))`, { value: \"ready\" });\n" +
      "await sql(`WITH direct_value AS (\n" +
      "  INSERT INTO tmp_cte_param_a (value) VALUES ($value) RETURNING value\n" +
      "), masked_value AS (\n" +
      "  INSERT INTO tmp_cte_param_required (value) VALUES (COALESCE($value, 'ready')) RETURNING value\n" +
      ") SELECT direct_value.value FROM direct_value CROSS JOIN masked_value`, { value: null });\n" +
      "await sql(`WITH guarded_value AS (\n" +
      "  INSERT INTO tmp_cte_param_required (value) SELECT $value::text\n" +
      "  WHERE $value::text IS NOT NULL RETURNING value\n" +
      ") SELECT COUNT(*)::int AS count FROM guarded_value`, { value: null });\n" +
      "await sql.execute(`UPDATE tmp_cte_param_a SET value = $value::text\n" +
      "  WHERE value = $value::text`, { value: \"ready\" });\n" +
      "await sql.execute(`UPDATE tmp_cte_param_a SET value = $value::text\n" +
      "  WHERE $value::text IS NULL OR value = $value::text`, { value: null });\n",
    );
    const result = prepareRoot(root, ["--strict-inference"]);
    expect(result.code, result.stderr).toBe(0);
    const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/WITH inserted AS MATERIALIZED.*params: \{ "name": string; "note": string \| null \}/);
    expect(dts).toMatch(
      /tmp_cte_param_b.*params: \{ "value": "ready" \| "done" \| null; "payload": import\("@onreza\/sqlx-js"\)\.SqlxJson<import\("\.\/types"\)\.CtePayload> \| null; "payloads": import\("@onreza\/sqlx-js"\)\.PgArrayParameter<import\("@onreza\/sqlx-js"\)\.SqlxJson<import\("\.\/types"\)\.CtePayload>, false> \| null; "labels": import\("@onreza\/sqlx-js"\)\.PgArrayParameter<string, false> \| null \}/,
    );
    expect(dts).toMatch(/tmp_cte_param_required.*params: \{ "value": "ready" \| "done" \}/);
    expect(dts).toMatch(/VALUES \(\$value\), \(COALESCE.*params: \{ "value": "ready" \| "done" \}/);
    expect(dts).toMatch(/masked_value.*params: \{ "value": "ready" \| "done" \| null \}/);
    expect(dts).toMatch(/guarded_value.*params: \{ "value": "ready" \| "done" \| null \}/);
    expect(dts).toMatch(/WHERE value = \$value::text.*params: \{ "value": "ready" \| "done" \}/);
    expect(dts).toMatch(/WHERE \$value::text IS NULL OR value = \$value::text.*params: \{ "value": "ready" \| "done" \| null \}/);
  });

  test("INSERT VALUES without column list resolves nullable params by table order", () => {
    writeFile("migrations/0005_insert_values_order.up.sql",
      "CREATE TABLE IF NOT EXISTS tmp_insert_values_order (\n" +
      "  id BIGINT NOT NULL,\n" +
      "  note TEXT\n" +
      ");\n",
    );
    writeFile("migrations/0005_insert_values_order.down.sql",
      "DROP TABLE IF EXISTS tmp_insert_values_order;\n",
    );
    const mig = migrate();
    expect(mig.code).toBe(0);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"INSERT INTO tmp_insert_values_order VALUES ($1, $2)\", 1n, null);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/INSERT INTO tmp_insert_values_order VALUES.*params: \[bigint, string \| null\]/);
  });

  test("conditional DML values inherit target types and nullability", () => {
    writeFile("migrations/0007_conditional_params.up.sql",
      "ALTER TABLE tmp_users ADD COLUMN IF NOT EXISTS conditional_at TIMESTAMPTZ;\n" +
      "ALTER TABLE tmp_users ADD COLUMN IF NOT EXISTS conditional_count INTEGER;\n" +
      "ALTER TABLE tmp_users ADD COLUMN IF NOT EXISTS conditional_note TEXT;\n",
    );
    writeFile("migrations/0007_conditional_params.down.sql",
      "ALTER TABLE tmp_users DROP COLUMN IF EXISTS conditional_note;\n" +
      "ALTER TABLE tmp_users DROP COLUMN IF EXISTS conditional_count;\n" +
      "ALTER TABLE tmp_users DROP COLUMN IF EXISTS conditional_at;\n",
    );
    const mig = migrate();
    expect(mig.code).toBe(0);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(`UPDATE tmp_users SET\n" +
      "  conditional_at = CASE\n" +
      "    WHEN NOT $setConditionalAt::boolean THEN conditional_at\n" +
      "    WHEN $clearConditionalAt::boolean THEN NULL\n" +
      "    ELSE $conditionalAt::timestamptz\n" +
      "  END,\n" +
      "  conditional_count = COALESCE($conditionalCount::int, conditional_count),\n" +
      "  name = CASE WHEN $setName::boolean THEN $name ELSE name END\n" +
      "WHERE id = $id`, {} as never);\n" +
      "await sql(\"UPDATE tmp_users SET (conditional_at, conditional_count) = ($conditionalAt, $conditionalCount) WHERE id = $id\", {} as never);\n" +
      "await sql(\"INSERT INTO tmp_users (name, email, conditional_note) SELECT $name, $email, $note UNION ALL SELECT $otherName, $otherEmail, $otherNote\", {} as never);\n",
    );
    const r = prepare();
    expect(r.code, r.stderr).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(
      /"setConditionalAt": boolean; "clearConditionalAt": boolean; "conditionalAt": import\("@onreza\/sqlx-js"\)\.PgTimestamptz<TemporalProvider> \| null; "conditionalCount": number \| null; "setName": boolean; "name": string; "id": bigint/,
    );
    expect(dts).toMatch(
      /SET \(conditional_at, conditional_count\).*"conditionalAt": import\("@onreza\/sqlx-js"\)\.PgTimestamptz<TemporalProvider> \| null; "conditionalCount": number \| null; "id": bigint/,
    );
    expect(dts).toMatch(
      /UNION ALL SELECT.*"name": string; "email": string; "note": string \| null; "otherName": string; "otherEmail": string; "otherNote": string \| null/,
    );
  });

  test("DML introspection preserves dots inside quoted schema and table names", () => {
    writeFile("migrations/0009_quoted_dots.up.sql",
      "CREATE SCHEMA IF NOT EXISTS \"tmp.dot\";\n" +
      "CREATE TABLE IF NOT EXISTS \"tmp.dot\".\"table.dot\" (\"id.dot\" BIGINT NOT NULL, \"note.dot\" TEXT);\n",
    );
    writeFile("migrations/0009_quoted_dots.down.sql", "DROP SCHEMA IF EXISTS \"tmp.dot\" CASCADE;\n");
    expect(migrate().code).toBe(0);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"INSERT INTO \\\"tmp.dot\\\".\\\"table.dot\\\" (\\\"id.dot\\\", \\\"note.dot\\\") VALUES ($1, $2)\", 1n, null);\n",
    );
    const result = prepare();
    expect(result.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/table\.dot.*params: \[bigint, string \| null\]/);
  });

  test("strict inference accepts structurally checked existential SqlxJson values", () => {
    writeFile("migrations/0006_json_fallback.up.sql",
      "CREATE TABLE IF NOT EXISTS tmp_json_fallback (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  payload JSONB NOT NULL,\n" +
      "  maybe_payload JSONB\n" +
      ");\n" +
      "CREATE DOMAIN tmp_json_param_domain AS JSONB;\n" +
      "CREATE TYPE tmp_json_param_record AS (payload JSONB, payloads JSONB[]);\n",
    );
    writeFile("migrations/0006_json_fallback.down.sql",
      "DROP TYPE IF EXISTS tmp_json_param_record;\n" +
      "DROP DOMAIN IF EXISTS tmp_json_param_domain;\n" +
      "DROP TABLE IF EXISTS tmp_json_fallback;\n",
    );
    const mig = migrate();
    expect(mig.code).toBe(0);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"INSERT INTO tmp_json_fallback (payload, maybe_payload) VALUES ($1, $2) RETURNING payload, maybe_payload\", sql.json({ ok: true, tags: [\"a\"], nested: { n: 1 } }), null);\n" +
      "await sql(\"SELECT $1::tmp_json_param_domain AS domain_value, $2::tmp_json_param_record AS record_value, $3::tmp_json_param_record[] AS record_values\", sql.json({ ok: true }), { payload: sql.json({ ok: true }), payloads: [sql.json({ ok: true })] }, sql.array([]));\n",
    );
    const r = prepare(["--strict-inference"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("inference failed");
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/tmp_json_fallback.*params: \[import\("@onreza\/sqlx-js"\)\.SqlxJson<unknown>, import\("@onreza\/sqlx-js"\)\.SqlxJson<unknown> \| null\]/);
    expect(dts).toContain('"payload": import("@onreza/sqlx-js").SqlxJson<import("@onreza/sqlx-js").JsonValue>');
    expect(dts).toContain('"maybe_payload": import("@onreza/sqlx-js").SqlxJson<import("@onreza/sqlx-js").JsonValue> | null');
    expect(dts).toMatch(
      /tmp_json_param_domain.*params: \[import\("@onreza\/sqlx-js"\)\.SqlxJson<unknown>, \{ payload: import\("@onreza\/sqlx-js"\)\.SqlxJson<unknown> \| null; payloads: \(import\("@onreza\/sqlx-js"\)\.SqlxJson<unknown> \| null\)\[\] \| null \}, import\("@onreza\/sqlx-js"\)\.PgArrayParameter<\{ payload: import\("@onreza\/sqlx-js"\)\.SqlxJson<unknown> \| null; payloads: \(import\("@onreza\/sqlx-js"\)\.SqlxJson<unknown> \| null\)\[\] \| null \}, boolean>\]/,
    );
  });

  test("prepare validates execution intent without runtime checks", () => {
    const root = isolatedRoot("execution-intent");
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"UPDATE tmp_users SET name = name WHERE id < 0\");\n",
    );
    const warning = prepareRoot(root, ["--warnings"]);
    expect(warning.code, warning.stderr).toBe(0);
    expect(warning.stderr).toContain("intent warning");
    expect(warning.stderr).toContain("Use sql.execute()");

    const strict = prepareRoot(root, ["--strict-inference"]);
    expect(strict.code).toBe(1);
    expect(strict.stderr).toContain("intent failed");

    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.execute(\"UPDATE tmp_users SET name = name WHERE id < 0 RETURNING id\");\n",
    );
    const discardedRows = prepareRoot(root, ["--warnings"]);
    expect(discardedRows.code, discardedRows.stderr).toBe(0);
    expect(discardedRows.stderr).toContain("sql.execute() is discarding rows");

    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.one(\"UPDATE tmp_users SET name = name WHERE id < 0\");\n",
    );
    const invalidCardinality = prepareRoot(root);
    expect(invalidCardinality.code).toBe(1);
    expect(invalidCardinality.stderr).toContain("sql.one() requires a statement with a result set");

    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.one(\"SELECT FROM tmp_users LIMIT 1\");\n",
    );
    const zeroColumnResult = prepareRoot(root);
    expect(zeroColumnResult.code, zeroColumnResult.stderr).toBe(0);
    expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8")).toContain("row: {  }");
  });

  test("prepare persists inference explanations for offline inspection", () => {
    const root = isolatedRoot("inference-explain");
    const query =
      "SELECT related.id AS related_id FROM tmp_users base "
      + "LEFT JOIN tmp_users related ON related.id = base.id + 1";
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      `await sql(${JSON.stringify(query)});\n`,
    );
    const result = prepareRoot(root, ["--strict-inference"]);
    expect(result.code, result.stderr).toBe(0);
    const entry = JSON.parse(
      readFileSync(join(root, ".sqlx-js", `${fingerprint(query)}.json`), "utf8"),
    );
    expect(entry.inference.columns[0]).toMatchObject({
      sources: [{
        schema: "public",
        table: "tmp_users",
        column: "id",
        notNull: true,
      }],
      reason: "widened by outer-join or nullable expression semantics",
    });
  });

  test("strict inference accepts set operations and inherited CTE scopes", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id, name AS label FROM tmp_users UNION ALL SELECT id, NULL::text AS label FROM tmp_users ORDER BY id\");\n" +
      "await sql(\"WITH source AS (SELECT id, name FROM tmp_users) SELECT id, name FROM source UNION ALL SELECT id, name FROM source ORDER BY id\");\n" +
      "await sql(\"VALUES (1::int) UNION ALL VALUES (2::int)\");\n",
    );
    const result = prepare(["--strict-inference"]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("nullability inference degraded");
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('row: { "id": bigint; "label": string | null }');
    expect(dts).toContain('row: { "id": bigint; "name": string }');
    expect(dts).toContain('row: { "column1": number }');
  });

  test("strict inference expands a materialized CTE row through a lateral fallback", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(`WITH picked AS MATERIALIZED (\n" +
      "  SELECT * FROM tmp_users ORDER BY id LIMIT 1\n" +
      ")\n" +
      "SELECT\n" +
      "  picked.id,\n" +
      "  COALESCE(later.name, picked.name) AS name,\n" +
      "  EXISTS(SELECT 1 FROM tmp_users WHERE id = picked.id) AS found\n" +
      "FROM picked\n" +
      "LEFT JOIN LATERAL (\n" +
      "  SELECT name FROM tmp_users WHERE id > picked.id ORDER BY id LIMIT 1\n" +
      ") later ON TRUE`);\n",
    );
    const result = prepare(["--strict-inference"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("nullability inference degraded");
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('row: { "id": bigint; "name": string; "found": boolean }');
  });

  test("strict inference keeps array constructors non-null in data-modifying CTEs", () => {
    const root = isolatedRoot("array-constructor-nullability");
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"WITH deleted AS MATERIALIZED (DELETE FROM tmp_users WHERE id < 0 RETURNING id) SELECT COALESCE(ARRAY(SELECT id FROM deleted), ARRAY[]::bigint[]) AS ids, EXISTS(SELECT 1 FROM deleted) AS \\\"hasDeleted\\\"\");\n",
    );
    const result = prepareRoot(root, ["--strict-inference"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("nullability inference degraded");
    const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('row: { "ids": (bigint)[]; "hasDeleted": boolean }');
  });

  test("array element nullability follows SQL, domain, and config proofs", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP TABLE IF EXISTS tmp_array_contracts;
        DROP DOMAIN IF EXISTS tmp_non_null_text;
        DROP DOMAIN IF EXISTS tmp_text_array;
        DROP DOMAIN IF EXISTS tmp_non_null_role;
        DROP TYPE IF EXISTS tmp_array_role;
        DROP TYPE IF EXISTS tmp_array_pair;
        CREATE DOMAIN tmp_non_null_text AS text NOT NULL;
        CREATE DOMAIN tmp_text_array AS text[];
        CREATE TYPE tmp_array_role AS ENUM ('admin', 'member');
        CREATE TYPE tmp_array_pair AS (label text, score int);
        CREATE DOMAIN tmp_non_null_role AS tmp_array_role NOT NULL;
        CREATE TABLE tmp_array_contracts (
          plain text[] NOT NULL,
          proven tmp_non_null_text[] NOT NULL,
          wrapped tmp_text_array NOT NULL,
          roles tmp_array_role[] NOT NULL,
          domain_roles tmp_non_null_role[] NOT NULL,
          pairs tmp_array_pair[] NOT NULL
        )
      `);
    } finally {
      await setup.end();
    }

    const root = isolatedRoot("array-element-contracts");
    writeRootFile(root, "sqlx-js.config.ts", `export default {
      arrayElementNullability: {
        "public.tmp_array_contracts.plain": "non-null",
      },
    };\n`);
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT plain, proven, wrapped, roles, domain_roles, pairs FROM tmp_array_contracts\");\n" +
      "await sql(\"WITH source AS (SELECT plain FROM tmp_array_contracts) SELECT plain AS cte_plain FROM source\");\n" +
      "await sql(\"SELECT nested.plain AS derived_plain FROM (SELECT plain FROM tmp_array_contracts) AS nested\");\n" +
      "await sql(\"SELECT plain AS set_plain FROM tmp_array_contracts UNION ALL SELECT plain AS set_plain FROM tmp_array_contracts\");\n" +
      "await sql(\"SELECT ARRAY[1, 2] AS non_null, ARRAY[1, NULL] AS nullable, ARRAY(SELECT id FROM tmp_users) AS selected\");\n" +
      "await sql(\"WITH values_source(value) AS (VALUES (1::int), (NULL::int)) SELECT ARRAY(SELECT value FROM values_source) AS values\");\n" +
      "await sql.execute(\"INSERT INTO tmp_array_contracts (plain, proven, wrapped, roles, domain_roles, pairs) VALUES ($1, $2, $3, $4, $5, ARRAY[ROW('label', 1)]::tmp_array_pair[])\", sql.array([\"a\"]), sql.array([\"b\"]), sql.array([\"c\", null]), sql.array([\"admin\"]), sql.array([\"member\"]));\n",
    );
    const result = prepareRoot(root, ["--strict-inference"]);
    expect(result.code, result.stderr).toBe(0);
    const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"plain": (string)[]; "proven": (string)[]; "wrapped": (string | null)[]');
    expect(dts).toContain('"roles": ("admin" | "member" | null)[]');
    expect(dts).toContain('"domain_roles": ("admin" | "member")[]');
    expect(dts).toContain('"pairs": ({ label: string | null; score: number | null } | null)[]');
    expect(dts).toContain('row: { "cte_plain": (string)[] }');
    expect(dts).toContain('row: { "derived_plain": (string)[] }');
    expect(dts).toContain('row: { "set_plain": (string)[] }');
    expect(dts).toContain('"non_null": (number)[]; "nullable": (number | null)[]; "selected": (bigint)[]');
    expect(dts).toContain('row: { "values": (number | null)[] }');
    expect(dts).toContain('params: [import("@onreza/sqlx-js").PgArrayParameter<string, false>, import("@onreza/sqlx-js").PgArrayParameter<string, false>, import("@onreza/sqlx-js").PgArrayParameter<string, boolean>, import("@onreza/sqlx-js").PgArrayParameter<"admin" | "member", boolean>, import("@onreza/sqlx-js").PgArrayParameter<"admin" | "member", false>]');
  });

  test("PostgreSQL array params emit the explicit PgArrayParameter wrapper", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT $1::text[] AS values\", sql.array([\"a\", \"b\"]));\n",
    );
    const result = prepare();
    expect(result.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('params: [import("@onreza/sqlx-js").PgArrayParameter<string, boolean>]');

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT $1::jsonb[] AS values\", sql.array([sql.json({ ok: true })]));\n",
    );
    const jsonResult = prepare(["--strict-inference"]);
    expect(jsonResult.code).toBe(0);
    const jsonDts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(jsonDts).toContain('PgArrayParameter<import("@onreza/sqlx-js").SqlxJson<unknown>, boolean>');
  });

  test("$N IS NULL OR col = $N pattern makes the param nullable", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users WHERE $1::text IS NULL OR name = $1\", null);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/IS NULL OR name = \$1.*params: \[string \| null\]/);
  });

  test("WHERE col = $N stays non-null even when column is nullable", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id FROM tmp_users WHERE bio = $1\", \"any\");\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/WHERE bio = \$1.*params: \[string\]/);
  });

  test("prepare emits non-null row types for equality chains and INNER JOIN ON", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT u.external_id, p.user_external_id FROM tmp_join_users u JOIN tmp_join_posts p ON p.user_external_id = u.external_id\");\n" +
      "await sql(\"SELECT a FROM tmp_narrow_values WHERE a IS NOT DISTINCT FROM b AND b IS NOT NULL\");\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"external_id": string; "user_external_id": string');
    expect(dts).toContain('"a": string');
  });

  test("prepare keeps outer-join rows nullable and sees DML RETURNING source scope", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT p.user_external_id FROM tmp_join_users u LEFT JOIN tmp_join_posts p ON p.user_external_id = u.external_id\");\n" +
      "await sql(\"DELETE FROM tmp_join_users u USING tmp_join_posts p WHERE p.user_external_id = u.external_id RETURNING p.title\");\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"user_external_id": string | null');
    expect(dts).toContain('"title": string');
  });

  test("prepare caches post-update target nullability without widening UPDATE FROM sources", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP TABLE IF EXISTS tmp_update_returning;
        CREATE TABLE tmp_update_returning (
          pending_first_seq integer,
          pending_last_seq integer,
          pending_payload_digest text
        )
      `);
    } finally {
      await setup.end();
    }

    const targetQuery = "UPDATE tmp_update_returning SET pending_first_seq = NULL, pending_last_seq = NULL, pending_payload_digest = NULL WHERE pending_first_seq = $firstSeq AND pending_last_seq = $lastSeq AND pending_payload_digest = $payloadDigest RETURNING pending_first_seq, pending_last_seq, pending_payload_digest";
    const sourceQuery = "UPDATE tmp_join_users u SET external_id = NULL FROM tmp_join_posts p WHERE u.id = p.id AND u.external_id IS NOT NULL AND p.user_external_id IS NOT NULL RETURNING u.external_id AS target_external_id, p.user_external_id AS source_external_id";
    const selfJoinQuery = "UPDATE tmp_join_users u SET external_id = NULL FROM tmp_join_users WHERE u.id = tmp_join_users.id AND tmp_join_users.external_id IS NOT NULL RETURNING u.external_id AS target_external_id, tmp_join_users.external_id AS source_external_id";
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      `await sql(${JSON.stringify(targetQuery)}, { firstSeq: 1, lastSeq: 2, payloadDigest: "digest" });\n` +
      `await sql(${JSON.stringify(sourceQuery)});\n` +
      `await sql(${JSON.stringify(selfJoinQuery)});\n`,
    );
    const r = prepare();
    expect(r.code, r.stderr).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"pending_first_seq": number | null; "pending_last_seq": number | null; "pending_payload_digest": string | null');
    expect(dts).toContain('"target_external_id": string | null; "source_external_id": string');

    const targetEntry = JSON.parse(
      readFileSync(join(tmp, ".sqlx-js", `${fingerprint(targetQuery)}.json`), "utf8"),
    ) as { columns: { name: string; nullable: boolean }[] };
    expect(targetEntry.columns.map(({ name, nullable }) => ({ name, nullable }))).toEqual([
      { name: "pending_first_seq", nullable: true },
      { name: "pending_last_seq", nullable: true },
      { name: "pending_payload_digest", nullable: true },
    ]);
    const sourceEntry = JSON.parse(
      readFileSync(join(tmp, ".sqlx-js", `${fingerprint(sourceQuery)}.json`), "utf8"),
    ) as { columns: { name: string; nullable: boolean }[] };
    expect(sourceEntry.columns.map(({ name, nullable }) => ({ name, nullable }))).toEqual([
      { name: "target_external_id", nullable: true },
      { name: "source_external_id", nullable: false },
    ]);
    const selfJoinEntry = JSON.parse(
      readFileSync(join(tmp, ".sqlx-js", `${fingerprint(selfJoinQuery)}.json`), "utf8"),
    ) as { columns: { name: string; nullable: boolean }[] };
    expect(selfJoinEntry.columns.map(({ name, nullable }) => ({ name, nullable }))).toEqual([
      { name: "target_external_id", nullable: true },
      { name: "source_external_id", nullable: false },
    ]);
  });

  test("sql.with queries reach the generated registry via the scanner", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "const requestSql = sql.with({ timeoutMs: 100 });\n" +
      "await requestSql.one(\"SELECT id FROM tmp_users WHERE id = $1\", 1);\n" +
      "await sql.with({ signal: new AbortController().signal }).optional(\"SELECT id FROM tmp_users WHERE email = $1\", \"x\");\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("SELECT id FROM tmp_users WHERE id = $1");
    expect(dts).toContain("SELECT id FROM tmp_users WHERE email = $1");
  });

  test("sql.file.one and sql.file.optional reach the generated registry via the scanner", () => {
    writeFile("queries/by_id.sql", "SELECT id, name FROM tmp_users WHERE id = $1\n");
    writeFile("queries/by_email.sql", "SELECT id FROM tmp_users WHERE email = $1\n");
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.file.one(\"./queries/by_id.sql\", 1);\n" +
      "await sql.file.optional(\"./queries/by_email.sql\", \"x\");\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"./queries/by_id.sql":');
    expect(dts).toContain('"./queries/by_email.sql":');
  });

  test("explicit PostgreSQL array params roundtrip", async () => {
    const { createSqlClient } = await import("../src/index");
    const db = createSqlClient(dbUrl, { execution: "adaptive" });
    const { sql } = db;
    try {
      const rows = await sql("SELECT $1::text[] AS xs", sql.array(["alpha", "beta,gamma", "with \"quote\""]));
      expect((rows[0] as { xs: string[] }).xs).toEqual(["alpha", "beta,gamma", "with \"quote\""]);
      const ints = await sql("SELECT $1::int[] AS ns", sql.array([1, 2, 3]));
      expect(Array.from((ints[0] as { ns: ArrayLike<number> }).ns)).toEqual([1, 2, 3]);
      const withNull = await sql("SELECT $1::text[] AS xs", sql.array(["a", null, "b"]));
      expect((withNull[0] as { xs: (string | null)[] }).xs).toEqual(["a", null, "b"]);
      const empty = await sql("SELECT $1::text[] AS xs", sql.array([]));
      expect((empty[0] as { xs: string[] }).xs).toEqual([]);
      const onlyNull = await sql("SELECT $1::int[] AS ns", sql.array([null]));
      expect((onlyNull[0] as { ns: (number | null)[] }).ns).toEqual([null]);
      const timestamp = Temporal.Instant.from("2026-01-02T03:04:05.000000Z");
      const dates = await sql("SELECT $1::timestamptz[] AS xs", sql.array([timestamp]));
      expect((dates[0] as { xs: Temporal.Instant[] }).xs.map((value) => value.toString()))
        .toEqual([timestamp.toString()]);
    } finally {
      await db.close();
    }
  });

  test("runtime codecs align database-local scalar and array values", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS hstore;
        CREATE EXTENSION IF NOT EXISTS citext;
        CREATE EXTENSION IF NOT EXISTS ltree;
        DROP TYPE IF EXISTS tmp_runtime_item CASCADE;
        DROP TYPE IF EXISTS tmp_runtime_membership CASCADE;
        DROP TYPE IF EXISTS tmp_runtime_role CASCADE;
        DROP DOMAIN IF EXISTS tmp_runtime_role_domain CASCADE;
        DROP DOMAIN IF EXISTS tmp_runtime_vectors CASCADE;
        DROP DOMAIN IF EXISTS tmp_runtime_positive CASCADE;
        DROP DOMAIN IF EXISTS tmp_runtime_json CASCADE;
        DROP TYPE IF EXISTS tmp_runtime_json_record CASCADE;
        CREATE TYPE tmp_runtime_role AS ENUM ('admin', 'member');
        CREATE DOMAIN tmp_runtime_role_domain AS tmp_runtime_role;
        CREATE DOMAIN tmp_runtime_positive AS integer CHECK (VALUE > 0);
        CREATE DOMAIN tmp_runtime_vectors AS vector[];
        CREATE DOMAIN tmp_runtime_json AS jsonb;
        CREATE TYPE tmp_runtime_item AS (label text, score integer);
        CREATE TYPE tmp_runtime_json_record AS (payload jsonb, history jsonb[]);
        CREATE TYPE tmp_runtime_membership AS (legacy text, tenant text, role text);
        ALTER TYPE tmp_runtime_membership DROP ATTRIBUTE legacy;
      `);
    } finally {
      await setup.end();
    }

    const { createSqlClient, array, json } = await import("../src/index");
    const runtime = createSqlClient(dbUrl);
    try {
      await runtime.ready();
      const literal = await runtime.unsafe(`
        SELECT
          '[1.5,-2]'::vector AS vector_value,
          '"a"=>"b", "nullable"=>NULL'::hstore AS hstore_value,
          'admin'::tmp_runtime_role AS role_value,
          ARRAY['admin', NULL]::tmp_runtime_role[] AS role_values,
          5::tmp_runtime_positive AS domain_value,
          ARRAY[5, NULL]::tmp_runtime_positive[] AS domain_values,
          ARRAY['[9,10]'::vector, '[11,12]'::vector]::tmp_runtime_vectors AS domain_vector_values,
          ROW('literal', 7)::tmp_runtime_item AS composite_value,
          ARRAY[ROW('first', 1), NULL]::tmp_runtime_item[] AS composite_values,
          ROW('tenant_b', 'role_user')::tmp_runtime_membership AS dropped_composite_value,
          ARRAY['[1,2]'::vector, '[3,4]'::vector] AS vector_values,
          ARRAY['Mixed', NULL]::citext[] AS citext_values,
          ARRAY['Top.Child'::ltree, NULL] AS ltree_values
      `);
      expect(literal[0]).toEqual({
        vector_value: [1.5, -2],
        hstore_value: { a: "b", nullable: null },
        role_value: "admin",
        role_values: ["admin", null],
        domain_value: 5,
        domain_values: [5, null],
        domain_vector_values: [[9, 10], [11, 12]],
        composite_value: { label: "literal", score: 7 },
        composite_values: [{ label: "first", score: 1 }, null],
        dropped_composite_value: { tenant: "tenant_b", role: "role_user" },
        vector_values: [[1, 2], [3, 4]],
        citext_values: ["Mixed", null],
        ltree_values: ["Top.Child", null],
      });

      const params = await runtime.unsafe(
        `SELECT $1::vector AS vector_value,
                $2::hstore AS hstore_value,
                $3::tmp_runtime_role AS role_value,
                $4::tmp_runtime_role[] AS role_values,
                $5::tmp_runtime_item AS composite_value,
                $6::tmp_runtime_item[] AS composite_values,
                $7::vector[] AS vector_values,
                $8::tmp_runtime_vectors AS domain_vector_values,
                $9::tmp_runtime_membership AS dropped_composite_value`,
        [8, 9],
        { key: "value", nullable: null, 'quote"slash\\': 'comma, arrow=> and "quote"' },
        "member",
        array(["member", null]),
        { label: 'parameter, "quoted"', score: 11 },
        array([{ label: "array\\value", score: 12 }, null]),
        array([[5, 6], [7, 8]]),
        array([[13, 14], [15, 16]]),
        { tenant: "tenant_c", role: "role_admin" },
      );
      expect(params[0]).toEqual({
        vector_value: [8, 9],
        hstore_value: { key: "value", nullable: null, 'quote"slash\\': 'comma, arrow=> and "quote"' },
        role_value: "member",
        role_values: ["member", null],
        composite_value: { label: 'parameter, "quoted"', score: 11 },
        composite_values: [{ label: "array\\value", score: 12 }, null],
        vector_values: [[5, 6], [7, 8]],
        domain_vector_values: [[13, 14], [15, 16]],
        dropped_composite_value: { tenant: "tenant_c", role: "role_admin" },
      });

      const jsonDocument = json({ exact: 9_007_199_254_740_993n });
      const jsonValues = await runtime.unsafe(
        `SELECT $1::tmp_runtime_json AS domain_value,
                $2::tmp_runtime_json_record AS composite_value,
                $3::tmp_runtime_json_record[] AS composite_values,
                $4::tmp_runtime_json[] AS domain_values`,
        jsonDocument,
        { payload: jsonDocument, history: [jsonDocument, null] },
        array([{ payload: jsonDocument, history: [jsonDocument] }, null]),
        array([jsonDocument, null]),
      ) as Array<{
        domain_value: SqlxJson;
        composite_value: { payload: SqlxJson; history: Array<SqlxJson | null> };
        composite_values: Array<{ payload: SqlxJson; history: SqlxJson[] } | null>;
        domain_values: Array<SqlxJson | null>;
      }>;
      expect(jsonValues[0]?.domain_value.value).toEqual(jsonDocument.value);
      expect(jsonValues[0]?.composite_value.payload.value).toEqual(jsonDocument.value);
      expect(jsonValues[0]?.composite_value.history.map((value) => value?.value ?? null))
        .toEqual([jsonDocument.value, null]);
      expect(jsonValues[0]?.composite_values[0]?.payload.value).toEqual(jsonDocument.value);
      expect(jsonValues[0]?.domain_values.map((value) => value?.value ?? null))
        .toEqual([jsonDocument.value, null]);
      await expect(runtime.unsafe(
        "SELECT $1::tmp_runtime_json_record",
        { payload: JSON.stringify({ raw: true }), history: [] },
      )).rejects.toThrow("PostgreSQL JSON values require a SqlxJson document");

      await expect(runtime.unsafe(
        "SELECT $1::tmp_runtime_item",
        { label: "missing score", score: undefined },
      )).rejects.toThrow(
        "PostgreSQL composite tmp_runtime_item field score is undefined; pass null explicitly",
      );
    } finally {
      await runtime.close();
    }

    type RuntimeRole = { value: "admin" | "member" };
    type RuntimeItem = { literal: string };
    const typeCodecs = {
      tmp_runtime_role: {
        parse: (value: string): RuntimeRole => ({ value: value as RuntimeRole["value"] }),
        serialize: (value: RuntimeRole) => value.value,
      },
      tmp_runtime_item: {
        parse: (value: string): RuntimeItem => ({ literal: value }),
        serialize: (value: RuntimeItem) => value.literal,
      },
    };
    const custom = createSqlClient(dbUrl, { typeCodecs });
    try {
      const rows = await custom.unsafe(
        `SELECT $1::tmp_runtime_role AS role,
                $2::tmp_runtime_role[] AS roles,
                $3::tmp_runtime_item AS item,
                $4::tmp_runtime_item[] AS items,
                $5::tmp_runtime_role_domain AS domain_role`,
        { value: "member" },
        array([{ value: "admin" }, null]),
        { literal: '("custom",13)' },
        array([{ literal: '("array",14)' }, null]),
        { value: "admin" },
      );
      expect(rows[0]).toEqual({
        role: { value: "member" },
        roles: [{ value: "admin" }, null],
        item: { literal: "(custom,13)" },
        items: [{ literal: "(array,14)" }, null],
        domain_role: { value: "admin" },
      });
    } finally {
      await custom.close();
    }

    const normalized = createSqlClient(dbUrl, {
      typeCodecs: {
        tmp_runtime_role: {
          parse: String,
          serialize: (value: string) => value.toLowerCase(),
        },
      },
    });
    try {
      const rows = await normalized.unsafe(
        "SELECT $1::tmp_runtime_role AS role",
        "ADMIN",
      );
      expect(rows[0]).toEqual({ role: "admin" });
    } finally {
      await normalized.close();
    }

    const transactional = createSqlClient(dbUrl, { typeCodecs });
    try {
      const role = await transactional.sql.transaction(async (tx) =>
        await tx.one("SELECT $1::tmp_runtime_role AS role", { value: "admin" }),
      );
      expect(role).toEqual({ role: { value: "admin" } });
    } finally {
      await transactional.close();
    }
  });

  test("explicit JSON params preserve top-level primitive arrays", async () => {
    const { createSqlClient } = await import("../src/index");
    const db = createSqlClient(dbUrl, { execution: "adaptive" });
    const { sql } = db;
    try {
      const rows = await sql("SELECT $1::jsonb AS value", sql.json([1, 2, 3]));
      expect((rows[0] as { value: SqlxJson }).value.value).toEqual([1, 2, 3]);
      const jsonNull = await sql("SELECT $1::jsonb AS value", sql.json(null));
      expect((jsonNull[0] as { value: SqlxJson }).value.value).toBeNull();
    } finally {
      await db.close();
    }
  });

  test("explicit PostgreSQL jsonb[] params roundtrip", async () => {
    const { createSqlClient } = await import("../src/index");
    const db = createSqlClient(dbUrl, { execution: "adaptive" });
    const { sql } = db;
    try {
      const rows = await sql(
        "SELECT $1::jsonb[] AS values",
        sql.array([
          sql.json({ kind: "object" }),
          sql.json([1, 2, 3]),
          sql.json(null),
          null,
        ]),
      );
      const values = (rows[0] as { values: Array<SqlxJson | null> }).values;
      expect(values.map((value) => value?.value ?? null)).toEqual([
        { kind: "object" },
        [1, 2, 3],
        null,
        null,
      ]);
      expect(values[2]).toBeInstanceOf(SqlxJson);
      expect(values[3]).toBeNull();
    } finally {
      await db.close();
    }
  });

  test("createClient enforces required array codecs for raw use", async () => {
    const { createClient } = await import("../src/index");
    const external = createClient(dbUrl);
    const timestamp = Temporal.Instant.from("2026-01-02T03:04:05.000000Z");
    try {
      const rows = await external.unsafe(
        "SELECT $1::jsonb[] AS js, $2::bytea[] AS bs, $3::timestamptz[] AS ds",
        [
          external.array([json({ kind: "external" }), null], 3807),
          external.typed([new Uint8Array([0xde, 0xad])], 0),
          external.typed([timestamp], 0),
        ],
      );
      const row = rows[0] as {
        js: Array<SqlxJson | null>;
        bs: Uint8Array[];
        ds: Temporal.Instant[];
      };
      expect(row.js.map((value) => value?.value ?? null)).toEqual([{ kind: "external" }, null]);
      expect(row.bs.map((value) => Array.from(value))).toEqual([[0xde, 0xad]]);
      expect(row.ds.map((value) => value.toString())).toEqual([timestamp.toString()]);
      await expect(Promise.resolve(external.unsafe(
        "SELECT $1::jsonb[]",
        [external.typed([JSON.stringify({ kind: "raw" })], 3807)],
      ))).rejects.toThrow("PostgreSQL JSON values require a SqlxJson document");
    } finally {
      await external.end();
    }
  });

  test("operation timeout recycles the pool and keeps the managed client usable", async () => {
    const { createSqlClient, QueryTimeoutError } = await import("../src/index");
    const transitions: string[] = [];
    const db = createSqlClient(dbUrl, {
      operationTimeoutMs: 100,
      cancelGraceMs: 100,
      onLifecycle: (event) => {
        if (event.kind === "state-change") transitions.push(`${event.from}->${event.to}`);
      },
    });
    try {
      await db.ready({ timeoutMs: 1_000 });
      let timeoutError: unknown;
      try {
        await db.sql("SELECT pg_sleep(1)");
      } catch (error) {
        timeoutError = error;
      }
      expect(timeoutError).toBeInstanceOf(QueryTimeoutError);
      expect(timeoutError).toMatchObject({
        timeoutMs: 100,
        phase: "execution",
        outcome: "unknown",
        generation: 1,
      });

      await db.ping({ timeoutMs: 1_000 });
      for (let attempt = 0; attempt < 100 && db.snapshot().state === "recycling"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(db.snapshot()).toMatchObject({
        generation: 2,
        state: "healthy",
        activeOperations: 0,
        recycleCount: 1,
      });
      expect(transitions).toEqual([
        "healthy->poisoned",
        "poisoned->recycling",
        "recycling->healthy",
      ]);
    } finally {
      await db.close({ graceMs: 100, forceAfterMs: 1_000 });
    }
  });

  test("AbortSignal cancels a dispatched query without recycling a clean pool", async () => {
    const { createSqlClient, QueryAbortedError } = await import("../src/index");
    const db = createSqlClient(dbUrl, { cancelGraceMs: 1_000 });
    const controller = new AbortController();
    try {
      await db.ready({ timeoutMs: 1_000 });
      const pending = db.sql.with({ signal: controller.signal })("SELECT pg_sleep(1)" as never);
      setTimeout(() => controller.abort("request closed"), 50);

      let abortError: unknown;
      try {
        await pending;
      } catch (error) {
        abortError = error;
      }
      expect(abortError).toBeInstanceOf(QueryAbortedError);
      expect(abortError).toMatchObject({
        phase: "execution",
        outcome: "unknown",
        generation: 1,
        reason: "request closed",
      });
      await db.ping({ timeoutMs: 1_000 });
      expect(db.snapshot()).toMatchObject({ generation: 1, state: "healthy", recycleCount: 0 });
    } finally {
      await db.close({ graceMs: 100, forceAfterMs: 1_000 });
    }
  });

  test("sql.execute returns affected row count and command", async () => {
    const { createSqlClient } = await import("../src/index");
    const db = createSqlClient(dbUrl, { execution: "adaptive" });
    const { sql } = db;
    try {
      const inserted = await sql.execute(
        "INSERT INTO tmp_users (name, email) VALUES ($1, $2)",
        "execute-user",
        `execute-${Date.now()}@example.com`,
      );
      expect(inserted).toEqual({ rowCount: 1, command: "INSERT" });
      const updated = await sql.execute("UPDATE tmp_users SET name = $1 WHERE name = $2", "execute-done", "execute-user");
      expect(updated).toEqual({ rowCount: 1, command: "UPDATE" });
    } finally {
      await db.close();
    }
  });

  test("typed savepoints recover PostgreSQL errors without hiding transaction failures", async () => {
    const { createSqlClient } = await import("../src/index");
    const db = createSqlClient(dbUrl);
    const token = Date.now();
    const firstEmail = `savepoint-${token}@example.com`;
    const secondEmail = `savepoint-after-${token}@example.com`;
    try {
      await db.sql.transaction(async (tx) => {
        await tx.savepoint(async (sp) => {
          await sp.execute(
            "INSERT INTO tmp_users (name, email) VALUES ($1, $2)",
            "savepoint",
            firstEmail,
          );
        });
        const recovered = await tx.savepoint(async (sp) => {
          try {
            await sp.execute(
              "INSERT INTO tmp_users (id, name, email) "
              + "SELECT id, 'duplicate', 'duplicate@example.com' FROM tmp_users ORDER BY id LIMIT 1",
            );
          } catch {}
          return true;
        });
        expect(recovered).toBe(true);
        await tx.execute(
          "INSERT INTO tmp_users (name, email) VALUES ($1, $2)",
          "after-savepoint",
          secondEmail,
        );
      });
      const rows = await db.unsafe(
        "SELECT email FROM tmp_users WHERE email IN ($1, $2) ORDER BY email",
        firstEmail,
        secondEmail,
      ) as { email: string }[];
      expect(rows.map((row) => row.email).sort()).toEqual([firstEmail, secondEmail].sort());
    } finally {
      await db.close();
    }
  });

  test("transaction timeout cancels work, rolls back, and keeps the pool usable", async () => {
    const { createSqlClient, TransactionTimeoutError } = await import("../src/index");
    const db = createSqlClient(dbUrl, { execution: "adaptive" });
    const { sql } = db;
    try {
      const email = `timeout-${Date.now()}@example.com`;
      let timeoutError: unknown;
      try {
        await sql.transaction({ timeoutMs: 100 }, async (tx) => {
          await tx.execute("INSERT INTO tmp_users (name, email) VALUES ($1, $2)", "timeout", email);
          await tx("SELECT pg_sleep(1)");
        });
      } catch (error) {
        timeoutError = error;
      }
      expect(timeoutError).toBeInstanceOf(TransactionTimeoutError);
      expect((timeoutError as InstanceType<typeof TransactionTimeoutError>).timeoutMs).toBe(100);
      const rolledBack = await sql.one(
        "SELECT COUNT(*)::int AS count FROM tmp_users WHERE email = $1",
        email,
      ) as { count: number };
      expect(rolledBack.count).toBe(0);
      expect(await sql.one("SELECT 1::int AS value")).toEqual({ value: 1 });

      const lateEmail = `late-timeout-${Date.now()}@example.com`;
      let callbackResumed = false;
      await expect(sql.transaction({ timeoutMs: 50 }, async (tx) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        callbackResumed = true;
        await tx.execute("INSERT INTO tmp_users (name, email) VALUES ($1, $2)", "late-timeout", lateEmail);
      })).rejects.toBeInstanceOf(TransactionTimeoutError);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(callbackResumed).toBe(true);
      const lateQuery = await sql.one(
        "SELECT COUNT(*)::int AS count FROM tmp_users WHERE email = $1",
        lateEmail,
      ) as { count: number };
      expect(lateQuery.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  test("bytea[] uses the internal PostgreSQL bytea codec", async () => {
    const { createClient, createSqlClient } = await import("../src/index");
    const db = createSqlClient(dbUrl, { execution: "adaptive" });
    const { sql } = db;
    const escapeClient = createClient(dbUrl, {
      max: 1,
      startupOptions: "-c bytea_output=escape",
    });
    try {
      const hex = await sql.one(
        "SELECT decode('005c7fff', 'hex') AS value",
      ) as { value: Uint8Array };
      expect(Array.from(hex.value)).toEqual([0x00, 0x5c, 0x7f, 0xff]);

      const literalRows = await sql("SELECT ARRAY[decode('dead', 'hex'), decode('beef', 'hex')]::bytea[] AS xs");
      const literal = (literalRows[0] as { xs: Uint8Array[] }).xs;
      expect(literal.map((x) => Array.from(x))).toEqual([[0xde, 0xad], [0xbe, 0xef]]);

      const paramRows = await sql("SELECT $1::bytea[] AS xs", sql.array([
        new Uint8Array([0xde, 0xad]),
        new Uint8Array([0xbe, 0xef]),
      ]));
      const param = (paramRows[0] as { xs: Uint8Array[] }).xs;
      expect(param.map((x) => Array.from(x))).toEqual([[0xde, 0xad], [0xbe, 0xef]]);

      const [escaped] = await escapeClient.unsafe<{ value: Uint8Array }>(
        "SELECT decode('005c7fff', 'hex') AS value",
      );
      expect(Array.from(escaped.value)).toEqual([0x00, 0x5c, 0x7f, 0xff]);
      const [escapedArray] = await escapeClient.unsafe<{ values: Uint8Array[] }>(
        "SELECT ARRAY[decode('005c7fff', 'hex'), decode('deadbeef', 'hex')] AS values",
      );
      expect(escapedArray.values.map((value) => Array.from(value))).toEqual([
        [0x00, 0x5c, 0x7f, 0xff],
        [0xde, 0xad, 0xbe, 0xef],
      ]);
    } finally {
      await escapeClient.end();
      await db.close();
    }
  });

  test("managed query timing separates pool wait from execution", async () => {
    const events: OnQueryEvent[] = [];
    const client = createRuntimeSqlClient(dbUrl, {
      max: 1,
      execution: "adaptive",
      onQuery: (event) => events.push(event),
    });
    try {
      await client.ready();
      const blocker = client.sql("SELECT pg_sleep(0.15) AS blocked");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = client.sql("SELECT 2::int AS queued");
      await Promise.all([blocker, queued]);

      const blockerEvent = events.find((event) => event.query.includes("blocked"))!;
      const queuedEvent = events.find((event) => event.query.includes("queued"))!;
      expect(blockerEvent.executionDurationMs).toBeGreaterThan(100);
      expect(queuedEvent.acquireDurationMs).toBeGreaterThan(100);
      expect(queuedEvent.executionDurationMs).toBeLessThan(queuedEvent.acquireDurationMs!);
      expect(queuedEvent.preDispatchDurationMs).toBeGreaterThanOrEqual(queuedEvent.acquireDurationMs!);
      expect(queuedEvent.durationMs).toBeGreaterThanOrEqual(queuedEvent.preDispatchDurationMs!);

      await client.sql.transaction(async (tx) => {
        const transactionBlocker = tx("SELECT pg_sleep(0.15) AS transaction_blocked");
        await new Promise((resolve) => setTimeout(resolve, 10));
        const transactionQueued = tx("SELECT 3::int AS transaction_queued");
        await Promise.all([transactionBlocker, transactionQueued]);
      });
      const transactionQueuedEvent = events.find((event) => event.query.includes("transaction_queued"))!;
      expect(transactionQueuedEvent.acquireDurationMs).toBeUndefined();
      expect(transactionQueuedEvent.preDispatchDurationMs).toBeGreaterThan(100);
      expect(transactionQueuedEvent.executionDurationMs).toBeLessThan(100);

      await expect(client.sql("SELECT $1::text", undefined as never)).rejects.toThrow(/undefined/);
      const preDispatchFailure = events.find((event) => event.query.includes("SELECT $1::text"))!;
      expect(preDispatchFailure.acquireDurationMs).toBeGreaterThanOrEqual(0);
      expect(preDispatchFailure.preDispatchDurationMs).toBe(preDispatchFailure.durationMs);
      expect(preDispatchFailure.executionDurationMs).toBeUndefined();

      await expect(
        client.sql.with({ timeoutMs: 50 })("SELECT pg_sleep(0.2) AS timed_out"),
      ).rejects.toBeInstanceOf(QueryTimeoutError);
      const timeout = events.find((event) => event.query.includes("timed_out"))!;
      expect(timeout.preDispatchDurationMs).toBeLessThan(timeout.durationMs);
      expect(timeout.executionDurationMs).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test("internal pool serializes concurrent transaction queries", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      const rows = await client.begin(async (tx) => {
        await tx.unsafe("CREATE TEMPORARY TABLE driver_values (value int NOT NULL)");
        await Promise.all([
          tx.unsafe("INSERT INTO driver_values (value) VALUES ($1)", [1]),
          tx.unsafe("INSERT INTO driver_values (value) VALUES ($1)", [2]),
        ]);
        return await tx.unsafe<{ value: number }>("SELECT value FROM driver_values ORDER BY value");
      });
      expect(rows.map((row) => row.value)).toEqual([1, 2]);
    } finally {
      await client.end();
    }
  });

  test("internal pool continues after a query error", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      const failed = client.unsafe("SELECT missing_driver_column").execute();
      const pending = client.unsafe<{ value: number }>("SELECT 1::int AS value").execute();
      await expect(Promise.resolve(failed)).rejects.toMatchObject({ code: "42703" });
      expect((await pending)[0]!.value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("unsupported COPY streams fail fast and reconnect later work", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      await expect(Promise.resolve(
        client.unsafe("COPY (SELECT 1) TO STDOUT"),
      )).rejects.toThrow("COPY streaming protocol is not supported");
      expect((await client.unsafe<{ value: number }>("SELECT 1::int AS value"))[0]!.value).toBe(1);
      await client.unsafe("CREATE TEMP TABLE driver_copy_input (value int)");
      await expect(Promise.resolve(
        client.unsafe("COPY driver_copy_input FROM STDIN"),
      )).rejects.toThrow("COPY streaming protocol is not supported");
      expect((await client.unsafe<{ value: number }>("SELECT 2::int AS value"))[0]!.value).toBe(2);
    } finally {
      await client.end();
    }
  });

  test("internal pool cancels an active query and remains usable", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      await client.unsafe("SELECT 1");
      const pending = client.unsafe("SELECT pg_sleep(10)").execute();
      setTimeout(() => void pending.cancel(), 50);
      await expect(Promise.resolve(pending)).rejects.toMatchObject({ code: "57014" });
      const rows = await client.unsafe<{ value: number }>("SELECT 1::int AS value");
      expect(rows[0]!.value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("internal pool cancels queued work before a connection is released", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      const blocker = client.unsafe("SELECT pg_sleep(0.2)").execute();
      const queued = client.unsafe("SELECT 2::int AS value").execute();
      setTimeout(() => void queued.cancel(), 20);
      const outcome = await Promise.race([
        Promise.resolve(queued).then(
          () => "resolved",
          (error) => error instanceof Error ? error.message : String(error),
        ),
        new Promise<"still queued">((resolve) => setTimeout(() => resolve("still queued"), 100)),
      ]);
      expect(outcome).toBe("sqlx-js: query cancelled before dispatch");
      await blocker;
      expect((await client.unsafe<{ value: number }>("SELECT 1::int AS value"))[0]!.value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("internal pool cancels immediate work before dispatch", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      await client.unsafe("CREATE TEMP TABLE driver_cancel_immediate (value int NOT NULL)");
      const pending = client.unsafe(
        "INSERT INTO driver_cancel_immediate (value) VALUES (1)",
      ).execute();
      void pending.cancel();
      await expect(Promise.resolve(pending)).rejects.toThrow("query cancelled before dispatch");
      const [{ count }] = await client.unsafe<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM driver_cancel_immediate",
      );
      expect(count).toBe(0);
    } finally {
      await client.end();
    }
  });

  test("cancellation during parameter encoding never dispatches the statement", async () => {
    const { createClient } = await import("../src/index");
    let pending: ReturnType<PostgresClient["unsafe"]> | undefined;
    const client = createClient(dbUrl, {
      max: 1,
      types: {
        cancellingInt: {
          to: 23,
          from: [],
          parse: Number,
          serialize: (value) => {
            void pending?.cancel();
            return String(value);
          },
        },
      },
    });
    await client.unsafe("DROP TABLE IF EXISTS driver_cancel_before_execute");
    await client.unsafe("CREATE TABLE driver_cancel_before_execute (value int NOT NULL)");
    try {
      pending = client.unsafe(
        "INSERT INTO driver_cancel_before_execute (value) VALUES ($1)",
        [1],
      );
      await expect(Promise.resolve(pending)).rejects.toThrow("query cancelled before dispatch");
      const [{ count }] = await client.unsafe<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM driver_cancel_before_execute",
      );
      expect(count).toBe(0);
    } finally {
      await client.unsafe("DROP TABLE IF EXISTS driver_cancel_before_execute");
      await client.end();
    }
  });

  test("a settled query cannot cancel later work on the same backend", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      const completed = client.unsafe("SELECT 1");
      await completed;
      const later = client.unsafe<{ value: number }>(
        "SELECT 2::int AS value FROM (SELECT pg_sleep(0.15)) AS wait",
      ).execute();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await completed.cancel();
      expect((await later)[0]!.value).toBe(2);
    } finally {
      await client.end();
    }
  });

  test("raw result metadata remains non-enumerable", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      const rows = await client.unsafe<{ value: number }>("SELECT 1::int AS value");
      expect(rows.count).toBe(1);
      expect(rows.command).toBe("SELECT");
      expect(Object.keys(rows)).toEqual(["0"]);
      expect(JSON.stringify(rows)).toBe('[{"value":1}]');
    } finally {
      await client.end();
    }
  });

  test("internal pool encodes UTF-8 and null bind parameters", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      const text = "Привет, PostgreSQL";
      const [row] = await client.unsafe<{ value: string; missing: null }>(
        "SELECT $1::text AS value, $2::text AS missing",
        [text, null],
      );
      expect(row).toEqual({ value: text, missing: null });
    } finally {
      await client.end();
    }
  });

  test("raw value rows preserve duplicate columns and multidimensional arrays", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      expect(await client.unsafe("SELECT 1::int AS value, 2::int AS value").values()).toEqual([[1, 2]]);
      const [row] = await client.unsafe<{ matrix: number[][] }>(
        "SELECT $1::int[][] AS matrix",
        [client.array([[1, 2], [3, 4]])],
      );
      expect(row.matrix).toEqual([[1, 2], [3, 4]]);
    } finally {
      await client.end();
    }
  });

  test("internal pool reconnects after a backend terminates its connection", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    const admin = createClient(dbUrl, { max: 1 });
    try {
      const [{ pid }] = await client.unsafe<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
      const pending = client.unsafe("SELECT pg_sleep(10)").execute();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await admin.unsafe("SELECT pg_terminate_backend($1)", [pid]);
      await expect(Promise.resolve(pending)).rejects.toBeInstanceOf(Error);
      const rows = await client.unsafe<{ value: number }>("SELECT 1::int AS value");
      expect(rows[0]!.value).toBe(1);
    } finally {
      await Promise.all([
        client.end(),
        admin.end(),
      ]);
    }
  });

  test("internal pool end settles after a backend terminates its connection", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    const admin = createClient(dbUrl, { max: 1 });
    try {
      const [{ pid }] = await client.unsafe<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
      const pending = client.unsafe("SELECT pg_sleep(10)").execute();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await admin.unsafe("SELECT pg_terminate_backend($1)", [pid]);
      await expect(Promise.resolve(pending)).rejects.toBeInstanceOf(Error);
      const ended = await Promise.race([
        client.end().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(ended).toBe(true);
    } finally {
      await Promise.all([
        client.end(),
        admin.end(),
      ]);
    }
  });

  test("transaction clients never reconnect outside their transaction", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    const admin = createClient(dbUrl, { max: 1 });
    await admin.unsafe("DROP TABLE IF EXISTS driver_transaction_escape");
    await admin.unsafe("CREATE TABLE driver_transaction_escape (value int NOT NULL)");
    try {
      await expect(client.begin(async (tx) => {
        const [{ pid }] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
        const pending = tx.unsafe("SELECT pg_sleep(10)").execute();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await admin.unsafe("SELECT pg_terminate_backend($1)", [pid]);
        await expect(Promise.resolve(pending)).rejects.toBeInstanceOf(Error);
        await tx.unsafe("INSERT INTO driver_transaction_escape (value) VALUES (1)");
      })).rejects.toThrow("transaction connection is closed");
      const [{ count }] = await admin.unsafe<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM driver_transaction_escape",
      );
      expect(count).toBe(0);
    } finally {
      await admin.unsafe("DROP TABLE IF EXISTS driver_transaction_escape");
      await Promise.all([
        client.end(),
        admin.end(),
      ]);
    }
  });

  test("raw transaction clients expire when their callback finishes", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    let transaction: Parameters<Parameters<PostgresClient["begin"]>[0]>[0] | undefined;
    try {
      await client.begin(async (tx) => {
        transaction = tx;
        await tx.unsafe("SELECT 1");
      });
      await expect(Promise.resolve(transaction!.unsafe("SELECT 1"))).rejects.toThrow(
        "transaction client cannot be used after the transaction ends",
      );
      expect((await client.unsafe<{ value: number }>("SELECT 1::int AS value"))[0]!.value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("internal codecs preserve bigint and SQL null array elements", async () => {
    const { createClient, ResultDecodeError } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      const [row] = await client.unsafe<{
        ordinal: bigint;
        smallints: (number | null)[];
        aggregated: (number | null)[];
        record: string;
        waited: void;
        xid: bigint;
        xids: (bigint | null)[];
        bounded: (number | null)[];
        matrix: number[][];
        oids: (number | null)[];
      }>(
        `SELECT
           row_number() OVER (ORDER BY value) AS ordinal,
           ARRAY[1::smallint, NULL]::smallint[] AS smallints,
           (
             SELECT array_agg(item ORDER BY position)
             FROM (VALUES (1, 1::int), (2, NULL::int)) AS items(position, item)
           ) AS aggregated,
           ROW(1::int, 'value'::text) AS record,
           pg_sleep(0) AS waited,
           '123'::xid8 AS xid,
           ARRAY['123'::xid8, NULL]::xid8[] AS xids,
           '[0:2]={-2,NULL,3}'::int2[] AS bounded,
           ARRAY[[-1,2],[3,-4]]::int4[][] AS matrix,
           ARRAY[0::oid, 4294967295::oid, NULL]::oid[] AS oids
         FROM (VALUES (1::int)) AS values(value)`,
      );
      expect(row.ordinal).toBe(1n);
      expect(row.smallints).toEqual([1, null]);
      expect(row.aggregated).toEqual([1, null]);
      expect(row.record).toBe("(1,value)");
      expect(row.waited).toBeUndefined();
      expect(row.xid).toBe(123n);
      expect(row.xids).toEqual([123n, null]);
      expect(row.bounded).toEqual([-2, null, 3]);
      expect(row.matrix).toEqual([[-1, 2], [3, -4]]);
      expect(row.oids).toEqual([0, 4294967295, null]);
      const [{ bc }] = await client.unsafe<{ bc: Temporal.PlainDate }>(
        "SELECT '4714-11-24 BC'::date AS bc",
      );
      expect(bc.toString()).toBe("-004713-11-24");
      const [{ roundtrip }] = await client.unsafe<{ roundtrip: Temporal.PlainDate }>(
        "SELECT $1::date AS roundtrip",
        [bc],
      );
      expect(roundtrip.toString()).toBe("-004713-11-24");
      const [{ futureDate }] = await client.unsafe<{ futureDate: Temporal.PlainDate }>(
        "SELECT '10000-01-01'::date AS \"futureDate\"",
      );
      expect(futureDate.toString()).toBe("+010000-01-01");
      const [{ futureRoundtrip }] = await client.unsafe<{ futureRoundtrip: Temporal.PlainDate }>(
        "SELECT $1::date AS \"futureRoundtrip\"",
        [futureDate],
      );
      expect(futureRoundtrip.toString()).toBe("+010000-01-01");
      const [{ bcTimestamp, bcInstant }] = await client.unsafe<{
        bcTimestamp: Temporal.PlainDateTime;
        bcInstant: Temporal.Instant;
      }>(
        `SELECT
           '0001-02-03 04:05:06.123456 BC'::timestamp AS "bcTimestamp",
           '0001-02-03 04:05:06.123456+00 BC'::timestamptz AS "bcInstant"`,
      );
      expect(bcTimestamp.toString()).toBe("0000-02-03T04:05:06.123456");
      expect(bcInstant.toString()).toBe("0000-02-03T04:05:06.123456Z");
      const [{ timestampRoundtrip, instantRoundtrip }] = await client.unsafe<{
        timestampRoundtrip: Temporal.PlainDateTime;
        instantRoundtrip: Temporal.Instant;
      }>(
        `SELECT
           $1::timestamp AS "timestampRoundtrip",
           $2::timestamptz AS "instantRoundtrip"`,
        [bcTimestamp, bcInstant],
      );
      expect(timestampRoundtrip.toString()).toBe("0000-02-03T04:05:06.123456");
      expect(instantRoundtrip.toString()).toBe("0000-02-03T04:05:06.123456Z");
      const rangeError = await Promise.resolve(client.unsafe(
        "SELECT '5874897-12-31'::date",
      )).catch((error) => error);
      expect(rangeError).toBeInstanceOf(ResultDecodeError);
      expect(rangeError).toMatchObject({
        columnIndex: 0,
        column: "date",
        typeOid: 1082,
        cause: expect.objectContaining({
          message: expect.stringContaining("outside Temporal.PlainDate range"),
        }),
      });
      expect((await client.unsafe<{ value: number }>("SELECT 1::int AS value"))[0]!.value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("raw result decode errors expose column context and keep the pool usable", async () => {
    const { createClient, ResultDecodeError } = await import("../src/index");
    const client = createClient(dbUrl, {
      max: 1,
      temporal: { infinity: "reject" },
    });
    try {
      const [{ pid: initialPid }] = await client.unsafe<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      const scalarQuery = `SELECT
        value::int AS ok,
        'infinity'::timestamptz AS "nextAttemptAt"
      FROM generate_series(1, 32) AS series(value)`;
      const scalarError = await Promise.resolve(client.unsafe(scalarQuery)).catch((error) => error);
      expect(scalarError).toBeInstanceOf(ResultDecodeError);
      expect(scalarError).toMatchObject({
        queryId: queryId(scalarQuery),
        columnIndex: 1,
        column: "nextAttemptAt",
        typeOid: 1184,
        hint: expect.stringContaining("isfinite(...)"),
        cause: expect.objectContaining({
          message: expect.stringContaining("PostgreSQL timestamptz infinity is rejected"),
        }),
      });
      expect((scalarError as Error).message).toContain("isfinite(...)");
      expect((scalarError as Error).stack).toContain("ResultDecodeError:");
      expect((scalarError as Error).stack).toContain("decodeDataRow");
      await expect(Promise.resolve(client.unsafe(
        "SELECT $1::date AS value",
        ["-infinity"],
      ))).rejects.toThrow("PostgreSQL date requires Temporal.PlainDate");
      const arrayQuery = "SELECT ARRAY['infinity'::timestamptz] AS value";
      const arrayError = await Promise.resolve(client.unsafe(arrayQuery)).catch((error) => error);
      expect(arrayError).toBeInstanceOf(ResultDecodeError);
      expect(arrayError).toMatchObject({
        queryId: queryId(arrayQuery),
        columnIndex: 0,
        column: "value",
        typeOid: 1185,
        hint: expect.stringContaining("isfinite(...)"),
        cause: expect.objectContaining({
          message: expect.stringContaining("PostgreSQL timestamptz infinity is rejected"),
        }),
      });
      await expect(Promise.resolve(client.unsafe(
        "SELECT $1::date[] AS value",
        [client.array(["-infinity"])],
      ))).rejects.toThrow("PostgreSQL date requires Temporal.PlainDate");
      const [{ pid: finalPid }] = await client.unsafe<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      expect(finalPid).toBe(initialPid);
    } finally {
      await client.end();
    }
  });

  test("managed custom-codec errors expose named query context in root and transaction paths", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP TABLE IF EXISTS tmp_decode_role_records;
        DROP TYPE IF EXISTS tmp_decode_role;
        CREATE TYPE tmp_decode_role AS ENUM ('admin');
        CREATE TABLE tmp_decode_role_records (role tmp_decode_role NOT NULL)
      `);
    } finally {
      await setup.end();
    }

    const { createSqlClient, defineQuery, ResultDecodeError } = await import("../src/index");
    const decodeCause = new Error("application role decoder rejected the value");
    const client = createSqlClient(dbUrl, {
      max: 1,
      typeCodecs: {
        tmp_decode_role: {
          parse: () => { throw decodeCause; },
          serialize: (value: string) => value,
        },
      },
    });
    const query = defineQuery.one(
      "billing.decodeRole",
      `INSERT INTO tmp_decode_role_records (role)
       VALUES ($role)
       RETURNING role`,
    );
    try {
      const [{ pid: initialPid }] = await client.unsafe<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      const rootError = await query.run(client.sql as never, { role: "admin" }).catch((error) => error);
      expect(rootError).toBeInstanceOf(ResultDecodeError);
      expect(rootError).toMatchObject({
        queryId: query.queryId,
        queryName: "billing.decodeRole",
        columnIndex: 0,
        column: "role",
        typeOid: expect.any(Number),
        cause: decodeCause,
      });
      const [{ count: committedCount }] = await client.unsafe<{ count: number }>(
        "SELECT count(*)::int AS count FROM tmp_decode_role_records",
      );
      expect(committedCount).toBe(1);

      const transactionError = await client.sql.transaction(async (transaction) =>
        await query.run(transaction as never, { role: "admin" })
      ).catch((error) => error);
      expect(transactionError).toBeInstanceOf(ResultDecodeError);
      expect(transactionError).toMatchObject({
        queryId: query.queryId,
        queryName: "billing.decodeRole",
        columnIndex: 0,
        column: "role",
        typeOid: expect.any(Number),
        cause: decodeCause,
      });
      expect((rootError as Error).stack).toContain("decodeDataRow");
      expect((transactionError as Error).stack).toContain("decodeDataRow");
      const [{ count: countAfterRollback }] = await client.unsafe<{ count: number }>(
        "SELECT count(*)::int AS count FROM tmp_decode_role_records",
      );
      expect(countAfterRollback).toBe(1);
      const [{ pid: finalPid }] = await client.unsafe<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      expect(finalPid).toBe(initialPid);
    } finally {
      await client.close();
      const cleanup = new PgClient(parseDatabaseUrl(dbUrl));
      await cleanup.connect();
      try {
        await cleanup.simpleQuery("DROP TABLE IF EXISTS tmp_decode_role_records; DROP TYPE IF EXISTS tmp_decode_role");
      } finally {
        await cleanup.end();
      }
    }
  });

  test("driver forces ISO and UTC temporal output over startup options", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, {
      max: 1,
      startupOptions: "-c DateStyle=SQL,DMY",
    });
    try {
      const [row] = await client.unsafe<{
        style: string;
        timezone: string;
        date: Temporal.PlainDate;
        timestamp: Temporal.PlainDateTime;
        timestamptz: Temporal.Instant;
      }>(
        `SELECT
           current_setting('DateStyle') AS style,
           current_setting('TimeZone') AS timezone,
           '2026-07-24'::date AS date,
           '2026-07-24 12:34:56'::timestamp AS timestamp,
           '2026-07-24 12:34:56+00'::timestamptz AS timestamptz`,
      );
      expect(row.style).toMatch(/^ISO/);
      expect(row.timezone).toBe("UTC");
      expect(row.date.toString()).toBe("2026-07-24");
      expect(row.timestamp.toString()).toBe("2026-07-24T12:34:56");
      expect(row.timestamptz.toString()).toBe("2026-07-24T12:34:56Z");
    } finally {
      await client.end();
    }
  });

  test("UTC startup policy overrides a non-UTC startup option", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, {
      max: 1,
      startupOptions: "-c TimeZone=Europe/Paris",
    });
    try {
      const [{ value, timezone }] = await client.unsafe<{ value: Temporal.Instant; timezone: string }>(
        "SELECT '1800-01-01 00:00:00+00'::timestamptz AS value, current_setting('TimeZone') AS timezone",
      );
      expect(value.toString()).toBe("1800-01-01T00:00:00Z");
      expect(timezone).toBe("UTC");
    } finally {
      await client.end();
    }
  });

  test("session temporal settings fail closed after startup", async () => {
    const { createSqlClient } = await import("../src/index");
    const client = createSqlClient(dbUrl, { max: 1 });
    try {
      await expect(client.unsafe("SET TimeZone = 'Europe/Paris'"))
        .rejects.toThrow("PostgreSQL session TimeZone changed");
      expect((await client.unsafe<{ value: string }>(
        "SELECT current_setting('TimeZone') AS value",
      ))[0]!.value).toBe("UTC");

      await expect(client.unsafe("SET DateStyle = 'SQL, DMY'"))
        .rejects.toThrow("PostgreSQL session DateStyle changed");
      expect((await client.unsafe<{ value: string }>(
        "SELECT current_setting('DateStyle') AS value",
      ))[0]!.value).toMatch(/^ISO/);
    } finally {
      await client.close();
    }
  });

  test("internal protocol rejects deferred errors received after CommandComplete", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    await client.unsafe("DROP TABLE IF EXISTS driver_deferred_child");
    await client.unsafe("DROP TABLE IF EXISTS driver_deferred_parent");
    await client.unsafe("CREATE TABLE driver_deferred_parent (id int PRIMARY KEY)");
    await client.unsafe(`
      CREATE TABLE driver_deferred_child (
        parent_id int REFERENCES driver_deferred_parent(id) DEFERRABLE INITIALLY DEFERRED
      )
    `);
    try {
      await expect(
        Promise.resolve(client.unsafe("INSERT INTO driver_deferred_child (parent_id) VALUES (1)")),
      ).rejects.toMatchObject({ code: "23503" });
      const [{ count }] = await client.unsafe<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM driver_deferred_child",
      );
      expect(count).toBe(0);
    } finally {
      await client.unsafe("DROP TABLE IF EXISTS driver_deferred_child");
      await client.unsafe("DROP TABLE IF EXISTS driver_deferred_parent");
      await client.end();
    }
  });

  test("transaction parameter errors settle and leave the pool usable", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      await expect(client.begin(async (tx) => {
        await Promise.all([
          tx.unsafe("SELECT 1"),
          tx.unsafe("SELECT $1::int", [undefined]),
        ]);
      })).rejects.toThrow("undefined is not a PostgreSQL value");
      const [{ value }] = await client.unsafe<{ value: number }>("SELECT 1::int AS value");
      expect(value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("raw JSON wrappers reject non-serializable values before dispatch", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      await expect(Promise.resolve(client.unsafe(
        "SELECT $1::jsonb",
        [client.json(1n as never)],
      ))).rejects.toThrow("PostgreSQL JSON values require a SqlxJson document");
      const [{ value }] = await client.unsafe<{ value: number }>("SELECT 1::int AS value");
      expect(value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("a caught database error cannot turn an automatic rollback into success", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      await expect(client.begin(async (tx) => {
        try {
          await tx.unsafe("SELECT missing_transaction_column");
        } catch {}
        return "not committed";
      })).rejects.toThrow("instead of COMMIT");
      const [{ value }] = await client.unsafe<{ value: number }>("SELECT 1::int AS value");
      expect(value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("raw transaction callbacks cannot finish after ending their transaction", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1 });
    try {
      await expect(client.begin(async (tx) => {
        await tx.unsafe("COMMIT");
        return "not transactional";
      })).rejects.toThrow("transaction ended before its callback completed");
      expect((await client.unsafe<{ value: number }>("SELECT 1::int AS value"))[0]!.value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("internal pool retires idle connections", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1, idleTimeoutMs: 20 });
    try {
      const [{ pid: firstPid }] = await client.unsafe<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const [{ pid: secondPid }] = await client.unsafe<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      expect(secondPid).not.toBe(firstPid);
    } finally {
      await client.end();
    }
  });

  test("internal pool enables TCP keepalive on new connections", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1, keepAliveMs: 0 });
    try {
      const [{ value }] = await client.unsafe<{ value: number }>("SELECT 1::int AS value");
      expect(value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("internal pool retires connections at their maximum lifetime", async () => {
    const { createClient } = await import("../src/index");
    const client = createClient(dbUrl, { max: 1, maxLifetimeMs: 20 });
    try {
      const [{ pid: firstPid }] = await client.unsafe<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const [{ pid: secondPid }] = await client.unsafe<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      expect(secondPid).not.toBe(firstPid);
    } finally {
      await client.end();
    }
  });

  test("internal pool resolves a fresh dynamic password for each connection", async () => {
    const { createClient } = await import("../src/index");
    let calls = 0;
    const client = createClient(dbUrl, {
      max: 1,
      idleTimeoutMs: 20,
      password: async () => {
        calls++;
        return "postgres";
      },
    });
    try {
      await client.unsafe("SELECT 1");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client.unsafe("SELECT 1");
      expect(calls).toBe(2);
    } finally {
      await client.end();
    }
  });

  test("internal pool surfaces structured PostgreSQL notices", async () => {
    const { createClient } = await import("../src/index");
    const notices: { message: string; severity?: string; code?: string }[] = [];
    const client = createClient(dbUrl, {
      max: 1,
      onNotice: async (notice) => {
        notices.push(notice);
        throw new Error("notice observer failed");
      },
    });
    try {
      await client.unsafe("DO $$ BEGIN RAISE NOTICE 'driver notice'; END $$");
      expect(notices).toEqual([
        expect.objectContaining({
          message: "driver notice",
          severity: "NOTICE",
          code: "00000",
        }),
      ]);
      expect((await client.unsafe<{ value: number }>("SELECT 1::int AS value"))[0]!.value).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("scanner recognizes sql.transaction callback param as sql-alias", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.transaction(async (tx) => {\n" +
      "  await tx(\"SELECT id FROM tmp_users WHERE id = $1\", 1);\n" +
      "});\n",
    );
    const r = prepare(["--verbose"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.ts:3:12/);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("SELECT id FROM tmp_users WHERE id = $1");
  });
}

export {};
