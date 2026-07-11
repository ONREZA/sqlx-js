import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = resolve(root, "dist/src/index.js");
const allowedRuntimeFiles = new Set([
  "dist/src/index.js",
  "dist/src/config.js",
  "dist/src/postgres-runtime.js",
  "dist/src/runtime.js",
  "dist/src/sql-params.js",
  "dist/src/sql-lex.js",
  "dist/src/migration-core.js",
  "dist/src/pg/oids.js",
  "dist/src/pg/wire.js",
]);
const forbidden = [
  "/commands/prepare.js",
  "/commands/migrate.js",
  "/scan/scanner.js",
  "/pg/analyze.js",
  "/pg/param-map.js",
  "/node_modules/typescript/",
  "/node_modules/libpg-query/",
];
const forbiddenPackages = ["typescript", "libpg-query"];
const visited = new Set();

function resolveImport(from, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  const candidate = resolve(dirname(from), specifier);
  if (extname(candidate)) return candidate;
  return `${candidate}.js`;
}

function visit(file) {
  if (visited.has(file)) return;
  const relativePath = relative(root, file).replaceAll("\\", "/");
  if (!allowedRuntimeFiles.has(relativePath)) {
    throw new Error(`runtime boundary: root export reached unapproved production module ${relativePath}`);
  }
  visited.add(file);
  if (!existsSync(file)) throw new Error(`runtime boundary: missing ${file}`);
  const source = readFileSync(file, "utf8");
  const imports = [
    ...source.matchAll(/\b(?:import|export)\s+(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ];
  for (const match of imports) {
    const target = resolveImport(file, match[1]);
    const normalized = target.replaceAll("\\", "/");
    const violation = forbidden.find((part) => normalized.includes(part));
    const packageViolation = forbiddenPackages.find((name) => target === name || target.startsWith(`${name}/`));
    if (violation || packageViolation) {
      throw new Error(`runtime boundary: ${file} statically imports forbidden module ${target}`);
    }
    if (target.startsWith(root)) visit(target);
  }
}

visit(entry);
console.log(`runtime boundary ok — ${visited.size} production module(s)`);
