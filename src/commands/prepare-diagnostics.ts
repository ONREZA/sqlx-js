import { containsUnknownType } from "../type-inspection";
import { fingerprint, type CacheEntry } from "../cache";
import {
  functionContractDiagnostics,
  type FunctionEntry,
} from "../function-cache";
import { ScanError, type QueryCallSite } from "../scan/scanner";

export type PrepareDiagnosticPhase =
  | "config"
  | "connect"
  | "scan"
  | "describe"
  | "plan"
  | "result-shape"
  | "introspect"
  | "analyze"
  | "param-map"
  | "inference"
  | "intent"
  | "function-contract"
  | "cache"
  | "verify";

export class PrepareFatalError extends Error {
  public readonly file?: string;
  public readonly line?: number;
  public readonly column?: number;

  constructor(
    public readonly phase: PrepareDiagnosticPhase,
    message: string,
    location: { file?: string; line?: number; column?: number } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrepareFatalError";
    this.file = location.file;
    this.line = location.line;
    this.column = location.column;
  }
}

export function fatal(phase: PrepareDiagnosticPhase, error: unknown): PrepareFatalError {
  if (error instanceof PrepareFatalError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const location = error instanceof ScanError
    ? { file: error.file, line: error.line, column: error.column }
    : {};
  return new PrepareFatalError(phase, message, location, { cause: error });
}

export type PrepareDiagnostic = {
  severity: "error" | "warning";
  phase: PrepareDiagnosticPhase;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  query?: string;
  queryId?: string;
  queryName?: string;
  profile?: string;
  code?: string;
  position?: number;
  hint?: string;
  functionSignature?: string;
};

export function addFunctionContractDiagnostics(
  functions: readonly FunctionEntry[],
  diagnostics: PrepareDiagnostic[],
  report: (message: string) => void = () => {},
): void {
  for (const warning of functionContractDiagnostics(functions)) {
    const diagnostic: PrepareDiagnostic = {
      severity: "warning",
      phase: "function-contract",
      code: warning.code,
      functionSignature: warning.functionSignature,
      message: warning.message,
    };
    diagnostics.push(diagnostic);
    report(formatPrepareWarning(diagnostic));
  }
}

export function formatPrepareWarning(diagnostic: PrepareDiagnostic): string {
  const subject = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""}`
    : diagnostic.functionSignature;
  return `${diagnostic.phase} warning: ${subject ? `${subject} — ` : ""}${diagnostic.message}`
    + `${diagnostic.hint ? `. Hint: ${diagnostic.hint}` : ""}`;
}

export function reportQueryDiagnostics(
  diagnostics: readonly PrepareDiagnostic[],
  sites: readonly QueryCallSite[],
  report: (message: string) => void,
): boolean {
  for (const diagnostic of diagnostics) {
    const label = diagnostic.severity === "error"
      ? `${diagnostic.phase} failed`
      : `${diagnostic.phase} warning`;
    const site = sites.find((candidate) =>
      candidate.file === diagnostic.file
      && candidate.line === diagnostic.line
      && candidate.column === diagnostic.column
    ) ?? sites[0]!;
    report(
      `  ${label}: ${formatSite(site)} — ${diagnostic.message}`
      + `${diagnostic.hint ? `. Hint: ${diagnostic.hint}` : ""}`,
    );
  }
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function formatSite(s: QueryCallSite): string {
  const profile = s.profiles?.[0] ? ` [profile:${s.profiles[0]}]` : "";
  return `${s.file}:${s.line}:${s.column}${s.queryName ? ` [${s.queryName}]` : ""}${profile}`;
}

export function siteDiagnostic(site: QueryCallSite): Pick<
  PrepareDiagnostic,
  "file" | "line" | "column" | "query" | "queryId" | "queryName" | "profile"
> {
  return {
    file: site.file,
    line: site.line,
    column: site.column,
    query: site.query,
    queryId: fingerprint(site.query),
    ...(site.queryName ? { queryName: site.queryName } : {}),
    ...(site.profiles?.[0] ? { profile: site.profiles[0] } : {}),
  };
}

function inferenceIssues(entry: CacheEntry): string[] {
  const issues: string[] = [];
  if (entry.degraded) issues.push(`nullability inference degraded: ${entry.degraded.reason}`);
  entry.paramTsTypes.forEach((type, index) => {
    const parameter = entry.paramNames?.[index] ? `$${entry.paramNames[index]}` : `$${index + 1}`;
    if (containsUnknownType(type)) issues.push(`parameter ${parameter} resolved to ${type}`);
  });
  for (const column of entry.columns) {
    if (containsUnknownType(column.tsType)) {
      issues.push(`result column ${JSON.stringify(column.name)} resolved to ${column.tsType}`);
    }
  }
  return issues;
}

export function inferenceDiagnostics(
  entry: CacheEntry,
  site: QueryCallSite,
  strict: boolean,
): PrepareDiagnostic[] {
  return inferenceIssues(entry).map((message) => ({
    severity: strict ? "error" : "warning",
    phase: "inference",
    message,
    ...siteDiagnostic(site),
  }));
}

export function planningDiagnostic(
  entry: CacheEntry,
  site: QueryCallSite,
): PrepareDiagnostic | undefined {
  if (entry.validation !== "parse-only") return undefined;
  return {
    severity: "warning",
    phase: "plan",
    message: "statement is outside PostgreSQL's generic planning surface; validation is parse-only",
    ...siteDiagnostic(site),
  };
}

export function executionIntentDiagnostics(
  entry: CacheEntry,
  sites: readonly QueryCallSite[],
  strict: boolean,
): PrepareDiagnostic[] {
  const diagnostics: PrepareDiagnostic[] = [];
  for (const site of sites) {
    if ((site.cardinality === "one" || site.cardinality === "optional") && !entry.hasResultSet) {
      diagnostics.push({
        severity: "error",
        phase: "intent",
        message: `sql.${site.cardinality}() requires a statement with a result set`,
        hint: "Use sql.execute() for statements without RETURNING",
        ...siteDiagnostic(site),
      });
    } else if (site.cardinality === "many" && !entry.hasResultSet) {
      diagnostics.push({
        severity: strict ? "error" : "warning",
        phase: "intent",
        message: "sql() is discarding a command result without a result set",
        hint: "Use sql.execute() to make the execution intent explicit",
        ...siteDiagnostic(site),
      });
    } else if (site.cardinality === "execute" && entry.hasResultSet) {
      diagnostics.push({
        severity: "warning",
        phase: "intent",
        message: "sql.execute() is discarding rows returned by the statement",
        hint: "Use sql(), sql.one(), or sql.optional() when returned rows are intentional",
        ...siteDiagnostic(site),
      });
    }
  }
  return diagnostics;
}
