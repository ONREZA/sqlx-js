import {
  createSqlxJson,
  isSqlxJson,
  stringifyJsonParameter,
  type JsonCompatible,
  type SqlxJson,
} from "./json-value";
import { assertNoDateSqlValue, isDateValue } from "./sql-value";
import { isTemporalValue } from "./temporal-api";

export const PARAMETER_KIND = Symbol("sqlx-js.parameter");

type PgArrayScalar<T, NullableElements extends boolean> =
  T | (NullableElements extends true ? null : never);
type PgArrayElement<Values extends readonly unknown[]> = Exclude<Values[number], null>;
type PgArrayContainsNull<Values extends readonly unknown[]> = null extends Values[number] ? true : false;

export declare class PgArrayParameter<T = unknown, NullableElements extends boolean = boolean> {
  private readonly __sqlxJsPgArrayParameter;
  readonly value: readonly PgArrayScalar<T, NullableElements>[];
}

type TaggedPgArrayParameter<T = unknown, NullableElements extends boolean = boolean> =
  PgArrayParameter<T, NullableElements> & {
    readonly [PARAMETER_KIND]: "array";
  };

export type ExecuteResult = {
  rowCount: number;
  command: string;
};

export function json<T>(value: T & JsonCompatible<T>): SqlxJson<T> {
  return createSqlxJson(value);
}

export function array<const Values extends readonly unknown[]>(
  value: Values,
): PgArrayParameter<PgArrayElement<Values>, PgArrayContainsNull<Values>>;
export function array(value: readonly unknown[]): TaggedPgArrayParameter {
  return { [PARAMETER_KIND]: "array", value } as unknown as TaggedPgArrayParameter;
}

export function parameterKind(value: unknown): "json" | "array" | undefined {
  if (isSqlxJson(value)) return "json";
  if (!value || typeof value !== "object") return undefined;
  return (value as { [PARAMETER_KIND]?: "json" | "array" })[PARAMETER_KIND];
}

export function renameRows(rows: unknown[]): unknown[] {
  assertNoDateSqlValue(rows, "PostgreSQL result");
  if (rows.length === 0) return rows;
  const first = rows[0];
  if (first === null || typeof first !== "object") return rows;
  let rename: Map<string, string> | undefined;
  for (const key of Object.keys(first as Record<string, unknown>)) {
    if (key.endsWith("!") || key.endsWith("?")) {
      rename ??= new Map();
      rename.set(key, key.slice(0, -1));
    }
  }
  if (!rename) return rows;
  return rows.map((row) => Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, value]) => [rename.get(key) ?? key, value]),
  ));
}

export function isPrimitiveArrayElement(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (isDateValue(value)) return false;
  if (value instanceof Uint8Array || isTemporalValue(value)) return true;
  const type = typeof value;
  return type === "string" || type === "number" || type === "bigint" || type === "boolean";
}

function quoteArrayElement(raw: string): string {
  return '"' + raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function encodePgArrayLiteral(
  values: unknown[],
  serializeElement?: (value: unknown) => string,
): string {
  return encodePgArrayLiteralInternal(values, serializeElement, false);
}

export function encodePgArrayLiteralElements(
  values: unknown[],
  serializeElement: (value: unknown) => string,
): string {
  return encodePgArrayLiteralInternal(values, serializeElement, true);
}

function encodePgArrayLiteralInternal(
  values: unknown[],
  serializeElement: ((value: unknown) => string) | undefined,
  nestedArraysAreElements: boolean,
): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value === null) {
      parts.push("NULL");
      continue;
    }
    if (value === undefined) {
      throw new Error("sqlx-js: undefined is not a PostgreSQL value; pass null explicitly");
    }
    if (Array.isArray(value) && !nestedArraysAreElements) {
      parts.push(encodePgArrayLiteralInternal(value, serializeElement, nestedArraysAreElements));
      continue;
    }
    if (serializeElement) {
      parts.push(quoteArrayElement(serializeElement(value)));
      continue;
    }
    if (parameterKind(value) === "json") {
      parts.push(quoteArrayElement(stringifyJsonParameter(value as SqlxJson)));
      continue;
    }
    if (isDateValue(value)) {
      throw new Error("sqlx-js: JavaScript Date is not supported; use the matching Temporal type");
    }
    if (isTemporalValue(value)) {
      throw new Error("sqlx-js: Temporal array values require a known PostgreSQL temporal array type");
    }
    if (value instanceof Uint8Array) {
      parts.push(quoteArrayElement(`\\x${Buffer.from(value).toString("hex")}`));
      continue;
    }
    if (typeof value === "bigint") {
      parts.push(value.toString());
      continue;
    }
    if (typeof value === "number") {
      parts.push(Number.isFinite(value) ? String(value) : quoteArrayElement(String(value)));
      continue;
    }
    if (typeof value === "boolean") {
      parts.push(value ? "t" : "f");
      continue;
    }
    const text = String(value);
    parts.push(text === "" || /[\\"{},\s]/.test(text) || text.toLowerCase() === "null"
      ? quoteArrayElement(text)
      : text);
  }
  return `{${parts.join(",")}}`;
}

type PgArrayValue<T> = T | null | PgArrayValue<T>[];

export function parsePgArrayLiteral<T = string>(
  input: string,
  parseElement: (value: string) => T = (value) => value as T,
): PgArrayValue<T>[] {
  const dimensions = /^(?:\[-?\d+:-?\d+\])+=/.exec(input);
  let index = dimensions?.[0].length ?? 0;
  const parseQuoted = (): T => {
    index++;
    let out = "";
    while (index < input.length) {
      const character = input[index++]!;
      if (character === '"') return parseElement(out);
      if (character === "\\") {
        if (index < input.length) out += input[index++]!;
      } else out += character;
    }
    throw new Error("sqlx-js: malformed PostgreSQL array literal");
  };
  const parseUnquoted = (): T | null => {
    const start = index;
    while (index < input.length && input[index] !== "," && input[index] !== "}") index++;
    const raw = input.slice(start, index);
    return raw === "NULL" ? null : parseElement(raw);
  };
  const parseArray = (): PgArrayValue<T>[] => {
    if (input[index] !== "{") throw new Error("sqlx-js: malformed PostgreSQL array literal");
    index++;
    const out: PgArrayValue<T>[] = [];
    while (index < input.length) {
      if (input[index] === "}") {
        index++;
        return out;
      }
      out.push(input[index] === "{" ? parseArray() : input[index] === '"' ? parseQuoted() : parseUnquoted());
      if (input[index] === ",") {
        index++;
        continue;
      }
      if (input[index] === "}") continue;
      if (index >= input.length) break;
      throw new Error("sqlx-js: malformed PostgreSQL array literal");
    }
    throw new Error("sqlx-js: malformed PostgreSQL array literal");
  };
  const parsed = parseArray();
  if (index !== input.length) throw new Error("sqlx-js: malformed PostgreSQL array literal");
  return parsed;
}

export function encodeParam(value: unknown): unknown {
  assertNoDateSqlValue(value, "PostgreSQL parameter");
  const kind = parameterKind(value);
  if (kind === "json") return stringifyJsonParameter(value as SqlxJson);
  if (kind === "array") return encodePgArrayLiteral([...(value as PgArrayParameter).value]);
  return value;
}
