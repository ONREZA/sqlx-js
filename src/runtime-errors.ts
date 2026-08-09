import type { QueryExecutionMetadata } from "./query";
import { PgError } from "./pg/wire";

export class NoRowsError extends Error {
  readonly queryId?: string;
  readonly queryName?: string;

  constructor(message = "expected exactly 1 row, got 0", metadata?: QueryExecutionMetadata) {
    super(message);
    this.name = "NoRowsError";
    if (metadata) {
      this.queryId = metadata.queryId;
      if (metadata.queryName !== undefined) this.queryName = metadata.queryName;
    }
  }
}

export class TooManyRowsError extends Error {
  readonly actual: number;
  readonly queryId?: string;
  readonly queryName?: string;

  constructor(actual: number, expected: "1" | "0 or 1" = "1", metadata?: QueryExecutionMetadata) {
    super(`expected ${expected} row${expected === "1" ? "" : "s"}, got ${actual}`);
    this.name = "TooManyRowsError";
    this.actual = actual;
    if (metadata) {
      this.queryId = metadata.queryId;
      if (metadata.queryName !== undefined) this.queryName = metadata.queryName;
    }
  }
}

export type QueryTimeoutPhase = "bootstrap" | "execution";
export type QueryOutcome = "not_sent" | "unknown";

type QueryInterruptionDetails = {
  phase: QueryTimeoutPhase;
  outcome: QueryOutcome;
  queryId: string;
  generation: number;
};

export class QueryTimeoutError extends Error {
  readonly phase: QueryTimeoutPhase;
  readonly outcome: QueryOutcome;
  readonly queryId: string;
  readonly generation: number;

  constructor(public readonly timeoutMs: number, details: QueryInterruptionDetails) {
    super(`query exceeded ${timeoutMs}ms during ${details.phase}`);
    this.name = "QueryTimeoutError";
    this.phase = details.phase;
    this.outcome = details.outcome;
    this.queryId = details.queryId;
    this.generation = details.generation;
  }
}

export class QueryAbortedError extends Error {
  readonly phase: QueryTimeoutPhase;
  readonly outcome: QueryOutcome;
  readonly queryId: string;
  readonly generation: number;
  readonly reason: unknown;

  constructor(details: QueryInterruptionDetails, reason?: unknown) {
    super(`query aborted during ${details.phase}`);
    this.name = "QueryAbortedError";
    this.phase = details.phase;
    this.outcome = details.outcome;
    this.queryId = details.queryId;
    this.generation = details.generation;
    this.reason = reason;
  }
}

export class GenerationRecycledError extends Error {
  readonly outcome: QueryOutcome;
  readonly queryId: string;
  readonly generation: number;

  constructor(details: Pick<QueryInterruptionDetails, "outcome" | "queryId" | "generation">, cause?: unknown) {
    super(`database client generation ${details.generation} was recycled`, { cause });
    this.name = "GenerationRecycledError";
    this.outcome = details.outcome;
    this.queryId = details.queryId;
    this.generation = details.generation;
  }
}

export class ClientClosingError extends Error {
  readonly phase?: QueryTimeoutPhase;
  readonly outcome?: QueryOutcome;
  readonly queryId?: string;
  readonly generation?: number;

  constructor(details?: QueryInterruptionDetails) {
    super("database client is closing");
    this.name = "ClientClosingError";
    this.phase = details?.phase;
    this.outcome = details?.outcome;
    this.queryId = details?.queryId;
    this.generation = details?.generation;
  }
}

export type ResultDecodeErrorDetails = QueryExecutionMetadata & {
  columnIndex: number;
  column: string;
  typeOid: number;
  hint?: string;
};

function replaceErrorStackHeader(error: Error, source: unknown): void {
  if (typeof source !== "string" || source.length === 0) return;
  const frameStart = source.indexOf("\n");
  error.stack = `${error.name}: ${error.message}${frameStart === -1 ? "" : source.slice(frameStart)}`;
}

export class ResultDecodeError extends Error {
  declare readonly cause: unknown;
  readonly queryId: string;
  readonly queryName?: string;
  readonly columnIndex: number;
  readonly column: string;
  readonly typeOid: number;
  readonly hint?: string;

  constructor(details: ResultDecodeErrorDetails, cause: unknown) {
    const query = details.queryName !== undefined
      ? `${JSON.stringify(details.queryName)} (${details.queryId})`
      : details.queryId;
    super(
      `sqlx-js: failed to decode query ${query} column[${details.columnIndex}] `
      + `${JSON.stringify(details.column)} (PostgreSQL type OID ${details.typeOid})`
      + (details.hint ? `. ${details.hint}` : ""),
      { cause },
    );
    this.name = "ResultDecodeError";
    this.queryId = details.queryId;
    if (details.queryName !== undefined) this.queryName = details.queryName;
    this.columnIndex = details.columnIndex;
    this.column = details.column;
    this.typeOid = details.typeOid;
    if (details.hint !== undefined) this.hint = details.hint;
    replaceErrorStackHeader(this, this.stack);
  }
}

export function withResultDecodeQueryMetadata(
  error: ResultDecodeError,
  metadata: QueryExecutionMetadata,
): ResultDecodeError {
  if (error.queryId === metadata.queryId && error.queryName === metadata.queryName) return error;
  const enriched = new ResultDecodeError({
    ...metadata,
    columnIndex: error.columnIndex,
    column: error.column,
    typeOid: error.typeOid,
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
  }, error.cause);
  replaceErrorStackHeader(enriched, error.stack);
  return enriched;
}

export class TransactionTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly outcome: "rolled_back" | "unknown" = "unknown",
    public readonly generation = 0,
  ) {
    super(`transaction exceeded ${timeoutMs}ms`);
    this.name = "TransactionTimeoutError";
  }
}

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

function firstString(...candidates: unknown[]): string | undefined {
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function toPgError(error: unknown): PgError | null {
  if (error instanceof PgError) return error;
  if (error === null || typeof error !== "object") return null;
  const value = error as Record<string, unknown>;
  const code = typeof value.code === "string" ? value.code : undefined;
  const severity = firstString(value.severity, value.severity_local);
  const isDatabaseError = value.name === "PostgresError"
    || (code !== undefined && SQLSTATE_PATTERN.test(code) && severity !== undefined);
  if (!isDatabaseError) return null;
  const fields: Record<string, string> = {};
  if (typeof value.message === "string" && value.message.length > 0) fields.M = value.message;
  if (code) fields.C = code;
  if (typeof value.detail === "string" && value.detail.length > 0) fields.D = value.detail;
  if (typeof value.hint === "string" && value.hint.length > 0) fields.H = value.hint;
  const position = firstString(value.position)
    ?? (typeof value.position === "number" && Number.isFinite(value.position) ? String(value.position) : undefined);
  if (position) fields.P = position;
  if (severity) fields.S = severity;
  const table = firstString(value.table_name, value.table);
  if (table) fields.t = table;
  const column = firstString(value.column_name, value.column);
  if (column) fields.c = column;
  const constraint = firstString(value.constraint_name, value.constraint);
  if (constraint) fields.n = constraint;
  const schema = firstString(value.schema_name, value.schema);
  if (schema) fields.s = schema;
  return new PgError(fields, { cause: error });
}

export const SQLSTATE = {
  notNullViolation: "23502",
  foreignKeyViolation: "23503",
  uniqueViolation: "23505",
  checkViolation: "23514",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
} as const;

export type KnownSqlState = (typeof SQLSTATE)[keyof typeof SQLSTATE];

export function isPgError(error: unknown): error is PgError;
export function isPgError<const Code extends string>(error: unknown, code: Code): error is PgError & { readonly code: Code };
export function isPgError(error: unknown, code?: string): error is PgError {
  return error instanceof PgError && (code === undefined || error.code === code);
}
