export type TemporalFactory = {
  readonly prototype: object;
  from(value: string): unknown;
} & (abstract new (...args: never[]) => unknown);

export type TemporalApi = {
  readonly Duration: TemporalFactory;
  readonly Instant: TemporalFactory;
  readonly PlainDate: TemporalFactory;
  readonly PlainDateTime: TemporalFactory;
  readonly PlainMonthDay: TemporalFactory;
  readonly PlainTime: TemporalFactory;
  readonly PlainYearMonth: TemporalFactory;
  readonly ZonedDateTime: TemporalFactory;
};

export type GlobalTemporalApi = typeof globalThis extends {
  readonly Temporal: infer Api extends TemporalApi;
} ? Api : never;
export type TemporalValue<
  Api extends TemporalApi,
  Name extends keyof TemporalApi,
> = Api[Name]["prototype"];

export type PgDate<Api extends TemporalApi = GlobalTemporalApi> = TemporalValue<Api, "PlainDate">;
export type PgTime<Api extends TemporalApi = GlobalTemporalApi> = TemporalValue<Api, "PlainTime">;
export type PgTimestamp<Api extends TemporalApi = GlobalTemporalApi> = TemporalValue<Api, "PlainDateTime">;
export type PgTimestamptz<Api extends TemporalApi = GlobalTemporalApi> = TemporalValue<Api, "Instant">;
export type TemporalJsonValue<Api extends TemporalApi = GlobalTemporalApi> =
  | TemporalValue<Api, "Duration">
  | TemporalValue<Api, "Instant">
  | TemporalValue<Api, "PlainDate">
  | TemporalValue<Api, "PlainDateTime">
  | TemporalValue<Api, "PlainMonthDay">
  | TemporalValue<Api, "PlainTime">
  | TemporalValue<Api, "PlainYearMonth">
  | TemporalValue<Api, "ZonedDateTime">;
export type TemporalTypeName =
  | "Temporal.Duration"
  | "Temporal.Instant"
  | "Temporal.PlainDate"
  | "Temporal.PlainDateTime"
  | "Temporal.PlainMonthDay"
  | "Temporal.PlainTime"
  | "Temporal.PlainYearMonth"
  | "Temporal.ZonedDateTime";
export type TemporalRuntimeValue = object & {
  readonly [Symbol.toStringTag]: TemporalTypeName;
  toString(): string;
};

const RESOLVED_TEMPORAL_APIS = new WeakMap<object, TemporalApi>();

export function resolveTemporalApi(api: TemporalApi | undefined): TemporalApi {
  const resolved = api ?? (globalThis as typeof globalThis & { Temporal?: TemporalApi }).Temporal;
  if (!resolved) {
    throw new Error(
      "sqlx-js: Temporal API is unavailable; use a runtime with globalThis.Temporal or install "
        + "temporal-polyfill and pass { temporalApi: Temporal } to createClient/createSqlClient",
    );
  }
  const cacheKey = (typeof resolved === "object" && resolved !== null) || typeof resolved === "function"
    ? resolved as object
    : undefined;
  const cached = cacheKey ? RESOLVED_TEMPORAL_APIS.get(cacheKey) : undefined;
  if (cached) return cached;
  const samples = {
    Duration: "PT1S",
    Instant: "2000-01-01T00:00:00Z",
    PlainDate: "2000-01-01",
    PlainDateTime: "2000-01-01T00:00:00",
    PlainMonthDay: "01-01",
    PlainTime: "00:00:00",
    PlainYearMonth: "2000-01",
    ZonedDateTime: "2000-01-01T00:00:00+00:00[UTC]",
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
  const snapshot: TemporalApi = Object.freeze({
    Duration: resolved.Duration,
    Instant: resolved.Instant,
    PlainDate: resolved.PlainDate,
    PlainDateTime: resolved.PlainDateTime,
    PlainMonthDay: resolved.PlainMonthDay,
    PlainTime: resolved.PlainTime,
    PlainYearMonth: resolved.PlainYearMonth,
    ZonedDateTime: resolved.ZonedDateTime,
  });
  if (cacheKey) RESOLVED_TEMPORAL_APIS.set(cacheKey, snapshot);
  RESOLVED_TEMPORAL_APIS.set(snapshot, snapshot);
  return snapshot;
}

export function isTemporalValue(value: unknown): value is TemporalRuntimeValue {
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
