import { test, expect } from "bun:test";
import { encodePgArrayLiteral, parsePgArrayLiteral } from "../src/runtime";

test("encodes simple string array", () => {
  expect(encodePgArrayLiteral(["a", "b", "c"])).toBe("{a,b,c}");
});

test("encodes numeric arrays", () => {
  expect(encodePgArrayLiteral([1, 2, 3])).toBe("{1,2,3}");
  expect(encodePgArrayLiteral([1.5, -2.25])).toBe("{1.5,-2.25}");
});

test("encodes bigint arrays", () => {
  expect(encodePgArrayLiteral([1n, 9007199254740993n])).toBe("{1,9007199254740993}");
});

test("encodes booleans as t/f", () => {
  expect(encodePgArrayLiteral([true, false, true])).toBe("{t,f,t}");
});

test("encodes NULL elements", () => {
  expect(encodePgArrayLiteral(["a", null, "b"])).toBe("{a,NULL,b}");
  expect(encodePgArrayLiteral([null, null])).toBe("{NULL,NULL}");
});

test("quotes strings containing commas, braces, quotes, backslashes", () => {
  expect(encodePgArrayLiteral(["a,b"])).toBe('{"a,b"}');
  expect(encodePgArrayLiteral(["{x}"])).toBe('{"{x}"}');
  expect(encodePgArrayLiteral(['"q"'])).toBe('{"\\"q\\""}');
  expect(encodePgArrayLiteral(["back\\slash"])).toBe('{"back\\\\slash"}');
});

test("quotes empty string and whitespace", () => {
  expect(encodePgArrayLiteral([""])).toBe('{""}');
  expect(encodePgArrayLiteral([" "])).toBe('{" "}');
  expect(encodePgArrayLiteral(["a b"])).toBe('{"a b"}');
});

test("quotes literal 'null' / 'NULL' to disambiguate from SQL NULL", () => {
  expect(encodePgArrayLiteral(["null"])).toBe('{"null"}');
  expect(encodePgArrayLiteral(["NULL"])).toBe('{"NULL"}');
});

test("empty array → empty literal", () => {
  expect(encodePgArrayLiteral([])).toBe("{}");
});

test("encodes multidimensional arrays recursively", () => {
  expect(encodePgArrayLiteral([[1, 2], [3, null]])).toBe("{{1,2},{3,NULL}}");
  expect(encodePgArrayLiteral([[1, 2], [3, null]], String)).toBe('{{"1","2"},{"3",NULL}}');
});

test("non-finite numbers are quoted", () => {
  expect(encodePgArrayLiteral([Infinity])).toBe('{"Infinity"}');
  expect(encodePgArrayLiteral([NaN])).toBe('{"NaN"}');
});

test("parses NULL elements distinctly from quoted NULL strings", () => {
  expect(parsePgArrayLiteral('{a,NULL,"NULL","with \\"quote\\""}')).toEqual(["a", null, "NULL", 'with "quote"']);
});

test("parses arrays with explicit PostgreSQL dimension bounds", () => {
  expect(parsePgArrayLiteral("[0:2]={one,two,three}")).toEqual(["one", "two", "three"]);
  expect(parsePgArrayLiteral("[-1:0][2:3]={{1,2},{3,4}}", Number)).toEqual([[1, 2], [3, 4]]);
});
