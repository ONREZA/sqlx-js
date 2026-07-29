import {
  CACHE_FORMAT_VERSION,
  GENERATOR_REVISION,
  RUNTIME_DESCRIPTOR_FORMAT_VERSION,
} from "./artifact-versions";
import { isBuiltinOid } from "./pg/oids";
import type { TemporalPolicy } from "./temporal";

export type RuntimeDescriptorType = {
  schema: string;
  name: string;
};

export type RuntimeQueryDescriptor = {
  params: readonly (number | string)[];
};

export type RuntimeDescriptorProfile = {
  role: string;
  queries: Readonly<Record<string, RuntimeQueryDescriptor>>;
};

export type RuntimeQueryDescriptors = {
  formatVersion: number;
  cacheFormat: number;
  generatorRevision: number;
  configHash: string;
  temporal: {
    readonly infinity: string;
  };
  types: Readonly<Record<string, RuntimeDescriptorType>>;
  queries: Readonly<Record<string, RuntimeQueryDescriptor>>;
  profiles: Readonly<Record<string, RuntimeDescriptorProfile>>;
};

export type PreparedRuntimeDescriptors = {
  queries: ReadonlyMap<string, RuntimeQueryDescriptor>;
  types: readonly (RuntimeDescriptorType & { key: string })[];
  temporal: TemporalPolicy;
};

type ActiveProfile = {
  name: string;
  role: string;
};

function descriptorError(message: string): Error {
  return new Error(
    `sqlx-js: queryDescriptors ${message}. Run \`sqlx-js prepare\` and deploy the regenerated runtime descriptor`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseQueries(
  value: unknown,
  types: ReadonlyMap<string, RuntimeDescriptorType>,
  location: string,
): Map<string, RuntimeQueryDescriptor> {
  if (!isRecord(value)) throw descriptorError(`${location} must be an object`);
  const queries = new Map<string, RuntimeQueryDescriptor>();
  for (const [id, raw] of Object.entries(value)) {
    if (
      !/^[0-9a-f]{16}$/.test(id)
      || !isRecord(raw)
      || !Array.isArray(raw.params)
    ) {
      throw descriptorError(`${location}.${id} is malformed`);
    }
    const params = raw.params as unknown[];
    for (const param of params) {
      if (typeof param === "number") {
        if (!Number.isSafeInteger(param) || !isBuiltinOid(param)) {
          throw descriptorError(`${location}.${id} contains an invalid built-in type OID`);
        }
      } else if (typeof param !== "string" || !types.has(param)) {
        throw descriptorError(`${location}.${id} references an unknown database-local type`);
      }
    }
    queries.set(id, {
      params: Object.freeze([...params]) as readonly (number | string)[],
    });
  }
  return queries;
}

export function prepareRuntimeDescriptors(
  value: RuntimeQueryDescriptors,
  profile?: ActiveProfile,
): PreparedRuntimeDescriptors {
  if (!isRecord(value)) throw descriptorError("must be an object");
  if (
    value.formatVersion !== RUNTIME_DESCRIPTOR_FORMAT_VERSION
    || value.cacheFormat !== CACHE_FORMAT_VERSION
    || value.generatorRevision !== GENERATOR_REVISION
  ) {
    throw descriptorError("uses an incompatible format or generator revision");
  }
  if (typeof value.configHash !== "string" || !isRecord(value.types) || !isRecord(value.profiles)) {
    throw descriptorError("is malformed");
  }
  if (
    !isRecord(value.temporal)
    || (value.temporal.infinity !== "preserve" && value.temporal.infinity !== "reject")
  ) {
    throw descriptorError("contains an invalid temporal policy");
  }
  const temporal: TemporalPolicy = Object.freeze({
    infinity: value.temporal.infinity,
  });

  const types = new Map<string, RuntimeDescriptorType>();
  for (const [key, raw] of Object.entries(value.types)) {
    if (
      !isRecord(raw)
      || typeof raw.schema !== "string"
      || raw.schema.length === 0
      || typeof raw.name !== "string"
      || raw.name.length === 0
      || key !== JSON.stringify([raw.schema, raw.name])
    ) {
      throw descriptorError(`type ${key} is malformed`);
    }
    types.set(key, { schema: raw.schema, name: raw.name });
  }

  let queries: Map<string, RuntimeQueryDescriptor>;
  if (profile) {
    const rawProfile = value.profiles[profile.name];
    if (
      !isRecord(rawProfile)
      || typeof rawProfile.role !== "string"
      || rawProfile.role.trim() === ""
      || !isRecord(rawProfile.queries)
    ) {
      throw descriptorError(`does not contain profile ${profile.name}`);
    }
    if (rawProfile.role !== profile.role) {
      throw descriptorError(
        `profile ${profile.name} requires role ${rawProfile.role}, but the client uses ${profile.role}`,
      );
    }
    queries = parseQueries(rawProfile.queries, types, `profiles.${profile.name}.queries`);
  } else {
    queries = parseQueries(value.queries, types, "queries");
  }

  const usedTypes = new Set<string>();
  for (const descriptor of queries.values()) {
    for (const param of descriptor.params) if (typeof param === "string") usedTypes.add(param);
  }
  return {
    queries,
    types: [...usedTypes].sort().map((key) => ({ key, ...types.get(key)! })),
    temporal,
  };
}
