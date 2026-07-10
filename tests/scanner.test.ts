import { test, expect, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { scanProject } from "../src/scan/scanner";

const tmp = join(import.meta.dir, ".tmp-scan");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setup(files: Record<string, string>) {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = join(tmp, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

test("finds sql() calls when sql is imported from sqlx-js", () => {
  setup({
    "a.ts": `
      import { sql } from "@onreza/sqlx-js";
      await sql("SELECT 1", 1);
      await sql("SELECT 2");
    `,
  });
  const sites = scanProject(tmp);
  expect(sites.length).toBe(2);
  expect(sites.map((s) => s.query).sort()).toEqual(["SELECT 1", "SELECT 2"]);
  expect(sites.find((s) => s.query === "SELECT 1")!.paramCount).toBe(1);
});

test("respects alias import", () => {
  setup({
    "a.ts": `
      import { sql as q } from "@onreza/sqlx-js";
      await q("SELECT x");
    `,
  });
  const sites = scanProject(tmp);
  expect(sites.length).toBe(1);
  expect(sites[0]!.query).toBe("SELECT x");
});

test("scan.modules recognizes an application database module", () => {
  setup({
    "a.ts": `
      import { sql } from "@app/database";
      await sql("SELECT app_query");
    `,
  });
  const sites = scanProject(tmp, { modules: ["@onreza/sqlx-js", "@app/database"] });
  expect(sites.map((site) => site.query)).toEqual(["SELECT app_query"]);
});

test("ignores sql() not imported from sqlx-js", () => {
  setup({
    "a.ts": `
      import { sql } from "other-lib";
      await sql("SELECT 1");
    `,
  });
  expect(scanProject(tmp).length).toBe(0);
});

test("rejects dynamic-string first arg", () => {
  setup({
    "a.ts": `
      import { sql } from "@onreza/sqlx-js";
      const q = "SELECT 1";
      await sql(q);
    `,
  });
  expect(() => scanProject(tmp)).toThrow(/string literal/);
});

test("captures line and column of each sql() call site", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT 1\");\n" +
      "  await sql(\"SELECT 2\");\n",
  });
  const sites = scanProject(tmp).slice().sort((a, b) => a.line - b.line);
  expect(sites).toHaveLength(2);
  expect(sites[0]!.line).toBe(2);
  expect(sites[0]!.column).toBe(11);
  expect(sites[1]!.line).toBe(3);
  expect(sites[1]!.column).toBe(13);
});

test("dynamic-first-arg error includes file:line:column", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "const q = \"SELECT 1\";\n" +
      "await sql(q);\n",
  });
  expect(() => scanProject(tmp)).toThrow(/a\.ts:3:11/);
});

test("sql.file() resolves paths relative to the project root", () => {
  setup({
    "src/a.ts": `
      import { sql } from "@onreza/sqlx-js";
      await sql.file("queries/get_user.sql", 1);
    `,
    "queries/get_user.sql": "SELECT id, name FROM users WHERE id = $1\n",
  });
  const sites = scanProject(tmp);
  expect(sites).toHaveLength(1);
  const s = sites[0]!;
  expect(s.kind).toBe("file");
  expect(s.query).toContain("SELECT id, name FROM users");
  expect(s.sqlFilePath).toBe("queries/get_user.sql");
  expect(s.paramCount).toBe(1);
});

test("sql.file() missing path throws with file:line:column", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.file(\"./does-not-exist.sql\");\n",
  });
  expect(() => scanProject(tmp)).toThrow(/a\.ts:2:16.*does-not-exist\.sql/s);
});

test("sql.file() requires string literal path", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "const p = \"x.sql\";\n" +
      "await sql.file(p);\n",
  });
  expect(() => scanProject(tmp)).toThrow(/string literal path/);
});

test("aliased sql.file() works", () => {
  setup({
    "a.ts": `
      import { sql as q } from "@onreza/sqlx-js";
      await q.file("./query.sql");
    `,
    "query.sql": "SELECT 1",
  });
  const sites = scanProject(tmp);
  expect(sites).toHaveLength(1);
  expect(sites[0]!.kind).toBe("file");
});

test("sql.one, sql.optional, and sql.execute are scanned as inline queries", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.one(\"SELECT id FROM users WHERE id = $1\", 1);\n" +
      "await sql.optional(\"SELECT name FROM users WHERE email = $1\", \"x\");\n" +
      "await sql.execute(\"UPDATE users SET active = false WHERE id = $1\", 1);\n",
  });
  const sites = scanProject(tmp).slice().sort((a, b) => a.line - b.line);
  expect(sites).toHaveLength(3);
  expect(sites[0]!.kind).toBe("inline");
  expect(sites[0]!.query).toBe("SELECT id FROM users WHERE id = $1");
  expect(sites[1]!.kind).toBe("inline");
  expect(sites[1]!.query).toBe("SELECT name FROM users WHERE email = $1");
  expect(sites[2]!.kind).toBe("inline");
  expect(sites[2]!.query).toBe("UPDATE users SET active = false WHERE id = $1");
});

test("sql.file one, optional, and execute are scanned as file queries", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.file.one(\"./q/by_id.sql\", 1);\n" +
      "await sql.file.optional(\"./q/by_email.sql\", \"x\");\n" +
      "await sql.file.execute(\"./q/update.sql\", 1);\n",
    "q/by_id.sql": "SELECT id FROM users WHERE id = $1\n",
    "q/by_email.sql": "SELECT id FROM users WHERE email = $1\n",
    "q/update.sql": "UPDATE users SET active = false WHERE id = $1\n",
  });
  const sites = scanProject(tmp).slice().sort((a, b) => a.line - b.line);
  expect(sites).toHaveLength(3);
  expect(sites[0]!.kind).toBe("file");
  expect(sites[0]!.sqlFilePath).toBe("./q/by_id.sql");
  expect(sites[1]!.kind).toBe("file");
  expect(sites[1]!.sqlFilePath).toBe("./q/by_email.sql");
  expect(sites[2]!.kind).toBe("file");
  expect(sites[2]!.sqlFilePath).toBe("./q/update.sql");
});

test("transaction tx.one / tx.optional / tx.file.one are scanned inside the callback", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.transaction(async (tx) => {\n" +
      "  await tx(\"SELECT 1 AS one\");\n" +
      "  await tx.one(\"SELECT id FROM users WHERE id = $1\", 1);\n" +
      "  await tx.optional(\"SELECT id FROM users WHERE email = $1\", \"x\");\n" +
      "  await tx.file.one(\"./q/by_id.sql\", 1);\n" +
      "});\n",
    "q/by_id.sql": "SELECT id FROM users WHERE id = $1\n",
  });
  const sites = scanProject(tmp).slice().sort((a, b) => a.line - b.line);
  expect(sites).toHaveLength(4);
  expect(sites[0]!.query).toBe("SELECT 1 AS one");
  expect(sites[1]!.query).toBe("SELECT id FROM users WHERE id = $1");
  expect(sites[2]!.query).toBe("SELECT id FROM users WHERE email = $1");
  expect(sites[3]!.kind).toBe("file");
  expect(sites[3]!.sqlFilePath).toBe("./q/by_id.sql");
});

test("scanner follows tsconfig project references in a monorepo", () => {
  setup({
    "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "packages/a" }, { path: "packages/b" }] }),
    "packages/a/tsconfig.json": JSON.stringify({ compilerOptions: { composite: true }, include: ["src/**/*.ts"] }),
    "packages/a/src/a.ts": 'import { sql } from "@onreza/sqlx-js"; sql("SELECT a");',
    "packages/a/ignored.ts": 'import { sql } from "@onreza/sqlx-js"; sql("SELECT ignored_a");',
    "packages/b/tsconfig.json": JSON.stringify({ compilerOptions: { composite: true }, include: ["src/**/*.ts"] }),
    "packages/b/src/b.ts": 'import { sql } from "@onreza/sqlx-js"; sql("SELECT b");',
    "outside.ts": 'import { sql } from "@onreza/sqlx-js"; sql("SELECT outside");',
  });

  expect(scanProject(tmp).map((site) => site.query).sort()).toEqual(["SELECT a", "SELECT b"]);
});

test("scan.include and scan.exclude explicitly select project files", () => {
  setup({
    "tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
    "src/keep.ts": 'import { sql } from "@onreza/sqlx-js"; sql("SELECT keep");',
    "src/skip.ts": 'import { sql } from "@onreza/sqlx-js"; sql("SELECT skip");',
    "scripts/extra.ts": 'import { sql } from "@onreza/sqlx-js"; sql("SELECT extra");',
  });

  expect(scanProject(tmp, {
    include: ["src/**/*.ts", "scripts/**/*.ts"],
    exclude: ["**/skip.ts"],
  }).map((site) => site.query).sort()).toEqual(["SELECT extra", "SELECT keep"]);
  expect(scanProject(tmp, { include: [] })).toEqual([]);
});
