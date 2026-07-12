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

test("UPDATE maps value-producing conditional parameters to assignment columns", async () => {
  const r = await buildParamMap(
    "UPDATE users SET " +
    "settings = CASE WHEN $1 THEN settings WHEN $2 THEN $3 ELSE $4 END, " +
    "name = COALESCE($5, name), " +
    "email = NULLIF($6, $7), " +
    "score = GREATEST($8, score)",
  );
  expect([...r.targets.entries()]).toEqual([
    [3, { schema: undefined, table: "users", column: "settings" }],
    [4, { schema: undefined, table: "users", column: "settings" }],
    [5, { schema: undefined, table: "users", column: "name" }],
    [6, { schema: undefined, table: "users", column: "email" }],
    [8, { schema: undefined, table: "users", column: "score" }],
  ]);
  expect([...r.dmlBound]).toEqual([3, 4, 5, 6, 8]);
});

test("UPDATE maps CASE predicate comparisons without overriding stored values", async () => {
  const r = await buildParamMap(
    "UPDATE users SET name = CASE WHEN status = $1 THEN $2 ELSE name END",
  );
  expect([...r.targets.entries()]).toEqual([
    [2, { schema: undefined, table: "users", column: "name" }],
    [1, { schema: undefined, table: "users", column: "status" }],
  ]);
  expect([...r.dmlBound]).toEqual([2]);
});

test("INSERT and ON CONFLICT map conditional value parameters to target columns", async () => {
  const inserted = await buildParamMap(
    "INSERT INTO users (name, settings) " +
    "SELECT COALESCE($1, 'anonymous'), CASE WHEN $2 THEN $3 ELSE $4 END",
  );
  expect([...inserted.targets.entries()]).toEqual([
    [1, { schema: undefined, table: "users", column: "name" }],
    [3, { schema: undefined, table: "users", column: "settings" }],
    [4, { schema: undefined, table: "users", column: "settings" }],
  ]);

  const updated = await buildParamMap(
    "INSERT INTO users (name) VALUES ($1) " +
    "ON CONFLICT (name) DO UPDATE SET settings = CASE WHEN $2 THEN $3 ELSE $4 END",
  );
  expect([...updated.targets.entries()]).toEqual([
    [1, { schema: undefined, table: "users", column: "name" }],
    [3, { schema: undefined, table: "users", column: "settings" }],
    [4, { schema: undefined, table: "users", column: "settings" }],
  ]);
});

test("INSERT set operations preserve target columns across every branch", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (name, settings) " +
    "SELECT $1, CASE WHEN $2 THEN $3 ELSE $4 END " +
    "UNION ALL SELECT $5, COALESCE($6, '{}'::jsonb)",
  );
  expect([...r.targets.entries()]).toEqual([
    [1, { schema: undefined, table: "users", column: "name" }],
    [3, { schema: undefined, table: "users", column: "settings" }],
    [4, { schema: undefined, table: "users", column: "settings" }],
    [5, { schema: undefined, table: "users", column: "name" }],
    [6, { schema: undefined, table: "users", column: "settings" }],
  ]);
});

test("multi-column UPDATE assignments map each row value to its own column", async () => {
  const r = await buildParamMap(
    "UPDATE users SET (name, email) = ($1, CASE WHEN $2 THEN $3 ELSE $4 END)",
  );
  expect([...r.targets.entries()]).toEqual([
    [1, { schema: undefined, table: "users", column: "name" }],
    [3, { schema: undefined, table: "users", column: "email" }],
    [4, { schema: undefined, table: "users", column: "email" }],
  ]);

  const upserted = await buildParamMap(
    "INSERT INTO users (name) VALUES ($1) " +
    "ON CONFLICT (name) DO UPDATE SET (email, settings) = ($2, $3)",
  );
  expect([...upserted.targets.entries()]).toEqual([
    [1, { schema: undefined, table: "users", column: "name" }],
    [2, { schema: undefined, table: "users", column: "email" }],
    [3, { schema: undefined, table: "users", column: "settings" }],
  ]);

  const selected = await buildParamMap(
    "UPDATE users SET (name, email) = (" +
    "SELECT $1, $2 FROM other WHERE other.id = $3 " +
    "UNION ALL SELECT $4, $5 FROM other WHERE other.id = $6)",
  );
  expect([...selected.targets.entries()]).toEqual([
    [1, { schema: undefined, table: "users", column: "name" }],
    [4, { schema: undefined, table: "users", column: "name" }],
    [3, { schema: undefined, table: "other", column: "id" }],
    [6, { schema: undefined, table: "other", column: "id" }],
    [2, { schema: undefined, table: "users", column: "email" }],
    [5, { schema: undefined, table: "users", column: "email" }],
  ]);
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

test("COALESCE nested inside INSERT keeps target provenance and nullability", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (name, age) VALUES ($1, COALESCE($2, 0))",
  );
  expect(r.dmlBound.has(1)).toBe(true);
  expect(r.targets.get(2)?.column).toBe("age");
  expect(r.dmlBound.has(2)).toBe(true);
  expect(r.forceNullable.has(2)).toBe(true);
});
