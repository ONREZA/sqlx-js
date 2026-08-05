import type { ExactDuplicateIgnore, QueryAuditConfig } from "./config";
import { queryId } from "./query-id";
import type { QueryExecutionMode, QueryResultAssertions } from "./query";
import type { QueryCallSite } from "./scan/scanner";

export type ExactQueryAuditSite = {
  file: string;
  line: number;
  column: number;
  origin: QueryCallSite["origin"];
  kind: QueryCallSite["kind"];
  cardinality: QueryExecutionMode;
  queryName: string | null;
  profiles: string[];
  sqlFilePath: string | null;
  nullableParams: number[];
  resultAssertions: QueryResultAssertions;
  expectedValidation: "parse-only" | null;
  timestampWithoutTimeZone: "allow" | "reject" | null;
  temporalReason: string | null;
};

export type ExactQueryContractDivergence =
  | "cardinality"
  | "profiles"
  | "nullable-parameters"
  | "result-assertions"
  | "expected-validation"
  | "temporal-policy";

export type ExactQuerySourceContract = {
  cardinality: QueryExecutionMode;
  profiles: string[];
  nullableParams: number[];
  resultAssertions: QueryResultAssertions;
  expectedValidation: "parse-only" | null;
  timestampWithoutTimeZone: "allow" | "reject" | null;
  temporalReason: string | null;
  occurrences: number;
  sites: string[];
};

export type ExactQueryCandidate = {
  queryId: string;
  query: string;
  sourceTextVariants: string[];
  queryNames: string[];
  classification: "definition-only" | "execution-only" | "mixed";
  occurrenceCount: number;
  status: "active" | "ignored";
  ignore?: ExactDuplicateIgnore;
  divergences: ExactQueryContractDivergence[];
  contracts: ExactQuerySourceContract[];
  callSites: ExactQueryAuditSite[];
};

export type QueryNameCollision = {
  queryName: string;
  queryIds: string[];
  definitions: Array<{
    queryId: string;
    file: string;
    line: number;
    column: number;
    cardinality: QueryExecutionMode;
    profiles: string[];
  }>;
};

export type StaleExactDuplicateIgnore = ExactDuplicateIgnore & {
  actualOccurrences: number | null;
  staleReason: "query-not-found" | "no-longer-duplicate" | "occurrence-count-changed";
};

export type ExactQueryAuditReport = {
  formatVersion: 1;
  ok: true;
  kind: "exact-query-reuse";
  advisory: true;
  summary: {
    sourceSites: number;
    uniqueQueries: number;
    possibleDuplicates: number;
    activePossibleDuplicates: number;
    ignoredPossibleDuplicates: number;
    contractDivergences: number;
    queryNameCollisions: number;
    staleIgnores: number;
    reviewRequired: boolean;
  };
  candidates: ExactQueryCandidate[];
  queryNameCollisions: QueryNameCollision[];
  staleIgnores: StaleExactDuplicateIgnore[];
};

function normalizeAssertions(assertions: QueryResultAssertions | undefined): QueryResultAssertions {
  return Object.fromEntries(
    Object.entries(assertions ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function auditSite(site: QueryCallSite): ExactQueryAuditSite {
  return {
    file: site.file,
    line: site.line,
    column: site.column,
    origin: site.origin,
    kind: site.kind,
    cardinality: site.cardinality ?? "many",
    queryName: site.queryName ?? null,
    profiles: [...(site.profiles ?? [])].sort(),
    sqlFilePath: site.sqlFilePath ?? null,
    nullableParams: [...(site.nullableParams ?? [])].sort((a, b) => a - b),
    resultAssertions: normalizeAssertions(site.resultAssertions),
    expectedValidation: site.expectedValidation ?? null,
    timestampWithoutTimeZone: site.timestampWithoutTimeZone ?? null,
    temporalReason: site.temporalReason ?? null,
  };
}

function compareSites(left: QueryCallSite, right: QueryCallSite): number {
  return left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column;
}

function sourceContract(site: ExactQueryAuditSite): Omit<ExactQuerySourceContract, "occurrences" | "sites"> {
  return {
    cardinality: site.cardinality,
    profiles: site.profiles,
    nullableParams: site.nullableParams,
    resultAssertions: site.resultAssertions,
    expectedValidation: site.expectedValidation,
    timestampWithoutTimeZone: site.timestampWithoutTimeZone,
    temporalReason: site.temporalReason,
  };
}

function contractGroups(sites: readonly ExactQueryAuditSite[]): ExactQuerySourceContract[] {
  const groups = new Map<string, ExactQuerySourceContract>();
  for (const site of sites) {
    const contract = sourceContract(site);
    const key = JSON.stringify(contract);
    const existing = groups.get(key) ?? { ...contract, occurrences: 0, sites: [] };
    existing.occurrences++;
    existing.sites.push(`${site.file}:${site.line}:${site.column}`);
    groups.set(key, existing);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, contract]) => contract);
}

function contractDivergences(contracts: readonly ExactQuerySourceContract[]): ExactQueryContractDivergence[] {
  const different = <T>(select: (contract: ExactQuerySourceContract) => T): boolean =>
    new Set(contracts.map((contract) => JSON.stringify(select(contract)))).size > 1;
  const out: ExactQueryContractDivergence[] = [];
  if (different((contract) => contract.cardinality)) out.push("cardinality");
  if (different((contract) => contract.profiles)) out.push("profiles");
  if (different((contract) => contract.nullableParams)) out.push("nullable-parameters");
  if (different((contract) => contract.resultAssertions)) out.push("result-assertions");
  if (different((contract) => contract.expectedValidation)) out.push("expected-validation");
  if (different((contract) => [contract.timestampWithoutTimeZone, contract.temporalReason])) {
    out.push("temporal-policy");
  }
  return out;
}

function originClassification(sites: readonly QueryCallSite[]): ExactQueryCandidate["classification"] {
  const origins = new Set(sites.map((site) => site.origin));
  if (origins.size > 1) return "mixed";
  return origins.has("definition") ? "definition-only" : "execution-only";
}

function queryNameCollisions(sites: readonly QueryCallSite[]): QueryNameCollision[] {
  const byName = new Map<string, QueryCallSite[]>();
  for (const site of sites) {
    if (!site.queryName) continue;
    const group = byName.get(site.queryName) ?? [];
    group.push(site);
    byName.set(site.queryName, group);
  }
  return [...byName.entries()].flatMap(([queryName, definitions]): QueryNameCollision[] => {
    const ids = [...new Set(definitions.map((site) => queryId(site.query)))].sort();
    if (ids.length < 2) return [];
    return [{
      queryName,
      queryIds: ids,
      definitions: [...definitions].sort(compareSites).map((site) => ({
        queryId: queryId(site.query),
        file: site.file,
        line: site.line,
        column: site.column,
        cardinality: site.cardinality ?? "many",
        profiles: [...(site.profiles ?? [])].sort(),
      })),
    }];
  }).sort((left, right) => left.queryName.localeCompare(right.queryName));
}

export function buildExactQueryAudit(
  sites: readonly QueryCallSite[],
  config: QueryAuditConfig = {},
): ExactQueryAuditReport {
  const grouped = new Map<string, QueryCallSite[]>();
  for (const site of sites) {
    const id = queryId(site.query);
    const group = grouped.get(id) ?? [];
    group.push(site);
    grouped.set(id, group);
  }
  const ignores = config.exactDuplicates?.ignore ?? [];
  const ignoreById = new Map(ignores.map((ignore) => [ignore.queryId, ignore]));
  const candidates = [...grouped.entries()].flatMap(([id, unsorted]): ExactQueryCandidate[] => {
    if (unsorted.length < 2) return [];
    const sourceSites = [...unsorted].sort(compareSites);
    const callSites = sourceSites.map(auditSite);
    const contracts = contractGroups(callSites);
    const ignore = ignoreById.get(id);
    const matchedIgnore = ignore?.occurrences === sourceSites.length ? ignore : undefined;
    return [{
      queryId: id,
      query: sourceSites[0]!.query,
      sourceTextVariants: [...new Set(sourceSites.map((site) => site.query))].sort(),
      queryNames: [...new Set(sourceSites.flatMap((site) => site.queryName ? [site.queryName] : []))].sort(),
      classification: originClassification(sourceSites),
      occurrenceCount: sourceSites.length,
      status: matchedIgnore ? "ignored" : "active",
      ...(matchedIgnore ? { ignore: matchedIgnore } : {}),
      divergences: contractDivergences(contracts),
      contracts,
      callSites,
    }];
  }).sort((left, right) => left.queryId.localeCompare(right.queryId));
  const staleIgnores = ignores.flatMap((ignore): StaleExactDuplicateIgnore[] => {
    const actual = grouped.get(ignore.queryId)?.length;
    if (actual === undefined) {
      return [{ ...ignore, actualOccurrences: null, staleReason: "query-not-found" }];
    }
    if (actual < 2) {
      return [{ ...ignore, actualOccurrences: actual, staleReason: "no-longer-duplicate" }];
    }
    if (actual !== ignore.occurrences) {
      return [{ ...ignore, actualOccurrences: actual, staleReason: "occurrence-count-changed" }];
    }
    return [];
  }).sort((left, right) => left.queryId.localeCompare(right.queryId));
  const collisions = queryNameCollisions(sites);
  const active = candidates.filter((candidate) => candidate.status === "active").length;
  const ignored = candidates.length - active;
  return {
    formatVersion: 1,
    ok: true,
    kind: "exact-query-reuse",
    advisory: true,
    summary: {
      sourceSites: sites.length,
      uniqueQueries: grouped.size,
      possibleDuplicates: candidates.length,
      activePossibleDuplicates: active,
      ignoredPossibleDuplicates: ignored,
      contractDivergences: candidates.filter((candidate) => candidate.divergences.length > 0).length,
      queryNameCollisions: collisions.length,
      staleIgnores: staleIgnores.length,
      reviewRequired: active > 0 || collisions.length > 0 || staleIgnores.length > 0,
    },
    candidates,
    queryNameCollisions: collisions,
    staleIgnores,
  };
}
