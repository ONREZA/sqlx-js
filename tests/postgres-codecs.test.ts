import { expect, test } from "bun:test";
import {
  parseCompositeLiteral,
  parseHstore,
  parseVector,
  PostgresTypeRegistry,
  serializeCompositeLiteral,
  serializeHstore,
  serializeVector,
} from "../src/postgres-codecs";

test("vector codec preserves finite and special values", () => {
  expect(parseVector("[1.5,-2,NaN,Infinity,-Infinity]")).toEqual([1.5, -2, NaN, Infinity, -Infinity]);
  expect(serializeVector([1.5, -2, NaN, Infinity, -Infinity])).toBe("[1.5,-2,NaN,Infinity,-Infinity]");
  expect(() => parseVector("1,2")).toThrow("malformed vector");
});

test("hstore codec handles null, empty, quoted, and escaped values", () => {
  const value = {
    plain: "value",
    empty: "",
    nullable: null,
    'quote"slash\\': 'comma, arrow=> and "quote"',
  };
  expect(parseHstore(serializeHstore(value))).toEqual(value);
  expect(parseHstore('"a"=>NULL, "b"=>"NULL"')).toEqual({ a: null, b: "NULL" });
  expect(Object.hasOwn(parseHstore('"__proto__"=>"safe"'), "__proto__")).toBe(true);
});

test("composite literal codec distinguishes SQL null from empty strings", () => {
  const fields = ["plain", null, "", 'quote"slash\\', "(nested,field)", "{one,two}"];
  const encoded = serializeCompositeLiteral(fields);
  expect(parseCompositeLiteral(encoded)).toEqual(fields);
  expect(parseCompositeLiteral('(plain,,"",quoted)')).toEqual(["plain", null, "", "quoted"]);
  expect(parseCompositeLiteral('("comma, ""quoted""",7)')).toEqual(['comma, "quoted"', "7"]);
});

test("runtime codec bootstrap is shared by concurrent first queries", async () => {
  let calls = 0;
  const client = {
    options: { parsers: {}, serializers: {}, types: {} },
    unsafe: () => ({
      values: async () => {
        calls++;
        return [];
      },
    }),
  };
  const registry = new PostgresTypeRegistry(client);
  const pending = registry.ready();
  expect(pending).toBeDefined();
  await Promise.all([pending, registry.ready(), registry.ready()]);
  expect(calls).toBe(1);
  expect(registry.ready()).toBeUndefined();
});

test("runtime codec bootstrap rejects unknown configured type names", async () => {
  const client = {
    options: { parsers: {}, serializers: {}, types: {} },
    unsafe: () => ({ values: async () => [] }),
  };
  const registry = new PostgresTypeRegistry(client, {
    missing_type: { parse: String, serialize: String },
  });
  await expect(registry.ready()).rejects.toThrow(
    "runtime type codec missing_type does not match a PostgreSQL type",
  );
});

test("runtime codec bootstrap rejects domain-specific codecs", async () => {
  const client = {
    options: { parsers: {}, serializers: {}, types: {} },
    unsafe: () => ({
      values: async () => [["public", "account_code", 50_000, 50_001, "d", 25, 0]],
    }),
  };
  const registry = new PostgresTypeRegistry(client, {
    account_code: { parse: String, serialize: String },
  });
  await expect(registry.ready()).rejects.toThrow(
    "runtime type codec account_code cannot override a PostgreSQL domain because result metadata exposes its base type",
  );
});

test("runtime codec bootstrap retries after a transient catalog failure", async () => {
  let attempts = 0;
  const client = {
    options: { parsers: {}, serializers: {}, types: {} },
    unsafe: () => ({
      values: async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary catalog failure");
        return [];
      },
    }),
  };
  const registry = new PostgresTypeRegistry(client);
  await expect(registry.ready()).rejects.toThrow("temporary catalog failure");
  await expect(registry.ready()).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});

test("explicit numeric driver codecs remain authoritative", async () => {
  const scalarParser = (value: string) => `numeric:${value}`;
  const arrayParser = (value: string) => `numeric-array:${value}`;
  const scalarSerializer = (value: unknown) => `numeric:${String(value)}`;
  const arraySerializer = (value: unknown) => `numeric-array:${String(value)}`;
  const client = {
    options: {
      parsers: { 50_000: scalarParser, 50_001: arrayParser },
      serializers: { 50_000: scalarSerializer, 50_001: arraySerializer },
      types: { explicit: { to: 50_000, from: [50_000, 50_001] } },
    },
    unsafe: () => ({
      values: async () => [["public", "vector", 50_000, 50_001, "b", 0, 0]],
    }),
  };
  const registry = new PostgresTypeRegistry(client, {
    vector: { parse: () => [1], serialize: () => "[1]" },
  });
  await registry.ready();
  expect(client.options.parsers[50_000]).toBe(scalarParser);
  expect(client.options.parsers[50_001]).toBe(arrayParser);
  expect(client.options.serializers[50_000]).toBe(scalarSerializer);
  expect(client.options.serializers[50_001]).toBe(arraySerializer);
});

test("built-in extension codecs do not capture user types with the same name", async () => {
  const client = {
    options: { parsers: {}, serializers: {}, types: {} },
    unsafe: () => ({
      values: async () => [["app", "vector", 60_000, 60_001, "e", 0, 0]],
    }),
  };
  const registry = new PostgresTypeRegistry(client);
  await registry.ready();
  expect(client.options.parsers[60_000]!("admin")).toBe("admin");
  expect(client.options.parsers[60_001]!('{admin,NULL}')).toEqual(["admin", null]);
});
