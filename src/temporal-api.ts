import type { Temporal as TemporalTypes } from "@js-temporal/polyfill";

export type TemporalFactory = {
  readonly prototype: object;
  from(value: string): unknown;
} & (abstract new (...args: never[]) => unknown);

export type TemporalApi = {
  readonly Instant: TemporalFactory;
  readonly PlainDate: TemporalFactory;
  readonly PlainDateTime: TemporalFactory;
  readonly PlainTime: TemporalFactory;
};

export type PgDate = TemporalTypes.PlainDate;
export type PgTime = TemporalTypes.PlainTime;
export type PgTimestamp = TemporalTypes.PlainDateTime;
export type PgTimestamptz = TemporalTypes.Instant;
export type TemporalJsonValue =
  | TemporalTypes.Duration
  | TemporalTypes.Instant
  | TemporalTypes.PlainDate
  | TemporalTypes.PlainDateTime
  | TemporalTypes.PlainMonthDay
  | TemporalTypes.PlainTime
  | TemporalTypes.PlainYearMonth
  | TemporalTypes.ZonedDateTime;

export function resolveTemporalApi(api: TemporalApi | undefined): TemporalApi {
  const resolved = api ?? (globalThis as typeof globalThis & { Temporal?: TemporalApi }).Temporal;
  if (!resolved) {
    throw new Error(
      "sqlx-js: Temporal API is unavailable; use a runtime with globalThis.Temporal or install "
        + "@js-temporal/polyfill and pass { temporalApi: Temporal } to createClient/createSqlClient, "
        + "or call configureDefaultTemporalApi(Temporal) before using deprecated global exports",
    );
  }
  const samples = {
    Instant: "2000-01-01T00:00:00Z",
    PlainDate: "2000-01-01",
    PlainDateTime: "2000-01-01T00:00:00",
    PlainTime: "00:00:00",
  } as const;
  for (const name of Object.keys(samples) as (keyof typeof samples)[]) {
    const factory = resolved[name];
    if (typeof factory !== "function" || typeof factory.prototype !== "object") {
      throw new Error(`sqlx-js: temporalApi.${name} must be a Temporal constructor`);
    }
    if (typeof factory.from !== "function") {
      throw new Error(`sqlx-js: temporalApi.${name}.from must be a function`);
    }
    let parsed: unknown;
    try {
      parsed = factory.from(samples[name]);
    } catch (cause) {
      throw new Error(`sqlx-js: temporalApi.${name}.from failed its compatibility check`, { cause });
    }
    if (!(parsed instanceof factory)) {
      throw new Error(`sqlx-js: temporalApi.${name}.from returned an incompatible value`);
    }
  }
  return resolved;
}

export function isTemporalValue(value: unknown): value is TemporalJsonValue {
  if (!value || typeof value !== "object") return false;
  const tag = (value as { readonly [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
  return tag === "Temporal.Duration"
    || tag === "Temporal.Instant"
    || tag === "Temporal.PlainDate"
    || tag === "Temporal.PlainTime"
    || tag === "Temporal.PlainDateTime"
    || tag === "Temporal.PlainMonthDay"
    || tag === "Temporal.PlainYearMonth"
    || tag === "Temporal.ZonedDateTime";
}
