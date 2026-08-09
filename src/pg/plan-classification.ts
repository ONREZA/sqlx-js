import { parse } from "libpg-query";
import type { PlanValidation } from "./wire";

const PLANNABLE_STATEMENTS = new Set([
  "DeleteStmt",
  "InsertStmt",
  "MergeStmt",
  "SelectStmt",
  "UpdateStmt",
]);

export async function classifyPlanValidation(sql: string): Promise<PlanValidation | undefined> {
  try {
    const parsed = await parse(sql);
    if (parsed.stmts.length !== 1) return undefined;
    const statement = parsed.stmts[0]?.stmt;
    if (!statement || typeof statement !== "object") return undefined;
    const statementType = Object.keys(statement)[0];
    if (statementType === "SelectStmt" && statement.SelectStmt?.intoClause) {
      return "parse-only";
    }
    return statementType && PLANNABLE_STATEMENTS.has(statementType) ? "planned" : "parse-only";
  } catch {
    return undefined;
  }
}
