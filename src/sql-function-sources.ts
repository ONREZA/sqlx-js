import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "libpg-query";
import type { SimilarityUnit } from "./query-similarity";

type JsonObject = Record<string, any>;

export type SqlFunctionCoverage = {
  files: number;
  discovered: number;
  proceduresSkipped: number;
  sql: number;
  plpgsql: number;
  other: number;
  analyzedSqlBodies: number;
  missingSqlBodies: number;
  ddlParseErrors: Array<{ source: string; message: string }>;
};

export type SqlFunctionExtraction = {
  units: SimilarityUnit[];
  coverage: SqlFunctionCoverage;
};

function parseMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sqlFiles(input: string): string[] {
  if (!statSync(input).isDirectory()) return [input];
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".sql")) out.push(path);
    }
  };
  walk(input);
  return out;
}

function stringNodeValue(value: unknown): string | null {
  const node = value as JsonObject | null;
  return typeof node?.String?.sval === "string" ? node.String.sval : null;
}

function optionValue(statement: JsonObject, name: string): unknown {
  const options = statement.CreateFunctionStmt?.options;
  if (!Array.isArray(options)) return undefined;
  return options.find((option) => option.DefElem?.defname === name)?.DefElem?.arg;
}

function functionName(statement: JsonObject): string {
  const parts = statement.CreateFunctionStmt?.funcname;
  if (!Array.isArray(parts)) return "unknown-function";
  return parts.map(stringNodeValue).filter((part): part is string => part !== null).join(".");
}

function functionBody(statement: JsonObject): string | null {
  const value = optionValue(statement, "as") as JsonObject | undefined;
  const body = value?.List?.items?.[0]?.String?.sval;
  return typeof body === "string" ? body : null;
}

function standardBodyStatements(statement: JsonObject): unknown[] {
  const body = statement.CreateFunctionStmt?.sql_body;
  const flatten = (value: unknown): unknown[] => {
    if (!value || typeof value !== "object") return [];
    const items = (value as JsonObject).List?.items;
    if (Array.isArray(items)) return items.flatMap(flatten);
    return [value];
  };
  return flatten(body);
}

function statementSource(source: string, statements: JsonObject[], index: number): string {
  const statement = statements[index]!;
  const start = typeof statement.stmt_location === "number" ? statement.stmt_location : 0;
  const length = typeof statement.stmt_len === "number" ? statement.stmt_len : 0;
  const next = statements[index + 1];
  const end = length > 0
    ? start + length
    : typeof next?.stmt_location === "number" ? next.stmt_location : source.length;
  return source.slice(start, end).trim();
}

function functionLanguage(statement: JsonObject): string {
  return (stringNodeValue(optionValue(statement, "language")) ?? "unknown").toLowerCase();
}

function functionParameterNames(statement: JsonObject): string[] {
  const parameters = statement.CreateFunctionStmt?.parameters;
  if (!Array.isArray(parameters)) return [];
  return parameters.flatMap((entry): string[] => {
    const parameter = entry.FunctionParameter;
    if (!parameter || typeof parameter.name !== "string") return [];
    if (parameter.mode === "FUNC_PARAM_OUT" || parameter.mode === "FUNC_PARAM_TABLE") return [];
    return [parameter.name];
  });
}

export async function extractSqlFunctionBodies(
  input: string,
  sourceRoot: string,
): Promise<SqlFunctionExtraction> {
  const files = sqlFiles(input);
  const coverage: SqlFunctionCoverage = {
    files: files.length,
    discovered: 0,
    proceduresSkipped: 0,
    sql: 0,
    plpgsql: 0,
    other: 0,
    analyzedSqlBodies: 0,
    missingSqlBodies: 0,
    ddlParseErrors: [],
  };
  const units: SimilarityUnit[] = [];
  for (const file of files) {
    const source = relative(sourceRoot, file).replace(/\\/g, "/");
    const ddl = readFileSync(file, "utf8");
    let parsed: JsonObject;
    try {
      parsed = await parse(ddl) as JsonObject;
    } catch (error) {
      coverage.ddlParseErrors.push({ source, message: parseMessage(error) });
      continue;
    }
    const statements = Array.isArray(parsed.stmts) ? parsed.stmts as JsonObject[] : [];
    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index]?.stmt as JsonObject | undefined;
      if (!statement?.CreateFunctionStmt) continue;
      if (statement.CreateFunctionStmt.is_procedure === true) {
        coverage.proceduresSkipped++;
        continue;
      }
      coverage.discovered++;
      const language = functionLanguage(statement);
      if (language === "sql") coverage.sql++;
      else if (language === "plpgsql") coverage.plpgsql++;
      else coverage.other++;
      if (language !== "sql") continue;
      const stringBody = functionBody(statement);
      const astStatements = standardBodyStatements(statement);
      if (!stringBody && astStatements.length === 0) {
        coverage.missingSqlBodies++;
        continue;
      }
      const name = functionName(statement);
      units.push({
        id: `function:${name}:${source}:${index}`,
        kind: "sql-function",
        label: name,
        sql: stringBody ?? statementSource(ddl, statements, index),
        sources: [source],
        parameterNames: functionParameterNames(statement),
        ...(astStatements.length > 0 ? { astStatements } : {}),
      });
      coverage.analyzedSqlBodies++;
    }
  }
  return { units, coverage };
}
