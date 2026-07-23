import { test, expect, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { scanProject } from "../src/scan/scanner";

const tmp = join(import.meta.dir, ".tmp-scan-edges");

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

test("namespace import: bs.sql(...) is detected", () => {
  setup({
    "a.ts":
      "import * as bs from \"@onreza/sqlx-js\";\n" +
      "await bs.sql(\"SELECT 1\");\n" +
      "await bs.sql.one(\"SELECT 2\");\n" +
      "await bs.sql.optional(\"SELECT 3\");\n" +
      "await bs.sql.execute(\"UPDATE jobs SET active = false\");\n",
  });
  const sites = scanProject(tmp).slice().sort((a, b) => a.line - b.line);
  expect(sites).toHaveLength(4);
  expect(sites.map((s) => s.query)).toEqual([
    "SELECT 1",
    "SELECT 2",
    "SELECT 3",
    "UPDATE jobs SET active = false",
  ]);
});

test("namespace import: bs.sql.file(...) / bs.sql.file.one(...)", () => {
  setup({
    "a.ts":
      "import * as bs from \"@onreza/sqlx-js\";\n" +
      "await bs.sql.file(\"./q.sql\");\n" +
      "await bs.sql.file.one(\"./q.sql\");\n" +
      "await bs.sql.file.execute(\"./q.sql\");\n",
    "q.sql": "SELECT 1\n",
  });
  const sites = scanProject(tmp).slice().sort((a, b) => a.line - b.line);
  expect(sites).toHaveLength(3);
  for (const s of sites) {
    expect(s.kind).toBe("file");
    expect(s.sqlFilePath).toBe("./q.sql");
  }
});

test("namespace import: bs.sql.transaction(tx => tx(...))", () => {
  setup({
    "a.ts":
      "import * as bs from \"@onreza/sqlx-js\";\n" +
      "await bs.sql.transaction(async (tx) => {\n" +
      "  await tx(\"SELECT inside\");\n" +
      "});\n",
  });
  const sites = scanProject(tmp);
  expect(sites).toHaveLength(1);
  expect(sites[0]!.query).toBe("SELECT inside");
});

test("createSqlClient: scoped sql surface is detected", () => {
  setup({
    "a.ts":
      "import { createSqlClient as createDatabase } from \"@onreza/sqlx-js\";\n" +
      "const db = createDatabase();\n" +
      "await db.sql(\"SELECT scoped\");\n" +
      "await db.sql.one(\"SELECT one\");\n" +
      "await db.sql.file.optional(\"./q.sql\");\n" +
      "await db.sql.transaction(async (tx) => {\n" +
      "  await tx.execute(\"UPDATE jobs SET active = false\");\n" +
      "});\n",
    "q.sql": "SELECT from_file\n",
  });

  const sites = scanProject(tmp).slice().sort((a, b) => a.line - b.line);
  expect(sites.map((site) => site.query)).toEqual([
    "SELECT scoped",
    "SELECT one",
    "SELECT from_file\n",
    "UPDATE jobs SET active = false",
  ]);
  expect(sites[2]!.kind).toBe("file");
});

test("createSqlClient profile is attached to direct and transactional queries", () => {
  setup({
    "a.ts":
      "import { createSqlClient } from \"@onreza/sqlx-js\";\n" +
      "const db = createSqlClient(undefined, { profile: profiles.api });\n" +
      "await db.sql(\"SELECT direct\");\n" +
      "await db.sql.transaction(async (tx) => {\n" +
      "  await tx.execute(\"UPDATE jobs SET active = false\");\n" +
      "});\n",
  });

  const sites = scanProject(tmp, {}, ["api", "worker"]).sort((a, b) => a.line - b.line);
  expect(sites.map((site) => site.profiles)).toEqual([["api"], ["api"]]);
});

test("createSqlClient profile survives transparent TypeScript expressions", () => {
  setup({
    "a.ts":
      "import { createSqlClient, type DatabaseProfile } from \"@onreza/sqlx-js\";\n" +
      "const db = (createSqlClient(undefined, { profile: profiles.api as DatabaseProfile }) satisfies object);\n" +
      "await db.sql(\"SELECT direct\");\n",
  });

  expect(scanProject(tmp, {}, ["api"])[0]?.profiles).toEqual(["api"]);
});

test("profiled projects reject unassigned and unknown client queries", () => {
  setup({
    "a.ts":
      "import { createSqlClient } from \"@onreza/sqlx-js\";\n" +
      "const db = createSqlClient();\n" +
      "await db.sql(\"SELECT unassigned\");\n",
  });
  expect(() => scanProject(tmp, {}, ["api"])).toThrow(/query has no connection profile/);

  setup({
    "a.ts":
      "import { createSqlClient } from \"@onreza/sqlx-js\";\n" +
      "const db = createSqlClient(undefined, { profile: profiles.missing });\n" +
      "await db.sql(\"SELECT unknown\");\n",
  });
  expect(() => scanProject(tmp, {}, ["api"])).toThrow(/unknown profile \"missing\"/);

  setup({
    "a.ts":
      "import { createSqlClient } from \"@onreza/sqlx-js\";\n" +
      "let db = createSqlClient(undefined, { profile: profiles.api });\n" +
      "await db.sql(\"SELECT mutable\");\n",
  });
  expect(() => scanProject(tmp, {}, ["api"])).toThrow(/profiled createSqlClient bindings must use const/);
});

test("namespace createSqlClient is detected and a local client shadow is ignored", () => {
  setup({
    "a.ts":
      "import * as sqlx from \"@onreza/sqlx-js\";\n" +
      "const db = sqlx.createSqlClient();\n" +
      "await db.sql(\"SELECT scoped\");\n" +
      "function inner(db: { sql: (...args: any[]) => unknown }) {\n" +
      "  return db.sql(\"SHOULD NOT BE SCANNED\");\n" +
      "}\n" +
      "void inner;\n",
  });

  expect(scanProject(tmp).map((site) => site.query)).toEqual(["SELECT scoped"]);
});

test("alias shadowing: local `const sql = ...` removes alias inside the block", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "function inner() {\n" +
      "  const sql = (..._args: any[]) => Promise.resolve([]);\n" +
      "  return sql(\"SHOULD NOT BE SCANNED\");\n" +
      "}\n" +
      "await sql(\"SELECT outer\");\n" +
      "void inner;\n",
  });
  const sites = scanProject(tmp);
  expect(sites.map((s) => s.query)).toEqual(["SELECT outer"]);
});

test("transaction with destructuring parameter does not crash", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.transaction(async ({ x }: any) => {\n" +
      "  return x;\n" +
      "});\n",
  });
  expect(() => scanProject(tmp)).not.toThrow();
  const sites = scanProject(tmp);
  expect(sites).toHaveLength(0);
});

test("transaction tx renamed via shadowing inside callback", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql.transaction(async (tx) => {\n" +
      "  const tx2 = tx;\n" +
      "  await tx(\"SELECT real\");\n" +
      "  return tx2;\n" +
      "});\n",
  });
  const sites = scanProject(tmp);
  expect(sites).toHaveLength(1);
  expect(sites[0]!.query).toBe("SELECT real");
});

test("destructured `{ sql }` re-binding shadows imported alias", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "function inner(obj: { sql: (...x: any[]) => Promise<any> }) {\n" +
      "  const { sql } = obj;\n" +
      "  return sql(\"SHOULD NOT BE SCANNED\");\n" +
      "}\n" +
      "await sql(\"SELECT keep\");\n" +
      "void inner;\n",
  });
  const sites = scanProject(tmp);
  expect(sites.map((s) => s.query)).toEqual(["SELECT keep"]);
});

test("FunctionDeclaration with the same name as sql alias shadows the import", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "function sql(_q: string) { return Promise.resolve([]); }\n" +
      "await sql(\"SHOULD NOT BE SCANNED\");\n",
  });
  const sites = scanProject(tmp);
  expect(sites).toHaveLength(0);
});

test("catch (sql) shadows the import inside the catch block", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "try {\n" +
      "  await sql(\"SELECT outside\");\n" +
      "} catch (sql) {\n" +
      "  void (sql as any)(\"SHOULD NOT BE SCANNED\");\n" +
      "}\n",
  });
  const sites = scanProject(tmp);
  expect(sites.map((s) => s.query)).toEqual(["SELECT outside"]);
});

test("namespace import: namespace identifier shadowed locally", () => {
  setup({
    "a.ts":
      "import * as bs from \"@onreza/sqlx-js\";\n" +
      "await bs.sql(\"SELECT outer\");\n" +
      "function inner() {\n" +
      "  const bs = { sql: (..._x: any[]) => Promise.resolve([]) };\n" +
      "  return bs.sql(\"NOT SCANNED\");\n" +
      "}\n" +
      "void inner;\n",
  });
  const sites = scanProject(tmp);
  expect(sites.some((s) => s.query === "SELECT outer")).toBe(true);
});

test("namespace import: function parameter shadows namespace inside body", () => {
  setup({
    "a.ts":
      "import * as bs from \"@onreza/sqlx-js\";\n" +
      "function inner(bs: { sql: (..._x: any[]) => Promise<any> }) {\n" +
      "  return bs.sql(\"SHOULD NOT BE SCANNED\");\n" +
      "}\n" +
      "await bs.sql(\"SELECT outer\");\n" +
      "void inner;\n",
  });
  const sites = scanProject(tmp);
  expect(sites.map((s) => s.query)).toEqual(["SELECT outer"]);
});

test("alias import: function parameter shadows sql alias inside body", () => {
  setup({
    "a.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "const inner = (sql: (..._x: any[]) => Promise<any>) => sql(\"SHOULD NOT BE SCANNED\");\n" +
      "await sql(\"SELECT outer\");\n" +
      "void inner;\n",
  });
  const sites = scanProject(tmp);
  expect(sites.map((s) => s.query)).toEqual(["SELECT outer"]);
});

test(".tsx file: sql() inside JSX is discovered", () => {
  setup({
    "page.tsx":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "async function Page() {\n" +
      "  const rows = await sql(\"SELECT 1 FROM jsx_users\");\n" +
      "  return <div>{rows.length}</div>;\n" +
      "}\n" +
      "void Page;\n",
  });
  const sites = scanProject(tmp);
  expect(sites.map((s) => s.query)).toEqual(["SELECT 1 FROM jsx_users"]);
});

test(".ts file: angle-bracket type assertions do not hide later queries", () => {
  setup({
    "query.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "const value = <number>1;\n" +
      "await sql(\"SELECT 1 FROM typed_users\");\n" +
      "void value;\n",
  });
  const sites = scanProject(tmp);
  expect(sites.map((s) => s.query)).toEqual(["SELECT 1 FROM typed_users"]);
});

test("syntax errors fail scanning before generated artifacts can be replaced", () => {
  setup({
    "broken.ts":
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "await sql(\"SELECT 1\");\n" +
      "const broken = ;\n",
  });
  expect(() => scanProject(tmp)).toThrow(/broken\.ts:3:/);
});
