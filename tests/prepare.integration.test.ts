import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const repoRoot = resolve(import.meta.dir, "..");
const tmp = join(repoRoot, "tests/.tmp-integration");
const IMAGE = process.env.BUN_SQLX_PG_IMAGE ?? "pgvector/pgvector:pg17";

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
      [join(repoRoot, "bin/bun-sqlx.ts"), "prepare", "--root", tmp, ...args],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" },
    );
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function migrate(): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(
      "bun",
      [join(repoRoot, "bin/bun-sqlx.ts"), "migrate", "run", "--root", tmp],
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
      ");\n",
    );
    writeFile("migrations/0001_init.down.sql", "DROP TABLE IF EXISTS tmp_users;\n");
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase("bun_sqlx_it")
      .withUsername("postgres")
      .withPassword("postgres")
      .start();
    dbUrl = `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/bun_sqlx_it`;

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
      "import { sql } from \"bun-sqlx\";\n" +
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
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT id, name FROM tmp_users WHERE id = $1\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.ts:2:11/);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
    expect(dts).toContain("interface KnownQueries");
    expect(dts).toContain("SELECT id, name FROM tmp_users WHERE id = $1");
    expect(readdirSync(join(tmp, ".bun-sqlx")).filter((f) => f.endsWith(".json")).length).toBeGreaterThan(0);
  });

  test("prepare prunes orphaned cache entries by default", () => {
    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    let r = prepare();
    expect(r.code).toBe(0);
    const firstFiles = readdirSync(join(tmp, ".bun-sqlx")).filter((f) => f.endsWith(".json"));
    expect(firstFiles.length).toBe(1);

    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT name FROM tmp_users\");\n",
    );
    r = prepare();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pruned 1 orphaned/);
    const second = readdirSync(join(tmp, ".bun-sqlx")).filter((f) => f.endsWith(".json"));
    expect(second.length).toBe(1);
    expect(second[0]).not.toBe(firstFiles[0]);
  });

  test("prepare --no-prune retains orphaned cache entries", () => {
    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT id FROM tmp_users\");\n",
    );
    let r = prepare();
    expect(r.code).toBe(0);
    const first = readdirSync(join(tmp, ".bun-sqlx")).filter((f) => f.endsWith(".json"));

    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT name FROM tmp_users\");\n",
    );
    r = prepare(["--no-prune"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/pruned/);
    const second = readdirSync(join(tmp, ".bun-sqlx")).filter((f) => f.endsWith(".json"));
    expect(second.length).toBe(first.length + 1);
  });

  test("sql.file produces KnownFileQueries entry keyed by path", () => {
    writeFile("queries/by_id.sql", "SELECT id, name FROM tmp_users WHERE id = $1\n");
    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql.file(\"./queries/by_id.sql\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
    expect(dts).toContain("interface KnownFileQueries");
    expect(dts).toContain('"queries/by_id.sql":');
  });

  test("sql.file with missing path errors at scan time with file:line:column", () => {
    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql.file(\"./nope.sql\");\n",
    );
    const r = prepare();
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/a\.ts:2:16.*nope\.sql/s);
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
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT id, embedding, tags, slug, path FROM tmp_ext WHERE id = $1\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
    expect(dts).toContain('"embedding": number[] | null');
    expect(dts).toContain('"tags": Record<string, string | null> | null');
    expect(dts).toContain('"slug": string');
    expect(dts).toContain('"path": string');
  });

  test("user customTypes override built-in defaults", () => {
    writeFile("bun-sqlx.config.ts",
      "import type { BunSqlxConfig } from \"bun-sqlx\";\n" +
      "const c: BunSqlxConfig = { customTypes: { vector: \"Float32Array\" } };\n" +
      "export default c;\n",
    );
    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT id, embedding FROM tmp_ext WHERE id = $1\", 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
    expect(dts).toContain('"embedding": Float32Array | null');
    rmSync(join(tmp, "bun-sqlx.config.ts"), { force: true });
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
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT id, value FROM tmp_counters\");\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
    expect(dts).toContain('"value": number');
  });

  test("COALESCE($N, col) makes the param nullable in emitted .d.ts", () => {
    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"UPDATE tmp_users SET name = COALESCE($1, name) WHERE id = $2\", null, 1);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
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
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"INSERT INTO tmp_users (name, email, bio) VALUES ($1, $2, $3)\", \"n\", \"e\", null);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
    expect(dts).toMatch(/INSERT INTO tmp_users.*params: \[string, string, string \| null\]/);
  });

  test("$N IS NULL OR col = $N pattern makes the param nullable", () => {
    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT id FROM tmp_users WHERE $1::text IS NULL OR name = $1\", null);\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
    expect(dts).toMatch(/IS NULL OR name = \$1.*params: \[string \| null\]/);
  });

  test("WHERE col = $N stays non-null even when column is nullable", () => {
    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql(\"SELECT id FROM tmp_users WHERE bio = $1\", \"any\");\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
    expect(dts).toMatch(/WHERE bio = \$1.*params: \[string\]/);
  });

  test("scanner recognizes sql.transaction callback param as sql-alias", () => {
    writeFile("a.ts",
      "import { sql } from \"bun-sqlx\";\n" +
      "await sql.transaction(async (tx) => {\n" +
      "  await tx(\"SELECT id FROM tmp_users WHERE id = $1\", 1);\n" +
      "});\n",
    );
    const r = prepare();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.ts:3:12/);
    const dts = readFileSync(join(tmp, "bun-sqlx-env.d.ts"), "utf8");
    expect(dts).toContain("SELECT id FROM tmp_users WHERE id = $1");
  });
}

export {};
