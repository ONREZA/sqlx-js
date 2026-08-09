import { describe, expect, test } from "bun:test";
import { inputTsType } from "../src/pg/input-types";
import { compositeLiteral, type CompositeInfo, type SchemaCache } from "../src/pg/schema";

describe("compositeLiteral", () => {
  test("renders fields with per-field nullability", () => {
    const info: CompositeInfo = {
      kind: "composite",
      name: "addr",
      fields: [
        { name: "street", tsType: "string", nullable: false },
        { name: "zip", tsType: "number", nullable: true },
      ],
    };
    expect(compositeLiteral(info)).toBe("{ street: string; zip: number | null }");
  });

  test("quotes non-identifier field names", () => {
    const info: CompositeInfo = {
      kind: "composite",
      name: "x",
      fields: [{ name: "weird-name", tsType: "number", nullable: false }],
    };
    expect(compositeLiteral(info)).toBe('{ "weird-name": number }');
  });

  test("canonicalizes structural result and input shapes without changing physical field order", () => {
    const info: CompositeInfo = {
      kind: "composite",
      name: "addr",
      fields: [
        { name: "zip", tsType: "number", nullable: true },
        { name: "street", tsType: "string", nullable: false },
      ],
    };
    const schema = {
      arrayElement: () => undefined,
      customType: (oid: number) => oid === 9_001 ? info : undefined,
      tsType: () => "unknown",
    } as unknown as SchemaCache;

    expect(compositeLiteral(info)).toBe("{ street: string; zip: number | null }");
    expect(inputTsType(9_001, schema)).toBe("{ street: string; zip: number | null }");
    expect(info.fields.map((field) => field.name)).toEqual(["zip", "street"]);
  });

  test("empty composite falls back to a record type", () => {
    expect(compositeLiteral({ kind: "composite", name: "e", fields: [] })).toBe("Record<string, unknown>");
  });
});
