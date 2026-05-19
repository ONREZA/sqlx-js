import { test, expect } from "bun:test";
import { buildParamMap } from "../src/pg/param-map";

test("INSERT VALUES maps params to columns by position", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (name, settings) VALUES ($1, $2)",
  );
  expect(r.targets.get(1)).toEqual({ schema: undefined, table: "users", column: "name" });
  expect(r.targets.get(2)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(r.dmlBound.has(1)).toBe(true);
  expect(r.dmlBound.has(2)).toBe(true);
  expect(r.forceNullable.size).toBe(0);
});

test("multi-row INSERT VALUES maps each row's params and marks them DML-bound", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (name, settings) VALUES ($1, $2), ($3, $4)",
  );
  expect(r.targets.get(1)?.column).toBe("name");
  expect(r.targets.get(2)?.column).toBe("settings");
  expect(r.targets.get(3)?.column).toBe("name");
  expect(r.targets.get(4)?.column).toBe("settings");
  for (const i of [1, 2, 3, 4]) expect(r.dmlBound.has(i)).toBe(true);
});

test("UPDATE SET marks assignments as DML-bound", async () => {
  const r = await buildParamMap(
    "UPDATE users SET settings = $1, name = $2 WHERE id = $3",
  );
  expect(r.targets.get(1)?.column).toBe("settings");
  expect(r.targets.get(2)?.column).toBe("name");
  expect(r.targets.get(3)?.column).toBe("id");
  expect(r.dmlBound.has(1)).toBe(true);
  expect(r.dmlBound.has(2)).toBe(true);
  expect(r.dmlBound.has(3)).toBe(false);
});

test("SELECT WHERE equality maps to column but does not mark DML", async () => {
  const r = await buildParamMap("SELECT id FROM users WHERE settings = $1");
  expect(r.targets.get(1)?.column).toBe("settings");
  expect(r.targets.get(1)?.table).toBe("users");
  expect(r.dmlBound.has(1)).toBe(false);
});

test("RETURNING expressions do not produce mappings", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (settings) VALUES ($1) RETURNING id",
  );
  expect(r.targets.size).toBe(1);
  expect(r.targets.get(1)?.column).toBe("settings");
});

test("COALESCE($N, ...) forces param nullable", async () => {
  const r = await buildParamMap(
    "UPDATE blocks SET question = COALESCE($1, question) WHERE id = $2",
  );
  expect(r.forceNullable.has(1)).toBe(true);
  expect(r.forceNullable.has(2)).toBe(false);
});

test("NULLIF($N, ...) forces param nullable", async () => {
  const r = await buildParamMap(
    "SELECT id, NULLIF($1, '') AS x FROM users WHERE id = $2",
  );
  expect(r.forceNullable.has(1)).toBe(true);
  expect(r.forceNullable.has(2)).toBe(false);
});

test("$N IS NULL / IS NOT NULL forces nullable", async () => {
  const r = await buildParamMap(
    "SELECT id FROM users WHERE ($1::text IS NULL OR status = $1)",
  );
  expect(r.forceNullable.has(1)).toBe(true);
});

test("IS DISTINCT FROM / IS NOT DISTINCT FROM force nullable", async () => {
  const r = await buildParamMap(
    "SELECT id FROM users WHERE status IS DISTINCT FROM $1",
  );
  expect(r.forceNullable.has(1)).toBe(true);
});

test("COALESCE nested inside SET on INSERT", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (name, age) VALUES ($1, COALESCE($2, 0))",
  );
  expect(r.dmlBound.has(1)).toBe(true);
  expect(r.dmlBound.has(2)).toBe(false);
  expect(r.forceNullable.has(2)).toBe(true);
});
