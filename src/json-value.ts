import type { TemporalApi, TemporalFactory, TemporalJsonValue } from "./temporal-api";
import { isTemporalValue, resolveTemporalApi } from "./temporal-api";
import { isDateValue, markDateFreeSqlValue } from "./sql-value";
import { JSON_PROTOCOL_VERSION } from "./artifact-versions";
import {
  assertJsonBigintDigits,
  canonicalJsonNumber,
  canonicalJsonNumberBytes,
  JSON_NUMBER_LIMITS,
} from "./json-number";
import { JSON_RESOURCE_LIMITS } from "./json-limits";
import { serializeExtendedJson, type JsonEncodingHooks } from "./json-encoding";

export const EXTENDED_JSON_PROTOCOL_VERSION = JSON_PROTOCOL_VERSION;

const MAX_INPUT_BYTES = JSON_RESOURCE_LIMITS.inputBytes;
const MAX_STRING_BYTES = JSON_RESOURCE_LIMITS.stringBytes;
const MAX_DEPTH = JSON_RESOURCE_LIMITS.depth;
const MAX_NODES = JSON_RESOURCE_LIMITS.nodes;
const MAX_CANONICAL_NUMBER_BYTES = JSON_RESOURCE_LIMITS.canonicalNumberBytes;
const MAX_NUMBER_TOKEN_LENGTH = JSON_NUMBER_LIMITS.tokenLength;
const PROTOCOL_VERSION_NUMBER_BYTES = String(EXTENDED_JSON_PROTOCOL_VERSION).length;
const JSON_NUMBER_CANONICAL_VALUE = Symbol("sqlx-js.json.number.canonical-value");
const JSON_NUMBER_COMPARABLE_VALUE = Symbol("sqlx-js.json.number.comparable-value");
const RAW_NUMBER = Symbol("sqlx-js.json.raw-number");
const SQLX_JSON_DOCUMENTS = new WeakMap<object, string | undefined>();
// Parser output is already canonical; keep the bypass inaccessible to callers.
let createCanonicalJsonNumber: (value: string) => JsonNumber;
let exactJsonNumberText: (value: unknown) => string | undefined;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | bigint | JsonNumber | TemporalJsonValue | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonInputValue = JsonValue;
export type JsonInputObject = { readonly [key: string]: JsonInputValue };
export type JsonInputArray = readonly JsonInputValue[];

type NonJsonValue = symbol | Date | Uint8Array | ((...args: never[]) => unknown);

export type JsonCompatible<T> =
  T extends JsonPrimitive | bigint | JsonNumber | TemporalJsonValue ? T
    : T extends NonJsonValue ? never
      : T extends readonly unknown[] ? T extends JsonInputArray
        ? T
        : { readonly [K in keyof T]: JsonCompatible<T[K]> }
        : T extends object ? Extract<keyof T, symbol> extends never
          ? T extends JsonInputObject
            ? T
            : { readonly [K in keyof T]: JsonCompatible<T[K]> }
          : never
          : never;

export type ImmutableJson<T> =
  T extends JsonPrimitive | bigint | JsonNumber | TemporalJsonValue ? T
    : T extends readonly (infer Item)[] ? readonly ImmutableJson<Item>[]
      : T extends object ? { readonly [K in keyof T]: ImmutableJson<T[K]> }
        : T;

type RawNumber = {
  readonly [RAW_NUMBER]: string;
};

type RawJson = string | boolean | null | RawNumber | RawJsonArray | RawJsonObject;

interface RawJsonArray extends Array<RawJson> {}

interface RawJsonObject {
  readonly [RAW_NUMBER]?: never;
  [key: string]: RawJson;
}

export type SqlxJsonParseOptions = {
  temporalApi?: TemporalApi;
};

export class JsonNumber {
  // Deep equality may observe this snapshot; raw encoding must trust only #value.
  private readonly [JSON_NUMBER_COMPARABLE_VALUE]: string;
  readonly #value: string;

  private constructor(value: string, canonical?: typeof JSON_NUMBER_CANONICAL_VALUE) {
    if (typeof value !== "string") {
      throw new Error("sqlx-js: JsonNumber requires a JSON number string");
    }
    const canonicalValue = canonical === JSON_NUMBER_CANONICAL_VALUE
      ? value
      : canonicalJsonNumber(value);
    this[JSON_NUMBER_COMPARABLE_VALUE] = canonicalValue;
    this.#value = canonicalValue;
    Object.freeze(this);
  }

  static from(value: string): JsonNumber {
    if (typeof value !== "string") {
      throw new Error("sqlx-js: JsonNumber.from requires a JSON number string");
    }
    return new JsonNumber(value);
  }

  static {
    createCanonicalJsonNumber = (value) => new JsonNumber(value, JSON_NUMBER_CANONICAL_VALUE);
    exactJsonNumberText = (value) => {
      if (value === null || typeof value !== "object" || !(#value in value)) return undefined;
      return value.#value;
    };
  }

  toString(): string {
    return this.#value;
  }
}

export class SqlxJson<T = JsonValue> {
  private declare readonly brand: void;
  readonly protocolVersion!: typeof EXTENDED_JSON_PROTOCOL_VERSION;
  readonly value!: ImmutableJson<T>;

  private constructor() {}

  static parse(text: string, options: SqlxJsonParseOptions = {}): SqlxJson<JsonValue> {
    return parseJsonResult(text, options.temporalApi);
  }

  static stringify(document: SqlxJson<unknown>): string {
    return stringifyJsonParameter(document);
  }
}

export function createSqlxJson<T>(value: T & JsonCompatible<T>): SqlxJson<T> {
  const state: SnapshotState = {
    nodes: 0,
    seen: new Set(),
    canonicalNumbers: { bytes: 0 },
    stringBytes: new Map(),
  };
  const snapshot = snapshotValue(value, state, 0) as ImmutableJson<T>;
  const document = createDocument(snapshot);
  SQLX_JSON_DOCUMENTS.set(document, serializeDocumentValue(snapshot));
  return document;
}

export function isSqlxJson(value: unknown): value is SqlxJson<unknown> {
  return value !== null
    && typeof value === "object"
    && SQLX_JSON_DOCUMENTS.has(value);
}

export function stringifyJsonParameter(document: SqlxJson<unknown>): string {
  if (!isSqlxJson(document)) {
    throw new Error("sqlx-js: PostgreSQL JSON values require a SqlxJson document created by sql.json(...)");
  }
  return SQLX_JSON_DOCUMENTS.get(document) ?? serializeDocumentValue(document.value);
}

export function parseJsonResult(value: string, temporalApi?: TemporalApi): SqlxJson<JsonValue> {
  if (typeof value !== "string") throw new Error("sqlx-js: Extended JSON input must be text");
  assertUtf8Limit(value, MAX_INPUT_BYTES, "Extended JSON input");
  const raw = new ExactJsonParser(value).parse();
  const provider: TemporalDecodeState = { value: temporalApi, resolved: false };
  const decoded = decodeValue(raw, provider, 0);
  return createDocument(decoded);
}

function createDocument<T>(value: ImmutableJson<T>): SqlxJson<T> {
  const document = Object.create(SqlxJson.prototype) as SqlxJson<T>;
  Object.defineProperties(document, {
    protocolVersion: {
      value: EXTENDED_JSON_PROTOCOL_VERSION,
      enumerable: true,
    },
    value: {
      value,
      enumerable: true,
    },
  });
  Object.freeze(document);
  markDateFreeSqlValue(document);
  SQLX_JSON_DOCUMENTS.set(document, undefined);
  return document;
}

type SnapshotState = {
  nodes: number;
  seen: Set<object>;
  canonicalNumbers: CanonicalNumberBudget;
  stringBytes: Map<string, number>;
};

function snapshotValue(value: unknown, state: SnapshotState, depth: number): JsonValue {
  assertValueBudget(state, depth);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertSnapshotUtf8Limit(value, state, "Extended JSON string");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("sqlx-js: Extended JSON numbers must be finite");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(
        "sqlx-js: Extended JSON integer numbers must be within JavaScript's safe integer range; use bigint or JsonNumber.from(...) instead",
      );
    }
    const normalized = Object.is(value, -0) ? 0 : value;
    reserveCanonicalNumberBytes(
      state.canonicalNumbers,
      canonicalJsonNumberBytes(String(normalized)),
    );
    return normalized;
  }
  if (typeof value === "bigint") {
    reserveCanonicalNumberBytes(state.canonicalNumbers, PROTOCOL_VERSION_NUMBER_BYTES);
    return value;
  }
  const exactNumber = exactJsonNumberText(value);
  if (exactNumber !== undefined) {
    reserveCanonicalNumberBytes(state.canonicalNumbers, exactNumber.length);
    return createCanonicalJsonNumber(exactNumber);
  }
  if (isDateValue(value)) {
    throw new Error("sqlx-js: JavaScript Date is not supported in Extended JSON; use the matching Temporal type");
  }
  if (isTemporalValue(value)) {
    reserveCanonicalNumberBytes(state.canonicalNumbers, PROTOCOL_VERSION_NUMBER_BYTES);
    return snapshotTemporal(value, state);
  }
  if (ArrayBuffer.isView(value)) {
    throw new Error("sqlx-js: binary views are not supported in Extended JSON; encode an explicit string instead");
  }
  if (typeof value !== "object") {
    throw new Error(`sqlx-js: unsupported Extended JSON value ${Object.prototype.toString.call(value)}`);
  }
  if (state.seen.has(value)) throw new Error("sqlx-js: Extended JSON document contains a circular reference");
  if (hasCustomToJson(value)) {
    throw new Error("sqlx-js: custom toJSON methods are not supported in Extended JSON documents");
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return snapshotArray(value, state, depth);
    if (!isPlainRecord(value)) throw new Error("sqlx-js: Extended JSON objects must be plain records");
    if (Object.hasOwn(value, "$sqlx")) {
      reserveCanonicalNumberBytes(state.canonicalNumbers, PROTOCOL_VERSION_NUMBER_BYTES);
    }
    return snapshotObject(value, state, depth);
  } finally {
    state.seen.delete(value);
  }
}

function snapshotArray(value: unknown[], state: SnapshotState, depth: number): JsonArray {
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw new Error("sqlx-js: Extended JSON arrays cannot contain symbol or named properties");
    }
  }
  const result: JsonValue[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
      throw new Error("sqlx-js: Extended JSON arrays cannot contain holes, accessors, or undefined elements");
    }
    result.push(snapshotValue(descriptor.value, state, depth + 1));
  }
  return Object.freeze(result);
}

function snapshotObject(value: object, state: SnapshotState, depth: number): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error("sqlx-js: Extended JSON objects cannot contain symbol-keyed properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) {
      throw new Error("sqlx-js: Extended JSON objects cannot contain accessor properties");
    }
    if (!descriptor.enumerable) continue;
    if (descriptor.value === undefined) {
      throw new Error("sqlx-js: Extended JSON objects cannot contain undefined values");
    }
    assertSnapshotUtf8Limit(key, state, "Extended JSON object key");
    defineDataProperty(result, key, snapshotValue(descriptor.value, state, depth + 1));
  }
  return Object.freeze(result);
}

function snapshotTemporal(value: TemporalJsonValue, state: SnapshotState): TemporalJsonValue {
  const name = temporalTypeName(value);
  const prototype = Object.getPrototypeOf(value) as { constructor?: unknown } | null;
  const factory = prototype?.constructor;
  if (!isTemporalFactory(factory)) {
    throw new Error(`sqlx-js: ${name} value has no compatible Temporal provider constructor`);
  }
  let canonical: string;
  let restored: unknown;
  try {
    canonical = String(value);
    restored = factory.from(canonical);
  } catch (cause) {
    throw new Error(`sqlx-js: ${name} value failed its provider compatibility check`, { cause });
  }
  if (!(restored instanceof factory) || temporalTypeName(restored) !== name) {
    throw new Error(`sqlx-js: ${name} provider returned an incompatible value`);
  }
  assertSnapshotUtf8Limit(canonical, state, `${name} value`);
  return Object.freeze(restored) as TemporalJsonValue;
}

function isTemporalFactory(value: unknown): value is TemporalFactory {
  return typeof value === "function"
    && typeof (value as Partial<TemporalFactory>).prototype === "object"
    && typeof (value as Partial<TemporalFactory>).from === "function";
}

function temporalTypeName(value: unknown): SupportedTemporalName {
  const tag = value && typeof value === "object"
    ? (value as { readonly [Symbol.toStringTag]?: unknown })[Symbol.toStringTag]
    : undefined;
  if (typeof tag === "string" && SUPPORTED_TEMPORAL_NAMES.has(tag as SupportedTemporalName)) {
    return tag as SupportedTemporalName;
  }
  if (typeof tag === "string" && tag.startsWith("Temporal.")) {
    throw new Error(`sqlx-js: unsupported Extended JSON Temporal type ${tag}`);
  }
  throw new Error("sqlx-js: malformed Extended JSON Temporal value");
}

type SupportedTemporalName =
  | "Temporal.Duration"
  | "Temporal.Instant"
  | "Temporal.PlainDate"
  | "Temporal.PlainDateTime"
  | "Temporal.PlainMonthDay"
  | "Temporal.PlainTime"
  | "Temporal.PlainYearMonth"
  | "Temporal.ZonedDateTime";

const SUPPORTED_TEMPORAL_NAMES = new Set<SupportedTemporalName>([
  "Temporal.Duration",
  "Temporal.Instant",
  "Temporal.PlainDate",
  "Temporal.PlainDateTime",
  "Temporal.PlainMonthDay",
  "Temporal.PlainTime",
  "Temporal.PlainYearMonth",
  "Temporal.ZonedDateTime",
]);

const TEMPORAL_FACTORIES: Record<SupportedTemporalName, keyof TemporalApi> = {
  "Temporal.Duration": "Duration",
  "Temporal.Instant": "Instant",
  "Temporal.PlainDate": "PlainDate",
  "Temporal.PlainDateTime": "PlainDateTime",
  "Temporal.PlainMonthDay": "PlainMonthDay",
  "Temporal.PlainTime": "PlainTime",
  "Temporal.PlainYearMonth": "PlainYearMonth",
  "Temporal.ZonedDateTime": "ZonedDateTime",
};

function decodeValue(
  value: RawJson,
  temporalApi: TemporalDecodeState,
  depth: number,
): JsonValue {
  if (depth > MAX_DEPTH) throw new Error(`sqlx-js: Extended JSON nesting exceeds ${MAX_DEPTH}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (isRawNumber(value)) return materializeNumber(value[RAW_NUMBER]);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => decodeValue(item, temporalApi, depth + 1)));
  }
  if (Object.hasOwn(value, "$sqlx")) return decodeTaggedValue(value, temporalApi, depth);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    defineDataProperty(result, key, decodeValue(value[key]!, temporalApi, depth + 1));
  }
  return Object.freeze(result);
}

function decodeTaggedValue(
  value: RawJsonObject,
  temporalApi: TemporalDecodeState,
  depth: number,
): JsonValue {
  assertExactKeys(value, ["$sqlx", "value"], "tagged node");
  const control = value.$sqlx;
  if (!isRawObject(control)) throw new Error("sqlx-js: Extended JSON $sqlx control must be an object");
  assertExactKeys(control, ["type", "v"], "$sqlx control");
  if (!isRawNumber(control.v) || control.v[RAW_NUMBER] !== String(EXTENDED_JSON_PROTOCOL_VERSION)) {
    throw new Error("sqlx-js: unknown Extended JSON protocol version");
  }
  if (typeof control.type !== "string") throw new Error("sqlx-js: Extended JSON tag type must be a string");
  const payload = value.value;
  if (control.type === "bigint") {
    if (typeof payload !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(payload) || payload === "-0") {
      throw new Error("sqlx-js: malformed Extended JSON bigint tag");
    }
    assertJsonBigintDigits(payload);
    return BigInt(payload);
  }
  if (control.type === "object") {
    if (!isRawObject(payload)) throw new Error("sqlx-js: malformed Extended JSON object escape");
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(payload)) {
      defineDataProperty(result, key, decodeValue(payload[key]!, temporalApi, depth + 1));
    }
    return Object.freeze(result);
  }
  if (control.type.startsWith("temporal.")) {
    const temporalName = `Temporal.${control.type.slice("temporal.".length)}` as SupportedTemporalName;
    if (!SUPPORTED_TEMPORAL_NAMES.has(temporalName)) {
      throw new Error(`sqlx-js: unknown Extended JSON tag type ${quotedForError(control.type)}`);
    }
    if (typeof payload !== "string") throw new Error(`sqlx-js: malformed Extended JSON ${control.type} tag`);
    if (!temporalApi.resolved) {
      temporalApi.value = resolveTemporalApi(temporalApi.value);
      temporalApi.resolved = true;
    }
    const factory = temporalApi.value![TEMPORAL_FACTORIES[temporalName]];
    let restored: unknown;
    try {
      restored = factory.from(payload);
    } catch (cause) {
      throw new Error(`sqlx-js: malformed Extended JSON ${control.type} value`, { cause });
    }
    if (!(restored instanceof factory) || temporalTypeName(restored) !== temporalName) {
      throw new Error(`sqlx-js: temporalApi.${TEMPORAL_FACTORIES[temporalName]}.from returned an incompatible value`);
    }
    return Object.freeze(restored) as TemporalJsonValue;
  }
  throw new Error(`sqlx-js: unknown Extended JSON tag type ${quotedForError(control.type)}`);
}

type TemporalDecodeState = {
  value: TemporalApi | undefined;
  resolved: boolean;
};

const JSON_ENCODING_HOOKS: JsonEncodingHooks = {
  exactNumberText: exactJsonNumberText,
  temporal(value) {
    if (!isTemporalValue(value)) return undefined;
    return {
      type: temporalTypeName(value).replace("Temporal.", "temporal."),
      payload: String(value),
    };
  },
  isPlainRecord,
};

function serializeDocumentValue(value: unknown): string {
  return serializeExtendedJson(
    value,
    EXTENDED_JSON_PROTOCOL_VERSION,
    JSON_ENCODING_HOOKS,
  );
}

function materializeNumber(token: string): number | JsonNumber {
  const canonical = canonicalJsonNumber(token);
  const number = Number(canonical);
  if (!Number.isFinite(number) || (number === 0 && canonical !== "0")) {
    return createCanonicalJsonNumber(canonical);
  }
  if (Number.isInteger(number) && !Number.isSafeInteger(number)) {
    return createCanonicalJsonNumber(canonical);
  }
  return Object.is(number, -0) ? 0 : number;
}

class ExactJsonParser {
  private index = 0;
  private nodes = 0;
  private readonly canonicalNumbers: CanonicalNumberBudget = { bytes: 0 };

  constructor(private readonly input: string) {}

  parse(): RawJson {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.input.length) this.fail("unexpected trailing input");
    return value;
  }

  private parseValue(depth: number): RawJson {
    this.nodes++;
    if (this.nodes > MAX_NODES) this.fail(`node count exceeds ${MAX_NODES}`);
    if (depth > MAX_DEPTH) this.fail(`nesting exceeds ${MAX_DEPTH}`);
    const char = this.input[this.index];
    if (char === '"') return this.parseString();
    if (char === "{") return this.parseObject(depth);
    if (char === "[") return this.parseArray(depth);
    if (char === "t") return this.parseKeyword("true", true);
    if (char === "f") return this.parseKeyword("false", false);
    if (char === "n") return this.parseKeyword("null", null);
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.parseNumber();
    this.fail("expected a JSON value");
  }

  private parseObject(depth: number): RawJsonObject {
    this.index++;
    this.skipWhitespace();
    const result: RawJsonObject = {};
    const keys = new Set<string>();
    if (this.input[this.index] === "}") {
      this.index++;
      return result;
    }
    while (this.index < this.input.length) {
      if (this.input[this.index] !== '"') this.fail("expected an object key");
      const key = this.parseString();
      if (keys.has(key)) this.fail(`duplicate object key ${quotedForError(key)}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.input[this.index] !== ":") this.fail("expected ':' after object key");
      this.index++;
      this.skipWhitespace();
      defineDataProperty(result, key, this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.input[this.index++];
      if (separator === "}") return result;
      if (separator !== ",") this.fail("expected ',' or '}' in object");
      this.skipWhitespace();
    }
    this.fail("unterminated object");
  }

  private parseArray(depth: number): RawJsonArray {
    this.index++;
    this.skipWhitespace();
    const result: RawJsonArray = [];
    if (this.input[this.index] === "]") {
      this.index++;
      return result;
    }
    while (this.index < this.input.length) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.input[this.index++];
      if (separator === "]") return result;
      if (separator !== ",") this.fail("expected ',' or ']' in array");
      this.skipWhitespace();
    }
    this.fail("unterminated array");
  }

  private parseString(): string {
    const start = this.index;
    this.index++;
    while (this.index < this.input.length) {
      const code = this.input.charCodeAt(this.index++);
      if (code === 0x22) {
        const token = this.input.slice(start, this.index);
        let value: string;
        try {
          value = JSON.parse(token) as string;
        } catch (cause) {
          throw new Error(`sqlx-js: malformed Extended JSON string at offset ${start}`, { cause });
        }
        assertUtf8Limit(value, MAX_STRING_BYTES, "Extended JSON string");
        return value;
      }
      if (code < 0x20) this.fail("unescaped control character in string");
      if (code !== 0x5c) continue;
      const escape = this.input[this.index++];
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(this.input.slice(this.index, this.index + 4))) {
          this.fail("invalid Unicode escape");
        }
        this.index += 4;
      } else if (!escape || !'"\\/bfnrt'.includes(escape)) {
        this.fail("invalid string escape");
      }
    }
    this.fail("unterminated string");
  }

  private parseNumber(): RawNumber {
    const start = this.index;
    if (this.input[this.index] === "-") this.index++;
    if (this.input[this.index] === "0") {
      this.index++;
      if (/\d/.test(this.input[this.index] ?? "")) this.fail("leading zero in number");
    } else {
      if (!/[1-9]/.test(this.input[this.index] ?? "")) this.fail("invalid number");
      while (/\d/.test(this.input[this.index] ?? "")) this.index++;
    }
    if (this.input[this.index] === ".") {
      this.index++;
      if (!/\d/.test(this.input[this.index] ?? "")) this.fail("missing fractional digits");
      while (/\d/.test(this.input[this.index] ?? "")) this.index++;
    }
    if (this.input[this.index] === "e" || this.input[this.index] === "E") {
      this.index++;
      if (this.input[this.index] === "+" || this.input[this.index] === "-") this.index++;
      if (!/\d/.test(this.input[this.index] ?? "")) this.fail("missing exponent digits");
      while (/\d/.test(this.input[this.index] ?? "")) this.index++;
    }
    const token = this.input.slice(start, this.index);
    if (token.length > MAX_NUMBER_TOKEN_LENGTH) {
      this.fail(`number token exceeds ${MAX_NUMBER_TOKEN_LENGTH} characters`);
    }
    reserveCanonicalNumberBytes(this.canonicalNumbers, canonicalJsonNumberBytes(token));
    return Object.freeze({ [RAW_NUMBER]: token });
  }

  private parseKeyword<T extends boolean | null>(keyword: string, value: T): T {
    if (this.input.slice(this.index, this.index + keyword.length) !== keyword) {
      this.fail(`invalid token, expected ${keyword}`);
    }
    this.index += keyword.length;
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.input.length && " \t\r\n".includes(this.input[this.index]!)) {
      this.index++;
    }
  }

  private fail(message: string): never {
    throw new Error(`sqlx-js: malformed Extended JSON at offset ${this.index}: ${message}`);
  }
}

function assertValueBudget(state: SnapshotState, depth: number): void {
  state.nodes++;
  if (state.nodes > MAX_NODES) throw new Error(`sqlx-js: Extended JSON node count exceeds ${MAX_NODES}`);
  if (depth > MAX_DEPTH) throw new Error(`sqlx-js: Extended JSON nesting exceeds ${MAX_DEPTH}`);
}

type CanonicalNumberBudget = {
  bytes: number;
};

function reserveCanonicalNumberBytes(state: CanonicalNumberBudget, bytes: number): void {
  state.bytes += bytes;
  if (state.bytes > MAX_CANONICAL_NUMBER_BYTES) {
    throw new Error(
      `sqlx-js: Extended JSON canonical number data exceeds ${MAX_CANONICAL_NUMBER_BYTES} bytes`,
    );
  }
}

function assertSnapshotUtf8Limit(value: string, state: SnapshotState, label: string): void {
  let bytes = state.stringBytes.get(value);
  if (bytes === undefined) {
    bytes = new TextEncoder().encode(value).byteLength;
    state.stringBytes.set(value, bytes);
  }
  if (bytes > MAX_STRING_BYTES) {
    throw new Error(`sqlx-js: ${label} exceeds ${MAX_STRING_BYTES} UTF-8 bytes`);
  }
}

function assertUtf8Limit(value: string, limit: number, label: string): void {
  if (new TextEncoder().encode(value).byteLength > limit) {
    throw new Error(`sqlx-js: ${label} exceeds ${limit} UTF-8 bytes`);
  }
}

function isRawNumber(value: RawJson | undefined): value is RawNumber {
  return !!value && typeof value === "object" && !Array.isArray(value) && RAW_NUMBER in value;
}

function isRawObject(value: RawJson | undefined): value is RawJsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value) && !isRawNumber(value);
}

function assertExactKeys(value: RawJsonObject, keys: string[], label: string): void {
  const actual = Object.keys(value).sort(compareKeys);
  const expected = [...keys].sort(compareKeys);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`sqlx-js: malformed Extended JSON ${label}`);
  }
}

function defineDataProperty<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quotedForError(value: string): string {
  const limit = 120;
  return JSON.stringify(value.length > limit ? `${value.slice(0, limit)}...` : value);
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
