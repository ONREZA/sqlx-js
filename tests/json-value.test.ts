import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill";
import { isDeepStrictEqual } from "node:util";
import {
  EXTENDED_JSON_PROTOCOL_VERSION,
  JsonNumber,
  SqlxJson,
  createSqlxJson,
  isSqlxJson,
  parseJsonResult,
  stringifyJsonParameter,
} from "../src/json-value";
import { canonicalJsonNumber, canonicalJsonNumberBytes } from "../src/json-number";
import { JsonEncodingBudget, JSON_RESOURCE_LIMITS } from "../src/json-limits";
import { serializeExtendedJson } from "../src/json-encoding";

function temporalApiFixture() {
  return {
    Duration: Temporal.Duration,
    Instant: Temporal.Instant,
    PlainDate: Temporal.PlainDate,
    PlainDateTime: Temporal.PlainDateTime,
    PlainMonthDay: Temporal.PlainMonthDay,
    PlainTime: Temporal.PlainTime,
    PlainYearMonth: Temporal.PlainYearMonth,
    ZonedDateTime: Temporal.ZonedDateTime,
  };
}

describe("SqlxJson documents", () => {
  test("snapshot and deeply freeze plain values", () => {
    const source = { nested: { value: 1 }, items: [true, null] };
    const document = createSqlxJson(source);

    source.nested.value = 2;
    source.items.push(false);

    expect(document.protocolVersion).toBe(EXTENDED_JSON_PROTOCOL_VERSION);
    expect(document.value).toEqual({ nested: { value: 1 }, items: [true, null] });
    expect(isSqlxJson(document)).toBeTrue();
    expect(Object.isFrozen(document)).toBeTrue();
    expect(Object.isFrozen(document.value)).toBeTrue();
    expect(Object.isFrozen(document.value.nested)).toBeTrue();
    expect(Object.isFrozen(document.value.items)).toBeTrue();
  });

  test("canonicalize keys, bigint, exact numbers, and negative zero", () => {
    const document = createSqlxJson({
      z: -0,
      exact: JsonNumber.from("12345678901234567890.12500"),
      id: 9_007_199_254_740_993n,
      a: true,
    });

    expect(SqlxJson.stringify(document)).toBe(
      '{"a":true,"exact":12345678901234567890.12500,'
      + '"id":{"$sqlx":{"type":"bigint","v":1},"value":"9007199254740993"},"z":0}',
    );

    const decoded = SqlxJson.parse(SqlxJson.stringify(document), { temporalApi: Temporal });
    expect(isSqlxJson(decoded)).toBeTrue();
    expect(decoded.value).toEqual({
      a: true,
      exact: JsonNumber.from("12345678901234567890.12500"),
      id: 9_007_199_254_740_993n,
      z: 0,
    });
  });

  test("preserve exact-number values in deep equality", () => {
    const one = JsonNumber.from("1");
    const anotherOne = JsonNumber.from("1");
    const two = JsonNumber.from("2");

    expect(one).toEqual(anotherOne);
    expect(one).not.toEqual(two);
    expect(isDeepStrictEqual(one, anotherOne)).toBeTrue();
    expect(isDeepStrictEqual(one, two)).toBeFalse();
    expect(Object.isFrozen(one)).toBeTrue();
  });

  test("escape application-owned reserved keys without moving ordinary paths", () => {
    const document = createSqlxJson({
      ordinary: { value: 1 },
      collision: { $sqlx: "application", value: 2n },
    });
    const text = SqlxJson.stringify(document);

    expect(text).toContain(
      '"collision":{"$sqlx":{"type":"object","v":1},"value":{"$sqlx":"application",'
      + '"value":{"$sqlx":{"type":"bigint","v":1},"value":"2"}}}',
    );
    expect(text).toContain('"ordinary":{"value":1}');
    expect(SqlxJson.parse(text, { temporalApi: Temporal }).value).toEqual(document.value);
  });

  test("round-trip every supported Temporal value through its provider", () => {
    const document = createSqlxJson({
      duration: Temporal.Duration.from("P1DT2H3M4.005006007S"),
      instant: Temporal.Instant.from("2026-08-04T10:15:30.123456789Z"),
      date: Temporal.PlainDate.from("2026-08-04"),
      dateTime: Temporal.PlainDateTime.from("2026-08-04T10:15:30.123456789"),
      monthDay: Temporal.PlainMonthDay.from("08-04"),
      time: Temporal.PlainTime.from("10:15:30.123456789"),
      yearMonth: Temporal.PlainYearMonth.from("2026-08"),
      zoned: Temporal.ZonedDateTime.from("2026-08-04T10:15:30.123456789+03:00[Europe/Moscow]"),
    });
    const decoded = SqlxJson.parse(SqlxJson.stringify(document), { temporalApi: Temporal });

    for (const [key, value] of Object.entries(decoded.value)) {
      expect(String(value), key).toBe(String(document.value[key as keyof typeof document.value]));
      expect(Object.isFrozen(value), key).toBeTrue();
    }
  });
});

describe("Extended JSON parsing", () => {
  test("read old untagged JSON without losing native numeric tokens", () => {
    const document = parseJsonResult(
      '{"safe":9007199254740991,"large":9007199254740993,'
      + '"decimal":12345678901234567890.125,"fraction":0.1,"overflow":1e400,"underflow":1e-4000}',
      Temporal,
    );

    expect(document.value).toEqual({
      safe: 9_007_199_254_740_991,
      large: JsonNumber.from("9007199254740993"),
      decimal: JsonNumber.from("12345678901234567890.125"),
      fraction: 0.1,
      overflow: JsonNumber.from(`1${"0".repeat(400)}`),
      underflow: JsonNumber.from(`0.${"0".repeat(3999)}1`),
    });
  });

  test("bound cumulative exponent expansion before materializing numbers", () => {
    const token = "1e131071";
    const compactDocument = `[${Array.from({ length: 129 }, () => token).join(",")}]`;

    expect(new TextEncoder().encode(compactDocument).byteLength).toBeLessThan(2_000);
    expect(() => SqlxJson.parse(compactDocument)).toThrow(
      "Extended JSON canonical number data exceeds 16777216 bytes",
    );

    const decoded = SqlxJson.parse(`[${token}]`).value as readonly JsonNumber[];
    expect(decoded[0]?.toString().length).toBe(131_072);

    const exact = JsonNumber.from(token);
    expect(() => createSqlxJson(Array.from({ length: 129 }, () => exact))).toThrow(
      "Extended JSON canonical number data exceeds 16777216 bytes",
    );
    expect(() => createSqlxJson(Array.from({ length: 60_000 }, () => 1e-300))).toThrow(
      "Extended JSON canonical number data exceeds 16777216 bytes",
    );

    const compactNumbers = Array.from({ length: 55_553 }, () => 1e-300);
    const taggedValues = Array.from({ length: 1_000 }, () => 1n);
    expect(() => createSqlxJson([...compactNumbers, ...taggedValues])).toThrow(
      "Extended JSON canonical number data exceeds 16777216 bytes",
    );
  });

  test("measure canonical numbers without diverging from materialization", () => {
    for (const token of ["0", "-0", "1", "-1", "123.4500", "0.00100", "1e400", "1e-4000"]) {
      expect(canonicalJsonNumberBytes(token), token).toBe(canonicalJsonNumber(token).length);
    }
  });

  test("reject duplicate keys and malformed or unknown control tags", () => {
    expect(() => SqlxJson.parse('{"a":1,"a":2}')).toThrow("duplicate object key");
    expect(() => SqlxJson.parse('{"$sqlx":{"type":"bigint","v":2},"value":"1"}'))
      .toThrow("unknown Extended JSON protocol version");
    expect(() => SqlxJson.parse('{"$sqlx":{"type":"future","v":1},"value":1}'))
      .toThrow('unknown Extended JSON tag type "future"');
    expect(() => SqlxJson.parse('{"$sqlx":{"type":"bigint","v":1,"extra":true},"value":"1"}'))
      .toThrow("malformed Extended JSON $sqlx control");
    expect(() => SqlxJson.parse('{"$sqlx":"legacy"}')).toThrow("malformed Extended JSON tagged node");

    const oversizedTag = "x".repeat(10_000);
    let oversizedTagError: Error | undefined;
    try {
      SqlxJson.parse(`{"$sqlx":{"type":"${oversizedTag}","v":1},"value":1}`);
    } catch (error) {
      oversizedTagError = error as Error;
    }
    expect(oversizedTagError?.message).toContain("unknown Extended JSON tag type");
    expect(oversizedTagError?.message.length).toBeLessThan(300);
  });

  test("construct object keys as data and keep the result immutable", () => {
    const document = SqlxJson.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2}');
    const value = document.value as Record<string, unknown>;

    expect(Object.hasOwn(value, "__proto__")).toBeTrue();
    expect(value.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.isFrozen(value)).toBeTrue();
  });

  test("reject excessive nesting and invalid exact-number input", () => {
    const nested = `${"[".repeat(130)}0${"]".repeat(130)}`;
    expect(() => SqlxJson.parse(nested)).toThrow("nesting exceeds 128");

    let tagged: unknown = 1n;
    for (let depth = 0; depth < 128; depth++) tagged = [tagged];
    expect(() => createSqlxJson(tagged as never)).toThrow("nesting exceeds 128");

    expect(() => createSqlxJson(Array.from({ length: 20_000 }, () => 1n))).toThrow(
      "node count exceeds 100000",
    );
    expect(() => JsonNumber.from("01")).toThrow("invalid JSON number");
    expect(() => JsonNumber.from("1e200000")).toThrow("exponent exceeds PostgreSQL jsonb numeric limits");
    expect(() => JsonNumber.from("1e131072")).toThrow("exceeds PostgreSQL jsonb numeric limits");

    const RuntimeJsonNumber = JsonNumber as unknown as new (value: unknown) => JsonNumber;
    expect(() => new RuntimeJsonNumber(1)).toThrow("requires a JSON number string");
    expect(() => new RuntimeJsonNumber('0,"injected":true')).toThrow("invalid JSON number");
    class JsonNumberSubclass extends RuntimeJsonNumber {
      override toString(): string {
        return '0,"injected":true';
      }
    }
    expect(SqlxJson.stringify(createSqlxJson({ amount: new JsonNumberSubclass("1") })))
      .toBe('{"amount":1}');

    const oversizedBigint = "1".repeat(131_073);
    expect(() => SqlxJson.parse(
      `{"$sqlx":{"type":"bigint","v":1},"value":"${oversizedBigint}"}`,
    )).toThrow("Extended JSON bigint exceeds 131072 decimal digits");
  });

  test("reject prototype-spoofed exact numbers", () => {
    const legitimate = JsonNumber.from("1");
    const comparableValue = Object.getOwnPropertySymbols(legitimate)[0]!;
    const fake = Object.create(JsonNumber.prototype) as Record<PropertyKey, unknown>;
    Object.defineProperty(fake, comparableValue, { value: '0,"role":"admin"' });

    expect(comparableValue).toBeDefined();
    expect(fake instanceof JsonNumber).toBeTrue();
    expect(() => createSqlxJson({ role: "user", value: fake } as never))
      .toThrow("Extended JSON objects must be plain records");
  });

  test("validate an explicit Temporal provider before decoding tags", () => {
    const brokenTemporal = { ...temporalApiFixture(), Instant: {} } as never;
    expect(() => SqlxJson.parse(
      '{"$sqlx":{"type":"temporal.Instant","v":1},"value":"2026-08-04T10:15:30Z"}',
      { temporalApi: brokenTemporal },
    )).toThrow("temporalApi.Instant must be a Temporal constructor");
  });

  test("reuse an immutable snapshot of a validated Temporal provider", () => {
    const provider = temporalApiFixture() as unknown as Record<string, unknown>;
    const encoded = '{"$sqlx":{"type":"temporal.Instant","v":1},"value":"2026-08-04T10:15:30Z"}';
    expect(String(SqlxJson.parse(encoded, { temporalApi: provider as never }).value))
      .toBe("2026-08-04T10:15:30Z");
    provider.Instant = {};
    expect(String(SqlxJson.parse(encoded, { temporalApi: provider as never }).value))
      .toBe("2026-08-04T10:15:30Z");
  });
});

describe("Extended JSON validation", () => {
  test("measure JSON string bytes exactly", () => {
    for (const value of [
      "plain",
      "\"\\\b\t\n\f\r\u0000\u001f",
      "é€😀",
      "\ud800",
      "\udc00",
    ]) {
      const budget = new JsonEncodingBudget();
      budget.reserveString(value);
      expect(budget.bytes, JSON.stringify(value)).toBe(
        new TextEncoder().encode(JSON.stringify(value)).byteLength,
      );
    }
  });

  test("preflight serialized bytes before repeated values amplify output", () => {
    const escaped = "\0".repeat(1_500_000);
    expect(() => createSqlxJson(Array.from({ length: 20_000 }, () => escaped))).toThrow(
      "Extended JSON document exceeds 16777216 UTF-8 bytes",
    );

    const largeBigint = BigInt("9".repeat(131_072));
    expect(() => createSqlxJson(Array.from({ length: 20_000 }, () => largeBigint))).toThrow(
      "Extended JSON document exceeds 16777216 UTF-8 bytes",
    );
  });

  test("accept the exact encoded document byte boundary", () => {
    const controlCharacters = (JSON_RESOURCE_LIMITS.inputBytes - 4) / 6;
    const atLimit = `${"\0".repeat(controlCharacters)}aa`;
    const encoded = SqlxJson.stringify(createSqlxJson(atLimit));

    expect(new TextEncoder().encode(encoded).byteLength).toBe(JSON_RESOURCE_LIMITS.inputBytes);
    expect(() => createSqlxJson(`${atLimit}a`)).toThrow(
      `Extended JSON document exceeds ${JSON_RESOURCE_LIMITS.inputBytes} UTF-8 bytes`,
    );
  });

  test("reuse one Temporal encoding across preflight and output", () => {
    const temporal = {};
    let encodings = 0;
    const encoded = serializeExtendedJson(temporal, EXTENDED_JSON_PROTOCOL_VERSION, {
      exactNumberText: () => undefined,
      temporal(value) {
        expect(value).toBe(temporal);
        encodings++;
        return { type: "temporal.Instant", payload: "2026-08-05T00:00:00Z" };
      },
      isPlainRecord: () => false,
    });

    expect(encodings).toBe(1);
    expect(encoded).toContain('"value":"2026-08-05T00:00:00Z"');
  });

  test("fail closed on non-deterministic application values", () => {
    expect(() => createSqlxJson(new Date() as never)).toThrow("JavaScript Date is not supported");
    expect(() => createSqlxJson({ missing: undefined } as never)).toThrow("undefined values");
    expect(() => createSqlxJson([undefined] as never)).toThrow("holes, accessors, or undefined elements");
    expect(() => createSqlxJson(new Map() as never)).toThrow("must be plain records");
    expect(() => createSqlxJson({ toJSON: () => 1 } as never)).toThrow("custom toJSON methods");
    expect(() => createSqlxJson({ value: Number.MAX_SAFE_INTEGER + 1 } as never)).toThrow(
      "use bigint or JsonNumber.from(...) instead",
    );
    expect(() => createSqlxJson({ value: Number.POSITIVE_INFINITY } as never)).toThrow("must be finite");
    expect(() => createSqlxJson(Object.defineProperty({}, "hidden", {
      get: () => 1,
    }) as never)).toThrow("accessor properties");
  });

  test("stringifier accepts only branded documents", () => {
    expect(() => stringifyJsonParameter({ value: 1 } as never)).toThrow("require a SqlxJson document");

    const legitimate = createSqlxJson({ safe: true });
    const brand = Object.getOwnPropertySymbols(legitimate)[0] ?? Symbol("spoofed");
    const fake = Object.create(SqlxJson.prototype) as Record<PropertyKey, unknown>;
    Object.defineProperties(fake, {
      [brand]: { value: EXTENDED_JSON_PROTOCOL_VERSION },
      protocolVersion: { value: EXTENDED_JSON_PROTOCOL_VERSION },
      value: { value: { safe: false } },
    });

    expect(fake instanceof SqlxJson).toBeTrue();
    expect(isSqlxJson(fake)).toBeFalse();
    expect(() => stringifyJsonParameter(fake as never)).toThrow("require a SqlxJson document");
    expect(Object.getOwnPropertySymbols(legitimate)).toEqual([]);
  });
});
