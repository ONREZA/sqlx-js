import { test, expect } from "bun:test";
import { BUILTIN_EXTENSION_TYPES, mergeExtensionTypes } from "../src/pg/extensions";

test("built-in extension registry covers pgvector, hstore, citext, ltree", () => {
  expect(BUILTIN_EXTENSION_TYPES.vector).toBe("number[]");
  expect(BUILTIN_EXTENSION_TYPES.halfvec).toBe("number[]");
  expect(BUILTIN_EXTENSION_TYPES.sparsevec).toBe("string");
  expect(BUILTIN_EXTENSION_TYPES.hstore).toBe("Record<string, string | null>");
  expect(BUILTIN_EXTENSION_TYPES.citext).toBe("string");
  expect(BUILTIN_EXTENSION_TYPES.ltree).toBe("string");
  expect(BUILTIN_EXTENSION_TYPES.lquery).toBe("string");
  expect(BUILTIN_EXTENSION_TYPES.ltxtquery).toBe("string");
});

test("mergeExtensionTypes returns a copy of built-ins when user config is missing", () => {
  const merged = mergeExtensionTypes();
  expect(merged.vector).toBe("number[]");
  merged.vector = "Float32Array";
  expect(BUILTIN_EXTENSION_TYPES.vector).toBe("number[]");
});

test("user customTypes override built-in defaults", () => {
  const merged = mergeExtensionTypes({ vector: "Float32Array", custom_thing: "MyType" });
  expect(merged.vector).toBe("Float32Array");
  expect(merged.custom_thing).toBe("MyType");
  expect(merged.hstore).toBe("Record<string, string | null>");
});
