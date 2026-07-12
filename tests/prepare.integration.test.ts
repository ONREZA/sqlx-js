import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PgClient, parseDatabaseUrl } from "../src/pg/wire";
import { validateAll } from "../src/commands/prepare";
import { SchemaCache, compositeLiteral } from "../src/pg/schema";
import { mergeExtensionTypes } from "../src/pg/extensions";
import { fingerprint } from "../src/cache";

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

  function schema(args: string[] = []): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), "schema", ...args, "--root", tmp],
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

  test("prepare succeeds for a valid query and emits .d.ts and cache", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id, name FROM tmp_users WHERE id = $1\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.ts:2:11/);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("interface KnownQueries");
    expect(dts).toContain("SELECT id, name FROM tmp_users WHERE id = $1");
    expect(queryCacheFiles().length).toBeGreaterThan(0);
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
    const r = prepare();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.ts:3:18/);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("SELECT id, name FROM tmp_users WHERE id = $1");
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
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.execute(\"SET statement_timeout = '1s'\");\n" +
      "await sql.execute(\"CALL tmp_parse_only_procedure()\");\n",
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
    const entries = queryCacheFiles(root).map((cacheFile) =>
      JSON.parse(readFileSync(join(root, ".sqlx-js", cacheFile), "utf8")) as { validation?: string });
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.validation === "parse-only")).toBe(true);
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
      "config",
      "env",
      "cache",
      "tsconfig",
      "database",
      "permissions",
      "runtimeTypes",
      "pgschema",
    ]);
    expect(payload.checks.every((check) => check.status !== "error")).toBe(true);
    expect(payload.checks.find((check) => check.name === "permissions")?.details).toMatchObject({
      schemaUsage: true,
      createDatabase: true,
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

  test("prepare emits KnownFunctions from pg_proc and keeps them in --check", async () => {
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
        CREATE FUNCTION tmp_catalog_slug(value text) RETURNS text
        LANGUAGE sql IMMUTABLE AS $$ SELECT lower(value) $$;
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
    expect(dts).toContain("interface KnownFunctions");
    expect(dts).toContain('"public.tmp_catalog_slug(value text)": { kind: "function"; params: [string]; returns: string | null; returnsSet: false }');
    expect(dts).toContain('"public.tmp_catalog_pair(value text)": { kind: "function"; params: [string]; returns: { slug: string | null; score: number | null }; returnsSet: true }');
    expect(dts).toContain('"public.tmp_catalog_json_table(value jsonb)": { kind: "function"; params: [import("@onreza/sqlx-js").JsonInput]; returns: { payload: import("@onreza/sqlx-js").JsonValue | null }; returnsSet: true }');
    expect(dts).toContain('"public.tmp_catalog_json_out(value text, OUT payload jsonb)": { kind: "function"; params: [string]; returns: { payload: import("@onreza/sqlx-js").JsonValue | null }; returnsSet: false }');
    expect(dts).toMatch(/"public\.tmp_catalog_json_inout\([^"]*jsonb\)": \{ kind: "function"; params: \[import\("@onreza\/sqlx-js"\)\.JsonInput\]; returns: \{ payload: import\("@onreza\/sqlx-js"\)\.JsonValue \| null \}; returnsSet: false \}/);
    expect(dts).toContain('"public.tmp_catalog_json_array(value jsonb[])": { kind: "function"; params: [(import("@onreza/sqlx-js").JsonInput | null)[]]; returns: (import("@onreza/sqlx-js").JsonValue | null)[] | null; returnsSet: false }');
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

  test("columnTypes override direct scalar results and mapped parameters only", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        CREATE TABLE IF NOT EXISTS tmp_column_types (
          id bigint PRIMARY KEY,
          action text NOT NULL
        )
      `);
    } finally {
      await setup.end();
    }
    const root = isolatedRoot("column-types");
    writeRootFile(root, "sqlx-js.config.ts", `export default {
      columnTypes: { "public.tmp_column_types.action": '\"created\" | \"deleted\"' },
    };\n`);
    writeRootFile(root, "a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT action, upper(action) AS derived FROM tmp_column_types WHERE action = $action\", { action: \"created\" });\n" +
      "await sql(\"INSERT INTO tmp_column_types (id, action) VALUES ($id, $action) RETURNING action\", { id: 1n, action: \"created\" });\n",
    );
    const r = prepareRoot(root);
    expect(r.code, r.stderr).toBe(0);
    const dts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"action": "created" | "deleted"');
    expect(dts).toContain('"derived": string');
    expect(dts).toContain('"action": "created" | "deleted" }');
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
      jsonbTypes: {
        "public.tmp_union_types.payload_a": 'import("./types").UnionPayload',
        "public.tmp_union_types.payload_b": 'import("./types").UnionPayload',
      },
      columnTypes: {
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
    expect(dts).toContain('"payload": import("./types").UnionPayload');
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
        {
          fp: "qmerge",
          query: "MERGE INTO tmp_users AS target USING (SELECT $1::bigint AS id) AS source ON target.id = source.id WHEN MATCHED THEN UPDATE SET name = target.name",
        },
        { fp: "qbad", query: "SELECT * FROM no_such_relation_xyz" },
      ];
      const results = await validateAll(cfg, session, queries, 4);
      expect(results.size).toBe(6);
      const q1 = results.get("q1")!;
      expect(q1.ok).toBe(true);
      if (q1.ok) expect(q1.fields.map((f) => f.name)).toEqual(["id", "name"]);
      const q2 = results.get("q2")!;
      if (q2.ok) expect(q2.fields.map((f) => f.name)).toEqual(["email"]);
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
      await setup.simpleQuery("CREATE TYPE tmp_addr AS (street text, zip int)");
      await setup.simpleQuery("CREATE TABLE tmp_comp (id bigserial primary key, addr tmp_addr)");
      const d = await setup.describe("SELECT addr FROM tmp_comp");
      const addrOid = d.fields[0]!.typeOid;
      const schema = new SchemaCache(setup);
      schema.setTypeRegistry(mergeExtensionTypes());
      await schema.loadCustomTypes([addrOid]);
      const info = schema.customType(addrOid);
      expect(info?.kind).toBe("composite");
      if (info?.kind === "composite") {
        expect(compositeLiteral(info)).toBe("{ street: string | null; zip: number | null }");
      }
    } finally {
      await setup.simpleQuery("DROP TABLE IF EXISTS tmp_comp CASCADE").catch(() => {});
      await setup.simpleQuery("DROP TYPE IF EXISTS tmp_addr CASCADE").catch(() => {});
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

  test("prepare --shadow-url applies migrations before preparing", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT id, name FROM tmp_users WHERE id = $1\", 1);\n",
    );
    const r = prepare(["--shadow-url", dbUrl]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("shadow:");
    expect(r.stdout).toContain("prepared 1 unique query");
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
    r = prepare();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pruned 1 orphaned/);
    const second = queryCacheFiles();
    expect(second.length).toBe(1);
    expect(second[0]).not.toBe(firstFiles[0]);
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
  jsonbTypes: { "tmp_search_path.tmp_search_path_target.payload": "SearchPathPayload" },
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
      expect(dts).toContain('JsonParameter<SearchPathPayload> | null');
      expect(dts).toContain('"payload": SearchPathPayload | null');
    } finally {
      await client.simpleQuery("DROP TABLE IF EXISTS public.tmp_search_path_target; DROP SCHEMA IF EXISTS tmp_search_path CASCADE");
      await client.end();
    }
  });

  test("sql.file produces KnownFileQueries entry keyed by path", () => {
    writeFile("queries/by_id.sql", "SELECT id, name FROM tmp_users WHERE id = $1\n");
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.file(\"./queries/by_id.sql\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("interface KnownFileQueries");
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

  test("schema dump/check writes snapshot and LLM manifest with constraints and functions", () => {
    writeFile("migrations/0008_schema_contract.up.sql",
      "CREATE TABLE IF NOT EXISTS tmp_contract_posts (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  user_id BIGINT NOT NULL REFERENCES tmp_users(id) ON DELETE CASCADE,\n" +
      "  rating INT CHECK (rating >= 0),\n" +
      "  title TEXT NOT NULL UNIQUE\n" +
      ");\n" +
      "CREATE INDEX IF NOT EXISTS tmp_contract_posts_user_id_idx ON tmp_contract_posts(user_id);\n" +
      "CREATE OR REPLACE FUNCTION tmp_contract_slug(value text) RETURNS text\n" +
      "LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT lower(value) $$;\n" +
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

    const dump = schema(["dump"]);
    expect(dump.code).toBe(0);
    const raw = readFileSync(join(tmp, ".sqlx-js/schema/schema.json"), "utf8");
    const snapshot = JSON.parse(raw) as {
      relations: { schema: string; name: string; constraints: { kind: string; references?: { table: string } }[]; indexes: { name: string }[] }[];
      functions: { name: string; volatility: string; strict: boolean }[];
    };
    const rel = snapshot.relations.find((r) => r.name === "tmp_contract_posts");
    expect(rel).toBeTruthy();
    expect(snapshot.relations.some((r) => r.name === "keep_me" && r.schema === "pgx")).toBe(true);
    expect(rel!.constraints.some((c) => c.kind === "foreign_key" && c.references?.table === "tmp_users")).toBe(true);
    expect(rel!.constraints.some((c) => c.kind === "check")).toBe(true);
    expect(rel!.indexes.some((i) => i.name === "tmp_contract_posts_user_id_idx")).toBe(true);
    expect(snapshot.functions.some((f) => f.name === "tmp_contract_slug" && f.volatility === "immutable" && f.strict)).toBe(true);

    const manifest = readFileSync(join(tmp, ".sqlx-js/schema/schema.md"), "utf8");
    expect(manifest).toContain("tmp_contract_posts");
    expect(manifest).toContain("tmp_contract_slug(value text) -> text");

    const check = schema(["check"]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("schema: ok");
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

  test("migrate verify auto-creates a shadow database and compares committed prepare artifacts", () => {
    const root = isolatedRoot("migrate-verify-auto-shadow");
    try {
      writeRootFile(root, "migrations/0301_base.up.sql",
        "CREATE TABLE tmp_migrate_verify_auto_shadow_users (\n" +
        "  id BIGSERIAL PRIMARY KEY,\n" +
        "  email TEXT NOT NULL\n" +
        ");\n",
      );
      writeRootFile(root, "migrations/0301_base.down.sql",
        "DROP TABLE IF EXISTS tmp_migrate_verify_auto_shadow_users;\n",
      );
      writeRootFile(root, "a.ts",
        "import { sql } from \"@onreza/sqlx-js\";\n" +
        "await sql(\"SELECT id, email FROM tmp_migrate_verify_auto_shadow_users WHERE email = $1\", \"x\");\n",
      );

      const generated = migrateCommand(["dev"], root);
      expect(generated.code).toBe(0);
      const beforeDts = readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8");
      const beforeCache = queryCacheFiles(root)
        .sort()
        .map((name) => [name, readFileSync(join(root, ".sqlx-js", name), "utf8")]);

      const r = migrateCommand(["verify"], root);

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

  test("migrate dev auto-creates a shadow database and writes prepare artifacts", () => {
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

      const r = migrateCommand(["dev"], root);

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

  test("strict inference accepts structurally checked existential JsonParameter values", () => {
    writeFile("migrations/0006_json_fallback.up.sql",
      "CREATE TABLE IF NOT EXISTS tmp_json_fallback (\n" +
      "  id BIGSERIAL PRIMARY KEY,\n" +
      "  payload JSONB NOT NULL,\n" +
      "  maybe_payload JSONB\n" +
      ");\n",
    );
    writeFile("migrations/0006_json_fallback.down.sql",
      "DROP TABLE IF EXISTS tmp_json_fallback;\n",
    );
    const mig = migrate();
    expect(mig.code).toBe(0);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"INSERT INTO tmp_json_fallback (payload, maybe_payload) VALUES ($1, $2) RETURNING payload, maybe_payload\", sql.json({ ok: true, tags: [\"a\"], nested: { n: 1 } }), null);\n",
    );
    const r = prepare(["--strict-inference"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("inference failed");
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/tmp_json_fallback.*params: \[import\("@onreza\/sqlx-js"\)\.JsonParameter<unknown>, import\("@onreza\/sqlx-js"\)\.JsonParameter<unknown> \| null\]/);
    expect(dts).toContain('"payload": import("@onreza/sqlx-js").JsonValue');
    expect(dts).toContain('"maybe_payload": import("@onreza/sqlx-js").JsonValue | null');
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
      "await sql(\"INSERT INTO tmp_array_contracts (plain, proven, wrapped, roles, domain_roles, pairs) VALUES ($1, $2, $3, $4, $5, ARRAY[ROW('label', 1)]::tmp_array_pair[])\", sql.array([\"a\"]), sql.array([\"b\"]), sql.array([\"c\", null]), sql.array([\"admin\"]), sql.array([\"member\"]));\n",
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
    expect(jsonDts).toContain('PgArrayParameter<import("@onreza/sqlx-js").JsonParameter<unknown>, boolean>');
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

  test("sql.one and sql.optional reach KnownQueries via the scanner", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.one(\"SELECT id FROM tmp_users WHERE id = $1\", 1);\n" +
      "await sql.optional(\"SELECT id FROM tmp_users WHERE email = $1\", \"x\");\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("SELECT id FROM tmp_users WHERE id = $1");
    expect(dts).toContain("SELECT id FROM tmp_users WHERE email = $1");
  });

  test("sql.file.one and sql.file.optional reach KnownFileQueries via the scanner", () => {
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
    const { sql, close } = await import("../src/index");
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
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
      const timestamp = new Date("2026-01-02T03:04:05.000Z");
      const dates = await sql("SELECT $1::timestamptz[] AS xs", sql.array([timestamp]));
      expect((dates[0] as { xs: Date[] }).xs).toEqual([timestamp]);
    } finally {
      await close();
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
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
        DROP TYPE IF EXISTS tmp_runtime_role CASCADE;
        DROP DOMAIN IF EXISTS tmp_runtime_role_domain CASCADE;
        DROP DOMAIN IF EXISTS tmp_runtime_vectors CASCADE;
        DROP DOMAIN IF EXISTS tmp_runtime_positive CASCADE;
        CREATE TYPE tmp_runtime_role AS ENUM ('admin', 'member');
        CREATE DOMAIN tmp_runtime_role_domain AS tmp_runtime_role;
        CREATE DOMAIN tmp_runtime_positive AS integer CHECK (VALUE > 0);
        CREATE DOMAIN tmp_runtime_vectors AS vector[];
        CREATE TYPE tmp_runtime_item AS (label text, score integer);
      `);
    } finally {
      await setup.end();
    }

    const { createSqlClient, array } = await import("../src/index");
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
                $8::tmp_runtime_vectors AS domain_vector_values`,
        [8, 9],
        { key: "value", nullable: null, 'quote"slash\\': 'comma, arrow=> and "quote"' },
        "member",
        array(["member", null]),
        { label: 'parameter, "quoted"', score: 11 },
        array([{ label: "array\\value", score: 12 }, null]),
        array([[5, 6], [7, 8]]),
        array([[13, 14], [15, 16]]),
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
      });
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
    const { sql, close } = await import("../src/index");
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
    try {
      const rows = await sql("SELECT $1::jsonb AS value", sql.json([1, 2, 3]));
      expect((rows[0] as { value: unknown }).value).toEqual([1, 2, 3]);
      const jsonNull = await sql("SELECT $1::jsonb AS value", sql.json(null));
      expect((jsonNull[0] as { value: unknown }).value).toBeNull();
    } finally {
      await close();
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  test("explicit PostgreSQL jsonb[] params roundtrip", async () => {
    const { sql, close } = await import("../src/index");
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
    try {
      const rows = await sql(
        "SELECT $1::jsonb[] AS values",
        sql.array([
          sql.json({ kind: "object" }),
          sql.json([1, 2, 3]),
          null,
        ]),
      );
      expect((rows[0] as { values: unknown[] }).values).toEqual([
        { kind: "object" },
        [1, 2, 3],
        null,
      ]);
    } finally {
      await close();
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  test("setClient installs required array codecs before the first query", async () => {
    const postgres = (await import("postgres")).default;
    const { sql, setClient, close } = await import("../src/index");
    const external = postgres(dbUrl);
    setClient(external as never);
    const timestamp = new Date("2026-01-02T03:04:05.000Z");
    try {
      const rows = await sql(
        "SELECT $1::jsonb[] AS js, $2::bytea[] AS bs, $3::timestamptz[] AS ds",
        sql.array([sql.json({ kind: "external" }), null]),
        sql.array([new Uint8Array([0xde, 0xad])]),
        sql.array([timestamp]),
      );
      const row = rows[0] as { js: unknown[]; bs: Uint8Array[]; ds: Date[] };
      expect(row.js).toEqual([{ kind: "external" }, null]);
      expect(row.bs.map((value) => Array.from(value))).toEqual([[0xde, 0xad]]);
      expect(row.ds).toEqual([timestamp]);
    } finally {
      await close();
    }
  });

  test("sql.execute returns affected row count and command", async () => {
    const { sql, close } = await import("../src/index");
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
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
      await close();
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  test("transaction timeout cancels work, rolls back, and keeps the pool usable", async () => {
    const { sql, close, TransactionTimeoutError } = await import("../src/index");
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
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
      await close();
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  test("bytea[] uses the native Postgres.js bytea codec", async () => {
    const { sql, close } = await import("../src/index");
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
    try {
      const literalRows = await sql("SELECT ARRAY[decode('dead', 'hex'), decode('beef', 'hex')]::bytea[] AS xs");
      const literal = (literalRows[0] as { xs: Uint8Array[] }).xs;
      expect(literal.map((x) => Array.from(x))).toEqual([[0xde, 0xad], [0xbe, 0xef]]);

      const paramRows = await sql("SELECT $1::bytea[] AS xs", sql.array([
        new Uint8Array([0xde, 0xad]),
        new Uint8Array([0xbe, 0xef]),
      ]));
      const param = (paramRows[0] as { xs: Uint8Array[] }).xs;
      expect(param.map((x) => Array.from(x))).toEqual([[0xde, 0xad], [0xbe, 0xef]]);
    } finally {
      await close();
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  test("scanner recognizes sql.transaction callback param as sql-alias", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.transaction(async (tx) => {\n" +
      "  await tx(\"SELECT id FROM tmp_users WHERE id = $1\", 1);\n" +
      "});\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.ts:3:12/);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain("SELECT id FROM tmp_users WHERE id = $1");
  });
}

export {};
