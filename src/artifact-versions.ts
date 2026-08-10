export const CACHE_FORMAT_VERSION = 12;
export const GENERATOR_REVISION = 30;
export const RUNTIME_DESCRIPTOR_FORMAT_VERSION = 4;
export const JSON_PROTOCOL_VERSION = 1;
export const RUNTIME_DESCRIPTOR_VERSION_FENCE = Object.freeze({
  formatVersion: RUNTIME_DESCRIPTOR_FORMAT_VERSION,
  cacheFormat: CACHE_FORMAT_VERSION,
  generatorRevision: GENERATOR_REVISION,
  jsonProtocol: JSON_PROTOCOL_VERSION,
} as const);
export const RUNTIME_DESCRIPTOR_FILE = "runtime-descriptors.json";
