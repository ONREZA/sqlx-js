import { test, expect } from "bun:test";
import { parse } from "libpg-query";
import { narrowFromWhere, isNarrowed } from "../src/pg/narrow";

async function whereOf(sql: string) {
  const ast = await parse(sql);
  return ast.stmts[0]!.stmt!.SelectStmt!.whereClause;
}

test("IS NOT NULL narrows the column", async () => {
  const set = narrowFromWhere(await whereOf("SELECT bio FROM users WHERE bio IS NOT NULL"));
  expect(isNarrowed(set, undefined, "bio")).toBe(true);
});

test("IS NULL does not narrow", async () => {
  const set = narrowFromWhere(await whereOf("SELECT bio FROM users WHERE bio IS NULL"));
  expect(isNarrowed(set, undefined, "bio")).toBe(false);
});

test("NOT (col IS NULL) narrows the column", async () => {
  const set = narrowFromWhere(await whereOf("SELECT bio FROM users WHERE NOT (bio IS NULL)"));
  expect(isNarrowed(set, undefined, "bio")).toBe(true);
});

test("NOT (col IS NOT NULL) does not narrow", async () => {
  const set = narrowFromWhere(await whereOf("SELECT bio FROM users WHERE NOT (bio IS NOT NULL)"));
  expect(isNarrowed(set, undefined, "bio")).toBe(false);
});

test("equality narrows both sides when neither is NULL literal", async () => {
  const set = narrowFromWhere(await whereOf("SELECT id FROM users WHERE bio = 'x'"));
  expect(isNarrowed(set, undefined, "bio")).toBe(true);
});

test("IS NOT DISTINCT FROM propagates non-null through AND equality chains", async () => {
  const set = narrowFromWhere(
    await whereOf("SELECT id FROM users WHERE bio IS NOT DISTINCT FROM note AND note IS NOT NULL"),
  );
  expect(isNarrowed(set, undefined, "bio")).toBe(true);
  expect(isNarrowed(set, undefined, "note")).toBe(true);
});

test("AND unions the narrowed sets", async () => {
  const set = narrowFromWhere(
    await whereOf("SELECT id FROM users WHERE bio IS NOT NULL AND age > 18"),
  );
  expect(isNarrowed(set, undefined, "bio")).toBe(true);
  expect(isNarrowed(set, undefined, "age")).toBe(true);
});

test("OR keeps only what every branch narrows", async () => {
  const set = narrowFromWhere(
    await whereOf("SELECT id FROM users WHERE bio IS NOT NULL OR age > 18"),
  );
  expect(isNarrowed(set, undefined, "bio")).toBe(false);
  expect(isNarrowed(set, undefined, "age")).toBe(false);
});

test("IN narrows the left ColumnRef", async () => {
  const set = narrowFromWhere(await whereOf("SELECT id FROM users WHERE age IN (1, 2, 3)"));
  expect(isNarrowed(set, undefined, "age")).toBe(true);
});

test("qualified WHERE matches qualified lookup", async () => {
  const set = narrowFromWhere(
    await whereOf("SELECT u.id FROM users u WHERE u.bio IS NOT NULL"),
  );
  expect(isNarrowed(set, "u", "bio")).toBe(true);
});

test("schema-qualified WHERE narrows through the table name", async () => {
  const set = narrowFromWhere(
    await whereOf("SELECT app.users.id FROM app.users WHERE app.users.bio IS NOT NULL"),
  );
  expect(isNarrowed(set, "users", "bio")).toBe(true);
});

test("unqualified WHERE matches qualified lookup", async () => {
  const set = narrowFromWhere(await whereOf("SELECT id FROM users WHERE bio IS NOT NULL"));
  expect(isNarrowed(set, "users", "bio")).toBe(true);
});
