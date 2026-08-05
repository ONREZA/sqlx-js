import { createHash } from "node:crypto";
import { parse } from "libpg-query";
import { rewriteNamedParameters } from "./sql-params";

type JsonObject = Record<string, any>;

export type SimilarityUnit = {
  id: string;
  kind: "application-query" | "sql-function";
  label: string;
  sql: string;
  sources: string[];
  parameterNames?: string[];
};

export type SimilarityCandidate = {
  id: string;
  nodeType: string;
  nodeCount: number;
  score: number;
  scope: "query-query" | "query-function" | "function-function";
  unitCount: number;
  identifiers: string[];
  relatedFragmentCount: number;
  relatedNodeTypes: string[];
  occurrences: Array<{
    unitId: string;
    kind: SimilarityUnit["kind"];
    label: string;
    sources: string[];
    path: string;
    sqlPreview: string;
  }>;
};

export type SimilarityParseError = {
  unitId: string;
  label: string;
  message: string;
};

export type SimilarityAnalysis = {
  parsedUnits: number;
  parsedStatements: number;
  fragmentUnitOccurrences: number;
  rawCandidateGroups: number;
  candidateGroups: number;
  parseErrors: SimilarityParseError[];
  candidates: SimilarityCandidate[];
};

type FragmentOccurrence = {
  unit: SimilarityUnit;
  path: string;
};

type FragmentGroup = {
  digest: string;
  nodeType: string;
  nodeCount: number;
  identifiers: string[];
  occurrencesByUnit: Map<string, FragmentOccurrence>;
};

type DigestResult = {
  digest: string;
  nodeCount: number;
  identifiers: string[];
};

const LOCATION_KEYS = new Set(["location", "stmt_location", "stmt_len"]);
const FRAGMENT_TYPES = new Set([
  "A_Expr",
  "BoolExpr",
  "CaseExpr",
  "CoalesceExpr",
  "CommonTableExpr",
  "DeleteStmt",
  "FuncCall",
  "InsertStmt",
  "JoinExpr",
  "MergeStmt",
  "OnConflictClause",
  "ResTarget",
  "SelectStmt",
  "SubLink",
  "UpdateStmt",
  "WithClause",
]);
const RAW_IDENTIFIER_KEYS = new Set([
  "aliasname",
  "catalogname",
  "colname",
  "ctename",
  "name",
  "relname",
  "schemaname",
]);

function digest(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function astNodeType(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !/^[A-Z][A-Za-z0-9_]*$/.test(keys[0]!)) return null;
  return keys[0]!;
}

function mergeIdentifiers(groups: readonly string[][]): string[] {
  const out = new Set<string>();
  for (const group of groups) {
    for (const identifier of group) {
      if (identifier.length > 0) out.add(identifier);
      if (out.size >= 32) return [...out].sort();
    }
  }
  return [...out].sort();
}

function constantKind(node: JsonObject): string {
  return Object.keys(node).filter((key) => key !== "location").sort().join("+") || "unknown";
}

function stringNodeValue(value: unknown): string | null {
  const node = value as JsonObject | null;
  return typeof node?.String?.sval === "string" ? node.String.sval : null;
}

function functionParameterReference(value: JsonObject, parameters: ReadonlySet<string>): boolean {
  const fields = value.ColumnRef?.fields;
  return Array.isArray(fields)
    && fields.length === 1
    && parameters.has(stringNodeValue(fields[0]) ?? "");
}

function digestAst(
  value: unknown,
  path: string,
  unit: SimilarityUnit,
  parameters: ReadonlySet<string>,
  minNodes: number,
  groups: Map<string, FragmentGroup>,
): DigestResult {
  if (value === null) return { digest: digest(["null"]), nodeCount: 0, identifiers: [] };
  if (typeof value !== "object") {
    return { digest: digest([typeof value, value]), nodeCount: 0, identifiers: [] };
  }
  if (Array.isArray(value)) {
    const children = value.map((child, index) =>
      digestAst(child, `${path}[${index}]`, unit, parameters, minNodes, groups)
    );
    return {
      digest: digest(["array", ...children.map((child) => child.digest)]),
      nodeCount: children.reduce((total, child) => total + child.nodeCount, 0),
      identifiers: mergeIdentifiers(children.map((child) => child.identifiers)),
    };
  }

  const object = value as JsonObject;
  const nodeType = astNodeType(object);
  if (nodeType === "A_Const") {
    return {
      digest: digest(["A_Const", constantKind(object.A_Const)]),
      nodeCount: 1,
      identifiers: [],
    };
  }
  if (nodeType === "ParamRef" || (nodeType === "ColumnRef" && functionParameterReference(object, parameters))) {
    return { digest: digest(["ParamRef"]), nodeCount: 1, identifiers: [] };
  }

  const childResults: Array<{ key: string; result: DigestResult }> = [];
  const ownIdentifiers: string[] = [];
  for (const key of Object.keys(object).sort()) {
    if (LOCATION_KEYS.has(key)) continue;
    const child = object[key];
    childResults.push({
      key,
      result: digestAst(child, `${path}.${key}`, unit, parameters, minNodes, groups),
    });
    if (typeof child === "string" && RAW_IDENTIFIER_KEYS.has(key)) ownIdentifiers.push(child);
  }
  if (nodeType === "String") {
    const identifier = stringNodeValue(object);
    if (identifier) ownIdentifiers.push(identifier);
  }
  const nodeCount = (nodeType ? 1 : 0)
    + childResults.reduce((total, child) => total + child.result.nodeCount, 0);
  const identifiers = mergeIdentifiers([
    ownIdentifiers,
    ...childResults.map((child) => child.result.identifiers),
  ]);
  const nodeDigest = digest([
    nodeType ?? "object",
    ...childResults.map((child) => [child.key, child.result.digest]),
  ]);

  if (nodeType && FRAGMENT_TYPES.has(nodeType) && nodeCount >= minNodes) {
    const group = groups.get(nodeDigest) ?? {
      digest: nodeDigest,
      nodeType,
      nodeCount,
      identifiers,
      occurrencesByUnit: new Map<string, FragmentOccurrence>(),
    };
    if (!group.occurrencesByUnit.has(unit.id)) {
      group.occurrencesByUnit.set(unit.id, { unit, path });
    }
    groups.set(nodeDigest, group);
  }

  return { digest: nodeDigest, nodeCount, identifiers };
}

function compactSql(sql: string, maxLength = 280): string {
  const compact = sql.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function candidateScope(units: readonly SimilarityUnit[]): SimilarityCandidate["scope"] {
  const kinds = new Set(units.map((unit) => unit.kind));
  if (kinds.size > 1) return "query-function";
  return kinds.has("application-query") ? "query-query" : "function-function";
}

function parseMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function analyzeSimilarityUnits(
  units: readonly SimilarityUnit[],
  options: { minNodes?: number; limit?: number } = {},
): Promise<SimilarityAnalysis> {
  const minNodes = options.minNodes ?? 12;
  const limit = options.limit ?? 50;
  const groups = new Map<string, FragmentGroup>();
  const parseErrors: SimilarityParseError[] = [];
  let parsedUnits = 0;
  let parsedStatements = 0;

  for (const unit of [...units].sort((left, right) => left.id.localeCompare(right.id))) {
    let parsed: JsonObject;
    try {
      const sql = unit.kind === "application-query" ? rewriteNamedParameters(unit.sql).query : unit.sql;
      parsed = await parse(sql) as JsonObject;
    } catch (error) {
      parseErrors.push({ unitId: unit.id, label: unit.label, message: parseMessage(error) });
      continue;
    }
    parsedUnits++;
    const statements = Array.isArray(parsed.stmts) ? parsed.stmts : [];
    parsedStatements += statements.length;
    const parameters = new Set(unit.parameterNames ?? []);
    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index]?.stmt;
      if (statement) digestAst(statement, `stmts[${index}].stmt`, unit, parameters, minNodes, groups);
    }
  }

  const fragmentUnitOccurrences = [...groups.values()].reduce(
    (total, group) => total + group.occurrencesByUnit.size,
    0,
  );
  const rawCandidates = [...groups.values()]
    .filter((group) => group.occurrencesByUnit.size >= 2)
    .map((group): SimilarityCandidate => {
      const occurrences = [...group.occurrencesByUnit.values()]
        .sort((left, right) => left.unit.id.localeCompare(right.unit.id));
      const candidateUnits = occurrences.map((occurrence) => occurrence.unit);
      return {
        id: group.digest.slice(0, 16),
        nodeType: group.nodeType,
        nodeCount: group.nodeCount,
        score: Number((group.nodeCount * Math.log2(candidateUnits.length + 1)).toFixed(2)),
        scope: candidateScope(candidateUnits),
        unitCount: candidateUnits.length,
        identifiers: group.identifiers,
        relatedFragmentCount: 1,
        relatedNodeTypes: [group.nodeType],
        occurrences: occurrences.map(({ unit, path }) => ({
          unitId: unit.id,
          kind: unit.kind,
          label: unit.label,
          sources: unit.sources,
          path,
          sqlPreview: compactSql(unit.sql),
        })),
      };
    })
    .sort((left, right) =>
      right.score - left.score
      || right.nodeCount - left.nodeCount
      || right.unitCount - left.unitCount
      || left.id.localeCompare(right.id)
    );
  const families = new Map<string, SimilarityCandidate[]>();
  for (const candidate of rawCandidates) {
    const key = candidate.occurrences.map((occurrence) => occurrence.unitId).join("\0");
    const family = families.get(key) ?? [];
    family.push(candidate);
    families.set(key, family);
  }
  const candidates = [...families.values()]
    .map((family) => ({
      ...family[0]!,
      relatedFragmentCount: family.length,
      relatedNodeTypes: [...new Set(family.map((candidate) => candidate.nodeType))].sort(),
    }))
    .sort((left, right) =>
      right.score - left.score
      || right.nodeCount - left.nodeCount
      || right.unitCount - left.unitCount
      || left.id.localeCompare(right.id)
    );

  return {
    parsedUnits,
    parsedStatements,
    fragmentUnitOccurrences,
    rawCandidateGroups: rawCandidates.length,
    candidateGroups: candidates.length,
    parseErrors,
    candidates: candidates.slice(0, limit),
  };
}
