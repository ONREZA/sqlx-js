import { describe, expect, test } from "bun:test";
import { compositeLiteral, type CompositeInfo } from "../src/pg/schema";

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

  test("empty composite falls back to a record type", () => {
    expect(compositeLiteral({ kind: "composite", name: "e", fields: [] })).toBe("Record<string, unknown>");
  });
});
