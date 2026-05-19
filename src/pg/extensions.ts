export const BUILTIN_EXTENSION_TYPES: Record<string, string> = {
  vector: "number[]",
  halfvec: "number[]",
  sparsevec: "string",

  hstore: "Record<string, string | null>",

  citext: "string",

  ltree: "string",
  lquery: "string",
  ltxtquery: "string",
};

export function mergeExtensionTypes(user?: Record<string, string>): Record<string, string> {
  if (!user) return { ...BUILTIN_EXTENSION_TYPES };
  return { ...BUILTIN_EXTENSION_TYPES, ...user };
}
