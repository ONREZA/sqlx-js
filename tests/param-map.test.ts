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

test("INSERT SELECT maps direct select params to target columns", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (name, settings) SELECT $1, $2",
  );
  expect(r.targets.get(1)).toEqual({ schema: undefined, table: "users", column: "name" });
  expect(r.targets.get(2)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(r.dmlBound.has(1)).toBe(true);
  expect(r.dmlBound.has(2)).toBe(true);
});

test("INSERT SELECT keeps DML target when a param is reused in source WHERE", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (settings) SELECT $1 FROM orgs WHERE orgs.settings = $1",
  );
  expect(r.targets.get(1)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(r.dmlBound.has(1)).toBe(true);
});

test("INSERT VALUES without a column list maps params by position", async () => {
  const r = await buildParamMap(
    "INSERT INTO users VALUES ($1, $2)",
  );
  expect(r.targets.get(1)).toEqual({ schema: undefined, table: "users", columnIndex: 1 });
  expect(r.targets.get(2)).toEqual({ schema: undefined, table: "users", columnIndex: 2 });
  expect(r.dmlBound.has(1)).toBe(true);
  expect(r.dmlBound.has(2)).toBe(true);
});

test("INSERT ON CONFLICT UPDATE maps SET params and target aliases in WHERE", async () => {
  const r = await buildParamMap(
    "INSERT INTO users AS u (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET settings = $2 WHERE u.email = $3",
  );
  expect(r.targets.get(1)).toEqual({ schema: undefined, table: "users", column: "id" });
  expect(r.targets.get(2)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(r.targets.get(3)).toEqual({ schema: undefined, table: "users", column: "email" });
  expect(r.dmlBound.has(1)).toBe(true);
  expect(r.dmlBound.has(2)).toBe(true);
  expect(r.dmlBound.has(3)).toBe(false);
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

test("UPDATE FROM maps relation aliases in WHERE", async () => {
  const r = await buildParamMap(
    "UPDATE users u SET settings = $1 FROM orgs o WHERE u.org_id = o.id AND o.slug = $2 AND u.email = $3",
  );
  expect(r.targets.get(1)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(r.targets.get(2)).toEqual({ schema: undefined, table: "orgs", column: "slug" });
  expect(r.targets.get(3)).toEqual({ schema: undefined, table: "users", column: "email" });
  expect(r.dmlBound.has(1)).toBe(true);
  expect(r.dmlBound.has(2)).toBe(false);
  expect(r.dmlBound.has(3)).toBe(false);
});

test("SELECT WHERE equality maps to column but does not mark DML", async () => {
  const r = await buildParamMap("SELECT id FROM users WHERE settings = $1");
  expect(r.targets.get(1)?.column).toBe("settings");
  expect(r.targets.get(1)?.table).toBe("users");
  expect(r.dmlBound.has(1)).toBe(false);
});

test("SELECT WHERE equality maps qualified aliases across joins", async () => {
  const r = await buildParamMap(
    "SELECT u.id FROM users u JOIN posts p ON p.user_id = u.id WHERE u.settings = $1 AND p.meta = $2",
  );
  expect(r.targets.get(1)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(r.targets.get(2)).toEqual({ schema: undefined, table: "posts", column: "meta" });
  expect(r.dmlBound.has(1)).toBe(false);
  expect(r.dmlBound.has(2)).toBe(false);
});

test("SELECT JOIN ON maps params with aliases", async () => {
  const r = await buildParamMap(
    "SELECT u.id FROM users u JOIN posts p ON p.user_id = $1 WHERE u.id = $2",
  );
  expect(r.targets.get(1)).toEqual({ schema: undefined, table: "posts", column: "user_id" });
  expect(r.targets.get(2)).toEqual({ schema: undefined, table: "users", column: "id" });
});

test("DELETE maps target and USING aliases in WHERE", async () => {
  const r = await buildParamMap(
    "DELETE FROM users u USING orgs o WHERE u.org_id = o.id AND u.email = $1 AND o.slug = $2",
  );
  expect(r.targets.get(1)).toEqual({ schema: undefined, table: "users", column: "email" });
  expect(r.targets.get(2)).toEqual({ schema: undefined, table: "orgs", column: "slug" });
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
