import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const COMMENT = "# sqlx-js generated artifacts";
const ATTRIBUTE = "linguist-generated";
const CACHE_DIRECTORY = ".sqlx-js";

type GeneratedArtifact = {
  kind: "cache" | "file";
  path: string;
};

type AttributeState = "set" | "unset" | "unspecified" | "no-match";

export type GeneratedGitAttributesInspection = {
  path: string;
  required: string[];
  missing: string[];
  unmanaged: string[];
};

export type GeneratedGitAttributesUpdate = GeneratedGitAttributesInspection & {
  added: string[];
  changed: boolean;
  created: boolean;
};

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function isInside(parent: string, path: string): boolean {
  const child = relative(resolve(parent), resolve(path));
  return child === "" || (
    !isAbsolute(child)
    && child !== ".."
    && !child.startsWith(`..${sep}`)
  );
}

function quotePattern(pattern: string): string {
  return /[\s"\\]/.test(pattern) || pattern.startsWith("#") || pattern.startsWith("!")
    ? JSON.stringify(pattern)
    : pattern;
}

function escapePatternPath(path: string): string {
  return path.replace(/([*?[\]\\])/g, "\\$1");
}

function attributeDirectories(root: string): string[] {
  const projectRoot = resolve(root);
  const directories = [projectRoot];
  let current = projectRoot;
  while (!existsSync(join(current, ".git"))) {
    const parent = dirname(current);
    if (parent === current) return [projectRoot];
    directories.push(parent);
    current = parent;
  }
  return directories;
}

function artifactPattern(directory: string, artifact: GeneratedArtifact): string {
  const path = escapePatternPath(portablePath(relative(directory, artifact.path)));
  const pattern = artifact.kind === "cache"
    ? `${path}/**`
    : path.includes("/") ? path : `/${path}`;
  return quotePattern(pattern);
}

function tokens(line: string): string[] {
  return line.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
}

function generatedAttributeState(line: string, pattern: string): AttributeState {
  const parts = tokens(line.trim());
  if (
    parts[0] !== pattern
    && (pattern.startsWith("/") || parts[0] !== `/${pattern}`)
  ) return "no-match";
  let state: AttributeState = "no-match";
  for (const attribute of parts.slice(1)) {
    if (attribute === ATTRIBUTE || attribute === `${ATTRIBUTE}=true`) state = "set";
    if (attribute === `-${ATTRIBUTE}` || attribute === `${ATTRIBUTE}=false`) state = "unset";
    if (attribute === `!${ATTRIBUTE}`) state = "unspecified";
  }
  return state;
}

function readAttributes(path: string): string {
  if (!lstatSync(path).isFile()) {
    throw new Error(`sqlx-js: ${path} must be a regular file`);
  }
  return readFileSync(path, "utf8");
}

function artifactIsGenerated(directories: string[], artifact: GeneratedArtifact): boolean {
  let state: AttributeState = "unspecified";
  for (const directory of [...directories].reverse()) {
    const attributesPath = join(directory, ".gitattributes");
    if (!existsSync(attributesPath)) continue;
    const pattern = artifactPattern(directory, artifact);
    for (const line of readAttributes(attributesPath).split(/\r?\n/)) {
      const next = generatedAttributeState(line, pattern);
      if (next !== "no-match") state = next;
    }
  }
  return state === "set";
}

function generatedArtifacts(root: string, paths: string[]): {
  artifacts: GeneratedArtifact[];
  unmanaged: string[];
} {
  const projectRoot = resolve(root);
  const cachePath = join(projectRoot, CACHE_DIRECTORY);
  const artifacts: GeneratedArtifact[] = [{ kind: "cache", path: cachePath }];
  const unmanaged: string[] = [];
  const resolvedPaths = paths.map((entry) =>
    isAbsolute(entry) ? resolve(entry) : resolve(projectRoot, entry)
  );
  for (const path of new Set(resolvedPaths)) {
    if (!isInside(projectRoot, path)) {
      unmanaged.push(path);
    } else if (!isInside(cachePath, path)) {
      artifacts.push({ kind: "file", path });
    }
  }
  return { artifacts, unmanaged };
}

export function inspectGeneratedGitAttributes(
  root: string,
  dtsPath = "sqlx-js-env.d.ts",
  additionalPaths: string[] = [],
): GeneratedGitAttributesInspection {
  const directories = attributeDirectories(root);
  const targetDirectory = directories.find((directory) => existsSync(join(directory, ".gitattributes")))
    ?? resolve(root);
  const path = join(targetDirectory, ".gitattributes");
  const { artifacts, unmanaged } = generatedArtifacts(root, [dtsPath, ...additionalPaths]);
  const required = artifacts.map((artifact) => `${artifactPattern(targetDirectory, artifact)} ${ATTRIBUTE}`);
  const missing = artifacts.flatMap((artifact, index) =>
    artifactIsGenerated(directories, artifact) ? [] : [required[index]!]
  );
  return { path, required, missing, unmanaged };
}

export function ensureGeneratedGitAttributes(
  root: string,
  dtsPath = "sqlx-js-env.d.ts",
  additionalPaths: string[] = [],
): GeneratedGitAttributesUpdate {
  const inspection = inspectGeneratedGitAttributes(root, dtsPath, additionalPaths);
  const created = !existsSync(inspection.path);
  if (inspection.missing.length === 0) {
    return { ...inspection, added: [], changed: false, created: false };
  }

  const source = created ? "" : readAttributes(inspection.path);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hasComment = source.split(/\r?\n/).some((line) => line.trim() === COMMENT);
  const block = [
    ...(hasComment ? [] : [COMMENT]),
    ...inspection.missing,
  ];
  let prefix = "";
  if (source && !source.endsWith(newline)) prefix += newline;
  if (source && !(source + prefix).endsWith(newline + newline)) prefix += newline;
  const addition = prefix + block.join(newline) + newline;
  if (created) writeFileSync(inspection.path, addition);
  else appendFileSync(inspection.path, addition);
  return {
    ...inspection,
    added: inspection.missing,
    changed: true,
    created,
  };
}
