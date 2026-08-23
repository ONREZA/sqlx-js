import { expect, test } from "bun:test";
import { npmPackFilename } from "../scripts/npm-pack-output.mjs";

test("reads the npm 11 pack JSON format", () => {
  expect(npmPackFilename([{ filename: "onreza-sqlx-js-0.36.0.tgz" }])).toBe(
    "onreza-sqlx-js-0.36.0.tgz",
  );
});

test("reads the npm 12 pack JSON format", () => {
  expect(npmPackFilename({
    "@onreza/sqlx-js": { filename: "onreza-sqlx-js-0.36.0.tgz" },
  })).toBe("onreza-sqlx-js-0.36.0.tgz");
});

test("rejects pack output without exactly one package", () => {
  expect(() => npmPackFilename({})).toThrow("npm pack did not return one package filename");
  expect(() => npmPackFilename([
    { filename: "first.tgz" },
    { filename: "second.tgz" },
  ])).toThrow("npm pack did not return one package filename");
});
