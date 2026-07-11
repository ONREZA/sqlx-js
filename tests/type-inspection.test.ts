import { expect, test } from "bun:test";
import { containsUnknownType } from "../src/type-inspection";

test("strict inference distinguishes existential JSON parameters from unresolved unknown types", () => {
  expect(containsUnknownType('import("@onreza/sqlx-js").JsonParameter<unknown>')).toBe(false);
  expect(containsUnknownType(
    'import("@onreza/sqlx-js").PgArrayParameter<import("@onreza/sqlx-js").JsonParameter<unknown>>',
  )).toBe(false);

  expect(containsUnknownType("unknown")).toBe(true);
  expect(containsUnknownType('import("other-package").JsonParameter<unknown>')).toBe(true);
  expect(containsUnknownType('import("@onreza/sqlx-js").JsonParameter<{ value: unknown }>')).toBe(true);
});
