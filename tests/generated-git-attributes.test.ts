import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureGeneratedGitAttributes,
  inspectGeneratedGitAttributes,
} from "../src/generated-git-attributes";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "sqlx-js-gitattributes-"));
  roots.push(value);
  return value;
}

test("generated Git attributes are created once", () => {
  const dir = root();
  expect(inspectGeneratedGitAttributes(dir).missing).toEqual([
    ".sqlx-js/** linguist-generated",
    "/sqlx-js-env.d.ts linguist-generated",
  ]);

  expect(ensureGeneratedGitAttributes(dir)).toMatchObject({
    changed: true,
    created: true,
    added: [
      ".sqlx-js/** linguist-generated",
      "/sqlx-js-env.d.ts linguist-generated",
    ],
  });
  expect(ensureGeneratedGitAttributes(dir)).toMatchObject({
    changed: false,
    created: false,
    added: [],
  });
});

test("generated Git attributes preserve existing rules and accept explicit true", () => {
  const dir = root();
  writeFileSync(
    join(dir, ".gitattributes"),
    "*.ts text\n.sqlx-js/** linguist-generated=true -diff\n",
  );

  const update = ensureGeneratedGitAttributes(dir, join(dir, "generated/db types.d.ts"));
  expect(update).toMatchObject({
    changed: true,
    created: false,
    added: ["\"generated/db types.d.ts\" linguist-generated"],
  });
  expect(readFileSync(join(dir, ".gitattributes"), "utf8")).toBe(
    "*.ts text\n" +
    ".sqlx-js/** linguist-generated=true -diff\n\n" +
    "# sqlx-js generated artifacts\n" +
    "\"generated/db types.d.ts\" linguist-generated\n",
  );
});

test("later canonical rules override earlier generated attributes", () => {
  const dir = root();
  writeFileSync(
    join(dir, ".gitattributes"),
    ".sqlx-js/** linguist-generated\n" +
    ".sqlx-js/** -linguist-generated\n" +
    "/sqlx-js-env.d.ts linguist-generated\n",
  );

  expect(inspectGeneratedGitAttributes(dir).missing).toEqual([
    ".sqlx-js/** linguist-generated",
  ]);
  expect(ensureGeneratedGitAttributes(dir).added).toEqual([
    ".sqlx-js/** linguist-generated",
  ]);
  expect(inspectGeneratedGitAttributes(dir).missing).toEqual([]);
});

test("generated Git attributes honor a containing monorepo file", () => {
  const repo = root();
  const project = join(repo, "packages/database");
  mkdirSync(join(repo, ".git"));
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(repo, ".gitattributes"),
    "packages/database/.sqlx-js/** linguist-generated\n" +
    "packages/database/sqlx-js-env.d.ts linguist-generated\n",
  );

  const inspection = inspectGeneratedGitAttributes(project);
  expect(inspection).toMatchObject({
    path: join(repo, ".gitattributes"),
    missing: [],
    unmanaged: [],
  });
  expect(ensureGeneratedGitAttributes(project)).toMatchObject({
    changed: false,
    added: [],
  });

  writeFileSync(
    join(repo, ".gitattributes"),
    "packages/database/.sqlx-js/** linguist-generated\n",
  );
  expect(ensureGeneratedGitAttributes(project)).toMatchObject({
    path: join(repo, ".gitattributes"),
    changed: true,
    created: false,
    added: ["packages/database/sqlx-js-env.d.ts linguist-generated"],
  });
});

test("generated Git attributes include extra outputs without redundant cache rules", () => {
  const dir = root();
  const inspection = inspectGeneratedGitAttributes(
    dir,
    ".sqlx-js/sqlx-js-env.d.ts",
    ["generated/db-enums.ts"],
  );
  expect(inspection.required).toEqual([
    ".sqlx-js/** linguist-generated",
    "generated/db-enums.ts linguist-generated",
  ]);
  expect(inspection.unmanaged).toEqual([]);
});

test("generated Git attributes report outputs outside the project root", () => {
  const dir = root();
  const outside = join(dirname(dir), "shared-sqlx-js-env.d.ts");
  const inspection = inspectGeneratedGitAttributes(dir, outside);
  expect(inspection.required).toEqual([".sqlx-js/** linguist-generated"]);
  expect(inspection.unmanaged).toEqual([outside]);
});

test("generated Git attributes preserve CRLF in an existing file", () => {
  const dir = root();
  writeFileSync(join(dir, ".gitattributes"), "*.ts text\r\n");
  ensureGeneratedGitAttributes(dir);
  const source = readFileSync(join(dir, ".gitattributes"), "utf8");
  expect(source).not.toContain("\n# sqlx-js generated artifacts\n");
  expect(source).toContain("\r\n# sqlx-js generated artifacts\r\n");
});

test("generated Git attributes escape wildcard characters in output paths", () => {
  const dir = root();
  const inspection = inspectGeneratedGitAttributes(
    dir,
    join(dir, "generated/[tenant]/types?.d.ts"),
  );
  expect(inspection.required[1]).toBe(
    "\"generated/\\\\[tenant\\\\]/types\\\\?.d.ts\" linguist-generated",
  );
});
