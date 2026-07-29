export type TemporalInfinityMode = "preserve" | "reject";

export type TemporalPolicy = {
  readonly infinity: TemporalInfinityMode;
};

export const DEFAULT_TEMPORAL_POLICY: TemporalPolicy = Object.freeze({
  infinity: "preserve",
});

export function resolveTemporalPolicy(
  policy: TemporalPolicy | undefined,
): TemporalPolicy {
  if (policy === undefined) return DEFAULT_TEMPORAL_POLICY;
  if (
    !policy
    || typeof policy !== "object"
    || (policy.infinity !== "preserve" && policy.infinity !== "reject")
  ) {
    throw new Error("sqlx-js: temporal.infinity must be preserve or reject");
  }
  return Object.freeze({ infinity: policy.infinity });
}
