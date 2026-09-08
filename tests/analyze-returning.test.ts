import { expect, test } from "bun:test";
import { analyzeQuery } from "../src/pg/analyze";
import { buildParamMap, effectiveParamTargets } from "../src/pg/param-map";
import { classifyPlanValidation } from "../src/pg/plan-classification";
import { analyzeSimilarityUnits } from "../src/query-similarity";
import { fakeSchema, rowDesc } from "./helpers/analyze";

const schema = fakeSchema([
  { name: "probe", oid: 100, columns: [
    { name: "id", attno: 1, notNull: true },
    { name: "value", attno: 2, notNull: false },
    { name: "tags", attno: 3, notNull: true, typeOid: 1007 },
  ] },
  { name: "source", oid: 101, columns: [
    { name: "id", attno: 1, notNull: true },
    { name: "value", attno: 2, notNull: false },
  ] },
]);

for (const [statement, nullable] of [
  ["INSERT INTO probe(id) VALUES (1)", [true, false, false, true, true]],
  ["INSERT INTO probe(id) VALUES (1) ON CONFLICT(id) DO UPDATE SET value = EXCLUDED.value", [true, false, false, true, true]],
  ["UPDATE probe SET value = NULL", [false, false, false, true, true]],
  ["DELETE FROM probe", [false, true, false, true, true]],
] as const) {
  for (const aliases of [false, true]) {
    test(`${statement} resolves ${aliases ? "aliased" : "default"} row versions`, async () => {
      const sql = `${statement} RETURNING ${aliases ? "WITH (OLD AS previous, NEW AS stored) " : ""}`
        + `${aliases ? "previous" : "old"}.id AS old_id, ${aliases ? "stored" : "new"}.id AS new_id, id, `
        + `${aliases ? "previous" : "old"}.value AS old_value, ${aliases ? "stored" : "new"}.value AS new_value`;
      const result = await analyzeQuery(sql, rowDesc([
        { name: "old_id", tableOid: 100, attno: 1 },
        { name: "new_id", tableOid: 100, attno: 1 },
        { name: "id", tableOid: 100, attno: 1 },
        { name: "old_value", tableOid: 100, attno: 2 },
        { name: "new_value", tableOid: 100, attno: 2 },
      ]), schema);
      expect(result.perColumnNullable).toEqual([...nullable]);
      expect(result.perColumnSources).toEqual(["id", "id", "id", "value", "value"].map((column) => [
        { schema: "public", table: "probe", column },
      ]));
      expect(result.referencedTables).toEqual([{ schema: undefined, name: "probe" }]);
      expect(result.degraded).toBeUndefined();
      expect(await classifyPlanValidation(sql)).toBe("planned");
    });
  }
}

test("similarity analysis accepts PostgreSQL 18 DML and retains returned row-version identity", async () => {
  const statements = [
    "INSERT INTO probe(id) VALUES (1) RETURNING WITH (OLD AS previous, NEW AS stored) previous.id",
    "INSERT INTO probe(id) VALUES (2) RETURNING WITH (OLD AS previous, NEW AS stored) previous.id",
    "INSERT INTO probe(id) VALUES (3) RETURNING WITH (OLD AS previous, NEW AS stored) stored.id",
  ];
  const result = await analyzeSimilarityUnits(statements.map((sql, index) => ({
    id: `q${index}`, kind: "application-query", label: `q${index}`, sql, sources: [],
  })), { minNodes: 8, limit: 20 });
  expect(result.parseErrors).toEqual([]);
  const inserts = result.candidates.filter((candidate) => candidate.nodeType === "InsertStmt");
  expect(inserts.map((candidate) => candidate.occurrences.map((occurrence) => occurrence.unitId))).toEqual([["q0", "q1"]]);
});

test("mixed RETURNING stars preserve positional row versions and expression contracts", async () => {
  const result = await analyzeQuery(
    "INSERT INTO probe(id) VALUES (1) RETURNING WITH (OLD AS previous, NEW AS stored) previous.*, 1 AS marker, stored.*, COALESCE(previous.id, stored.id) AS effective, *",
    rowDesc(["id", "value", "tags", "marker", "id", "value", "tags", "effective", "id", "value", "tags"].map((name) => ({ name }))),
    schema,
  );
  expect(result.perColumnNullable).toEqual([true, true, true, false, false, true, false, false, false, true, false]);
  expect(result.perColumnSources[0]).toEqual([{ schema: "public", table: "probe", column: "id" }]);
  expect(result.perColumnSources[4]).toEqual(result.perColumnSources[0]);
  expect(result.perColumnSources[3]).toBeNull();
});

test("UPDATE narrows only OLD and FROM sources against pre-update predicates", async () => {
  const result = await analyzeQuery(
    "UPDATE probe p SET value = NULL FROM source s WHERE p.id = s.id AND p.value IS NOT NULL AND s.value IS NOT NULL RETURNING WITH (OLD AS previous, NEW AS stored) previous.value, stored.value, p.value, s.value",
    rowDesc(["old_value", "new_value", "target_value", "source_value"].map((name) => ({ name }))), schema,
  );
  expect(result.perColumnNullable).toEqual([false, true, true, false]);
});

test("DELETE predicates cannot narrow the absent NEW row", async () => {
  const result = await analyzeQuery(
    "DELETE FROM probe WHERE value IS NOT NULL RETURNING old.value, new.value, new.id, value",
    rowDesc(["old_value", "new_value", "new_id", "value"].map((name) => ({ name }))), schema,
  );
  expect(result.perColumnNullable).toEqual([false, true, true, false]);
});

test("RETURNING * excludes UPDATE FROM relations and synthetic aliases", async () => {
  const result = await analyzeQuery(
    "UPDATE probe p SET value = s.value FROM source s WHERE p.id = s.id RETURNING *, old.id AS before, s.id AS source_id",
    rowDesc(["id", "value", "tags", "before", "source_id"].map((name) => ({ name }))), schema,
  );
  expect(result.perColumnNullable).toEqual([false, true, false, false, false]);
  expect(result.perColumnSources[4]).toEqual([{ schema: "public", table: "source", column: "id" }]);
});

test("existing relation aliases mask default OLD and NEW names", async () => {
  const result = await analyzeQuery(
    "DELETE FROM probe AS new USING source AS old WHERE new.id = old.id RETURNING old.id, new.id",
    rowDesc([{ name: "source_id" }, { name: "target_id" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([false, false]);
  expect(result.perColumnSources).toEqual([
    [{ schema: "public", table: "source", column: "id" }],
    [{ schema: "public", table: "probe", column: "id" }],
  ]);
});

test("explicit aliases can swap reserved names and preserve quoted identifiers", async () => {
  const result = await analyzeQuery(
    'INSERT INTO probe(id) VALUES (1) RETURNING WITH (OLD AS new, NEW AS "Stored") new.id, "Stored".id',
    rowDesc([{ name: "before" }, { name: "after" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([true, false]);
});

test("DML CTE stars preserve row-version nullability and column provenance", async () => {
  const result = await analyzeQuery(
    "WITH changed(before_id, before_value, before_tags, after_id, after_value, after_tags) AS (INSERT INTO probe(id) VALUES (1) RETURNING WITH (OLD AS previous, NEW AS stored) previous.*, stored.*) SELECT before_id, after_id, before_tags, after_tags FROM changed",
    rowDesc(["before_id", "after_id", "before_tags", "after_tags"].map((name) => ({ name }))), schema,
  );
  expect(result.perColumnNullable).toEqual([true, false, true, false]);
  expect(result.perColumnSources).toEqual(["id", "id", "tags", "tags"].map((column) => [
    { schema: "public", table: "probe", column },
  ]));
});

for (const statement of [
  "INSERT INTO probe(id) VALUES ($1) ON CONFLICT(id) DO UPDATE SET value = $2",
  "UPDATE probe SET value = $2 WHERE id = $1",
  "DELETE FROM probe WHERE id = $1 AND value = $2",
]) {
  test(`RETURNING parameter mapping: ${statement}`, async () => {
    const { bindings } = await buildParamMap(`${statement} RETURNING WITH (OLD AS previous, NEW AS stored) previous.id, stored.value`);
    expect(effectiveParamTargets(bindings.get(1))).toEqual([{ table: "probe", schema: undefined, column: "id" }]);
    expect(effectiveParamTargets(bindings.get(2))).toEqual([{ table: "probe", schema: undefined, column: "value" }]);
  });
}
