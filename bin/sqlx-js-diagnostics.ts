#!/usr/bin/env node

export {};

type Diagnostic = {
  severity: "error" | "warning";
  phase: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  profile?: string;
  functionSignature?: string;
};

type DiagnosticPayload = {
  formatVersion: number;
  ok: boolean;
  diagnostics: Diagnostic[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, name: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") throw new Error(`${name} must be a string`);
}

function optionalPosition(value: unknown, name: string): asserts value is number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1)) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function parsePayload(value: unknown): DiagnosticPayload {
  if (!isRecord(value) || value.formatVersion !== 1 || typeof value.ok !== "boolean" || !Array.isArray(value.diagnostics)) {
    throw new Error("expected sqlx-js diagnostic formatVersion 1");
  }
  const diagnostics = value.diagnostics.map((item, index): Diagnostic => {
    if (!isRecord(item)) throw new Error(`diagnostics[${index}] must be an object`);
    if (item.severity !== "error" && item.severity !== "warning") {
      throw new Error(`diagnostics[${index}].severity must be error or warning`);
    }
    if (typeof item.phase !== "string") throw new Error(`diagnostics[${index}].phase must be a string`);
    if (typeof item.message !== "string") throw new Error(`diagnostics[${index}].message must be a string`);
    optionalString(item.file, `diagnostics[${index}].file`);
    optionalString(item.code, `diagnostics[${index}].code`);
    optionalString(item.profile, `diagnostics[${index}].profile`);
    optionalString(item.functionSignature, `diagnostics[${index}].functionSignature`);
    optionalPosition(item.line, `diagnostics[${index}].line`);
    optionalPosition(item.column, `diagnostics[${index}].column`);
    return {
      severity: item.severity,
      phase: item.phase,
      message: item.message,
      ...(item.file !== undefined ? { file: item.file } : {}),
      ...(item.line !== undefined ? { line: item.line } : {}),
      ...(item.column !== undefined ? { column: item.column } : {}),
      ...(item.code !== undefined ? { code: item.code } : {}),
      ...(item.profile !== undefined ? { profile: item.profile } : {}),
      ...(item.functionSignature !== undefined ? { functionSignature: item.functionSignature } : {}),
    };
  });
  return { formatVersion: 1, ok: value.ok, diagnostics };
}

function githubData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function githubProperty(value: string): string {
  return githubData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function renderGithub(diagnostic: Diagnostic): string {
  const properties: string[] = [];
  if (diagnostic.file) properties.push(`file=${githubProperty(diagnostic.file)}`);
  if (diagnostic.line !== undefined) properties.push(`line=${diagnostic.line}`);
  if (diagnostic.column !== undefined) properties.push(`col=${diagnostic.column}`);
  const propertyText = properties.length > 0 ? ` ${properties.join(",")}` : "";
  const profile = diagnostic.profile ? ` profile:${diagnostic.profile}` : "";
  const code = diagnostic.code ? ` ${diagnostic.code}` : "";
  const subject = diagnostic.functionSignature ? `${diagnostic.functionSignature}: ` : "";
  return `::${diagnostic.severity}${propertyText}::${githubData(`[${diagnostic.phase}${profile}${code}] ${subject}${diagnostic.message}`)}`;
}

function renderUnix(diagnostic: Diagnostic): string {
  const clean = (value: string) => value.replace(/[\r\n]+/g, " ");
  const file = clean(diagnostic.file ?? "<project>");
  const line = diagnostic.line ?? 1;
  const column = diagnostic.column ?? 1;
  const profile = diagnostic.profile ? ` profile:${clean(diagnostic.profile)}` : "";
  const code = diagnostic.code ? ` ${clean(diagnostic.code)}` : "";
  const subject = diagnostic.functionSignature ? `${clean(diagnostic.functionSignature)}: ` : "";
  return `${file}:${line}:${column}: ${diagnostic.severity}: [${clean(diagnostic.phase)}${profile}${code}] ${subject}${clean(diagnostic.message)}`;
}

function usage(): never {
  console.log("usage: sqlx-js-diagnostics github|unix < prepare-diagnostics.json");
  process.exit(0);
}

const format = process.argv[2];
if (format === "--help" || format === "-h") usage();
if (format !== "github" && format !== "unix") {
  console.error("sqlx-js-diagnostics: expected output format github or unix");
  process.exit(2);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;

let payload: DiagnosticPayload;
try {
  payload = parsePayload(JSON.parse(input));
} catch (error) {
  console.error(`sqlx-js-diagnostics: ${(error as Error).message}`);
  process.exit(2);
}

for (const diagnostic of payload.diagnostics) {
  console.log(format === "github" ? renderGithub(diagnostic) : renderUnix(diagnostic));
}
process.exit(payload.ok ? 0 : 1);
