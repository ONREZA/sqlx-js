import { JsonEncodingBudget, JSON_RESOURCE_LIMITS } from "./json-limits";
import { assertJsonBigintDigits } from "./json-number";

export type EncodedTemporal = {
  type: string;
  payload: string;
};

export type JsonEncodingHooks = {
  exactNumberText(value: unknown): string | undefined;
  temporal(value: unknown): EncodedTemporal | undefined;
  isPlainRecord(value: object): boolean;
};

type EncodeState = {
  nodes: number;
  protocolVersion: number;
  hooks: JsonEncodingHooks;
  bigints: Map<bigint, string>;
  objectKeys: WeakMap<object, string[]>;
  temporals: WeakMap<object, EncodedTemporal | null>;
};

type MeasureState = EncodeState & {
  budget: JsonEncodingBudget;
};

export function serializeExtendedJson(
  value: unknown,
  protocolVersion: number,
  hooks: JsonEncodingHooks,
): string {
  const bigints = new Map<bigint, string>();
  const objectKeys = new WeakMap<object, string[]>();
  const temporals = new WeakMap<object, EncodedTemporal | null>();
  const shared = { protocolVersion, hooks, bigints, objectKeys, temporals };
  measureEncodedValue(value, 0, { nodes: 0, ...shared, budget: new JsonEncodingBudget() });
  const text = encodeValue(value, 0, { nodes: 0, ...shared });
  if (new TextEncoder().encode(text).byteLength > JSON_RESOURCE_LIMITS.inputBytes) {
    throw new Error(
      `sqlx-js: Extended JSON document exceeds ${JSON_RESOURCE_LIMITS.inputBytes} UTF-8 bytes`,
    );
  }
  return text;
}

function encodeValue(value: unknown, depth: number, state: EncodeState): string {
  reserveNodes(state, 1);
  assertDepth(depth);
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (typeof value === "bigint") {
    const payload = encodedBigint(value, state);
    assertJsonBigintDigits(payload);
    return encodeTag("bigint", JSON.stringify(payload), depth, state);
  }
  const exactNumber = state.hooks.exactNumberText(value);
  if (exactNumber !== undefined) return exactNumber;
  const temporal = encodedTemporal(value, state);
  if (temporal) {
    return encodeTag(temporal.type, JSON.stringify(temporal.payload), depth, state);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeValue(item, depth + 1, state)).join(",")}]`;
  }
  if (!value || typeof value !== "object" || !state.hooks.isPlainRecord(value)) {
    throw new Error("sqlx-js: malformed SqlxJson document value");
  }
  return encodeObject(
    value as Record<string, unknown>,
    depth,
    Object.hasOwn(value, "$sqlx"),
    state,
  );
}

function measureEncodedValue(value: unknown, depth: number, state: MeasureState): void {
  reserveNodes(state, 1);
  assertDepth(depth);
  if (value === null) return state.budget.reserve(4);
  if (typeof value === "string") return state.budget.reserveString(value);
  if (typeof value === "boolean") return state.budget.reserve(value ? 4 : 5);
  if (typeof value === "number") {
    return state.budget.reserve((Object.is(value, -0) ? "0" : String(value)).length);
  }
  if (typeof value === "bigint") {
    const payload = encodedBigint(value, state);
    assertJsonBigintDigits(payload);
    return measureTag("bigint", depth, state, () => state.budget.reserveString(payload));
  }
  const exactNumber = state.hooks.exactNumberText(value);
  if (exactNumber !== undefined) return state.budget.reserve(exactNumber.length);
  const temporal = encodedTemporal(value, state);
  if (temporal) {
    return measureTag(
      temporal.type,
      depth,
      state,
      () => state.budget.reserveString(temporal.payload),
    );
  }
  if (Array.isArray(value)) {
    state.budget.reserve(2);
    for (let index = 0; index < value.length; index++) {
      if (index > 0) state.budget.reserve(1);
      measureEncodedValue(value[index], depth + 1, state);
    }
    return;
  }
  if (!value || typeof value !== "object" || !state.hooks.isPlainRecord(value)) {
    throw new Error("sqlx-js: malformed SqlxJson document value");
  }
  measureObject(value as Record<string, unknown>, depth, Object.hasOwn(value, "$sqlx"), state);
}

function encodedTemporal(value: unknown, state: EncodeState): EncodedTemporal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cached = state.temporals.get(value);
  if (cached !== undefined) return cached ?? undefined;
  const encoded = state.hooks.temporal(value) ?? null;
  state.temporals.set(value, encoded);
  return encoded ?? undefined;
}

function encodedBigint(value: bigint, state: EncodeState): string {
  let encoded = state.bigints.get(value);
  if (encoded === undefined) {
    encoded = value.toString();
    state.bigints.set(value, encoded);
  }
  return encoded;
}

function encodedObjectKeys(value: object, state: EncodeState): string[] {
  let keys = state.objectKeys.get(value);
  if (!keys) {
    keys = Object.keys(value).sort(compareKeys);
    state.objectKeys.set(value, keys);
  }
  return keys;
}

function measureObject(
  value: Record<string, unknown>,
  depth: number,
  escaped: boolean,
  state: MeasureState,
): void {
  const measureBody = () => {
    state.budget.reserve(2);
    const keys = encodedObjectKeys(value, state);
    for (let index = 0; index < keys.length; index++) {
      if (index > 0) state.budget.reserve(1);
      const key = keys[index]!;
      state.budget.reserveString(key);
      state.budget.reserve(1);
      measureEncodedValue(value[key], depth + (escaped ? 2 : 1), state);
    }
  };
  if (escaped) measureTag("object", depth, state, measureBody);
  else measureBody();
}

function measureTag(
  type: string,
  depth: number,
  state: MeasureState,
  measurePayload: () => void,
): void {
  assertDepth(depth + 2);
  reserveNodes(state, 4);
  state.budget.reserve('{"$sqlx":{"type":'.length);
  state.budget.reserveString(type);
  state.budget.reserve(`,"v":${state.protocolVersion}},"value":`.length);
  measurePayload();
  state.budget.reserve(1);
}

function encodeObject(
  value: Record<string, unknown>,
  depth: number,
  escaped: boolean,
  state: EncodeState,
): string {
  const childDepth = depth + (escaped ? 2 : 1);
  const body = encodedObjectKeys(value, state)
    .map((key) => `${JSON.stringify(key)}:${encodeValue(value[key], childDepth, state)}`)
    .join(",");
  return escaped ? encodeTag("object", `{${body}}`, depth, state) : `{${body}}`;
}

function encodeTag(type: string, payload: string, depth: number, state: EncodeState): string {
  assertDepth(depth + 2);
  reserveNodes(state, 4);
  return `{"$sqlx":{"type":${JSON.stringify(type)},"v":${state.protocolVersion}},"value":${payload}}`;
}

function assertDepth(depth: number): void {
  if (depth > JSON_RESOURCE_LIMITS.depth) {
    throw new Error(`sqlx-js: Extended JSON nesting exceeds ${JSON_RESOURCE_LIMITS.depth}`);
  }
}

function reserveNodes(state: EncodeState, count: number): void {
  state.nodes += count;
  if (state.nodes > JSON_RESOURCE_LIMITS.nodes) {
    throw new Error(`sqlx-js: Extended JSON node count exceeds ${JSON_RESOURCE_LIMITS.nodes}`);
  }
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
