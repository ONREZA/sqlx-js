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
  expect(r.stdout).toContain("--dry-run");
  expect(r.stdout).toContain("--json");
  expect(r.stdout).toContain("sqlx-js db install");
  expect(r.stdout).toContain("sqlx-js doctor");
  expect(r.stdout).toContain("--verify");
  expect(r.stdout).toContain("--offline");
  expect(r.stdout).toContain("--jsonl");
  expect(r.stdout).toContain("--schema-provider");
  expect(r.stdout).toContain("check [--json]");
  expect(r.stdout).toContain("migrate dev");
  expect(r.stdout).toContain("verify [--shadow-admin-url");
  expect(r.stdout).toContain("--shadow-admin-url");
  expect(r.stdout).toContain("revert [--dry-run]");
  expect(r.stdout).toContain("archive restore");
});

test("CLI help lists the init command", () => {
  const r = spawnSync("bun", [binPath, "--help"], { encoding: "utf8" });
  expect(r.stdout).toContain("sqlx-js init");
});

test("CLI command help is successful and command-specific", () => {
  const r = spawnSync("bun", [binPath, "prepare", "--help"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  expect(r.stdout).toContain("usage: sqlx-js prepare");
  expect(r.stdout).toContain("--strict-inference");
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
    }],
  });
  const unix = spawnSync("bun", [diagnosticsBinPath, "unix"], { encoding: "utf8", input });
  expect(unix.status).toBe(0);
  expect(unix.stdout.trim()).toBe("src/users.ts:12:7: warning: [inference] result column resolved conservatively");

  const github = spawnSync("bun", [diagnosticsBinPath, "github"], { encoding: "utf8", input });
  expect(github.status).toBe(0);
  expect(github.stdout.trim()).toBe("::warning file=src/users.ts,line=12,col=7::[inference] result column resolved conservatively");
});

test("CLI init scaffolds project files and is idempotent without DATABASE_URL", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-init-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "bun test" } }, null, 2));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }, null, 2));
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
    expect(readFileSync(join(root, "sqlx-js.config.ts"), "utf8")).toContain("defineConfig");
    expect(JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")).include).toContain("sqlx-js-env.d.ts");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts).toMatchObject({
      test: "bun test",
      "sqlx:prepare": "sqlx-js prepare",
      "sqlx:check": "sqlx-js prepare --check",
      "sqlx:offline": "sqlx-js prepare --offline",
      "sqlx:verify": "sqlx-js prepare --verify --strict-inference",
    });

    const r2 = spawnSync("bun", [binPath, "init", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain("left unchanged");
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
    expect(r.stdout).toContain("sqlx-js db install");
    expect(r.stdout).toContain("sqlx-js db check");
    expect(existsSync(join(root, "sqlx-js.config.ts"))).toBe(true);
    expect(existsSync(join(root, "schema.sql"))).toBe(true);
    expect(readFileSync(join(root, "sqlx-js.config.ts"), "utf8")).toContain('provider: "pgschema"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI db check probes pgschema help", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-check-"));
  const binDir = join(root, "bin");
  const capture = join(root, "capture.txt");
  try {
    mkdirSync(binDir);
    writeFileSync(join(root, "sqlx-js.config.ts"), `export default {
  schema: {
    provider: "pgschema",
    file: "schema.sql",
    schemas: ["public"],
  },
};
`);
    const fake = join(binDir, "pgschema");
    writeFileSync(fake, `#!/bin/sh
: > "$CAPTURE"
for arg in "$@"; do
  printf 'arg=%s\\n' "$arg" >> "$CAPTURE"
done
if [ "$1" = "--help" ]; then
  printf 'pgschema help\\n'
  exit 0
fi
printf 'unexpected args\\n' >&2
exit 1
`);
    chmodSync(fake, 0o755);

    const r = spawnSync("bun", [binPath, "db", "check", "--root", root], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        CAPTURE: capture,
        DATABASE_URL: "",
      },
    });

    expect(r.status).toBe(0);
    expect(readFileSync(capture, "utf8")).toContain("arg=--help");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI db plan delegates to configured pgschema", () => {
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
      [binPath, "db", "plan", "--root", root, "--", "--root", "pgschema-root", "--output-json", "plan.json"],
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

test("CLI db apply accepts pgschema plan without schema file", () => {
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

    const r = spawnSync("bun", [binPath, "db", "apply", "--root", root, "--", "--plan", "plan.json", "--auto-approve"], {
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

test("CLI db plan rejects multi-schema pgschema config", () => {
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

    const r = spawnSync("bun", [binPath, "db", "plan", "--root", root], {
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
