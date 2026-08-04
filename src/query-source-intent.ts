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

export function resultElementNonNullOverrides(sites: readonly QueryCallSite[]): string[] {
  return [...new Set(sites.flatMap((site) => Object.entries(site.resultAssertions ?? {})
    .filter(([, assertion]) => assertion.elements === "non-null")
    .map(([column]) => column)))].sort();
}

export function sameResultElementNonNullOverrides(
  cached: readonly string[],
  current: readonly string[],
): boolean {
  return cached.length === current.length && cached.every((value, index) => value === current[index]);
}
