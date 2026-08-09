import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { SqlxJsConfig } from "../config";
import { buildExactQueryAudit, type ExactQueryAuditReport, type ExactQueryAuditSite } from "../query-audit";
import { queryId } from "../query-id";
import { buildQuerySourceCatalog, querySourceLocation } from "../query-source-catalog";
import {
  analyzeSimilarityUnits,
  type SimilarityCandidate,
  type SimilarityParseError,
  type SimilarityUnit,
} from "../query-similarity";
import type { QueryCallSite } from "../scan/scanner";
import { extractSqlFunctionBodies, type SqlFunctionCoverage } from "../sql-function-sources";
import { loadQuerySources, QueriesError } from "./queries";

type ApplicationQueryCoverage = {
  sourceSites: number;
  uniqueQueries: number;
  repeatedFingerprints: number;
  repeatedSourceSites: number;
  definitionOnly: number;
  executionOnly: number;
  mixedOrigins: number;
};

export type QuerySimilarityReport = {
  formatVersion: 1;
  ok: true;
  complete: boolean;
  kind: "ast-query-similarity";
  advisory: true;
  experimental: true;
  parameters: {
    minNodes: number;
    limit: number;
    functionSource: {
      path: string;
      origin: "cli" | "schema";
    } | null;
  };
  normalization: {
    locations: "ignored";
    parameterPositions: "alpha-renamed-with-identity-preserved";
    functionParameterReferences: "parameterized";
    literalValues: "ignored-with-kind-preserved";
    identifiers: "preserved";
  };
  coverage: {
    applicationQueries: ApplicationQueryCoverage;
    functions: SqlFunctionCoverage | null;
    parsedUnits: number;
    parsedStatements: number;
    parseErrors: SimilarityParseError[];
    fragmentUnitOccurrences: number;
    rawCandidateGroups: number;
    candidateGroups: number;
    returnedCandidates: number;
  };
  candidates: SimilarityCandidate[];
};

function applicationQueryUnits(sites: readonly QueryCallSite[]): {
  units: SimilarityUnit[];
  coverage: ApplicationQueryCoverage;
} {
  const catalog = buildQuerySourceCatalog(sites);
  const units = catalog.map(({ queryId: id, query, sites: group }): SimilarityUnit => {
    const names = [...new Set(group.flatMap((site) => site.queryName ? [site.queryName] : []))].sort();
    return {
      id: `query:${id}`,
      kind: "application-query",
      label: names.length > 0 ? names.join(", ") : id,
      sql: query,
      sources: group.map(querySourceLocation),
    };
  });
  const repeated = catalog.map((group) => group.sites).filter((group) => group.length > 1);
  return {
    units,
    coverage: {
      sourceSites: sites.length,
      uniqueQueries: units.length,
      repeatedFingerprints: repeated.length,
      repeatedSourceSites: repeated.reduce((total, group) => total + group.length, 0),
      definitionOnly: repeated.filter((group) => group.every((site) => site.origin === "definition")).length,
      executionOnly: repeated.filter((group) => group.every((site) => site.origin === "execution")).length,
      mixedOrigins: repeated.filter((group) => new Set(group.map((site) => site.origin)).size > 1).length,
    },
  };
}

function configuredFunctionSource(
  root: string,
  config: SqlxJsConfig,
  explicit: string | undefined,
): { absolute: string; path: string; origin: "cli" | "schema" } | null {
  const origin = explicit !== undefined ? "cli" : "schema";
  const input = explicit ?? (config.schema?.provider === "pgschema" ? config.schema.file ?? "schema.sql" : undefined);
  if (input === undefined) return null;
  if (input.trim() === "") {
    throw new QueriesError("functions", "function source must be a non-empty root-relative path");
  }
  if (isAbsolute(input)) {
    throw new QueriesError("functions", `function source must be root-relative, got ${JSON.stringify(input)}`);
  }
  const absolute = resolve(root, input);
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new QueriesError("functions", `function source escapes --root: ${input}`);
  }
  if (!existsSync(absolute)) {
    throw new QueriesError("functions", `function source not found: ${input}`);
  }
  return { absolute, path: fromRoot.replace(/\\/g, "/"), origin };
}

export async function buildExactQueryAuditReport(root: string): Promise<ExactQueryAuditReport> {
  const { config, sites } = await loadQuerySources(root);
  return buildExactQueryAudit(sites, config.queryAudit);
}

export async function buildQuerySimilarityReport(options: {
  root: string;
  functionsPath?: string;
  minNodes?: number;
  limit?: number;
}): Promise<QuerySimilarityReport> {
  const minNodes = options.minNodes ?? 12;
  const limit = options.limit ?? 50;
  if (!Number.isInteger(minNodes) || minNodes < 1) {
    throw new QueriesError("similarity", "--min-nodes must be a positive integer");
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new QueriesError("similarity", "--limit must be a positive integer");
  }
  const { config, sites } = await loadQuerySources(options.root);
  const queries = applicationQueryUnits(sites);
  const functionSource = configuredFunctionSource(options.root, config, options.functionsPath);
  let functions: Awaited<ReturnType<typeof extractSqlFunctionBodies>> | null = null;
  if (functionSource) {
    try {
      functions = await extractSqlFunctionBodies(functionSource.absolute, options.root);
    } catch (error) {
      throw new QueriesError(
        "functions",
        error instanceof Error ? error.message : String(error),
        undefined,
        undefined,
        undefined,
        { cause: error },
      );
    }
  }
  const analysis = await analyzeSimilarityUnits(
    [...queries.units, ...(functions?.units ?? [])],
    { minNodes, limit },
  );
  const complete = analysis.parseErrors.length === 0
    && (functions?.coverage.ddlParseErrors.length ?? 0) === 0
    && (functions?.coverage.missingSqlBodies ?? 0) === 0;
  return {
    formatVersion: 1,
    ok: true,
    complete,
    kind: "ast-query-similarity",
    advisory: true,
    experimental: true,
    parameters: {
      minNodes,
      limit,
      functionSource: functionSource
        ? { path: functionSource.path, origin: functionSource.origin }
        : null,
    },
    normalization: {
      locations: "ignored",
      parameterPositions: "alpha-renamed-with-identity-preserved",
      functionParameterReferences: "parameterized",
      literalValues: "ignored-with-kind-preserved",
      identifiers: "preserved",
    },
    coverage: {
      applicationQueries: queries.coverage,
      functions: functions?.coverage ?? null,
      parsedUnits: analysis.parsedUnits,
      parsedStatements: analysis.parsedStatements,
      parseErrors: analysis.parseErrors,
      fragmentUnitOccurrences: analysis.fragmentUnitOccurrences,
      rawCandidateGroups: analysis.rawCandidateGroups,
      candidateGroups: analysis.candidateGroups,
      returnedCandidates: analysis.candidates.length,
    },
    candidates: analysis.candidates,
  };
}

function siteContract(site: ExactQueryAuditSite): string {
  const parts: string[] = [site.origin, site.cardinality];
  if (site.queryName) parts.push(`name=${site.queryName}`);
  if (site.profiles.length > 0) parts.push(`profiles=${site.profiles.join(",")}`);
  if (site.nullableParams.length > 0) parts.push(`nullableParams=${site.nullableParams.join(",")}`);
  if (Object.keys(site.resultAssertions).length > 0) {
    parts.push(`resultAssertions=${Object.keys(site.resultAssertions).join(",")}`);
  }
  if (site.expectedValidation) parts.push(`validation=${site.expectedValidation}`);
  if (site.timestampWithoutTimeZone) parts.push(`timestamp=${site.timestampWithoutTimeZone}`);
  return parts.join(" ");
}

function printExactQueryAudit(report: ExactQueryAuditReport): void {
  console.log(
    `possible exact duplicates: ${report.summary.possibleDuplicates} `
    + `(${report.summary.activePossibleDuplicates} active, ${report.summary.ignoredPossibleDuplicates} ignored)`,
  );
  for (const candidate of report.candidates) {
    console.log(
      `${candidate.queryId} duplicate=${candidate.duplicateStatus} `
      + `review=${candidate.reviewRequired ? "required" : "acknowledged"} `
      + `${candidate.classification} occurrences=${candidate.occurrenceCount}`
      + `${candidate.divergences.length > 0 ? ` divergences=${candidate.divergences.join(",")}` : ""}`,
    );
    if (candidate.ignore) console.log(`  ignore: ${candidate.ignore.reason}`);
    for (const site of candidate.callSites) {
      console.log(`  ${site.file}:${site.line}:${site.column} ${siteContract(site)}`);
    }
  }
  for (const collision of report.queryNameCollisions) {
    console.log(`query-name collision: ${collision.queryName} queryIds=${collision.queryIds.join(",")}`);
    for (const definition of collision.definitions) {
      console.log(`  ${definition.file}:${definition.line}:${definition.column} ${definition.queryId}`);
    }
  }
  for (const ignore of report.staleIgnores) {
    console.log(
      `stale ignore: ${ignore.queryId} ${ignore.staleReason} `
      + `configured=${ignore.occurrences} actual=${ignore.actualOccurrences ?? "missing"} reason=${ignore.reason}`,
    );
  }
  if (
    report.candidates.length === 0
    && report.queryNameCollisions.length === 0
    && report.staleIgnores.length === 0
  ) {
    console.log("no possible exact query duplicates or query-name collisions found");
  }
}

function printQuerySimilarity(report: QuerySimilarityReport): void {
  console.log(
    `experimental similarity ${report.complete ? "complete" : "partial"}: `
    + `${report.coverage.returnedCandidates} candidates returned, `
    + `${report.coverage.candidateGroups} families, ${report.coverage.parsedUnits} parsed units`,
  );
  if (report.coverage.functions) {
    const functions = report.coverage.functions;
    console.log(
      `functions: ${functions.analyzedSqlBodies} SQL analyzed, ${functions.plpgsql} plpgsql skipped, `
      + `${functions.other} other-language skipped, ${functions.proceduresSkipped} procedures skipped, `
      + `${functions.missingSqlBodies} SQL bodies missing, ${functions.ddlParseErrors.length} DDL parse errors`,
    );
  }
  for (const candidate of report.candidates) {
    console.log(
      `${candidate.id} score=${candidate.score} ${candidate.scope} ${candidate.nodeType} `
      + `nodes=${candidate.nodeCount} units=${candidate.unitCount}`,
    );
    if (candidate.identifiers.length > 0) console.log(`  identifiers: ${candidate.identifiers.join(", ")}`);
    for (const occurrence of candidate.occurrences) {
      console.log(`  ${occurrence.kind} ${occurrence.label}: ${occurrence.sources.join(", ")}`);
    }
  }
  if (report.candidates.length === 0) console.log("no AST similarity candidates found");
  for (const error of report.coverage.functions?.ddlParseErrors ?? []) {
    console.log(`skipped DDL ${error.source}: ${error.message}`);
  }
  for (const error of report.coverage.parseErrors) {
    console.log(`skipped SQL ${error.label}: ${error.message}`);
  }
}

export async function runExactQueryAudit(options: { root: string; json?: boolean }): Promise<void> {
  const report = await buildExactQueryAuditReport(options.root);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printExactQueryAudit(report);
}

export async function runQuerySimilarities(options: {
  root: string;
  json?: boolean;
  functionsPath?: string;
  minNodes?: number;
  limit?: number;
}): Promise<void> {
  const report = await buildQuerySimilarityReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printQuerySimilarity(report);
}
