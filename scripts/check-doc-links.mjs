import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const markdownFiles = [];

function collectMarkdownFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collectMarkdownFiles(path);
    else if (entry.name.endsWith(".md")) markdownFiles.push(path);
  }
}

collectMarkdownFiles(process.cwd());

const missing = [];
const mutableUpgradeStatuses = [];

for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  if (
    file.startsWith(resolve(process.cwd(), "docs/upgrades"))
    && /^Status:/m.test(source)
  ) {
    mutableUpgradeStatuses.push(`${file}: remove mutable Status metadata from the upgrade guide`);
  }

  for (const match of source.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;

    target = target.split("#", 1)[0];
    if (!target) continue;

    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(target);
    } catch {
      missing.push(`${file}: invalid link encoding: ${target}`);
      continue;
    }

    if (!existsSync(resolve(dirname(file), decodedTarget))) {
      missing.push(`${file}: missing relative target: ${target}`);
    }
  }
}

const failures = [...missing, ...mutableUpgradeStatuses];
if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Checked ${markdownFiles.length} Markdown files: links and upgrade metadata are valid\n`,
  );
}
