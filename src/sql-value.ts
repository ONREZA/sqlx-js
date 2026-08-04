import { isTemporalValue } from "./temporal-api";

const DATE_GET_TIME = Date.prototype.getTime;
const MAP_ENTRIES = Map.prototype.entries;
const SET_VALUES = Set.prototype.values;
const DATE_FREE_SQL_VALUES = new WeakSet<object>();

export function markDateFreeSqlValue<T extends object>(value: T): T {
  DATE_FREE_SQL_VALUES.add(value);
  return value;
}

export function assertNoDateSqlValue(
  value: unknown,
  context: string,
  seen = new Set<object>(),
): void {
  if (isDateValue(value)) {
    throw new Error(`sqlx-js: JavaScript Date is not supported as a ${context}; use the matching Temporal type`);
  }
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return;
  if (DATE_FREE_SQL_VALUES.has(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoDateSqlValue(item, context, seen);
    return;
  }
  if (isTemporalValue(value)) {
    assertNoDateOwnValues(value, context, seen);
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      assertNoDateSqlValue(key, context, seen);
      assertNoDateSqlValue(item, context, seen);
    }
    return;
  }
  if (value instanceof Set) {
    for (const item of value) assertNoDateSqlValue(item, context, seen);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    assertNoDateOwnValues(value, context, seen);
    return;
  }
  const entries = mapEntries(value);
  if (entries) {
    for (const [key, item] of entries) {
      assertNoDateSqlValue(key, context, seen);
      assertNoDateSqlValue(item, context, seen);
    }
    return;
  }
  const values = setValues(value);
  if (values) {
    for (const item of values) assertNoDateSqlValue(item, context, seen);
    return;
  }
  assertNoDateOwnValues(value, context, seen);
}

function assertNoDateOwnValues(value: object, context: string, seen: Set<object>): void {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) assertNoDateSqlValue(descriptor.value, context, seen);
  }
}

export function isDateValue(value: unknown): value is Date {
  if (!value || typeof value !== "object") return false;
  try {
    Reflect.apply(DATE_GET_TIME, value, []);
    return true;
  } catch {
    return false;
  }
}

function mapEntries(value: object): IterableIterator<[unknown, unknown]> | undefined {
  try {
    return Reflect.apply(MAP_ENTRIES, value, []) as IterableIterator<[unknown, unknown]>;
  } catch {
    return undefined;
  }
}

function setValues(value: object): IterableIterator<unknown> | undefined {
  try {
    return Reflect.apply(SET_VALUES, value, []) as IterableIterator<unknown>;
  } catch {
    return undefined;
  }
}
