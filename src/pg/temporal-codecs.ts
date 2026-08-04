import { isDateValue } from "../sql-value";
import type {
  PgDate,
  PgTime,
  PgTimestamp,
  PgTimestamptz,
  TemporalApi,
  TemporalFactory,
} from "../temporal-api";

export class TemporalInfinityError extends Error {
  readonly decodeHint = "Normalize PostgreSQL infinity sentinels in SQL with isfinite(...) before decoding";

  constructor(type: string) {
    super(`sqlx-js: PostgreSQL ${type} infinity is rejected by temporal.infinity policy`);
  }
}

export function postgresTemporalParsers(
  temporalApi: TemporalApi,
): Record<number, (value: string) => unknown> {
  return {
    1082: (value) => parseDate(value, temporalApi),
    1083: (value) => parseTime(value, temporalApi),
    1114: (value) => parseTimestamp(value, temporalApi),
    1184: (value) => parseTimestamptz(value, temporalApi),
  };
}

export function postgresTemporalSerializers(
  temporalApi: TemporalApi,
): Record<number, (value: unknown) => string> {
  return {
    1082: (value) => serializeDate(value, temporalApi),
    1083: (value) => serializeTime(value, temporalApi),
    1114: (value) => serializeTimestamp(value, temporalApi),
    1184: (value) => serializeTimestamptz(value, temporalApi),
  };
}

function parseDate(value: string, temporalApi: TemporalApi): PgDate {
  return parseTemporalValue<PgDate>(
    temporalApi.PlainDate,
    postgresTemporalIso(value, "date"),
    "date",
    "Temporal.PlainDate",
  );
}

function parseTime(value: string, temporalApi: TemporalApi): PgTime {
  rejectTemporalInfinity(value, "time");
  if (/^24:00(?::00(?:[.,]0+)?)?$/.test(value)) {
    throw new Error("sqlx-js: PostgreSQL time 24:00 has no lossless Temporal.PlainTime representation");
  }
  return parseTemporalValue<PgTime>(temporalApi.PlainTime, value, "time", "Temporal.PlainTime");
}

function parseTimestamp(value: string, temporalApi: TemporalApi): PgTimestamp {
  return parseTemporalValue<PgTimestamp>(
    temporalApi.PlainDateTime,
    postgresTemporalIso(value, "timestamp"),
    "timestamp",
    "Temporal.PlainDateTime",
  );
}

function parseTimestamptz(value: string, temporalApi: TemporalApi): PgTimestamptz {
  return parseTemporalValue<PgTimestamptz>(
    temporalApi.Instant,
    postgresTemporalIso(value, "timestamptz"),
    "timestamptz",
    "Temporal.Instant",
  );
}

function parseTemporalValue<T>(
  factory: TemporalFactory,
  value: string,
  postgresType: string,
  temporalType: string,
): T {
  if (/(?:^|T)\d{2}:\d{2}:60(?:[.,]\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)?$/.test(value)) {
    throw new Error(
      `sqlx-js: PostgreSQL ${postgresType} leap second has no lossless ${temporalType} representation`,
    );
  }
  let parsed: unknown;
  try {
    parsed = factory.from(value);
  } catch (cause) {
    throw new Error(
      `sqlx-js: PostgreSQL ${postgresType} value ${JSON.stringify(value)} is outside ${temporalType} range`,
      { cause },
    );
  }
  if (!(parsed instanceof (factory as unknown as abstract new (...args: never[]) => T))) {
    throw new Error(`sqlx-js: temporalApi.${temporalType.slice("Temporal.".length)}.from returned an incompatible value`);
  }
  return parsed;
}

function postgresTemporalIso(
  postgresValue: string,
  kind: "date" | "timestamp" | "timestamptz",
): string {
  rejectTemporalInfinity(postgresValue, kind);
  const bc = postgresValue.endsWith(" BC");
  const raw = bc ? postgresValue.slice(0, -3) : postgresValue;
  const match = /^(\d+)(.*)$/.exec(raw);
  const postgresYear = match ? Number(match[1]) : Number.NaN;
  const year = bc ? 1 - postgresYear : postgresYear;
  const isoYear = Number.isSafeInteger(year)
    ? year >= 0 && year <= 9999
      ? String(year).padStart(4, "0")
      : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`
    : "";
  return `${isoYear}${match?.[2] ?? ""}`.replace(" ", "T");
}

function serializeDate(value: unknown, temporalApi: TemporalApi): string {
  assertTemporalInstance<PgDate>(value, temporalApi.PlainDate, "Temporal.PlainDate", "date");
  assertIsoCalendar(value, "date");
  return formatPostgresDate(value);
}

function serializeTime(value: unknown, temporalApi: TemporalApi): string {
  assertTemporalInstance<PgTime>(value, temporalApi.PlainTime, "Temporal.PlainTime", "time");
  return formatPostgresTime(value, "time");
}

function serializeTimestamp(value: unknown, temporalApi: TemporalApi): string {
  assertTemporalInstance<PgTimestamp>(value, temporalApi.PlainDateTime, "Temporal.PlainDateTime", "timestamp");
  assertIsoCalendar(value, "timestamp");
  const { date, era } = postgresDate(value);
  return `${date}T${formatPostgresTime(value, "timestamp")}${era}`;
}

function serializeTimestamptz(value: unknown, temporalApi: TemporalApi): string {
  assertTemporalInstance<PgTimestamptz>(value, temporalApi.Instant, "Temporal.Instant", "timestamptz");
  if (value.epochNanoseconds % 1_000n !== 0n) {
    throw new Error("sqlx-js: Temporal.Instant has sub-microsecond precision that PostgreSQL cannot preserve");
  }
  return formatPostgresInstant(value);
}

function formatPostgresInstant(value: PgTimestamptz): string {
  const iso = value.toString({ fractionalSecondDigits: 6 });
  const match = /^([+-]?\d+)(.*)$/.exec(iso);
  if (!match) throw new Error("sqlx-js: Temporal.Instant produced an invalid ISO value");
  const year = Number(match[1]);
  if (!Number.isSafeInteger(year)) {
    throw new Error("sqlx-js: Temporal.Instant year is outside PostgreSQL's supported range");
  }
  const postgresYear = year <= 0 ? 1 - year : year;
  return `${String(postgresYear).padStart(4, "0")}${match[2]}${year <= 0 ? " BC" : ""}`;
}

function assertTemporalInstance<T>(
  value: unknown,
  constructor: { prototype: object },
  expected: string,
  postgresType: string,
): asserts value is T {
  if (!(value instanceof (constructor as unknown as abstract new (...args: never[]) => T))) {
    if (isDateValue(value)) {
      throw new Error(`sqlx-js: PostgreSQL ${postgresType} does not accept JavaScript Date; use ${expected}`);
    }
    throw new Error(`sqlx-js: PostgreSQL ${postgresType} requires ${expected}`);
  }
}

function assertIsoCalendar(value: { calendarId: string }, postgresType: string): void {
  if (value.calendarId !== "iso8601") {
    throw new Error(`sqlx-js: PostgreSQL ${postgresType} requires an ISO 8601 Temporal calendar`);
  }
}

function formatPostgresDate(value: { year: number; month: number; day: number }): string {
  const { date, era } = postgresDate(value);
  return `${date}${era}`;
}

function postgresDate(value: { year: number; month: number; day: number }): {
  date: string;
  era: string;
} {
  const year = value.year;
  const postgresYear = year <= 0 ? 1 - year : year;
  const date = [
    String(postgresYear).padStart(4, "0"),
    String(value.month).padStart(2, "0"),
    String(value.day).padStart(2, "0"),
  ].join("-");
  return { date, era: year <= 0 ? " BC" : "" };
}

function formatPostgresTime(
  value: {
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
    microsecond: number;
    nanosecond: number;
  },
  postgresType: string,
): string {
  if (value.nanosecond !== 0) {
    throw new Error(
      `sqlx-js: Temporal value for PostgreSQL ${postgresType} has sub-microsecond precision that PostgreSQL cannot preserve`,
    );
  }
  const time = [
    String(value.hour).padStart(2, "0"),
    String(value.minute).padStart(2, "0"),
    String(value.second).padStart(2, "0"),
  ].join(":");
  const microseconds = String(value.millisecond * 1_000 + value.microsecond).padStart(6, "0");
  return `${time}.${microseconds}`;
}

function rejectTemporalInfinity<T>(value: T, type: string): T {
  if (value === "infinity" || value === "-infinity") {
    throw new TemporalInfinityError(type);
  }
  return value;
}
