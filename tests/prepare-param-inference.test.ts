import { expect, test } from "bun:test";
import { resolveParamNullable, resolveParamTs } from "../src/commands/prepare-inference";
import type { SqlxJsConfig } from "../src/config";
import { arrayElementOid, oidToTs } from "../src/pg/oids";
import { buildParamMap } from "../src/pg/param-map";
import type { CustomTypeInfo } from "../src/pg/schema";
import { fakeSchema } from "./helpers/analyze";

const customTypes = new Map<number, CustomTypeInfo>([
  [9001, { kind: "scalar", name: "payload_domain", tsType: "unknown", baseOid: 3802 }],
  [9002, { kind: "scalar", name: "payload_array_domain", tsType: "unknown", baseOid: 3807 }],
  [9004, { kind: "scalar", name: "action_domain", tsType: "string", baseOid: 1043 }],
  [9005, { kind: "enum", name: "state", values: ["ready", "done"] }],
  [9006, { kind: "enum", name: "other_state", values: ["ready", "done"] }],
]);
const columns = [
  ["payload", 3802], ["other_payload", 3802], ["nullable_payload", 3802],
  ["action", 25], ["count", 23], ["big_count", 20], ["varchar_action", 1043],
  ["char_action", 1042], ["payloads", 3807], ["labels", 1009],
  ["domain_payload", 9001], ["wrapped_payloads", 9002], ["domain_payloads", 9003],
  ["domain_action", 9004], ["state", 9005], ["other_state", 9006],
] as const;
const schema = fakeSchema([{ name: "probe", oid: 100, columns: columns.map(([name, typeOid], index) => ({
  name, typeOid, attno: index + 1, notNull: name !== "nullable_payload",
})) }]);
schema.customType = (oid) => customTypes.get(oid);
schema.tsType = (oid) => {
  const custom = customTypes.get(oid);
  return custom?.kind === "enum" ? custom.values.map((value) => JSON.stringify(value)).join(" | ") : oidToTs(oid).ts;
};
schema.arrayElement = (oid) => {
  const custom = customTypes.get(oid);
  if (custom?.kind === "scalar" && custom.baseOid) return schema.arrayElement(custom.baseOid);
  const element = oid === 9003 ? 9001 : arrayElementOid(oid);
  return element === undefined ? undefined : {
    typeOid: element, tsType: oidToTs(element).ts, nullability: "unknown",
  };
};

const json = (type: string) => `import("@onreza/sqlx-js").SqlxJson<${type}>`;
const array = (type: string, nonNull = false) =>
  `import("@onreza/sqlx-js").PgArrayParameter<${type}, ${nonNull ? "false" : "boolean"}>`;

async function infer(query: string, oid: number, config: SqlxJsConfig) {
  const mapping = await buildParamMap(query);
  return {
    type: resolveParamTs(1, "$1", oid, mapping.bindings, schema, config),
    nullable: resolveParamNullable(1, mapping, schema),
    mapping,
  };
}

for (const query of [
  "UPDATE probe SET payload = $1::text::jsonb",
  "SELECT * FROM probe WHERE payload = $1::text::jsonb",
]) {
  test(`JSON destination cannot replace a text wire parameter: ${query}`, async () => {
    const result = await infer(query, 25, { columnTypes: { "probe.payload": "Payload" } });
    expect(result.type).toBe("string");
    expect(result.nullable).toBe(false);
  });
}

test("a text destination cannot replace the JSON transport wrapper", async () => {
  const result = await infer("UPDATE probe SET action = $1::jsonb::text", 3802, {
    columnTypes: { "probe.action": "Action" },
  });
  expect(result.type).toBe(json("unknown"));
});

for (const [query, oid, expected, column] of [
  ["UPDATE probe SET action = $1::int::text", 23, "number", "action"],
  ["UPDATE probe SET count = $1::bigint::int", 20, "bigint", "count"],
  ["UPDATE probe SET big_count = $1::int::bigint", 23, "number", "big_count"],
] as const) {
  test(`scalar casts retain the described input contract: ${query}`, async () => {
    expect((await infer(query, oid, { columnTypes: { [`probe.${column}`]: "StoredValue" } })).type)
      .toBe(expected);
  });
}

test("incompatible stored targets do not cause declaration conflicts", async () => {
  const result = await infer("UPDATE probe SET payload = $1::jsonb, action = $1::jsonb::text", 3802, {
    columnTypes: { "probe.payload": "Payload", "probe.action": "Action" },
  });
  expect(result.type).toBe(json("Payload"));
});

test("compatible stored targets still reject conflicting declarations", async () => {
  await expect(infer("UPDATE probe SET payload = $1::jsonb, other_payload = $1::jsonb", 3802, {
    columnTypes: { "probe.payload": "Payload", "probe.other_payload": "OtherPayload" },
  })).rejects.toThrow("maps to conflicting JSON declarations");
});

test("incompatible DML targets retain precedence over predicate assertions", async () => {
  const result = await infer("UPDATE probe SET payload = $1::text::jsonb WHERE action = $1", 25, {
    columnTypes: { "probe.payload": "Payload", "probe.action": "Action" },
  });
  expect(result.type).toBe("string");
  expect(result.nullable).toBe(false);
  expect(() => resolveParamNullable(1, result.mapping, schema, true)).toThrow("NOT NULL stored target");
});

for (const query of [
  "UPDATE probe SET nullable_payload = $1::text::jsonb",
  "UPDATE probe SET payload = COALESCE($1::text::jsonb, payload)",
]) {
  test(`cast filtering preserves nullable stored-value semantics: ${query}`, async () => {
    const result = await infer(query, 25, {
      columnTypes: { "probe.payload": "Payload", "probe.nullable_payload": "Payload" },
    });
    expect(result.type).toBe("string");
    expect(result.nullable).toBe(true);
  });
}

for (const [column, cast, oid, expected] of [
  ["payload", "::json", 114, json("Payload")],
  ["varchar_action", "::text", 25, "Payload"],
  ["char_action", "::text", 25, "Payload"],
  ["domain_payload", "::jsonb", 3802, json("Payload")],
  ["domain_payload", "", 9001, json("Payload")],
  ["domain_action", "::text", 25, "Payload"],
  ["payloads", "::json[]::jsonb[]", 199, array(json("Payload"))],
  ["wrapped_payloads", "::jsonb[]", 3807, array(json("Payload"))],
  ["domain_payloads", "::jsonb[]", 3807, array(json("Payload"))],
] as const) {
  test(`compatible wire types preserve column assertions: ${column} with OID ${oid}`, async () => {
    expect((await infer(`UPDATE probe SET ${column} = $1${cast}`, oid, {
      columnTypes: { [`probe.${column}`]: "Payload" },
    })).type).toBe(expected);
  });
}

test("distinct PostgreSQL enums do not share assertions through equal label unions", async () => {
  const result = await infer("UPDATE probe SET state = $1::other_state::text::state", 9006, {
    columnTypes: { "probe.state": "State" },
  });
  expect(result.type).toBe('"ready" | "done"');
});

test("incompatible array targets do not narrow input elements", async () => {
  const result = await infer("UPDATE probe SET payloads = $1::text[]::jsonb[]", 1009, {
    columnTypes: { "probe.payloads": "Payload" },
    arrayElementNullability: { "probe.payloads": "non-null" },
  });
  expect(result.type).toBe(array("string"));
});

test("compatible array targets retain non-null element assertions", async () => {
  const result = await infer("UPDATE probe SET payloads = $1::json[]::jsonb[]", 199, {
    columnTypes: { "probe.payloads": "Payload" },
    arrayElementNullability: { "probe.payloads": "non-null" },
  });
  expect(result.type).toBe(array(json("Payload"), true));
});
