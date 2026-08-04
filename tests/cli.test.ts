import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const binPath = join(repoRoot, "bin/sqlx-js.ts");
const diagnosticsBinPath = join(repoRoot, "bin/sqlx-js-diagnostics.ts");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };

test("CLI --version is sourced from package metadata", () => {
  const r = spawnSync("bun", [binPath, "--version"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe(pkg.version);
});

test("CLI help prints package metadata version", () => {
  const r = spawnSync("bun", [binPath, "--help"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  expect(r.stdout).toContain(`v${pkg.version}`);
  expect(r.stdout).toContain("sqlx-js dev");
  expect(r.stdout).toContain("sqlx-js verify");
  expect(r.stdout).toContain("sqlx-js pgschema install|plan|apply");
  expect(r.stdout).toContain("sqlx-js snapshot dump|check");
  expect(r.stdout).toContain("sqlx-js doctor");
  expect(r.stdout).toContain("--schema-provider");
  expect(r.stdout).toContain("sqlx-js queries");
  expect(r.stdout).toContain("sqlx-js json audit");
  expect(r.stdout).toContain("<subcommand> --help");
});

test("CLI help lists the init command", () => {
  const r = spawnSync("bun", [binPath, "--help"], { encoding: "utf8" });
  expect(r.stdout).toContain("sqlx-js init");
});

test("CLI rejects project commands from a different sqlx-js version and doctor reports both identities", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-cli-identity-"));
  try {
    const packageDir = join(root, "node_modules/@onreza/sqlx-js");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: "@onreza/sqlx-js",
      version: "9.9.9",
    }));

    const queries = spawnSync("bun", [binPath, "queries", "--root", root], { encoding: "utf8" });
    expect(queries.status).toBe(2);
    expect(queries.stderr).toContain(`running CLI ${pkg.version}`);
    expect(queries.stderr).toContain("@onreza/sqlx-js 9.9.9 resolved from --root");
    expect(queries.stderr).toContain("Run the package-local sqlx-js script");

    const structuredQueries = spawnSync("bun", [binPath, "queries", "--json", "--root", root], {
      encoding: "utf8",
    });
    expect(structuredQueries.status).toBe(2);
    expect(structuredQueries.stderr).toBe("");
    expect(JSON.parse(structuredQueries.stdout)).toMatchObject({
      formatVersion: 1,
      ok: false,
      diagnostics: [{ severity: "error", phase: "config" }],
    });

    const structuredJsonAudit = spawnSync(
      "bun",
      [binPath, "json", "audit", "--json", "--root", root],
      { encoding: "utf8" },
    );
    expect(structuredJsonAudit.status).toBe(2);
    expect(structuredJsonAudit.stderr).toBe("");
    expect(JSON.parse(structuredJsonAudit.stdout)).toMatchObject({
      formatVersion: 1,
      protocolVersion: 1,
      ok: false,
      complete: false,
      summary: {
        columns: 0,
        scannedColumns: 0,
        collisionRows: 0,
        duplicateKeyRows: 0,
        invalidNumberRows: 0,
        errors: 1,
        dependencies: 0,
        sourceUsages: 0,
        reviewRequired: true,
      },
      diagnostics: [{ severity: "error" }],
    });

    const init = spawnSync("bun", [binPath, "init", "--root", root], { encoding: "utf8" });
    expect(init.status).toBe(2);
    expect(init.stderr).toContain("does not match");

    writeFileSync(join(root, ".gitattributes"), "*.ts text\n");
    const doctorFix = spawnSync("bun", [binPath, "doctor", "--root", root, "--json", "--fix"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(doctorFix.status).toBe(1);
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe("*.ts text\n");
    expect(JSON.parse(doctorFix.stdout).checks.find(
      (check: { name: string }) => check.name === "gitAttributes",
    )).toMatchObject({
      status: "error",
      details: { fixError: expect.stringContaining("package identity must be valid and match") },
    });

    const doctor = spawnSync("bun", [binPath, "doctor", "--root", root, "--json"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    const payload = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
    };
    expect(payload.checks.find((check) => check.name === "packageIdentity")).toMatchObject({
      status: "error",
      details: { runningVersion: pkg.version, targetVersion: "9.9.9" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI command help is successful and command-specific", () => {
  const parent = mkdtempSync(join(tmpdir(), "sqlx-js-help-"));
  const root = join(parent, "must-not-exist");
  const cases = [
    { args: ["init"], expected: ["usage: sqlx-js init", "without replacing"] },
    { args: ["dev"], expected: ["usage: sqlx-js dev", "Writes worktree: yes"] },
    { args: ["verify"], expected: ["usage: sqlx-js verify", "Writes worktree: no"] },
    {
      args: ["doctor"],
      expected: ["usage: sqlx-js doctor", "shadow permissions", "only with --fix"],
    },
    { args: ["ci"], expected: ["usage: sqlx-js ci", "provider-aware"] },
    { args: ["prepare"], expected: ["usage: sqlx-js prepare", "Query-artifact engine"] },
    { args: ["queries"], expected: ["usage: sqlx-js queries", "without a database"] },
    { args: ["json", "audit"], expected: ["usage: sqlx-js json audit", "read-only transaction"] },
    { args: ["pgschema", "install"], expected: ["usage: sqlx-js pgschema install", "checksum"] },
    { args: ["pgschema", "plan"], expected: ["usage: sqlx-js pgschema plan", "without applying"] },
    { args: ["pgschema", "apply"], expected: ["usage: sqlx-js pgschema apply", "reviewed --plan"] },
    { args: ["migrate", "add"], expected: ["usage: sqlx-js migrate add", ".up.sql and .down.sql"] },
    { args: ["migrate", "run"], expected: ["usage: sqlx-js migrate run", "target database"] },
    { args: ["migrate", "info"], expected: ["usage: sqlx-js migrate info", "migration history"] },
    { args: ["migrate", "check"], expected: ["usage: sqlx-js migrate check", "filenames"] },
    { args: ["migrate", "revert"], expected: ["usage: sqlx-js migrate revert", "Revert the latest"] },
    { args: ["migrate", "squash"], expected: ["usage: sqlx-js migrate squash", "schema-only baseline"] },
    { args: ["migrate", "archive"], expected: ["usage: sqlx-js migrate archive", "Inspect or restore"] },
    { args: ["snapshot", "dump"], expected: ["usage: sqlx-js snapshot dump", "read-only"] },
    { args: ["snapshot", "check"], expected: ["usage: sqlx-js snapshot check", "read-only"] },
  ];
  try {
    for (const { args, expected } of cases) {
      const r = spawnSync("bun", [binPath, ...args, "--help", "--root", root], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      for (const text of expected) expect(r.stdout).toContain(text);
    }
    expect(existsSync(root)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("json audit --json reports missing DATABASE_URL as one structured document", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-json-audit-"));
  try {
    const result = spawnSync(
      "bun",
      [binPath, "json", "audit", "--json", "--root", root],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      formatVersion: 1,
      protocolVersion: 1,
      ok: false,
      complete: false,
      columns: [],
      dependencies: [],
      sourceUsages: [],
      diagnostics: [{ severity: "error", message: "DATABASE_URL is required for json audit" }],
    });
    expect(report.summary).toEqual({
      columns: 0,
      scannedColumns: 0,
      collisionRows: 0,
      duplicateKeyRows: 0,
      invalidNumberRows: 0,
      errors: 1,
      dependencies: 0,
      sourceUsages: 0,
      reviewRequired: true,
    });

    const invalid = spawnSync(
      "bun",
      [binPath, "json", "unknown", "--json", "--root", root],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
    );
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toBe("");
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ok: false,
      complete: false,
      diagnostics: [{ message: 'sqlx-js: unknown json command "unknown"' }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare detail modes are human-only and exclude watch mode", () => {
  const structured = spawnSync(
    "bun",
    [binPath, "prepare", "--warnings", "--json"],
    { encoding: "utf8" },
  );
  expect(structured.status).toBe(2);
  expect(JSON.parse(structured.stdout).diagnostics[0].message).toBe(
    "--warnings, --verbose, --json, and --jsonl are mutually exclusive",
  );

  const duplicateDetail = spawnSync(
    "bun",
    [binPath, "prepare", "--warnings", "--verbose"],
    { encoding: "utf8" },
  );
  expect(duplicateDetail.status).toBe(2);
  expect(duplicateDetail.stderr).toContain(
    "--warnings, --verbose, --json, and --jsonl are mutually exclusive",
  );

  const watch = spawnSync(
    "bun",
    [binPath, "prepare", "--verbose", "--watch"],
    { encoding: "utf8" },
  );
  expect(watch.status).toBe(2);
  expect(watch.stderr).toContain("--verbose is unnecessary with prepare --watch");

  const warningWatch = spawnSync(
    "bun",
    [binPath, "prepare", "--warnings", "--watch"],
    { encoding: "utf8" },
  );
  expect(warningWatch.status).toBe(2);
  expect(warningWatch.stderr).toContain("--warnings is unnecessary with prepare --watch");
});

test("default prepare summary preserves fatal phases and source locations", () => {
  const missingDatabase = spawnSync(
    "bun",
    [binPath, "prepare"],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
  );
  expect(missingDatabase.status).toBe(2);
  expect(missingDatabase.stderr).toContain("connect failed: DATABASE_URL is required for prepare");
  expect(missingDatabase.stderr).toContain("summary: 0 warnings, 1 error (connect: 1)");

  const root = mkdtempSync(join(tmpdir(), "sqlx-js-summary-scan-"));
  try {
    writeFileSync(join(root, "a.ts"),
      "import { sql } from \"@onreza/sqlx-js\";\n"
      + "const query = \"SELECT 1\";\n"
      + "await sql(query);\n",
    );
    const scan = spawnSync(
      "bun",
      [binPath, "prepare", "--check", "--root", root],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
    );
    expect(scan.status).toBe(1);
    expect(scan.stderr).toContain("scan failed: a.ts:3:11 —");
    expect(scan.stderr).not.toContain("a.ts:3:11 — sqlx-js: a.ts:3:11");
    expect(scan.stderr).toContain("summary: 0 warnings, 1 error (scan: 1)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostics CLI renders versioned prepare JSON for editors and GitHub", () => {
  const input = JSON.stringify({
    formatVersion: 1,
    ok: true,
    diagnostics: [{
      severity: "warning",
      phase: "inference",
      message: "result column resolved conservatively",
      file: "src/users.ts",
      line: 12,
      column: 7,
      profile: "api",
    }],
  });
  const unix = spawnSync("bun", [diagnosticsBinPath, "unix"], { encoding: "utf8", input });
  expect(unix.status).toBe(0);
  expect(unix.stdout.trim()).toBe(
    "src/users.ts:12:7: warning: [inference profile:api] result column resolved conservatively",
  );

  const github = spawnSync("bun", [diagnosticsBinPath, "github"], { encoding: "utf8", input });
  expect(github.status).toBe(0);
  expect(github.stdout.trim()).toBe(
    "::warning file=src/users.ts,line=12,col=7::[inference profile:api] result column resolved conservatively",
  );
});

test("diagnostics CLI preserves function contract subjects", () => {
  const input = JSON.stringify({
    formatVersion: 1,
    ok: true,
    diagnostics: [{
      severity: "warning",
      phase: "function-contract",
      code: "security-definer-missing-search-path",
      functionSignature: "public.read_secret()",
      message: "SECURITY DEFINER has no function-local search_path",
    }],
  });
  const unix = spawnSync("bun", [diagnosticsBinPath, "unix"], { encoding: "utf8", input });
  expect(unix.status).toBe(0);
  expect(unix.stdout.trim()).toBe(
    "<project>:1:1: warning: [function-contract security-definer-missing-search-path] public.read_secret(): SECURITY DEFINER has no function-local search_path",
  );

  const github = spawnSync("bun", [diagnosticsBinPath, "github"], { encoding: "utf8", input });
  expect(github.status).toBe(0);
  expect(github.stdout.trim()).toBe(
    "::warning::[function-contract security-definer-missing-search-path] public.read_secret(): SECURITY DEFINER has no function-local search_path",
  );
});

test("CLI init scaffolds project files and is idempotent without DATABASE_URL", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-init-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture",
      type: "module",
      scripts: { test: "bun test" },
    }, null, 2));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2023",
        strict: true,
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    }, null, 2));
    const packageDir = join(root, "node_modules/@onreza/sqlx-js");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: "@onreza/sqlx-js",
      version: pkg.version,
      type: "module",
      exports: { ".": { types: "./index.d.ts" } },
    }));
    writeFileSync(join(packageDir, "index.d.ts"), `
      export interface KnownQueries {}
      export interface KnownFileQueries {}
      export interface KnownFunctions {}
      export interface KnownProfiles {}
      export interface QueryRegistry {
        queries: object;
        fileQueries: object;
        runtimeDescriptors?: true;
        jsonProtocol: 1;
      }
      export declare function createSqlClient<Registry extends QueryRegistry>(
        url?: string,
        options?: { queryDescriptors: unknown; temporalApi?: unknown },
      ): { sql: unknown };
    `);
    const temporalDir = join(root, "node_modules/@js-temporal/polyfill");
    mkdirSync(temporalDir, { recursive: true });
    writeFileSync(join(temporalDir, "package.json"), JSON.stringify({
      name: "@js-temporal/polyfill",
      version: "0.5.1",
      type: "module",
      exports: { ".": { types: "./index.d.ts" } },
    }));
    writeFileSync(join(temporalDir, "index.d.ts"), "export declare const Temporal: object;\n");
    const r1 = spawnSync("bun", [binPath, "init", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain("created sqlx-js.config.ts");
    expect(r1.stdout).toContain("created migrations/");
    expect(existsSync(join(root, "sqlx-js.config.ts"))).toBe(true);
    expect(existsSync(join(root, "migrations"))).toBe(true);
    expect(existsSync(join(root, ".env.example"))).toBe(true);
    expect(existsSync(join(root, "sqlx-js-env.d.ts"))).toBe(true);
    expect(readFileSync(join(root, "sqlx-js-env.d.ts"), "utf8")).toContain("jsonProtocol: 1;");
    expect(existsSync(join(root, "db.ts"))).toBe(true);
    expect(readFileSync(join(root, "db.ts"), "utf8")).toContain("queryDescriptors");
    expect(existsSync(join(root, ".sqlx-js/runtime-descriptors.json"))).toBe(true);
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(
      "# sqlx-js generated artifacts\n" +
      ".sqlx-js/** linguist-generated\n" +
      "/sqlx-js-env.d.ts linguist-generated\n",
    );
    expect(readFileSync(join(root, "sqlx-js.config.ts"), "utf8")).toContain("defineConfig");
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
    expect(tsconfig.include).toContain("sqlx-js-env.d.ts");
    expect(tsconfig.include).toContain("db.ts");
    expect(tsconfig.compilerOptions.resolveJsonModule).toBe(true);
    const typecheck = spawnSync(join(repoRoot, "node_modules/.bin/tsc"), ["-p", root], {
      encoding: "utf8",
    });
    expect(typecheck.stderr + typecheck.stdout).toBe("");
    expect(typecheck.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts).toMatchObject({
      test: "bun test",
      "sqlx:prepare": "sqlx-js prepare",
      "sqlx:dev": "sqlx-js dev --strict-inference",
      "sqlx:check": "sqlx-js prepare --check",
      "sqlx:offline": "sqlx-js prepare --offline",
      "sqlx:verify": "sqlx-js verify --strict-inference",
      "sqlx:ci": "sqlx-js ci",
      "sqlx:queries": "sqlx-js queries --json",
    });

    const r2 = spawnSync("bun", [binPath, "init", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain("left unchanged");
    expect(readFileSync(join(root, ".gitattributes"), "utf8").match(/linguist-generated/g)).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI doctor --fix adds generated Git attributes to an existing project", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-doctor-fix-"));
  try {
    writeFileSync(join(root, ".gitattributes"), "*.ts text\n");
    writeFileSync(join(root, "sqlx-js.config.mjs"), `export default {
      enumCatalog: { output: "db-enums.ts", schemas: ["public"] },
    };\n`);
    const diagnosis = spawnSync(
      "bun",
      [binPath, "doctor", "--root", root, "--json"],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
    );
    expect(diagnosis.status).toBe(1);
    const diagnosisPayload = JSON.parse(diagnosis.stdout) as {
      checks: Array<{ name: string; status: string; fixable?: boolean }>;
    };
    expect(diagnosisPayload.checks.find((check) => check.name === "gitAttributes")).toMatchObject({
      status: "warning",
      fixable: true,
    });
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe("*.ts text\n");

    const result = spawnSync(
      "bun",
      [binPath, "doctor", "--root", root, "--json", "--fix"],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
    );
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      checks: Array<{
        name: string;
        status: string;
        fixable?: boolean;
        details?: { fixed?: string[] };
      }>;
    };
    expect(payload.checks.find((check) => check.name === "gitAttributes")).toMatchObject({
      status: "ok",
      details: {
        fixed: [
          ".sqlx-js/** linguist-generated",
          "/sqlx-js-env.d.ts linguist-generated",
          "/db-enums.ts linguist-generated",
        ],
      },
    });
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(
      "*.ts text\n\n" +
      "# sqlx-js generated artifacts\n" +
      ".sqlx-js/** linguist-generated\n" +
      "/sqlx-js-env.d.ts linguist-generated\n" +
      "/db-enums.ts linguist-generated\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI doctor keeps Git attribute failures machine-readable", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-doctor-attributes-error-"));
  try {
    mkdirSync(join(root, ".gitattributes"));
    for (const args of [[], ["--fix"]]) {
      const result = spawnSync(
        "bun",
        [binPath, "doctor", "--root", root, "--json", ...args],
        { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        checks: Array<{ name: string; status: string; message: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.checks.find((check) => check.name === "gitAttributes")).toMatchObject({
        status: "error",
        message: expect.stringContaining(args.length ? "cannot update" : "cannot inspect"),
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI init preserves an explicit resolveJsonModule setting", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-init-json-setting-"));
  try {
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { resolveJsonModule: false },
      include: ["src/**/*.ts"],
    }, null, 2));
    const result = spawnSync("bun", [binPath, "init", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "manual  tsconfig.json: set compilerOptions.resolveJsonModule to true",
    );
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
    expect(tsconfig.compilerOptions.resolveJsonModule).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI init scaffolds pgschema workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-init-pgschema-"));
  try {
    const r = spawnSync("bun", [binPath, "init", "--schema-provider", "pgschema", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("created schema.sql");
    expect(r.stdout).toContain("sqlx-js pgschema install");
    expect(r.stdout).toContain("sqlx-js doctor");
    expect(r.stdout).toContain("sqlx-js dev --strict-inference");
    expect(r.stdout).toContain("sqlx-js verify --strict-inference");
    expect(existsSync(join(root, "sqlx-js.config.ts"))).toBe(true);
    expect(existsSync(join(root, "schema.sql"))).toBe(true);
    expect(readFileSync(join(root, "sqlx-js.config.ts"), "utf8")).toContain('provider: "pgschema"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI pgschema plan delegates to configured pgschema", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-"));
  const binDir = join(root, "bin");
  const capture = join(root, "capture.txt");
  try {
    mkdirSync(binDir);
    writeFileSync(join(root, "sqlx-js.config.ts"), `export default {
  schema: {
    provider: "pgschema",
    file: "schema.sql",
    schemas: ["private"],
  },
};
`);
    writeFileSync(join(root, "schema.sql"), "CREATE TABLE users (id bigint primary key);\n");
    const fake = join(binDir, "pgschema");
    writeFileSync(fake, `#!/bin/sh
: > "$CAPTURE"
for arg in "$@"; do
  printf 'arg=%s\\n' "$arg" >> "$CAPTURE"
done
printf 'pgpassword=%s\\n' "$PGPASSWORD" >> "$CAPTURE"
printf 'pgsslmode=%s\\n' "$PGSSLMODE" >> "$CAPTURE"
printf 'pgsslrootcert=%s\\n' "$PGSSLROOTCERT" >> "$CAPTURE"
printf 'pgsslcert=%s\\n' "$PGSSLCERT" >> "$CAPTURE"
printf 'pgsslkey=%s\\n' "$PGSSLKEY" >> "$CAPTURE"
`);
    chmodSync(fake, 0o755);

    const r = spawnSync(
      "bun",
      [binPath, "pgschema", "plan", "--root", root, "--", "--root", "pgschema-root", "--output-json", "plan.json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          CAPTURE: capture,
          DATABASE_URL: "postgres://app_user:s3cr3t@localhost:5544/app_db?sslmode=verify-full&sslrootcert=/etc/ca.pem&sslcert=/etc/client.crt&sslkey=/etc/client.key",
        },
      },
    );
    expect(r.status).toBe(0);
    const out = readFileSync(capture, "utf8");
    expect(out).toContain("arg=plan");
    expect(out).toContain("arg=--host");
    expect(out).toContain("arg=localhost");
    expect(out).toContain("arg=--port");
    expect(out).toContain("arg=5544");
    expect(out).toContain("arg=--db");
    expect(out).toContain("arg=app_db");
    expect(out).toContain("arg=--user");
    expect(out).toContain("arg=app_user");
    expect(out).toContain(`arg=${join(root, "schema.sql")}`);
    expect(out).toContain("arg=private");
    expect(out).toContain("arg=--root");
    expect(out).toContain("arg=pgschema-root");
    expect(out).toContain("arg=--output-json");
    expect(out).toContain("arg=plan.json");
    expect(out).toContain("pgpassword=s3cr3t");
    expect(out).toContain("pgsslmode=verify-full");
    expect(out).toContain("pgsslrootcert=/etc/ca.pem");
    expect(out).toContain("pgsslcert=/etc/client.crt");
    expect(out).toContain("pgsslkey=/etc/client.key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI pgschema apply accepts a reviewed plan without schema file", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-apply-plan-"));
  const binDir = join(root, "bin");
  const capture = join(root, "capture.txt");
  try {
    mkdirSync(binDir);
    writeFileSync(join(root, "sqlx-js.config.ts"), `export default {
  schema: {
    provider: "pgschema",
    file: "schema.sql",
    schemas: ["private"],
  },
};
`);
    const fake = join(binDir, "pgschema");
    writeFileSync(fake, `#!/bin/sh
: > "$CAPTURE"
for arg in "$@"; do
  printf 'arg=%s\\n' "$arg" >> "$CAPTURE"
done
`);
    chmodSync(fake, 0o755);

    const r = spawnSync("bun", [binPath, "pgschema", "apply", "--root", root, "--", "--plan", "plan.json", "--auto-approve"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        CAPTURE: capture,
        DATABASE_URL: "postgres://app_user:s3cr3t@localhost:5544/app_db",
      },
    });

    expect(r.status).toBe(0);
    expect(readFileSync(capture, "utf8").trim().split("\n")).toEqual([
      "arg=apply",
      "arg=--host",
      "arg=localhost",
      "arg=--port",
      "arg=5544",
      "arg=--db",
      "arg=app_db",
      "arg=--user",
      "arg=app_user",
      "arg=--schema",
      "arg=private",
      "arg=--plan",
      "arg=plan.json",
      "arg=--auto-approve",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI pgschema plan rejects multi-schema config", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-multi-"));
  const binDir = join(root, "bin");
  const capture = join(root, "capture.txt");
  try {
    mkdirSync(binDir);
    writeFileSync(join(root, "sqlx-js.config.ts"), `export default {
  schema: {
    provider: "pgschema",
    file: "schema.sql",
    schemas: ["public", "private"],
  },
};
`);
    writeFileSync(join(root, "schema.sql"), "CREATE TABLE users (id bigint primary key);\n");
    const fake = join(binDir, "pgschema");
    writeFileSync(fake, `#!/bin/sh
printf 'called\\n' > "$CAPTURE"
exit 0
`);
    chmodSync(fake, 0o755);

    const r = spawnSync("bun", [binPath, "pgschema", "plan", "--root", root], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        CAPTURE: capture,
        DATABASE_URL: "postgres://app_user:s3cr3t@localhost:5544/app_db",
      },
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain("supports exactly one --schema value");
    expect(existsSync(capture)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI migrate check --json does not require DATABASE_URL", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-cli-"));
  try {
    const r = spawnSync("bun", [binPath, "migrate", "check", "--json", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, migrations: 0, archives: 0, issues: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects migrate run --json without dry-run before connecting", () => {
  const r = spawnSync("bun", [binPath, "migrate", "run", "--json"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://user:pass@example.invalid:5432/db" },
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("--json for migrate run requires --dry-run");
});

test("CLI rejects migrate revert --json without dry-run before connecting", () => {
  const r = spawnSync("bun", [binPath, "migrate", "revert", "--json"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://user:pass@example.invalid:5432/db" },
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("--json for migrate revert requires --dry-run");
});

test("prepare --json reports missing DATABASE_URL as one structured document", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-cli-json-"));
  try {
    const r = spawnSync("bun", [binPath, "prepare", "--json", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({
      formatVersion: 1,
      ok: false,
      mode: "prepare",
      diagnostics: [{ phase: "connect" }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare --jsonl rejects non-watch mode with one structured event", () => {
  const r = spawnSync("bun", [binPath, "prepare", "--jsonl"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" },
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout)).toMatchObject({
    formatVersion: 1,
    event: "error",
    diagnostic: { phase: "config" },
  });
});

test("prepare --check --json classifies config loading failures", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-cli-config-"));
  try {
    writeFileSync(join(root, "sqlx-js.config.mjs"), "export default [];\n");
    const r = spawnSync("bun", [binPath, "prepare", "--check", "--json", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({
      formatVersion: 1,
      ok: false,
      mode: "check",
      diagnostics: [{ phase: "config" }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare --check --json preserves scanner source location", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-cli-scan-"));
  try {
    writeFileSync(join(root, "a.ts"),
      "import { sql } from \"@onreza/sqlx-js\";\n" +
      "const query = \"SELECT 1\";\n" +
      "await sql(query);\n",
    );
    const r = spawnSync("bun", [binPath, "prepare", "--check", "--json", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({
      diagnostics: [{ phase: "scan", file: "a.ts", line: 3, column: 11 }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ci --json keeps provider verification failures machine-readable", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-ci-json-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "sqlx-js.config.js"), "export default null;\n");
    const r = spawnSync("bun", [binPath, "ci", "--json", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({
      formatVersion: 1,
      ok: false,
      results: [{ name: "verify", ok: false, exitCode: 2 }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
