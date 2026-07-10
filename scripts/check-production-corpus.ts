import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { findSourceFiles, scanFile } from "../src/scan/scanner";
import { fingerprint, type CacheEntry } from "../src/cache";
import { containsUnknownType } from "../src/type-inspection";

const root = resolve(import.meta.dir, "../example");
const cacheDir = join(root, ".sqlx-js");
const entries = readdirSync(cacheDir)
  .filter((name) => /^[0-9a-f]{16}\.json$/.test(name))
  .map((name) => JSON.parse(readFileSync(join(cacheDir, name), "utf8")) as CacheEntry);
const corpusFile = join(root, "v10_production_corpus.ts");
const corpusSites = scanFile(corpusFile, root);
const cachedQueries = new Set(entries.map((entry) => fingerprint(entry.query)));
const missingCorpusArtifacts = corpusSites.filter((site) => !cachedQueries.has(fingerprint(site.query))).length;

let degradedQueries = 0;
let unknownTypes = 0;
let overrides = 0;
for (const entry of entries) {
  if (entry.degraded) degradedQueries++;
  unknownTypes += entry.paramTsTypes.filter(containsUnknownType).length;
  unknownTypes += entry.columns.filter((column) => containsUnknownType(column.tsType)).length;
  overrides += entry.columns.filter((column) => column.override !== undefined).length;
}

let unsafeCalls = 0;
for (const file of findSourceFiles(root)) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, false, ts.ScriptKind.TSX);
  const aliases = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "@onreza/sqlx-js") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "unsafe") aliases.add(element.name.text);
      }
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) unsafeCalls++;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        namespaces.has(node.expression.expression.text) &&
        node.expression.name.text === "unsafe"
      ) unsafeCalls++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const report = {
  queries: entries.length,
  corpusSites: corpusSites.length,
  missingCorpusArtifacts,
  unsafeCalls,
  overrides,
  degradedQueries,
  unknownTypes,
};
console.log(JSON.stringify(report));
const issues: string[] = [];
if (corpusSites.length !== 5) issues.push(`expected 5 production corpus call sites, found ${corpusSites.length}`);
if (missingCorpusArtifacts > 0) issues.push(`${missingCorpusArtifacts} corpus query artifact(s) are missing`);
if (unsafeCalls > 0) issues.push(`${unsafeCalls} unsafe query call(s) found`);
if (degradedQueries > 0) issues.push(`${degradedQueries} query artifact(s) have degraded inference`);
if (unknownTypes > 0) issues.push(`${unknownTypes} generated unknown type(s) found`);
if (issues.length > 0) throw new Error(`production corpus check failed: ${issues.join("; ")}`);
