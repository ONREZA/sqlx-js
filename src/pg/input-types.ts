import { arrayTsType } from "./oids";
import { canonicalCompositeFields, typeScriptPropertyName, type SchemaCache } from "./schema";

const JSON_OIDS = new Set([114, 3802]);

export const JSON_INPUT_TS = 'import("@onreza/sqlx-js").SqlxJson<unknown>';

export function jsonScalarOid(
  oid: number,
  schema: SchemaCache,
  seen = new Set<number>(),
): 114 | 3802 | undefined {
  if (oid === 114 || oid === 3802) return oid;
  if (seen.has(oid)) return undefined;
  seen.add(oid);
  const custom = schema.customType(oid);
  return custom?.kind === "scalar" && custom.baseOid
    ? jsonScalarOid(custom.baseOid, schema, seen)
    : undefined;
}

export function inputTsType(
  oid: number,
  schema: SchemaCache,
  seen = new Set<number>(),
): string {
  if (JSON_OIDS.has(oid)) return JSON_INPUT_TS;
  const array = schema.arrayElement(oid);
  if (array) {
    return arrayTsType(inputTsType(array.typeOid, schema, seen), array.nullability);
  }
  const custom = schema.customType(oid);
  if (custom?.kind === "scalar" && custom.baseOid) {
    return inputTsType(custom.baseOid, schema, seen);
  }
  if (custom?.kind !== "composite") return schema.tsType(oid);
  if (seen.has(oid)) return "unknown";
  seen.add(oid);
  const fields = canonicalCompositeFields(custom.fields).map((field) => {
    const type = field.typeOid === undefined
      ? field.tsType
      : inputTsType(field.typeOid, schema, seen);
    return `${typeScriptPropertyName(field.name)}: ${type}${field.nullable ? " | null" : ""}`;
  });
  seen.delete(oid);
  return fields.length === 0 ? "Record<string, unknown>" : `{ ${fields.join("; ")} }`;
}
