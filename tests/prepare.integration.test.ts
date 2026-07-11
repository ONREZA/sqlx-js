import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PgClient, parseDatabaseUrl } from "../src/pg/wire";
import { describeAll } from "../src/commands/prepare";
import { SchemaCache, compositeLiteral } from "../src/pg/schema";
import { mergeExtensionTypes } from "../src/pg/extensions";

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
      expect(payload.diagnostics[0]!.message).toContain("different jsonbTypes/customTypes config");
    } finally {
      rmSync(join(tmp, "sqlx-js.config.ts"), { force: true });
    }
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
      diagnostics: { phase: string; file: string; line: number; code?: string }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics[0]).toMatchObject({ phase: "describe", file: "a.ts", line: 2, code: "42P01" });
  });

  test("prepare emits KnownFunctions from pg_proc and keeps them in --check", async () => {
    const setup = new PgClient(parseDatabaseUrl(dbUrl));
    await setup.connect();
    try {
      await setup.simpleQuery(`
        DROP FUNCTION IF EXISTS tmp_catalog_slug(text);
        DROP FUNCTION IF EXISTS tmp_catalog_pair(text);
        DROP FUNCTION IF EXISTS tmp_catalog_json_table(jsonb);
        DROP FUNCTION IF EXISTS tmp_catalog_json_out(text);
        DROP FUNCTION IF EXISTS tmp_catalog_json_inout(jsonb);
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

    r = prepare(["--check"]);
    expect(r.code).toBe(0);
    dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('"public.tmp_catalog_slug(value text)":');
  });

  test("describeAll resolves every query across a connection pool", async () => {
    const cfg = parseDatabaseUrl(dbUrl);
    const session = new PgClient(cfg);
    await session.connect();
    try {
      const queries = [
        { fp: "q1", query: "SELECT id, name FROM tmp_users WHERE id = $1" },
        { fp: "q2", query: "SELECT email FROM tmp_users" },
        { fp: "q3", query: "SELECT title FROM tmp_join_posts" },
        { fp: "q4", query: "SELECT external_id FROM tmp_join_users" },
        { fp: "qbad", query: "SELECT * FROM no_such_relation_xyz" },
      ];
      const results = await describeAll(cfg, session, queries, 4);
      expect(results.size).toBe(5);
      const q1 = results.get("q1")!;
      expect(q1.ok).toBe(true);
      if (q1.ok) expect(q1.fields.map((f) => f.name)).toEqual(["id", "name"]);
      const q2 = results.get("q2")!;
      if (q2.ok) expect(q2.fields.map((f) => f.name)).toEqual(["email"]);
      expect(results.get("qbad")!.ok).toBe(false);
      // session connection stays usable after the pool drains
      const after = await session.describe("SELECT 1 AS one");
      expect(after.fields.length).toBe(1);
    } finally {
      await session.end();
    }
  });

  test("describeAll degrades to the session connection when extra workers cannot connect", async () => {
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
      const results = await describeAll(badCfg, session, queries, 4);
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
    rmSync(join(tmp, "sqlx-js.config.ts"), { force: true });
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

  test("unconfigured jsonb params use explicit JsonParameter<JsonInputValue>", () => {
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
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toMatch(/tmp_json_fallback.*params: \[import\("@onreza\/sqlx-js"\)\.JsonParameter<import\("@onreza\/sqlx-js"\)\.JsonInputValue>, import\("@onreza\/sqlx-js"\)\.JsonParameter<import\("@onreza\/sqlx-js"\)\.JsonInputValue> \| null\]/);
    expect(dts).toContain('"payload": import("@onreza/sqlx-js").JsonValue');
    expect(dts).toContain('"maybe_payload": import("@onreza/sqlx-js").JsonValue | null');
  });

  test("PostgreSQL array params emit the explicit PgArrayParameter wrapper", () => {
    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT $1::text[] AS values\", sql.array([\"a\", \"b\"]));\n",
    );
    const result = prepare();
    expect(result.code).toBe(0);
    const dts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(dts).toContain('params: [import("@onreza/sqlx-js").PgArrayParameter<string>]');

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT $1::jsonb[] AS values\", sql.array([sql.json({ ok: true })]));\n",
    );
    const jsonResult = prepare();
    expect(jsonResult.code).toBe(0);
    const jsonDts = readFileSync(join(tmp, "sqlx-js-env.d.ts"), "utf8");
    expect(jsonDts).toContain('PgArrayParameter<import("@onreza/sqlx-js").JsonParameter<import("@onreza/sqlx-js").JsonInputValue>>');
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
      const timestamp = new Date("2026-01-02T03:04:05.000Z");
      const dates = await sql("SELECT $1::timestamptz[] AS xs", sql.array([timestamp]));
      expect((dates[0] as { xs: Date[] }).xs).toEqual([timestamp]);
    } finally {
      await close();
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
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
