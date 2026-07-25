import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const skillsRoot = resolve("skills");
const errors = [];

if (!existsSync(skillsRoot)) {
  errors.push("skills directory does not exist");
}

const skillDirectories = existsSync(skillsRoot)
  ? readdirSync(skillsRoot)
      .map((name) => join(skillsRoot, name))
      .filter((path) => statSync(path).isDirectory())
      .filter((path) => existsSync(join(path, "SKILL.md")))
      .sort()
  : [];

for (const directory of skillDirectories) {
  const directoryName = basename(directory);
  const skillFile = join(directory, "SKILL.md");
  const content = readFileSync(skillFile, "utf8");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);

  if (!frontmatter) {
    errors.push(`${skillFile}: missing YAML frontmatter`);
    continue;
  }

  const fields = new Map();
  for (const line of frontmatter[1].split("\n")) {
    if (line.trim() === "") continue;
    const match = line.match(/^([a-z][a-z0-9-]*):\s+(.+)$/);
    if (!match) {
      errors.push(`${skillFile}: unsupported frontmatter line: ${line}`);
      continue;
    }
    fields.set(match[1], match[2].replace(/^"(.*)"$/, "$1"));
  }

  for (const key of fields.keys()) {
    if (key !== "name" && key !== "description") {
      errors.push(`${skillFile}: unsupported frontmatter field: ${key}`);
    }
  }

  const name = fields.get("name");
  const description = fields.get("description");

  if (!name) {
    errors.push(`${skillFile}: missing name`);
  } else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      errors.push(`${skillFile}: invalid name: ${name}`);
    }
    if (name !== directoryName) {
      errors.push(`${skillFile}: name must match parent directory`);
    }
  }

  if (!description || description.length > 1024) {
    errors.push(`${skillFile}: description must contain 1-1024 characters`);
  }

  if (content.includes("TODO")) {
    errors.push(`${skillFile}: unresolved TODO`);
  }
  if (content.split("\n").length > 500) {
    errors.push(`${skillFile}: SKILL.md exceeds 500 lines`);
  }
  if (existsSync(join(directory, "README.md"))) {
    errors.push(`${directory}: skill-local README.md is not allowed`);
  }

  const references = join(directory, "references");
  if (
    !existsSync(references)
    || !statSync(references).isDirectory()
    || readdirSync(references).filter((file) => file.endsWith(".md")).length === 0
  ) {
    errors.push(`${directory}: references must contain at least one Markdown file`);
  }

  const agentMetadata = join(directory, "agents", "openai.yaml");
  if (!existsSync(agentMetadata)) {
    errors.push(`${directory}: missing agents/openai.yaml`);
  } else if (name) {
    const metadata = readFileSync(agentMetadata, "utf8");
    const displayName = metadata.match(/^  display_name: "(.+)"$/m)?.[1];
    const shortDescription = metadata.match(
      /^  short_description: "(.+)"$/m,
    )?.[1];
    const defaultPrompt = metadata.match(/^  default_prompt: "(.+)"$/m)?.[1];

    if (!displayName) {
      errors.push(`${agentMetadata}: missing display_name`);
    }
    if (
      !shortDescription
      || shortDescription.length < 25
      || shortDescription.length > 64
    ) {
      errors.push(`${agentMetadata}: short_description must contain 25-64 characters`);
    }
    if (!defaultPrompt?.includes(`$${name}`)) {
      errors.push(`${agentMetadata}: default prompt must mention $${name}`);
    }
  }
}

if (skillDirectories.length === 0) {
  errors.push("no skills found");
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${skillDirectories.length} agent skills\n`);
}
