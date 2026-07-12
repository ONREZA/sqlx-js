import { describe, expect, test } from "bun:test";
import { analyzeQuery } from "../src/pg/analyze";
import type { ColumnInfo, SchemaCache } from "../src/pg/schema";
import type { FieldDescription } from "../src/pg/wire";

type TableDef = {
  schema?: string;
  name: string;
  oid: number;
  columns: { name: string; attno: number; notNull: boolean; typeOid?: number }[];
};

function fakeSchema(tables: TableDef[]): SchemaCache {
  const byOidAttno = new Map<string, ColumnInfo>();
  const byName = new Map<string, number>();
  const byOid = new Map<number, Map<string, ColumnInfo>>();
  const oidToName = new Map<number, { schema: string; name: string }>();
  for (const t of tables) {
    const schema = t.schema ?? "public";
    byName.set(`${schema}.${t.name}`, t.oid);
    oidToName.set(t.oid, { schema, name: t.name });
    const cols = new Map<string, ColumnInfo>();
    for (const c of t.columns) {
      const info: ColumnInfo = {
        attrelid: t.oid,
        attnum: c.attno,
        notNull: c.notNull,
        typeOid: c.typeOid ?? 23,
        name: c.name,
      };
      cols.set(c.name, info);
      byOidAttno.set(`${t.oid}/${c.attno}`, info);
    }
    byOid.set(t.oid, cols);
  }
  return {
    loadTableNames: async () => {},
    loadAttributes: async () => {},
    loadColumnsForTables: async () => {},
    loadTableNamesByOid: async () => {},
    loadCustomTypes: async () => {},
    resolveTable: (s: string | undefined, n: string) => byName.get(`${s ?? "public"}.${n}`),
    isNotNull: (oid: number, attno: number) => byOidAttno.get(`${oid}/${attno}`)?.notNull,
    columnNameByAttno: (oid: number, attno: number) => byOidAttno.get(`${oid}/${attno}`)?.name,
    columnsOf: (oid: number) => byOid.get(oid),
    tableNameByOid: (oid: number) => oidToName.get(oid),
    customType: () => undefined,
    arrayElement: (oid: number) => oid === 1007
      ? { typeOid: 23, tsType: "number", nullability: "unknown" as const }
      : undefined,
    setTypeRegistry: () => {},
  } as unknown as SchemaCache;
}

function rowDesc(parts: { name: string; tableOid?: number; attno?: number; typeOid?: number }[]): FieldDescription[] {
  return parts.map((p) => ({
    name: p.name,
    tableOid: p.tableOid ?? 0,
    columnAttr: p.attno ?? 0,
    typeOid: p.typeOid ?? 23,
    typeSize: 4,
    typeModifier: -1,
    format: 0,
  }));
}

describe("analyze: CTE / WITH", () => {
  test("infers nullability of CTE column references", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [
        { name: "id", attno: 1, notNull: true },
        { name: "bio", attno: 2, notNull: false },
      ],
    }]);
    // WITH active AS (SELECT id, bio FROM users) SELECT id, bio FROM active
    const sql = "WITH active AS (SELECT id, bio FROM users) SELECT id, bio FROM active";
    const rd = rowDesc([
      { name: "id", tableOid: 0, attno: 0 },
      { name: "bio", tableOid: 0, attno: 0 },
    ]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(false);
    expect(result.perColumnNullable[1]).toBe(true);
  });

  test("CTE through outer JOIN keeps inner not-null as nullable", async () => {
    const schema = fakeSchema([
      {
        name: "users",
        oid: 16400,
        columns: [
          { name: "id", attno: 1, notNull: true },
          { name: "name", attno: 2, notNull: true },
        ],
      },
      {
        name: "posts",
        oid: 16401,
        columns: [
          { name: "id", attno: 1, notNull: true },
          { name: "user_id", attno: 2, notNull: true },
        ],
      },
    ]);
    const sql = "WITH p AS (SELECT id, user_id FROM posts) SELECT u.id, p.id FROM users u LEFT JOIN p ON p.user_id = u.id";
    const rd = rowDesc([
      { name: "id", tableOid: 0, attno: 0 },
      { name: "id", tableOid: 0, attno: 0 },
    ]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(false);
    expect(result.perColumnNullable[1]).toBe(true);
  });

  test("infers CTE columns produced by UNION ALL", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [
        { name: "id", attno: 1, notNull: true },
        { name: "name", attno: 2, notNull: true },
        { name: "bio", attno: 3, notNull: false },
      ],
    }]);
    const sql = "WITH combined AS (SELECT id, name FROM users UNION ALL SELECT id, bio FROM users) SELECT id, name FROM combined";
    const rd = rowDesc([
      { name: "id", tableOid: 0, attno: 0 },
      { name: "name", tableOid: 0, attno: 0 },
    ]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable).toEqual([false, true]);
    expect(result.degraded).toBeUndefined();
  });

  test("expands materialized CTE rows through a lateral fallback", async () => {
    const schema = fakeSchema([
      {
        name: "billing_period_terms",
        oid: 16400,
        columns: [
          { name: "id", attno: 1, notNull: true },
          { name: "plan_slug", attno: 2, notNull: true },
        ],
      },
      {
        name: "billing_period_amendment",
        oid: 16401,
        columns: [
          { name: "terms_id", attno: 1, notNull: true },
          { name: "plan_slug", attno: 2, notNull: true },
        ],
      },
    ]);
    const sql = `WITH terms AS MATERIALIZED (
      SELECT * FROM billing_period_terms ORDER BY id LIMIT 1
    )
    SELECT
      terms.id,
      COALESCE(amendment.plan_slug, terms.plan_slug) AS plan_slug,
      EXISTS(SELECT 1) AS found
    FROM terms
    LEFT JOIN LATERAL (
      SELECT plan_slug
      FROM billing_period_amendment
      WHERE terms_id = terms.id
      LIMIT 1
    ) amendment ON TRUE`;
    const result = await analyzeQuery(sql, rowDesc([
      { name: "id" },
      { name: "plan_slug" },
      { name: "found", typeOid: 16 },
    ]), schema);
    expect(result.perColumnNullable).toEqual([false, false, false]);
    expect(result.degraded).toBeUndefined();
  });

  test("does not misalign an unqualified star with an untracked range function", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [
        { name: "id", attno: 1, notNull: true },
        { name: "bio", attno: 2, notNull: false },
      ],
    }]);
    const result = await analyzeQuery(
      "WITH mixed(user_id, user_bio, series, marker) AS (" +
      "SELECT *, 1 AS marker FROM users CROSS JOIN unnest(ARRAY[NULL::int])" +
      ") SELECT series FROM mixed",
      rowDesc([{ name: "series" }]),
      schema,
    );
    expect(result.perColumnNullable).toEqual([true]);
  });
});

describe("analyze: set operations", () => {
  test("combines nullability across UNION ALL branches", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [
        { name: "id", attno: 1, notNull: true },
        { name: "name", attno: 2, notNull: true },
        { name: "bio", attno: 3, notNull: false },
      ],
    }]);
    const sql = "SELECT id, name FROM users UNION ALL SELECT id, bio FROM users ORDER BY id";
    const rd = rowDesc([
      { name: "id", tableOid: 0, attno: 0 },
      { name: "name", tableOid: 0, attno: 0 },
    ]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable).toEqual([false, true]);
    expect(result.perColumnSources).toEqual([
      [{ schema: "public", table: "users", column: "id" }],
      [
        { schema: "public", table: "users", column: "name" },
        { schema: "public", table: "users", column: "bio" },
      ],
    ]);
    expect(result.referencedTables).toEqual([{ name: "users" }]);
    expect(result.degraded).toBeUndefined();
  });

  test("handles nested INTERSECT and EXCEPT branches", async () => {
    const schema = fakeSchema([]);
    const sql = "SELECT 1 AS id INTERSECT SELECT 2 AS id EXCEPT SELECT NULL::int AS id";
    const result = await analyzeQuery(sql, rowDesc([{ name: "id" }]), schema);
    expect(result.perColumnNullable).toEqual([false]);
    expect(result.degraded).toBeUndefined();
  });

  test("shares a top-level WITH scope with every set-operation branch", async () => {
    const schema = fakeSchema([]);
    const sql = "WITH source AS (SELECT 1 AS id) SELECT id FROM source UNION ALL SELECT id FROM source";
    const result = await analyzeQuery(sql, rowDesc([{ name: "id" }]), schema);
    expect(result.perColumnNullable).toEqual([false]);
    expect(result.degraded).toBeUndefined();
  });

  test("resolves earlier CTEs inside a later set-operation CTE", async () => {
    const schema = fakeSchema([]);
    const sql = "WITH first AS (SELECT 1 AS id), second AS (SELECT id FROM first UNION ALL SELECT id FROM first) SELECT id FROM second";
    const result = await analyzeQuery(sql, rowDesc([{ name: "id" }]), schema);
    expect(result.perColumnNullable).toEqual([false]);
    expect(result.degraded).toBeUndefined();
  });

  test("combines VALUES rows and VALUES set-operation branches", async () => {
    const schema = fakeSchema([]);
    const nullable = await analyzeQuery(
      "VALUES (1::int), (NULL::int)",
      rowDesc([{ name: "column1" }]),
      schema,
    );
    const nonNullable = await analyzeQuery(
      "VALUES (1) UNION ALL VALUES (2)",
      rowDesc([{ name: "column1" }]),
      schema,
    );
    expect(nullable.perColumnNullable).toEqual([true]);
    expect(nullable.degraded).toBeUndefined();
    expect(nonNullable.perColumnNullable).toEqual([false]);
    expect(nonNullable.degraded).toBeUndefined();
  });

  test("infers a CTE backed by VALUES set-operation branches", async () => {
    const schema = fakeSchema([]);
    const sql = "WITH items(value) AS (VALUES (1) UNION ALL VALUES (2)) SELECT value FROM items";
    const result = await analyzeQuery(sql, rowDesc([{ name: "value" }]), schema);
    expect(result.perColumnNullable).toEqual([false]);
    expect(result.degraded).toBeUndefined();
  });
});

describe("analyze: non-null expressions", () => {
  test("treats array constructors and EXISTS sublinks as non-null", async () => {
    const schema = fakeSchema([]);
    const sql = `SELECT
      ARRAY[1, 2] AS literal_array,
      ARRAY(SELECT NULL::int WHERE FALSE) AS subquery_array,
      COALESCE(ARRAY(SELECT NULL::int WHERE FALSE), ARRAY[]::int[]) AS fallback_array,
      EXISTS(SELECT 1) AS exists_value`;
    const result = await analyzeQuery(sql, rowDesc([
      { name: "literal_array" },
      { name: "subquery_array" },
      { name: "fallback_array" },
      { name: "exists_value" },
    ]), schema);
    expect(result.perColumnNullable).toEqual([false, false, false, false]);
    expect(result.degraded).toBeUndefined();
  });

  test("propagates array nullability through CTEs, VALUES, and set operations", async () => {
    const schema = fakeSchema([]);
    const cte = await analyzeQuery(
      "WITH source AS (SELECT ARRAY[1] AS values) SELECT values FROM source",
      rowDesc([{ name: "values" }]),
      schema,
    );
    const values = await analyzeQuery(
      "VALUES (ARRAY[1]), (ARRAY[]::int[])",
      rowDesc([{ name: "column1" }]),
      schema,
    );
    const nonNullableUnion = await analyzeQuery(
      "SELECT ARRAY[1] AS values UNION ALL SELECT ARRAY(SELECT 2) AS values",
      rowDesc([{ name: "values" }]),
      schema,
    );
    const nullableUnion = await analyzeQuery(
      "SELECT ARRAY[1] AS values UNION ALL SELECT NULL::int[] AS values",
      rowDesc([{ name: "values" }]),
      schema,
    );
    expect(cte.perColumnNullable).toEqual([false]);
    expect(values.perColumnNullable).toEqual([false]);
    expect(nonNullableUnion.perColumnNullable).toEqual([false]);
    expect(nullableUnion.perColumnNullable).toEqual([true]);
    expect(cte.perColumnArrayElementNullability).toEqual(["non-null"]);
    expect(values.perColumnArrayElementNullability).toEqual(["non-null"]);
    expect(nonNullableUnion.perColumnArrayElementNullability).toEqual(["non-null"]);
  });

  test("tracks nullable elements through constructors, array_agg, and derived tables", async () => {
    const schema = fakeSchema([]);
    const result = await analyzeQuery(
      `SELECT
        ARRAY[1, NULL] AS literal_values,
        array_agg(value) AS aggregate_values,
        nested.values AS derived_values
      FROM (VALUES (1::int), (NULL::int)) AS source(value)
      CROSS JOIN (SELECT ARRAY[1, 2] AS values) AS nested
      GROUP BY nested.values`,
      rowDesc([
        { name: "literal_values", typeOid: 1007 },
        { name: "aggregate_values", typeOid: 1007 },
        { name: "derived_values", typeOid: 1007 },
      ]),
      schema,
    );
    expect(result.perColumnArrayElementNullability).toEqual(["nullable", "nullable", "non-null"]);
  });
});

describe("analyze: CTE explicit column list and unnamed expressions", () => {
  test("WITH foo(a, b) AS (...) uses the declared alias names", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [
        { name: "id", attno: 1, notNull: true },
        { name: "bio", attno: 2, notNull: false },
      ],
    }]);
    const sql = "WITH foo(a, b) AS (SELECT id, bio FROM users) SELECT a, b FROM foo";
    const rd = rowDesc([
      { name: "a", tableOid: 0, attno: 0 },
      { name: "b", tableOid: 0, attno: 0 },
    ]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(false);
    expect(result.perColumnNullable[1]).toBe(true);
  });

  test("CTE column from an unnamed expression is conservatively nullable", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [{ name: "id", attno: 1, notNull: true }],
    }]);
    const sql = "WITH n AS (SELECT id + 1 FROM users) SELECT * FROM n";
    const rd = rowDesc([{ name: "?column?", tableOid: 0, attno: 0 }]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(true);
  });
});

describe("analyze: degraded reason", () => {
  test("unsupported statement type marks result as degraded", async () => {
    const schema = fakeSchema([]);
    const sql = "EXPLAIN SELECT 1";
    const rd = rowDesc([{ name: "QUERY PLAN", tableOid: 0, attno: 0 }]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable).toEqual([true]);
    expect(result.degraded).toBeDefined();
    expect(result.degraded!.reason).toContain("unsupported statement type");
  });

  test("non-degraded path does not set degraded field", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [{ name: "id", attno: 1, notNull: true }],
    }]);
    const result = await analyzeQuery("SELECT id FROM users", rowDesc([{ name: "id", tableOid: 16400, attno: 1 }]), schema);
    expect(result.degraded).toBeUndefined();
  });
});

describe("analyze: subquery aliases", () => {
  test("derived table reference preserves analyzed column nullability", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [{ name: "id", attno: 1, notNull: true }],
    }]);
    const sql = "SELECT s.x FROM (SELECT id AS x FROM users) s";
    const rd = rowDesc([{ name: "x", tableOid: 0, attno: 0 }]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(false);
  });

  test("derived single-relation star preserves analyzed column nullability", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [{ name: "id", attno: 1, notNull: true }],
    }]);
    const result = await analyzeQuery(
      "SELECT derived.id FROM (SELECT * FROM users) derived",
      rowDesc([{ name: "id" }]),
      schema,
    );
    expect(result.perColumnNullable).toEqual([false]);
  });

  test("schema-qualified columns resolve through the table scope", async () => {
    const schema = fakeSchema([{
      schema: "app",
      name: "users",
      oid: 16400,
      columns: [{ name: "id", attno: 1, notNull: true }],
    }]);
    const result = await analyzeQuery(
      "SELECT app.users.id FROM app.users",
      rowDesc([{ name: "id", tableOid: 16400, attno: 1 }]),
      schema,
    );
    expect(result.perColumnNullable).toEqual([false]);
    expect(result.perColumnSources).toEqual([[{ schema: "app", table: "users", column: "id" }]]);
  });
});

describe("analyze: JOIN ON narrowing", () => {
  test("qualified self-joins keep alias-specific WHERE narrowing", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [
        { name: "id", attno: 1, notNull: true },
        { name: "name", attno: 2, notNull: false },
      ],
    }]);
    const result = await analyzeQuery(
      "SELECT u1.name FROM users u1 JOIN users u2 ON u1.id = u2.id WHERE u1.name IS NOT NULL",
      rowDesc([{ name: "name", tableOid: 16400, attno: 2 }]),
      schema,
    );
    expect(result.perColumnNullable).toEqual([false]);
  });

  test("INNER JOIN ON equality narrows nullable join keys", async () => {
    const schema = fakeSchema([
      {
        name: "users",
        oid: 16400,
        columns: [{ name: "external_id", attno: 1, notNull: false }],
      },
      {
        name: "posts",
        oid: 16401,
        columns: [{ name: "user_external_id", attno: 1, notNull: false }],
      },
    ]);
    const sql = "SELECT u.external_id, p.user_external_id FROM users u JOIN posts p ON p.user_external_id = u.external_id";
    const rd = rowDesc([
      { name: "external_id", tableOid: 16400, attno: 1 },
      { name: "user_external_id", tableOid: 16401, attno: 1 },
    ]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable).toEqual([false, false]);
  });

  test("LEFT JOIN ON equality does not narrow the null-extended side", async () => {
    const schema = fakeSchema([
      {
        name: "users",
        oid: 16400,
        columns: [{ name: "external_id", attno: 1, notNull: false }],
      },
      {
        name: "posts",
        oid: 16401,
        columns: [{ name: "user_external_id", attno: 1, notNull: false }],
      },
    ]);
    const sql = "SELECT p.user_external_id FROM users u LEFT JOIN posts p ON p.user_external_id = u.external_id";
    const rd = rowDesc([{ name: "user_external_id", tableOid: 16401, attno: 1 }]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(true);
  });

  test("INNER JOIN ON inside a null-extended branch stays nullable", async () => {
    const schema = fakeSchema([
      {
        name: "users",
        oid: 16400,
        columns: [{ name: "id", attno: 1, notNull: true }],
      },
      {
        name: "posts",
        oid: 16401,
        columns: [{ name: "external_id", attno: 1, notNull: false }],
      },
      {
        name: "comments",
        oid: 16402,
        columns: [{ name: "post_external_id", attno: 1, notNull: false }],
      },
    ]);
    const sql = "SELECT p.external_id FROM users u LEFT JOIN (posts p JOIN comments c ON c.post_external_id = p.external_id) ON true";
    const rd = rowDesc([{ name: "external_id", tableOid: 16401, attno: 1 }]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(true);
  });
});

describe("analyze: RETURNING from DML", () => {
  test("INSERT ... RETURNING preserves NOT NULL of target columns", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [
        { name: "id", attno: 1, notNull: true },
        { name: "bio", attno: 2, notNull: false },
      ],
    }]);
    const sql = "INSERT INTO users (id, bio) VALUES ($1, $2) RETURNING id, bio";
    const rd = rowDesc([
      { name: "id", tableOid: 16400, attno: 1 },
      { name: "bio", tableOid: 16400, attno: 2 },
    ]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(false);
    expect(result.perColumnNullable[1]).toBe(true);
  });

  test("UPDATE ... RETURNING with narrowing on WHERE", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [
        { name: "id", attno: 1, notNull: true },
        { name: "bio", attno: 2, notNull: false },
      ],
    }]);
    const sql = "UPDATE users SET bio = $1 WHERE id = $2 AND bio IS NOT NULL RETURNING bio";
    const rd = rowDesc([{ name: "bio", tableOid: 16400, attno: 2 }]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(false);
  });

  test("DELETE ... RETURNING surfaces table column nullability", async () => {
    const schema = fakeSchema([{
      name: "users",
      oid: 16400,
      columns: [
        { name: "id", attno: 1, notNull: true },
        { name: "bio", attno: 2, notNull: false },
      ],
    }]);
    const sql = "DELETE FROM users WHERE id = $1 RETURNING id, bio";
    const rd = rowDesc([
      { name: "id", tableOid: 16400, attno: 1 },
      { name: "bio", tableOid: 16400, attno: 2 },
    ]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(false);
    expect(result.perColumnNullable[1]).toBe(true);
  });

  test("DELETE ... USING RETURNING includes USING table scope", async () => {
    const schema = fakeSchema([
      {
        name: "users",
        oid: 16400,
        columns: [{ name: "id", attno: 1, notNull: true }],
      },
      {
        name: "posts",
        oid: 16401,
        columns: [
          { name: "title", attno: 1, notNull: true },
          { name: "user_id", attno: 2, notNull: true },
        ],
      },
    ]);
    const sql = "DELETE FROM users u USING posts p WHERE p.user_id = u.id RETURNING p.title";
    const rd = rowDesc([{ name: "title", tableOid: 16401, attno: 1 }]);
    const result = await analyzeQuery(sql, rd, schema);
    expect(result.perColumnNullable[0]).toBe(false);
  });
});
