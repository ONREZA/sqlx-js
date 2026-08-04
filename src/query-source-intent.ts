import type { QueryCallSite } from "./scan/scanner";

export function nullableParamOverrides(sites: readonly QueryCallSite[]): number[] {
  return [...new Set(sites.flatMap((site) => site.nullableParams ?? []))].sort((a, b) => a - b);
}

export function sameNullableParamOverrides(
  cached: readonly number[],
  current: readonly number[],
): boolean {
  return cached.length === current.length && cached.every((value, index) => value === current[index]);
}
