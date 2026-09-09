import { expect, test } from "bun:test";
import { analyzeQuery } from "../src/pg/analyze";
import { fakeSchema, rowDesc } from "./helpers/analyze";

for (const [options, typeOid] of [
  ["", 25], ["(FORMAT TEXT)", 25], ["(FORMAT JSON)", 114],
  ["(FORMAT XML)", 142], ["(FORMAT YAML)", 25],
  ["(ANALYZE, BUFFERS, WAL, FORMAT JSON)", 114],
  ["(FORMAT XML, FORMAT JSON)", 114],
] as const) {
  test(`EXPLAIN has a non-null utility result: ${options}`, async () => {
    const result = await analyzeQuery(`EXPLAIN ${options} SELECT NULL`, rowDesc([{ name: "QUERY PLAN", typeOid }]), fakeSchema([]));
    expect(result).toEqual({
      perColumnNullable: [false], perColumnSources: [null],
      perColumnArrayElementNullability: ["unknown"], referencedTables: [],
    });
  });
}

for (const fields of [
  [{ name: "QUERY PLAN", typeOid: 25 }],
  [{ name: "other", typeOid: 114 }],
  [{ name: "QUERY PLAN", typeOid: 114, tableOid: 100, attno: 1 }],
  [{ name: "QUERY PLAN", typeOid: 114 }, { name: "extra", typeOid: 25 }],
]) {
  test(`unexpected EXPLAIN description remains degraded: ${JSON.stringify(fields)}`, async () => {
    const result = await analyzeQuery("EXPLAIN (FORMAT JSON) SELECT 1", rowDesc(fields), fakeSchema([]));
    expect(result.perColumnNullable).toEqual(fields.map(() => true));
    expect(result.degraded?.reason).toContain("EXPLAIN result contract");
  });
}

test("parse-only utility statements still need independent inference support", async () => {
  const result = await analyzeQuery("SHOW work_mem", rowDesc([{ name: "work_mem", typeOid: 25 }]), fakeSchema([]));
  expect(result.degraded?.reason).toContain("unsupported statement type");
});
