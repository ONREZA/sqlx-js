import { test, expect } from "bun:test";
import { arrayElementOid, oidToTs, isBuiltinOid } from "../src/pg/oids";

const JSON_VALUE = 'import("@onreza/sqlx-js").JsonValue';

test("scalar OIDs map to expected TS types", () => {
  expect(oidToTs(16).ts).toBe("boolean");
  expect(oidToTs(20).ts).toBe("bigint");
  expect(oidToTs(23).ts).toBe("number");
  expect(oidToTs(25).ts).toBe("string");
  expect(oidToTs(1082).ts).toBe('import("@onreza/sqlx-js").PgTemporal');
  expect(oidToTs(1184).ts).toBe('import("@onreza/sqlx-js").PgTemporal');
  expect(oidToTs(2249).ts).toBe("string");
  expect(oidToTs(2278).ts).toBe("void");
  expect(oidToTs(2950).ts).toBe("string");
  expect(oidToTs(3802).ts).toBe(JSON_VALUE);
  expect(oidToTs(5069).ts).toBe("bigint");
});

test("array OIDs include nullable elements by default", () => {
  expect(oidToTs(1007).ts).toBe("(number | null)[]");
  expect(oidToTs(1009).ts).toBe("(string | null)[]");
  expect(oidToTs(1016).ts).toBe("(bigint | null)[]");
});

test("unknown OID falls back to unknown", () => {
  expect(oidToTs(999_999).ts).toBe("unknown");
});

test("isBuiltinOid recognizes scalars and arrays", () => {
  expect(isBuiltinOid(23)).toBe(true);
  expect(isBuiltinOid(1007)).toBe(true);
  expect(isBuiltinOid(999_999)).toBe(false);
});

test("range types resolve to string", () => {
  expect(oidToTs(3904).ts).toBe("string");
  expect(oidToTs(3906).ts).toBe("string");
  expect(oidToTs(3908).ts).toBe("string");
  expect(oidToTs(3910).ts).toBe("string");
  expect(oidToTs(3912).ts).toBe("string");
  expect(oidToTs(3926).ts).toBe("string");
});

test("range array types include nullable elements", () => {
  expect(oidToTs(3905).ts).toBe("(string | null)[]");
  expect(oidToTs(3907).ts).toBe("(string | null)[]");
  expect(oidToTs(3909).ts).toBe("(string | null)[]");
  expect(oidToTs(3911).ts).toBe("(string | null)[]");
  expect(oidToTs(3913).ts).toBe("(string | null)[]");
  expect(oidToTs(3927).ts).toBe("(string | null)[]");
});

test("multirange types resolve to string", () => {
  expect(oidToTs(4451).ts).toBe("string");
  expect(oidToTs(4536).ts).toBe("string");
  expect(oidToTs(6150).ts).toBe("(string | null)[]");
  expect(oidToTs(6157).ts).toBe("(string | null)[]");
});

test("geometric types resolve to string", () => {
  expect(oidToTs(600).ts).toBe("string");
  expect(oidToTs(601).ts).toBe("string");
  expect(oidToTs(602).ts).toBe("string");
  expect(oidToTs(603).ts).toBe("string");
  expect(oidToTs(604).ts).toBe("string");
  expect(oidToTs(628).ts).toBe("string");
  expect(oidToTs(718).ts).toBe("string");
});

test("bit-string types resolve to string", () => {
  expect(oidToTs(1560).ts).toBe("string");
  expect(oidToTs(1562).ts).toBe("string");
  expect(oidToTs(1561).ts).toBe("(string | null)[]");
  expect(oidToTs(1563).ts).toBe("(string | null)[]");
});

test("network array types include nullable elements", () => {
  expect(oidToTs(1040).ts).toBe("(string | null)[]");
  expect(oidToTs(1041).ts).toBe("(string | null)[]");
  expect(oidToTs(651).ts).toBe("(string | null)[]");
  expect(oidToTs(775).ts).toBe("(string | null)[]");
});

test("json array type maps via _json (199)", () => {
  expect(oidToTs(199).ts).toBe(`(${JSON_VALUE} | null)[]`);
  expect(isBuiltinOid(199)).toBe(true);
});

test("xml/money arrays resolve correctly", () => {
  expect(oidToTs(143).ts).toBe("(string | null)[]");
  expect(oidToTs(791).ts).toBe("(string | null)[]");
});

test("internal OIDs (name, xid, tid, cid, pg_lsn, regclass, regtype) resolve to string", () => {
  expect(oidToTs(19).ts).toBe("string");
  expect(oidToTs(27).ts).toBe("string");
  expect(oidToTs(28).ts).toBe("string");
  expect(oidToTs(29).ts).toBe("string");
  expect(oidToTs(2205).ts).toBe("string");
  expect(oidToTs(2206).ts).toBe("string");
  expect(oidToTs(3220).ts).toBe("string");
  expect(oidToTs(1003).ts).toBe("(string | null)[]");
  expect(oidToTs(3221).ts).toBe("(string | null)[]");
});

test("stable catalog and text-search OIDs map to their actual element types", () => {
  expect(arrayElementOid(3644)).toBe(3642);
  expect(arrayElementOid(3645)).toBe(3615);
  expect(oidToTs(3644).ts).toBe("(string | null)[]");
  expect(oidToTs(3645).ts).toBe("(string | null)[]");
  expect(oidToTs(271).ts).toBe("(bigint | null)[]");
  expect(oidToTs(4073).ts).toBe("(string | null)[]");
  expect(oidToTs(5039).ts).toBe("(string | null)[]");
});
