import { expect, test } from "bun:test";
import { analyzeQuery } from "../src/pg/analyze";
import { resolveParamTs } from "../src/commands/prepare-inference";
import { buildParamMap, effectiveParamTargets } from "../src/pg/param-map";
import { fakeSchema, rowDesc } from "./helpers/analyze";

const schema = fakeSchema([
  { name: "probe", oid: 100, columns: [
    { name: "id", attno: 1, notNull: true },
    { name: "value", attno: 3, notNull: false },
  ] },
  { schema: "other", name: "probe", oid: 101, columns: [
    { name: "id", attno: 1, notNull: true },
    { name: "value", attno: 2, notNull: false },
  ] },
  { name: "old", oid: 102, columns: [{ name: "id", attno: 1, notNull: true }] },
]);

for (const query of [
  "WITH probe AS (SELECT chr(118) AS id) SELECT id FROM probe WHERE id = $1",
  "SELECT probe.id FROM (SELECT chr(118) AS id) AS probe WHERE probe.id = $1",
  "SELECT probe.id FROM chr(118) AS probe(id) WHERE probe.id = $1",
]) {
  test(`parameter types do not inherit unrelated table declarations: ${query}`, async () => {
    const result = await buildParamMap(query);
    expect(resolveParamTs(1, "$1", 25, result.bindings, schema, {
      columnTypes: { "public.probe.id": "number" },
    })).toBe("string");
  });
}

for (const relation of ["probe", "public.probe"]) {
  test(`DML target ${relation} cannot be shadowed by a CTE`, async () => {
    const result = await analyzeQuery(
      `WITH probe AS (SELECT 1 AS id, 2 AS value) UPDATE ${relation} SET value = NULL RETURNING value, new.value, old.id`,
      rowDesc([{ name: "value" }, { name: "new_value" }, { name: "old_id" }]), schema,
    );
    expect(result.perColumnNullable).toEqual([true, true, false]);
    expect(result.perColumnSources).toEqual(["value", "value", "id"].map((column) => [{ schema: "public", table: "probe", column }]));
  });
}

test("schema-qualified SELECT relations are not replaced with equally named CTEs", async () => {
  const result = await analyzeQuery(
    "WITH probe AS (SELECT 1 AS value) SELECT public.probe.value FROM public.probe",
    rowDesc([{ name: "value" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([true]);
  expect(result.perColumnSources).toEqual([[{ schema: "public", table: "probe", column: "value" }]]);
});

test("forward CTE references never resolve to an equally named physical table", async () => {
  const result = await analyzeQuery(
    "WITH RECURSIVE first AS (SELECT id FROM probe), probe AS (SELECT NULL::integer AS id) SELECT id FROM first",
    rowDesc([{ name: "id" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([true]);
  expect(result.perColumnSources).toEqual([null]);
});

for (const from of [
  "probe AS p(value, id)",
  "(SELECT id, value FROM probe) AS p(value, id)",
  "(SELECT * FROM probe) AS p(value, id)",
]) {
  test(`column alias lists retain the physical contract: ${from}`, async () => {
    const result = await analyzeQuery(`SELECT p.id, p.value, p.* FROM ${from}`,
      rowDesc(["id", "value", "value", "id"].map((name) => ({ name }))), schema);
    expect(result.perColumnNullable).toEqual([true, false, false, true]);
    expect(result.perColumnSources).toEqual(["value", "id", "id", "value"].map((column) => [{ schema: "public", table: "probe", column }]));
  });
}

test("DML CTE reference aliases preserve nullability, source columns, and array elements", async () => {
  const result = await analyzeQuery(
    "WITH changed AS (DELETE FROM probe RETURNING id, value, ARRAY[old.id] AS before_ids, ARRAY[new.id] AS after_ids) SELECT p.id, p.value, p.before, p.after FROM changed AS p(value, id, before, after)",
    rowDesc(["id", "value", "before", "after"].map((name) => ({ name }))), schema,
  );
  expect(result.perColumnNullable).toEqual([true, false, false, false]);
  expect(result.perColumnSources.slice(0, 2)).toEqual(["value", "id"].map((column) => [{ schema: "public", table: "probe", column }]));
  expect(result.perColumnArrayElementNullability).toEqual(["unknown", "unknown", "non-null", "nullable"]);
});

test("CTE aliases rename duplicate OLD and NEW output names by position", async () => {
  const result = await analyzeQuery(
    "WITH changed AS (INSERT INTO probe(id) VALUES (1) RETURNING old.*, new.*) SELECT p.before_id, p.after_id FROM changed AS p(before_id, before_value, after_id, after_value)",
    rowDesc([{ name: "before_id" }, { name: "after_id" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([true, false]);
  expect(result.perColumnSources).toEqual(Array.from({ length: 2 }, () => [{ schema: "public", table: "probe", column: "id" }]));
});

test("derived aliases preserve duplicate output slots until positional renaming", async () => {
  const result = await analyzeQuery(
    "SELECT p.before, p.after FROM (SELECT value AS duplicate, id AS duplicate FROM probe) AS p(before, after)",
    rowDesc([{ name: "before" }, { name: "after" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([true, false]);
});

for (const from of [
  "(SELECT * FROM changed UNION ALL SELECT * FROM changed) AS combined",
  "combined",
]) {
  test(`DML CTE star contracts survive nested set operations: ${from}`, async () => {
    const result = await analyzeQuery(
      `WITH changed AS (DELETE FROM probe RETURNING old.id AS before, new.id AS after), combined AS (SELECT * FROM changed UNION ALL SELECT * FROM changed) SELECT before, after FROM ${from}`,
      rowDesc([{ name: "before" }, { name: "after" }]), schema,
    );
    expect(result.perColumnNullable).toEqual([false, true]);
    expect(result.perColumnSources).toEqual(Array.from({ length: 2 }, () => [{ schema: "public", table: "probe", column: "id" }]));
  });
}

test("qualified table identity survives equal relation names across schemas", async () => {
  const result = await analyzeQuery(
    "SELECT public.probe.*, other.probe.* FROM public.probe RIGHT JOIN other.probe ON false",
    rowDesc(["id", "value", "id", "value"].map((name) => ({ name }))), schema,
  );
  expect(result.perColumnNullable).toEqual([true, true, false, true]);
  expect(result.perColumnSources).toEqual([
    [{ schema: "public", table: "probe", column: "id" }],
    [{ schema: "public", table: "probe", column: "value" }],
    [{ schema: "other", table: "probe", column: "id" }],
    [{ schema: "other", table: "probe", column: "value" }],
  ]);
  expect(result.referencedTables).toHaveLength(2);
});

test("narrowing never crosses equally named tables from different schemas", async () => {
  const result = await analyzeQuery(
    "SELECT public.probe.value, other.probe.value FROM public.probe, other.probe WHERE other.probe.value IS NOT NULL",
    rowDesc([{ name: "left_value" }, { name: "right_value" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([true, false]);
});

test("schema-qualified targets mask the default OLD relation name", async () => {
  const result = await analyzeQuery("INSERT INTO public.old VALUES (1) RETURNING old.id, new.id",
    rowDesc([{ name: "target_id" }, { name: "new_id" }]), schema);
  expect(result.perColumnNullable).toEqual([false, false]);
});

test("OR does not intersect narrowing for different schema-qualified relations", async () => {
  const result = await analyzeQuery(
    "SELECT public.probe.value, other.probe.value FROM public.probe, other.probe WHERE public.probe.value IS NOT NULL OR other.probe.value IS NOT NULL",
    rowDesc([{ name: "left_value" }, { name: "right_value" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([true, true]);
});

test("UPDATE removes qualified pre-update narrowing from NEW but retains it for OLD", async () => {
  const result = await analyzeQuery(
    "UPDATE public.probe SET value = NULL WHERE public.probe.value IS NOT NULL RETURNING value, old.value, new.value",
    rowDesc([{ name: "value" }, { name: "before" }, { name: "after" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([true, false, true]);
});

test("quoted alias delimiters cannot retain pre-update narrowing on NEW", async () => {
  const result = await analyzeQuery(
    'UPDATE probe AS "p|q" SET value = NULL WHERE "p|q".value IS NOT NULL RETURNING "p|q".value, old.value, new.value',
    rowDesc([{ name: "value" }, { name: "before" }, { name: "after" }]), schema,
  );
  expect(result.perColumnNullable).toEqual([true, false, true]);
});

test("casts keep the same row-version contract with or without stars", async () => {
  const descriptions = rowDesc([
    { name: "old_id", tableOid: 100, attno: 1 },
    { name: "new_id", tableOid: 100, attno: 1 },
  ]);
  const plain = await analyzeQuery("DELETE FROM probe RETURNING old.id::integer, new.id::integer", descriptions, schema);
  const starred = await analyzeQuery("DELETE FROM probe RETURNING *, old.id::integer, new.id::integer",
    [...rowDesc([{ name: "id", tableOid: 100, attno: 1 }, { name: "value", tableOid: 100, attno: 3 }]), ...descriptions], schema);
  expect(plain.perColumnNullable).toEqual([false, true]);
  expect(starred.perColumnNullable.slice(2)).toEqual(plain.perColumnNullable);
  expect(starred.perColumnSources.slice(2)).toEqual(plain.perColumnSources);
});

for (const qualifier of ["", "p."]) {
  test(`parameter provenance follows positional column aliases: ${qualifier || "unqualified"}`, async () => {
    const result = await buildParamMap(`SELECT * FROM probe AS p(value, id) WHERE ${qualifier}id = $1 AND ${qualifier}value = $2`);
    expect(effectiveParamTargets(result.bindings.get(1))).toEqual([{ schema: undefined, table: "probe", columnIndex: 2 }]);
    expect(effectiveParamTargets(result.bindings.get(2))).toEqual([{ schema: undefined, table: "probe", columnIndex: 1 }]);
  });
}
