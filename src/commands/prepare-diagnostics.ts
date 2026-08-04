import { containsUnknownType } from "../type-inspection";
import { fingerprint, type CacheEntry } from "../cache";
import {
  functionContractDiagnostics,
  type FunctionEntry,
} from "../function-cache";
import { ScanError, type QueryCallSite } from "../scan/scanner";
import { resolveTemporalPolicy, type TemporalPolicyOptions } from "../temporal";

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
  | "temporal"
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
    report(formatPrepareDiagnostic(diagnostic));
  }
}

export function formatPrepareDiagnostic(diagnostic: PrepareDiagnostic): string {
  const location = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""}`
    : diagnostic.functionSignature;
  const qualifiers = [
    diagnostic.queryName ? `[${diagnostic.queryName}]` : "",
    diagnostic.profile ? `[profile:${diagnostic.profile}]` : "",
    diagnostic.queryId ? `[query:${diagnostic.queryId}]` : "",
  ].filter(Boolean).join(" ");
  const subject = [location, qualifiers].filter(Boolean).join(" ");
  const label = diagnostic.severity === "warning"
    ? `${diagnostic.phase} warning`
    : `${diagnostic.phase} failed`;
  const metadata = [
    diagnostic.position === undefined ? "" : `pos ${diagnostic.position}`,
    diagnostic.code ? `code ${diagnostic.code}` : "",
  ].filter(Boolean);
  const query = diagnostic.severity === "error" && diagnostic.query
    ? `\n  query: ${formatQuerySnippet(diagnostic.query)}`
    : "";
  return `${label}: ${subject ? `${subject} — ` : ""}${diagnostic.message}`
    + `${metadata.length > 0 ? ` (${metadata.join(", ")})` : ""}`
    + `${diagnostic.hint ? `. Hint: ${diagnostic.hint}` : ""}`
    + query;
}

export function formatPrepareDiagnosticCounts(
  diagnostics: readonly PrepareDiagnostic[],
): string {
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  return `${formatSeverityCount("warning", warnings)}, ${formatSeverityCount("error", errors)}`;
}

function formatSeverityCount(
  severity: "warning" | "error",
  diagnostics: readonly PrepareDiagnostic[],
): string {
  const byPhase = new Map<PrepareDiagnosticPhase, number>();
  for (const diagnostic of diagnostics) {
    byPhase.set(diagnostic.phase, (byPhase.get(diagnostic.phase) ?? 0) + 1);
  }
  const phases = [...byPhase.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([phase, count]) => `${phase}: ${count}`)
    .join(", ");
  const label = diagnostics.length === 1 ? severity : `${severity}s`;
  return `${diagnostics.length} ${label}${phases ? ` (${phases})` : ""}`;
}

export function reportPrepareDiagnostics(
  diagnostics: readonly PrepareDiagnostic[],
  showWarnings = false,
  report: (message: string) => void = console.error,
): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "warning" && !showWarnings) continue;
    report(formatPrepareDiagnostic(diagnostic));
  }
}

export function formatPrepareTotals(
  result: { sites: number; entries: number; functions: number; enums: number },
): string {
  return `${formatQueryTotals(result.sites, result.entries)}, `
    + `${result.functions} ${result.functions === 1 ? "function" : "functions"}, `
    + `${result.enums} ${result.enums === 1 ? "enum" : "enums"}`;
}

export function formatQueryTotals(sites: number, entries: number): string {
  return `${formatUniqueQueries(entries)}, ${sites} source ${sites === 1 ? "site" : "sites"}`;
}

function formatUniqueQueries(count: number): string {
  return `${count} unique ${count === 1 ? "query" : "queries"}`;
}

export function withOutputHints(
  message: string,
  diagnostics: readonly PrepareDiagnostic[],
  showWarnings = false,
): string {
  const hints = [];
  if (!showWarnings && diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    hints.push("use --warnings to show warning details");
  }
  hints.push("use --verbose for per-query progress");
  return `${message}; ${hints.length === 1 ? "hint" : "hints"}: ${hints.join("; ")}`;
}

export function formatQuerySnippet(query: string, max = 80): string {
  const oneLine = query.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
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
      `  ${label}: ${formatSite(site)}${diagnostic.queryId ? ` [query:${diagnostic.queryId}]` : ""} — ${diagnostic.message}`
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

export function temporalPolicyDiagnostics(
  entry: CacheEntry,
  sites: readonly QueryCallSite[],
  policy: TemporalPolicyOptions | undefined,
): PrepareDiagnostic[] {
  if (!entry.usesTimestampWithoutTimeZone) return [];
  const defaultMode = resolveTemporalPolicy(policy).timestampWithoutTimeZone;
  return sites.flatMap((site) => {
    const mode = site.timestampWithoutTimeZone ?? defaultMode;
    if (mode === "allow") return [];
    return [{
      severity: "error" as const,
      phase: "temporal" as const,
      code: "SQLXJS_TIMESTAMP_WITHOUT_TIME_ZONE",
      message: "query I/O uses PostgreSQL timestamp without time zone, including through a parameter-mapped column, array, domain, range, multirange, or composite",
      hint: "Use timestamptz for instants. For intentional wall-clock data, use a named defineQuery() with temporal.timestampWithoutTimeZone: { allow: true, reason: \"...\" }.",
      ...siteDiagnostic(site),
    }];
  });
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

export function planningDiagnostics(
  validation: CacheEntry["validation"],
  sites: readonly QueryCallSite[],
  strict = false,
): PrepareDiagnostic[] {
  if (validation === "parse-only") {
    const site = sites.find((candidate) => candidate.expectedValidation !== "parse-only");
    return site
      ? [{
        severity: strict ? "error" : "warning",
        phase: "plan",
        message: "statement is outside PostgreSQL's generic planning surface; validation is parse-only",
        ...siteDiagnostic(site),
      }]
      : [];
  }
  const stale = sites.find((candidate) => candidate.expectedValidation === "parse-only");
  return stale
    ? [{
      severity: "warning",
      phase: "plan",
      message: "statement is now planned; remove the stale expectedValidation: \"parse-only\" source contract",
      ...siteDiagnostic(stale),
    }]
    : [];
}

export function planningValidationTag(
  validation: CacheEntry["validation"],
  sites: readonly QueryCallSite[],
): string {
  if (validation !== "parse-only") return "";
  return sites.every((site) => site.expectedValidation === "parse-only")
    ? " [parse-only acknowledged]"
    : " [parse-only]";
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
