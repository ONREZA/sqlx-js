import { expect, test } from "bun:test";
import { resolveColumnTs } from "../src/commands/prepare-inference";
import type { SqlxJsConfig } from "../src/config";
import { analyzeQuery } from "../src/pg/analyze";
import { arrayElementOid, oidToTs } from "../src/pg/oids";
import type { CustomTypeInfo } from "../src/pg/schema";
import { fakeSchema, rowDesc } from "./helpers/analyze";

const columns = [
  ["count", 23], ["other_count", 23], ["big_count", 20],
  ["payload", 3802], ["action", 25], ["payloads", 3807],
  ["counts", 1007], ["big_counts", 1016], ["domain_payload", 9001],
] as const;
const schema = fakeSchema([{ name: "probe", oid: 100, columns: columns.map(([name, typeOid], index) => ({
  name, typeOid, attno: index + 1, notNull: true,
})) }]);
const domain: CustomTypeInfo = { kind: "scalar", name: "payload_domain", tsType: "unknown", baseOid: 3802 };
schema.customType = (oid) => oid === 9001 ? domain : undefined;
schema.arrayElement = (oid) => {
  const element = arrayElementOid(oid);
  return element === undefined ? undefined : {
    typeOid: element, tsType: oidToTs(element).ts, nullability: "unknown",
  };
};

async function infer(query: string, resultOid: number, config: SqlxJsConfig) {
  const fields = rowDesc([{ name: "value", typeOid: resultOid }]);
  const analysis = await analyzeQuery(query, fields, schema);
  return resolveColumnTs(fields[0]!, schema, config, analysis.perColumnSources[0],
    analysis.perColumnArrayElementNullability[0]);
}

test("EXCEPT promotion cannot reuse an int4 assertion for an int8 result", async () => {
  expect(await infer("SELECT count AS value FROM probe EXCEPT SELECT big_count FROM probe", 20, {
    columnTypes: { "probe.count": "SmallId" },
  })).toBe("bigint");
});

test("EXCEPT array promotion cannot reuse assertions from incompatible element representations", async () => {
  expect(await infer("SELECT counts AS value FROM probe EXCEPT SELECT big_counts FROM probe", 1016, {
    arrayElementNullability: { "probe.counts": "non-null" },
  })).toBe("(bigint | null)[]");
});

for (const [query, oid, expected] of [
  ["SELECT payload::text AS value FROM probe", 25, "string"],
  ["SELECT action::jsonb AS value FROM probe", 3802,
    'import("@onreza/sqlx-js").SqlxJson<import("@onreza/sqlx-js").JsonValue>'],
  ["SELECT payloads::text[] AS value FROM probe", 1009, "(string | null)[]"],
] as const) {
  test(`result casts retain the described representation: ${query}`, async () => {
    expect(await infer(query, oid, {
      columnTypes: { "probe.payload": "Payload", "probe.action": "Action", "probe.payloads": "Payload" },
      arrayElementNullability: { "probe.payloads": "non-null" },
    })).toBe(expected);
  });
}

test("EXCEPT preserves a compatible scalar assertion from its left branch", async () => {
  expect(await infer("SELECT count AS value FROM probe EXCEPT SELECT other_count FROM probe", 23, {
    columnTypes: { "probe.count": "SmallId" },
  })).toBe("SmallId");
});

test("UNION preserves matching compatible assertions from both branches", async () => {
  expect(await infer("SELECT count AS value FROM probe UNION SELECT other_count FROM probe", 23, {
    columnTypes: { "probe.count": "SmallId", "probe.other_count": "SmallId" },
  })).toBe("SmallId");
});

test("UNION cannot narrow the whole result using only its compatible source branch", async () => {
  expect(await infer("SELECT count AS value FROM probe UNION SELECT big_count FROM probe", 20, {
    columnTypes: { "probe.big_count": "BigId" },
  })).toBe("bigint");
});

test("EXCEPT preserves JSON assertions when a stored domain becomes its base result type", async () => {
  expect(await infer("SELECT domain_payload AS value FROM probe EXCEPT SELECT payload FROM probe", 3802, {
    columnTypes: { "probe.domain_payload": "Payload" },
  })).toBe('import("@onreza/sqlx-js").SqlxJson<Payload>');
});
