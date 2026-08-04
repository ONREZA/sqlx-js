import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";
import {
  EXTENDED_JSON_PROTOCOL_VERSION,
  JsonNumber,
  SqlxJson,
  createSqlxJson,
  isSqlxJson,
  parseJsonResult,
  stringifyJsonParameter,
} from "../src/json-value";

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
    expect(decoded.value).toEqual({
      a: true,
      exact: JsonNumber.from("12345678901234567890.12500"),
      id: 9_007_199_254_740_993n,
      z: 0,
    });
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

  test("validate an explicit Temporal provider before decoding tags", () => {
    const brokenTemporal = { ...Temporal, Instant: {} } as never;
    expect(() => SqlxJson.parse(
      '{"$sqlx":{"type":"temporal.Instant","v":1},"value":"2026-08-04T10:15:30Z"}',
      { temporalApi: brokenTemporal },
    )).toThrow("temporalApi.Instant must be a Temporal constructor");
  });

  test("reuse an immutable snapshot of a validated Temporal provider", () => {
    const provider = { ...Temporal } as unknown as Record<string, unknown>;
    const encoded = '{"$sqlx":{"type":"temporal.Instant","v":1},"value":"2026-08-04T10:15:30Z"}';
    expect(String(SqlxJson.parse(encoded, { temporalApi: provider as never }).value))
      .toBe("2026-08-04T10:15:30Z");
    provider.Instant = {};
    expect(String(SqlxJson.parse(encoded, { temporalApi: provider as never }).value))
      .toBe("2026-08-04T10:15:30Z");
  });
});

describe("Extended JSON validation", () => {
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
  });
});
