import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const repoRoot = resolve(import.meta.dir, "..");
const tmp = join(repoRoot, "tests/.tmp-integration");
const IMAGE = process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg17";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { encoding: "utf8" });
  return r.status === 0;
}

const haveDocker = dockerAvailable();

if (!haveDocker) {
  test.skip("integration suite requires Docker for testcontainers", () => {});
} else {
  let container: StartedPostgreSqlContainer;
  let dbUrl: string;

  function writeFile(rel: string, content: string) {
    const full = join(tmp, rel);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
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

  function schema(args: string[] = []): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/sqlx-js.ts"), "schema", ...args, "--root", tmp],
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
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase("sqlx_js_it")
      .withUsername("postgres")
      .withPassword("postgres")
      .start();
    dbUrl = `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/sqlx_js_it`;

    resetWorkspace();
    const r = migrate();
    if (r.code !== 0) throw new Error(`integration migrate failed: ${r.stderr}\n${r.stdout}`);
  }, 120_000);

  afterAll(async () => {
    rmSync(tmp, { recursive: true, force: true });
    if (container) await container.stop();
  }, 60_000);

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
    expect(readdirSync(join(tmp, ".sqlx-js")).filter((f) => f.endsWith(".json")).length).toBeGreaterThan(0);
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
    const firstFiles = readdirSync(join(tmp, ".sqlx-js")).filter((f) => f.endsWith(".json"));
    expect(firstFiles.length).toBe(1);

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT name FROM tmp_users\");\n",
    );
    r = prepare();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pruned 1 orphaned/);
    const second = readdirSync(join(tmp, ".sqlx-js")).filter((f) => f.endsWith(".json"));
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
    const first = readdirSync(join(tmp, ".sqlx-js")).filter((f) => f.endsWith(".json"));

    writeFile("a.ts",
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT name FROM tmp_users\");\n",
    );
    r = prepare(["--no-prune"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/pruned/);
    const second = readdirSync(join(tmp, ".sqlx-js")).filter((f) => f.endsWith(".json"));
    expect(second.length).toBe(first.length + 1);
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
    expect(dts).toContain('"queries/by_id.sql":');
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
    expect(dts).toContain('"queries/by_id.sql":');
    expect(dts).toContain('"queries/by_email.sql":');
  });

  test("text[] param roundtrips via PG array literal encoding", async () => {
    const { sql, close } = await import("../src/index");
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
    try {
      const rows = await sql("SELECT $1::text[] AS xs", ["alpha", "beta,gamma", "with \"quote\""]);
      expect((rows[0] as { xs: string[] }).xs).toEqual(["alpha", "beta,gamma", "with \"quote\""]);
      const ints = await sql("SELECT $1::int[] AS ns", [1, 2, 3]);
      expect(Array.from((ints[0] as { ns: ArrayLike<number> }).ns)).toEqual([1, 2, 3]);
      const withNull = await sql("SELECT $1::text[] AS xs", ["a", null, "b"]);
      expect((withNull[0] as { xs: (string | null)[] }).xs).toEqual(["a", null, "b"]);
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

      const paramRows = await sql("SELECT $1::bytea[] AS xs", [
        new Uint8Array([0xde, 0xad]),
        new Uint8Array([0xbe, 0xef]),
      ]);
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
