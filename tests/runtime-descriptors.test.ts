import { expect, test } from "bun:test";
import {
  CACHE_FORMAT_VERSION,
  GENERATOR_REVISION,
  RUNTIME_DESCRIPTOR_FORMAT_VERSION,
} from "../src/artifact-versions";
import { fingerprint, type CacheEntry } from "../src/cache";
import { renderRuntimeDescriptors } from "../src/runtime-descriptor-artifact";
import {
  prepareRuntimeDescriptors,
  type RuntimeQueryDescriptors,
} from "../src/runtime-descriptors";

function entry(
  query: string,
  paramTypeIdentities: CacheEntry["paramTypeIdentities"],
  profile?: string,
): CacheEntry {
  return {
    query,
    ...(profile ? { profile } : {}),
    validation: "planned",
    paramOids: paramTypeIdentities.map((identity) => typeof identity === "number" ? identity : 0),
    paramTypeIdentities,
    paramTsTypes: paramTypeIdentities.map(() => "unknown"),
    paramNullable: paramTypeIdentities.map(() => false),
    nullableParamOverrides: [],
    resultElementNonNullOverrides: [],
    columns: [],
    hasResultSet: false,
    inference: {
      columns: [],
      params: paramTypeIdentities.map(() => ({
        targets: [],
        reason: "test fixture",
      })),
    },
  };
}

test("runtime descriptor rendering deduplicates database-local types and binds profiles", () => {
  const status = { schema: "app", name: "status" };
  const entries = [
    entry("SELECT 1", []),
    entry("SELECT $value::int4", [23]),
    entry("SELECT $1::app.status", [status], "api"),
    entry("SELECT $1::app.status, $2::app.status", [status, status], "worker"),
  ];
  const profiles = {
    api: { name: "api", role: "app_api" },
    worker: { name: "worker", role: "app_worker" },
  } as const;
  const artifact = JSON.parse(
    renderRuntimeDescriptors(entries, "config-hash", profiles),
  ) as RuntimeQueryDescriptors;
  const key = JSON.stringify(["app", "status"]);

  expect(artifact).toMatchObject({
    formatVersion: RUNTIME_DESCRIPTOR_FORMAT_VERSION,
    cacheFormat: CACHE_FORMAT_VERSION,
    generatorRevision: GENERATOR_REVISION,
    configHash: "config-hash",
    temporal: { infinity: "preserve" },
    types: { [key]: status },
    profiles: {
      api: { role: "app_api" },
      worker: { role: "app_worker" },
    },
  });
  expect(Object.keys(artifact.types)).toEqual([key]);
  expect(artifact.queries[fingerprint("SELECT 1")]).toBeUndefined();
  expect(artifact.queries[fingerprint("SELECT $value::int4")]).toEqual({
    params: [23],
  });
  expect(prepareRuntimeDescriptors(artifact, profiles.api)).toMatchObject({
    types: [{ key, ...status }],
    temporal: { infinity: "preserve" },
  });
});

test("runtime descriptors carry the generated temporal policy", () => {
  const artifact = JSON.parse(renderRuntimeDescriptors(
    [],
    "config-hash",
    {},
    { infinity: "reject" },
  )) as RuntimeQueryDescriptors;

  expect(prepareRuntimeDescriptors(artifact).temporal).toEqual({
    infinity: "reject",
  });
});

test("runtime descriptor parsing selects only the active profile contract", () => {
  const status = { schema: "app", name: "status" };
  const artifact = JSON.parse(renderRuntimeDescriptors([
    entry("SELECT $1::app.status", [status], "api"),
    entry("SELECT $1::int4", [23], "worker"),
  ], "config-hash", {
    api: { name: "api", role: "app_api" },
    worker: { name: "worker", role: "app_worker" },
  })) as RuntimeQueryDescriptors;

  const prepared = prepareRuntimeDescriptors(artifact, { name: "worker", role: "app_worker" });
  expect([...prepared.queries.keys()]).toEqual([fingerprint("SELECT $1::int4")]);
  expect(prepared.types).toEqual([]);
});

test("runtime descriptor rendering uses locale-independent key order", () => {
  const artifact = JSON.parse(renderRuntimeDescriptors([], "config-hash", {
    a: { name: "a", role: "role_a" },
    Z: { name: "Z", role: "role_z" },
  })) as RuntimeQueryDescriptors;

  expect(Object.keys(artifact.profiles)).toEqual(["Z", "a"]);
});

test("runtime descriptor parsing fails closed on stale revisions and profile roles", () => {
  const artifact = JSON.parse(renderRuntimeDescriptors([
    entry("SELECT $1::int4", [23], "api"),
  ], "config-hash", {
    api: { name: "api", role: "app_api" },
  })) as RuntimeQueryDescriptors;

  expect(() => prepareRuntimeDescriptors({
    ...artifact,
    generatorRevision: artifact.generatorRevision - 1,
  })).toThrow(/incompatible format or generator revision/);
  expect(() => prepareRuntimeDescriptors(
    artifact,
    { name: "api", role: "wrong_role" },
  )).toThrow(/profile api requires role app_api/);
});
