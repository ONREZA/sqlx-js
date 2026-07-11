import { expect, test } from "bun:test";
import { bindNamedParameters, originalPosition, rewriteNamedParameters } from "../src/sql-params";

test("named parameters are numbered by first use and reused", () => {
  const rewritten = rewriteNamedParameters("SELECT $email, $id, $email");
  expect(rewritten.query).toBe("SELECT $1, $2, $1");
  expect(rewritten.names).toEqual(["email", "id"]);
  expect(bindNamedParameters(rewritten, [{ id: 7, email: "a@b" }])).toEqual({
    query: "SELECT $1, $2, $1",
    params: ["a@b", 7],
  });
});

test("SQL strings, identifiers, comments, and dollar quotes are not rewritten", () => {
  const query = `SELECT '$ignored', "$ignored", $value -- $ignored\n/* $ignored */ $$ $ignored $$`;
  const rewritten = rewriteNamedParameters(query);
  expect(rewritten.query).toContain("'$ignored'");
  expect(rewritten.query).toContain('"$ignored"');
  expect(rewritten.query).toContain("$1 -- $ignored");
  expect(rewritten.query).toContain("$$ $ignored $$");
  expect(rewritten.names).toEqual(["value"]);
});

test("named binding rejects missing and unknown keys", () => {
  const rewritten = rewriteNamedParameters("SELECT $id");
  expect(() => bindNamedParameters(rewritten, [{}])).toThrow(/missing named parameter.*id/);
  expect(() => bindNamedParameters(rewritten, [{ id: 1, extra: 2 }])).toThrow(/unknown named parameter.*extra/);
});

test("named and positional parameters cannot be mixed", () => {
  expect(() => rewriteNamedParameters("SELECT $id, $1")).toThrow(/cannot be mixed/);
});

test("rewritten PostgreSQL positions map back to the source query", () => {
  const rewritten = rewriteNamedParameters("SELECT $long_name + broken");
  expect(originalPosition(rewritten, rewritten.query.indexOf("broken") + 1)).toBe(21);
});
