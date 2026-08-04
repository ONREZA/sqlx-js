import { randomBytes } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CACHE_FORMAT_VERSION,
  GENERATOR_REVISION,
  RUNTIME_DESCRIPTOR_FILE,
  RUNTIME_DESCRIPTOR_FORMAT_VERSION,
} from "./artifact-versions";
import { fingerprint, type CacheEntry } from "./cache";
import type { DatabaseProfiles } from "./config";
import { resolveTemporalPolicy, type TemporalPolicyOptions } from "./temporal";
import type {
  RuntimeDescriptorProfile,
  RuntimeDescriptorType,
  RuntimeQueryDescriptor,
  RuntimeQueryDescriptors,
} from "./runtime-descriptors";

export { RUNTIME_DESCRIPTOR_FILE };

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  return Object.fromEntries([...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

export function renderRuntimeDescriptors(
  entries: readonly CacheEntry[],
  configHash: string,
  profiles: DatabaseProfiles = {},
  temporal?: TemporalPolicyOptions,
): string {
  const types = new Map<string, RuntimeDescriptorType>();
  const queries = new Map<string, RuntimeQueryDescriptor>();
  const profileQueries = new Map<string, Map<string, RuntimeQueryDescriptor>>();
  for (const name of Object.keys(profiles)) profileQueries.set(name, new Map());

  for (const entry of entries) {
    if (entry.paramTypeIdentities.length !== entry.paramTsTypes.length) {
      throw new Error("sqlx-js: cache entry has incomplete parameter type identities. Run `sqlx-js prepare`.");
    }
    if (entry.paramTypeIdentities.length === 0) continue;
    const params = entry.paramTypeIdentities.map((identity) => {
      if (typeof identity === "number") return identity;
      const key = JSON.stringify([identity.schema, identity.name]);
      types.set(key, identity);
      return key;
    });
    const descriptor: RuntimeQueryDescriptor = {
      params,
    };
    const id = fingerprint(entry.query);
    if (entry.profile) {
      const target = profileQueries.get(entry.profile);
      if (!target) {
        throw new Error(`sqlx-js: cache entry references unknown profile ${entry.profile}`);
      }
      target.set(id, descriptor);
    } else {
      queries.set(id, descriptor);
    }
  }

  const renderedProfiles = new Map<string, RuntimeDescriptorProfile>();
  for (const [name, profile] of Object.entries(profiles)) {
    renderedProfiles.set(name, {
      role: profile.role,
      queries: sortedRecord(profileQueries.get(name) ?? []),
    });
  }
  const artifact: RuntimeQueryDescriptors = {
    formatVersion: RUNTIME_DESCRIPTOR_FORMAT_VERSION,
    cacheFormat: CACHE_FORMAT_VERSION,
    generatorRevision: GENERATOR_REVISION,
    configHash,
    temporal: resolveTemporalPolicy(temporal),
    types: sortedRecord(types),
    queries: sortedRecord(queries),
    profiles: sortedRecord(renderedProfiles),
  };
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function runtimeDescriptorPath(cacheDir: string): string {
  return join(cacheDir, RUNTIME_DESCRIPTOR_FILE);
}

export function writeRuntimeDescriptors(
  cacheDir: string,
  entries: readonly CacheEntry[],
  configHash: string,
  profiles: DatabaseProfiles = {},
  temporal?: TemporalPolicyOptions,
): void {
  const path = runtimeDescriptorPath(cacheDir);
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, renderRuntimeDescriptors(entries, configHash, profiles, temporal));
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}
