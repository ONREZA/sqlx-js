export type TimestampWithoutTimeZoneMode = "allow" | "reject";

export type TemporalPolicy = {
  readonly infinity: "reject";
  readonly timestampWithoutTimeZone: TimestampWithoutTimeZoneMode;
  readonly sessionTimeZone: "UTC";
};

export type TemporalPolicyOptions = {
  readonly infinity?: "reject";
  readonly timestampWithoutTimeZone?: TimestampWithoutTimeZoneMode;
  readonly sessionTimeZone?: "UTC";
};

export const DEFAULT_TEMPORAL_POLICY: TemporalPolicy = Object.freeze({
  infinity: "reject",
  timestampWithoutTimeZone: "reject",
  sessionTimeZone: "UTC",
});

export function resolveTemporalPolicy(
  policy: TemporalPolicyOptions | undefined,
): TemporalPolicy {
  if (policy === undefined) return DEFAULT_TEMPORAL_POLICY;
  if (!policy || typeof policy !== "object") {
    throw new Error("sqlx-js: temporal must be an object");
  }
  const unknown = Object.keys(policy).find((key) =>
    key !== "infinity" && key !== "timestampWithoutTimeZone" && key !== "sessionTimeZone"
  );
  if (unknown) throw new Error(`sqlx-js: temporal has unknown option ${JSON.stringify(unknown)}`);
  if (policy.infinity !== undefined && policy.infinity !== "reject") {
    throw new Error("sqlx-js: temporal.infinity must be reject because PostgreSQL infinity has no Temporal representation");
  }
  if (
    policy.timestampWithoutTimeZone !== undefined
    && policy.timestampWithoutTimeZone !== "allow"
    && policy.timestampWithoutTimeZone !== "reject"
  ) {
    throw new Error("sqlx-js: temporal.timestampWithoutTimeZone must be allow or reject");
  }
  if (policy.sessionTimeZone !== undefined && policy.sessionTimeZone !== "UTC") {
    throw new Error("sqlx-js: temporal.sessionTimeZone must be UTC");
  }
  return Object.freeze({
    infinity: "reject",
    timestampWithoutTimeZone: policy.timestampWithoutTimeZone ?? "reject",
    sessionTimeZone: "UTC",
  });
}
