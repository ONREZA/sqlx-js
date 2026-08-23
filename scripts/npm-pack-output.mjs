export function npmPackFilename(output) {
  const packages = Array.isArray(output)
    ? output
    : output && typeof output === "object"
      ? Object.values(output)
      : [];
  const filename = packages.length === 1 ? packages[0]?.filename : undefined;
  if (typeof filename !== "string") throw new Error("npm pack did not return one package filename");
  return filename;
}
