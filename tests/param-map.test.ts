import { test, expect } from "bun:test";
import {
  buildParamMap,
  effectiveParamTargets,
  type ParamMapResult,
  type ParamTarget,
} from "../src/pg/param-map";

function target(result: ParamMapResult, param: number): ParamTarget | undefined {
  return effectiveParamTargets(result.bindings.get(param))[0];
}

function targetEntries(result: ParamMapResult): [number, ParamTarget][] {
  const entries: [number, ParamTarget][] = [];
  for (const [param, binding] of result.bindings) {
    const current = effectiveParamTargets(binding)[0];
    if (current) entries.push([param, current]);
  }
  return entries;
}

function isDmlBound(result: ParamMapResult, param: number): boolean {
  return (result.bindings.get(param)?.dmlTargets.length ?? 0) > 0;
}

function dmlParams(result: ParamMapResult): number[] {
  return [...result.bindings]
    .filter(([, binding]) => binding.dmlTargets.length > 0)
    .map(([param]) => param);
}

test("INSERT VALUES maps params to columns by position", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (name, settings) VALUES ($1, $2)",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", column: "name" });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(isDmlBound(r, 1)).toBe(true);
  expect(isDmlBound(r, 2)).toBe(true);
  expect(r.forceNullable.size).toBe(0);
});

test("multi-row INSERT VALUES maps each row's params and marks them DML-bound", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (name, settings) VALUES ($1, $2), ($3, $4)",
  );
  expect(target(r, 1)?.column).toBe("name");
  expect(target(r, 2)?.column).toBe("settings");
  expect(target(r, 3)?.column).toBe("name");
  expect(target(r, 4)?.column).toBe("settings");
  for (const i of [1, 2, 3, 4]) expect(isDmlBound(r, i)).toBe(true);
});

test("INSERT SELECT maps direct select params to target columns", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (name, settings) SELECT $1, $2",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", column: "name" });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(isDmlBound(r, 1)).toBe(true);
  expect(isDmlBound(r, 2)).toBe(true);
});

test("INSERT SELECT keeps DML target when a param is reused in source WHERE", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (settings) SELECT $1 FROM orgs WHERE orgs.settings = $1",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(isDmlBound(r, 1)).toBe(true);
  expect(r.bindings.get(1)?.referenceTargets).toEqual([
    { schema: undefined, table: "orgs", column: "settings" },
  ]);
});

test("INSERT VALUES without a column list maps params by position", async () => {
  const r = await buildParamMap(
    "INSERT INTO users VALUES ($1, $2)",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", columnIndex: 1 });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "users", columnIndex: 2 });
  expect(isDmlBound(r, 1)).toBe(true);
  expect(isDmlBound(r, 2)).toBe(true);
});

test("INSERT ON CONFLICT UPDATE maps SET params and target aliases in WHERE", async () => {
  const r = await buildParamMap(
    "INSERT INTO users AS u (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET settings = $2 WHERE u.email = $3",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", column: "id" });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(target(r, 3)).toEqual({ schema: undefined, table: "users", column: "email" });
  expect(isDmlBound(r, 1)).toBe(true);
  expect(isDmlBound(r, 2)).toBe(true);
  expect(isDmlBound(r, 3)).toBe(false);
});

test("UPDATE SET marks assignments as DML-bound", async () => {
  const r = await buildParamMap(
    "UPDATE users SET settings = $1, name = $2 WHERE id = $3",
  );
  expect(target(r, 1)?.column).toBe("settings");
  expect(target(r, 2)?.column).toBe("name");
  expect(target(r, 3)?.column).toBe("id");
  expect(isDmlBound(r, 1)).toBe(true);
  expect(isDmlBound(r, 2)).toBe(true);
  expect(isDmlBound(r, 3)).toBe(false);
});

test("UPDATE maps value-producing conditional parameters to assignment columns", async () => {
  const r = await buildParamMap(
    "UPDATE users SET " +
    "settings = CASE WHEN $1 THEN settings WHEN $2 THEN $3 ELSE $4 END, " +
    "name = COALESCE($5, name), " +
    "email = NULLIF($6, $7), " +
    "score = GREATEST($8, score)",
  );
  expect(targetEntries(r)).toEqual([
    [3, { schema: undefined, table: "users", column: "settings" }],
    [4, { schema: undefined, table: "users", column: "settings" }],
    [5, { schema: undefined, table: "users", column: "name" }],
    [6, { schema: undefined, table: "users", column: "email" }],
    [8, { schema: undefined, table: "users", column: "score" }],
  ]);
  expect(dmlParams(r)).toEqual([3, 4, 5, 6, 8]);
});

test("UPDATE maps CASE predicate comparisons without overriding stored values", async () => {
  const r = await buildParamMap(
    "UPDATE users SET name = CASE WHEN status = $1 THEN $2 ELSE name END",
  );
  expect(targetEntries(r)).toEqual([
    [2, { schema: undefined, table: "users", column: "name" }],
    [1, { schema: undefined, table: "users", column: "status" }],
  ]);
  expect(dmlParams(r)).toEqual([2]);
});

test("INSERT and ON CONFLICT map conditional value parameters to target columns", async () => {
  const inserted = await buildParamMap(
    "INSERT INTO users (name, settings) " +
    "SELECT COALESCE($1, 'anonymous'), CASE WHEN $2 THEN $3 ELSE $4 END",
  );
  expect(targetEntries(inserted)).toEqual([
    [1, { schema: undefined, table: "users", column: "name" }],
    [3, { schema: undefined, table: "users", column: "settings" }],
    [4, { schema: undefined, table: "users", column: "settings" }],
  ]);

  const updated = await buildParamMap(
    "INSERT INTO users (name) VALUES ($1) " +
    "ON CONFLICT (name) DO UPDATE SET settings = CASE WHEN $2 THEN $3 ELSE $4 END",
  );
  expect(targetEntries(updated)).toEqual([
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
  expect(targetEntries(r)).toEqual([
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
  expect(targetEntries(r)).toEqual([
    [1, { schema: undefined, table: "users", column: "name" }],
    [3, { schema: undefined, table: "users", column: "email" }],
    [4, { schema: undefined, table: "users", column: "email" }],
  ]);

  const upserted = await buildParamMap(
    "INSERT INTO users (name) VALUES ($1) " +
    "ON CONFLICT (name) DO UPDATE SET (email, settings) = ($2, $3)",
  );
  expect(targetEntries(upserted)).toEqual([
    [1, { schema: undefined, table: "users", column: "name" }],
    [2, { schema: undefined, table: "users", column: "email" }],
    [3, { schema: undefined, table: "users", column: "settings" }],
  ]);

  const selected = await buildParamMap(
    "UPDATE users SET (name, email) = (" +
    "SELECT $1, $2 FROM other WHERE other.id = $3 " +
    "UNION ALL SELECT $4, $5 FROM other WHERE other.id = $6)",
  );
  expect(targetEntries(selected)).toEqual([
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
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "orgs", column: "slug" });
  expect(target(r, 3)).toEqual({ schema: undefined, table: "users", column: "email" });
  expect(isDmlBound(r, 1)).toBe(true);
  expect(isDmlBound(r, 2)).toBe(false);
  expect(isDmlBound(r, 3)).toBe(false);
});

test("SELECT WHERE equality maps to column but does not mark DML", async () => {
  const r = await buildParamMap("SELECT id FROM users WHERE settings = $1");
  expect(target(r, 1)?.column).toBe("settings");
  expect(target(r, 1)?.table).toBe("users");
  expect(isDmlBound(r, 1)).toBe(false);
});

test("SELECT WHERE equality maps qualified aliases across joins", async () => {
  const r = await buildParamMap(
    "SELECT u.id FROM users u JOIN posts p ON p.user_id = u.id WHERE u.settings = $1 AND p.meta = $2",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "posts", column: "meta" });
  expect(isDmlBound(r, 1)).toBe(false);
  expect(isDmlBound(r, 2)).toBe(false);
});

test("SELECT JOIN ON maps params with aliases", async () => {
  const r = await buildParamMap(
    "SELECT u.id FROM users u JOIN posts p ON p.user_id = $1 WHERE u.id = $2",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "posts", column: "user_id" });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "users", column: "id" });
});

test("DELETE maps target and USING aliases in WHERE", async () => {
  const r = await buildParamMap(
    "DELETE FROM users u USING orgs o WHERE u.org_id = o.id AND u.email = $1 AND o.slug = $2",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", column: "email" });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "orgs", column: "slug" });
});

test("RETURNING expressions do not produce mappings", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (settings) VALUES ($1) RETURNING id",
  );
  expect(r.bindings.size).toBe(1);
  expect(target(r, 1)?.column).toBe("settings");
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
  expect(isDmlBound(r, 1)).toBe(true);
  expect(target(r, 2)?.column).toBe("age");
  expect(isDmlBound(r, 2)).toBe(true);
  expect(r.bindings.get(2)?.dmlTargets[0]?.nullSafe).toBe(true);
  expect(r.forceNullable.has(2)).toBe(true);
});

test("data-modifying CTEs map stored parameters to every target column", async () => {
  const r = await buildParamMap(
    "WITH created_user AS (" +
    "INSERT INTO users (name, settings) VALUES ($1, $2) RETURNING id" +
    "), created_audit AS (" +
    "INSERT INTO audit_log (user_id, actor_id) SELECT id, $3 FROM created_user RETURNING id" +
    ") SELECT created_user.id FROM created_user CROSS JOIN created_audit",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", column: "name" });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "users", column: "settings" });
  expect(target(r, 3)).toEqual({ schema: undefined, table: "audit_log", column: "actor_id" });
  expect(dmlParams(r)).toEqual([1, 2, 3]);
});

test("parameters retain every compatible DML target across CTEs", async () => {
  const r = await buildParamMap(
    "WITH created_user AS (" +
    "INSERT INTO users (id, owner_id) VALUES ($1, $2) RETURNING id" +
    "), created_audit AS (" +
    "INSERT INTO audit_log (user_id, actor_id) VALUES ($1, $2) RETURNING id" +
    ") SELECT created_user.id FROM created_user CROSS JOIN created_audit",
  );
  expect(r.bindings.get(1)?.dmlTargets).toEqual([
    { target: { schema: undefined, table: "users", column: "id" }, nullSafe: false },
    { target: { schema: undefined, table: "audit_log", column: "user_id" }, nullSafe: false },
  ]);
  expect(r.bindings.get(2)?.dmlTargets).toEqual([
    { target: { schema: undefined, table: "users", column: "owner_id" }, nullSafe: false },
    { target: { schema: undefined, table: "audit_log", column: "actor_id" }, nullSafe: false },
  ]);
});

test("a DML root retains targets from its own data-modifying CTEs", async () => {
  const r = await buildParamMap(
    "WITH created_audit AS (" +
    "INSERT INTO audit_log (actor_id) VALUES ($1) RETURNING id" +
    ") INSERT INTO users (owner_id) SELECT $1 FROM created_audit",
  );
  expect(r.bindings.get(1)?.dmlTargets).toEqual([
    { target: { schema: undefined, table: "audit_log", column: "actor_id" }, nullSafe: false },
    { target: { schema: undefined, table: "users", column: "owner_id" }, nullSafe: false },
  ]);
});

test("a non-null write guard makes its DML target null-safe", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (owner_id) SELECT $1 WHERE $1 IS NOT NULL",
  );
  expect(r.bindings.get(1)?.dmlTargets).toEqual([
    { target: { schema: undefined, table: "users", column: "owner_id" }, nullSafe: true },
  ]);
});

test("an ON CONFLICT write guard makes its assignment target null-safe", async () => {
  const r = await buildParamMap(
    "INSERT INTO users (id) VALUES ($2) " +
    "ON CONFLICT (id) DO UPDATE SET owner_id = $1 WHERE $1 IS NOT NULL",
  );
  expect(r.bindings.get(1)?.dmlTargets).toEqual([
    { target: { schema: undefined, table: "users", column: "owner_id" }, nullSafe: true },
  ]);
});

test("boolean non-null guards protect stored parameters", async () => {
  const inserted = await buildParamMap(
    "INSERT INTO users (owner_id, actor_id) SELECT $1, $2 " +
    "WHERE (($1 IS NOT NULL AND $3) OR ($1 IS NOT NULL AND $4)) " +
    "AND NOT ($2 IS NULL)",
  );
  expect(inserted.bindings.get(1)?.dmlTargets).toEqual([
    { target: { schema: undefined, table: "users", column: "owner_id" }, nullSafe: true },
  ]);
  expect(inserted.bindings.get(2)?.dmlTargets).toEqual([
    { target: { schema: undefined, table: "users", column: "actor_id" }, nullSafe: true },
  ]);

  const updated = await buildParamMap(
    "UPDATE users SET owner_id = $1 WHERE $1 IS NOT NULL",
  );
  expect(updated.bindings.get(1)?.dmlTargets).toEqual([
    { target: { schema: undefined, table: "users", column: "owner_id" }, nullSafe: true },
  ]);
});

test("direct null propagation dominates null-safe reuse for the same target", async () => {
  const firstMasked = await buildParamMap(
    "INSERT INTO users (name) VALUES (COALESCE($1, 'fallback')), ($1)",
  );
  const firstDirect = await buildParamMap(
    "INSERT INTO users (name) VALUES ($1), (COALESCE($1, 'fallback'))",
  );
  expect(firstMasked.bindings.get(1)?.dmlTargets).toEqual([
    { target: { schema: undefined, table: "users", column: "name" }, nullSafe: false },
  ]);
  expect(firstDirect.bindings.get(1)?.dmlTargets).toEqual(
    firstMasked.bindings.get(1)?.dmlTargets,
  );
});

test("CTE UPDATE and DELETE statements retain assignment and predicate targets", async () => {
  const r = await buildParamMap(
    "WITH changed AS (" +
    "UPDATE users SET name = $1 WHERE email = $2 RETURNING id" +
    "), removed AS (" +
    "DELETE FROM audit_log WHERE actor_id = $3 RETURNING id" +
    ") SELECT changed.id FROM changed CROSS JOIN removed",
  );
  expect(target(r, 1)).toEqual({ schema: undefined, table: "users", column: "name" });
  expect(target(r, 2)).toEqual({ schema: undefined, table: "users", column: "email" });
  expect(target(r, 3)).toEqual({ schema: undefined, table: "audit_log", column: "actor_id" });
  expect(dmlParams(r)).toEqual([1]);
});
