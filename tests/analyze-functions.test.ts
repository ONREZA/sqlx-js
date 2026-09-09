import { expect, test } from "bun:test";
import { analyzeQuery } from "../src/pg/analyze";
import { fakeSchema, rowDesc } from "./helpers/analyze";

for (const reference of ["u.value", "value"]) {
  for (const predicate of ["", "WHERE u.value IS NOT NULL", "WHERE value IS NOT NULL", "WHERE u.value > 0"]) {
    for (const array of [false, true]) {
      const inner = `SELECT ${reference} FROM unnest(ARRAY[1, NULL]::int[]) AS u(value) ${predicate}`;
      const sql = array ? `SELECT ARRAY(${inner}) AS values` : inner;
      test(`function output narrowing: ${sql}`, async () => {
        const result = await analyzeQuery(sql, rowDesc([{ name: "values", typeOid: array ? 1007 : 23 }]), fakeSchema([]));
        expect(result.degraded).toBeUndefined();
        expect(result.perColumnNullable).toEqual([array ? false : !predicate]);
        expect(result.perColumnSources).toEqual([null]);
        expect(result.perColumnArrayElementNullability).toEqual([array ? (predicate ? "non-null" : "nullable") : "unknown"]);
      });
    }
  }
}

for (const sql of [
  "SELECT unnest FROM unnest(ARRAY[1, NULL]) WHERE unnest IS NOT NULL",
  "SELECT unnest.unnest FROM pg_catalog.unnest(ARRAY[1, NULL]) WHERE unnest.unnest IS NOT NULL",
  'SELECT "U"."Value" FROM unnest(ARRAY[1, NULL]) AS "U"("Value") WHERE "U"."Value" IS NOT NULL',
  "WITH filtered AS (SELECT value FROM unnest(ARRAY[1,NULL]) AS u(value) WHERE value IS NOT NULL) SELECT value FROM filtered",
  "SELECT value FROM (SELECT u.value FROM unnest(ARRAY[1,NULL]) AS u(value) WHERE u.value IS NOT NULL) AS filtered",
  "SELECT u.value FROM (SELECT 1 AS id) AS p LEFT JOIN unnest(ARRAY[1,NULL]) AS u(value) ON true WHERE u.value IS NOT NULL",
  "SELECT u.value FROM unnest(ARRAY[1,NULL]) AS u(value) INNER JOIN (SELECT 1 AS id) AS p ON u.value = p.id",
  "SELECT u.value FROM ROWS FROM (unnest(ARRAY[1,NULL]), generate_series(1,2)) WITH ORDINALITY AS u(value, id, n) WHERE u.value IS NOT NULL",
]) {
  test(`function narrowing survives scope composition: ${sql}`, async () => {
    const result = await analyzeQuery(sql, rowDesc([{ name: "value" }]), fakeSchema([]));
    expect(result.perColumnNullable).toEqual([false]);
    expect(result.perColumnSources).toEqual([null]);
  });
}

for (const sql of [
  "SELECT value FROM unnest(ARRAY[1,NULL]) AS u(value), unnest(ARRAY[2,NULL]) AS v(value) WHERE u.value IS NOT NULL",
  "SELECT value FROM unnest(ARRAY[1,NULL]) AS u(value), unnest(ARRAY[2,NULL]) AS v(value) WHERE value IS NOT NULL",
  "SELECT u.value FROM (SELECT 1 AS id) AS p LEFT JOIN unnest(ARRAY[1,NULL]) AS u(value) ON u.value IS NOT NULL",
  "SELECT u.value FROM unnest(ARRAY[1,NULL]) AS u(value) WHERE u.value IS NOT NULL OR true",
  "SELECT u.value FROM unnest(ARRAY[1,NULL]) AS u(value), unnest(ARRAY[2,NULL]) AS v(value) WHERE v.value IS NOT NULL",
  "SELECT u.value FROM unnest(ARRAY[1,NULL]) AS u(value, value) WHERE u.value IS NOT NULL",
  "SELECT value FROM unnest(ARRAY[1,NULL]) AS u(value, value), (SELECT 1 AS value) AS p WHERE p.value IS NOT NULL",
  "SELECT value FROM unnest(ARRAY[1,NULL]) AS u(value), (SELECT 1 AS value, 2 AS value) AS p WHERE u.value IS NOT NULL",
  "SELECT u.value FROM unnest(ARRAY[1,NULL]) AS u(value), unnest(ARRAY[2,NULL]) AS v(value) WHERE value IS NOT NULL",
]) {
  test(`function references remain conservative: ${sql}`, async () => {
    const result = await analyzeQuery(sql, rowDesc([{ name: "value" }]), fakeSchema([]));
    expect(result.perColumnNullable).toEqual([true]);
  });
}

for (const reference of ["u.value", "value"]) {
  test(`function outputs never inherit equally named table provenance: ${reference}`, async () => {
    const schema = fakeSchema([{ name: "u", oid: 100, columns: [{ name: "value", attno: 1, notNull: true }] }]);
    const result = await analyzeQuery(`SELECT ${reference} FROM unnest(ARRAY[1,NULL]) AS u(value)`, rowDesc([{ name: "value" }]), schema);
    expect(result.perColumnNullable).toEqual([true]);
    expect(result.perColumnSources).toEqual([null]);
  });
}
