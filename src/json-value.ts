import { isDateValue } from "./sql-value";
import { isTemporalValue, type TemporalJsonValue } from "./temporal-api";

export type JsonPrimitive = string | number | boolean | null;
export type JsonInputValue = JsonPrimitive | JsonInputObject | JsonInputArray;
export type JsonInputObject = { readonly [key: string]: JsonInputValue | undefined };
export type JsonInputArray = readonly JsonInputValue[];
type NonJsonValue = bigint | symbol | Date | TemporalJsonValue | Uint8Array | ((...args: never[]) => unknown);
export type JsonCompatible<T> =
  T extends JsonPrimitive ? T
    : T extends NonJsonValue ? never
      : T extends readonly unknown[] ? T extends JsonInputArray
        ? T
        : { readonly [K in keyof T]: JsonCompatible<T[K]> }
        : T extends object ? Extract<keyof T, symbol> extends never
          ? T extends JsonInputObject
            ? T
            : {
                readonly [K in keyof T]: undefined extends T[K]
                  ? JsonCompatible<Exclude<T[K], undefined>> | undefined
                  : JsonCompatible<T[K]>;
              }
          : never
          : never;

export function stringifyJsonParameter(value: unknown): string {
  assertSafeJsonValue(value, new Set());
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new Error("sqlx-js: JSON parameter is not JSON-serializable", { cause });
  }
  if (serialized === undefined) {
    throw new Error("sqlx-js: JSON parameter is not JSON-serializable");
  }
  parseJsonResult(serialized);
  return serialized;
}

export function parseJsonResult(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  assertSafeJsonValue(parsed, new Set());
  return parsed;
}

function assertSafeJsonValue(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("sqlx-js: JSON numbers must be finite");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("sqlx-js: JSON integers must be within JavaScript's safe integer range; encode this value as a string");
    }
    return;
  }
  if (isDateValue(value)) {
    throw new Error("sqlx-js: JavaScript Date is not supported in JSON; encode an explicit string instead");
  }
  if (isTemporalValue(value)) {
    throw new Error("sqlx-js: Temporal values are not supported in JSON; encode an explicit string instead");
  }
  if (ArrayBuffer.isView(value)) {
    throw new Error("sqlx-js: binary views are not supported in JSON; encode an explicit string instead");
  }
  if (typeof value !== "object") {
    throw new Error(`sqlx-js: unsupported JSON value ${Object.prototype.toString.call(value)}`);
  }
  if (seen.has(value)) {
    throw new Error("sqlx-js: JSON parameter contains a circular reference");
  }
  if (hasCustomToJson(value)) {
    throw new Error("sqlx-js: custom toJSON methods are not supported in JSON parameters");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        throw new Error("sqlx-js: JSON arrays cannot contain symbol or named properties");
      }
    }
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
        throw new Error("sqlx-js: JSON arrays cannot contain holes, accessors, or undefined elements");
      }
      assertSafeJsonValue(descriptor.value, seen);
    }
  } else {
    if (!isPlainRecord(value)) {
      throw new Error("sqlx-js: JSON objects must be plain records");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error("sqlx-js: JSON objects cannot contain symbol-keyed properties");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new Error("sqlx-js: JSON objects cannot contain accessor properties");
      }
      if (descriptor.value !== undefined) assertSafeJsonValue(descriptor.value, seen);
    }
  }
  seen.delete(value);
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  return typeof constructor === "function" && constructor.name === "Object";
}

function hasCustomToJson(value: object): boolean {
  const seen = new Set<object>();
  let current: object | null = value;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (Object.getOwnPropertyDescriptor(current, "toJSON")) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}
