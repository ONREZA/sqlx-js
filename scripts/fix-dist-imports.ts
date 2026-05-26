import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...files(path));
    else if (path.endsWith(".js") || path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function withJsExtension(specifier: string): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;
  if (extname(specifier) !== "") return specifier;
  return `${specifier}.js`;
}

function rewrite(content: string): string {
  return content
    .replace(/\b(from\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_m, before: string, specifier: string, after: string) => {
      return `${before}${withJsExtension(specifier)}${after}`;
    })
    .replace(/\b(import\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_m, before: string, specifier: string, after: string) => {
      return `${before}${withJsExtension(specifier)}${after}`;
    })
    .replace(/\b(import\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g, (_m, before: string, specifier: string, after: string) => {
      return `${before}${withJsExtension(specifier)}${after}`;
    });
}

for (const file of files(dist)) {
  const before = readFileSync(file, "utf8");
  const after = rewrite(before);
  if (after !== before) writeFileSync(file, after);
}

chmodSync(join(dist, "bin/sqlx-js.js"), 0o755);
