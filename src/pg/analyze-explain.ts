import type { AnalysisResult } from "./analyze-types";
import type { FieldDescription } from "./wire";

export function analyzeExplain(stmt: any, rowDesc: FieldDescription[]): AnalysisResult | undefined {
  let format = "text";
  for (const option of stmt.options ?? []) {
    const def = option.DefElem;
    if (def?.defname === "format") format = def.arg?.String?.sval;
  }
  const oid = new Map([["text", 25], ["json", 114], ["xml", 142], ["yaml", 25]]).get(format);
  const field = rowDesc[0];
  if (oid === undefined || rowDesc.length !== 1 || !field
    || field.name !== "QUERY PLAN" || field.typeOid !== oid
    || field.tableOid !== 0 || field.columnAttr !== 0) return undefined;
  return {
    perColumnNullable: [false],
    perColumnSources: [null],
    perColumnArrayElementNullability: ["unknown"],
    referencedTables: [],
  };
}
