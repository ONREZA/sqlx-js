import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  managedPgschemaPath,
  PGSCHEMA_VERSION,
  probeSchemaMaterializer,
  resolvePgschemaAsset,
  runPgschemaCommand,
  runPgschemaInstall,
  runSchemaMaterializer,
  SchemaMaterializerCommandError,
  type PgschemaAsset,
} from "../src/commands/pgschema";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

test("resolvePgschemaAsset rejects Windows", () => {
  expect(() => resolvePgschemaAsset("win32", "x64")).toThrow("WSL");
});

test("probeSchemaMaterializer checks executability without running the command", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-materializer-probe-"));
  const command = join(root, "materialize.sh");
  const marker = join(root, "executed");
  try {
    writeFileSync(command, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`);
    chmodSync(command, 0o755);
    expect(probeSchemaMaterializer(root, {
      schema: { provider: "pgschema", materializer: { command: "./materialize.sh" } },
    })).toMatchObject({
      ok: true,
      command: "./materialize.sh",
    });
    expect(existsSync(marker)).toBe(false);

    chmodSync(command, 0o644);
    expect(probeSchemaMaterializer(root, {
      schema: { provider: "pgschema", materializer: { command: "./materialize.sh" } },
    })).toMatchObject({
      ok: false,
      message: expect.stringContaining("not found or not executable"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPgschemaInstall downloads and verifies the pinned binary", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-install-"));
  const body = Buffer.from("#!/bin/sh\nprintf 'pgschema test\\n'\n");
  const asset: PgschemaAsset = {
    key: "test-platform",
    name: "pgschema-test",
    sha256: sha256(body),
  };
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.url !== `/${asset.name}`) {
      res.writeHead(404).end();
      return;
    }
    hits += 1;
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const logs: string[] = [];

    await runPgschemaInstall({
      root,
      asset,
      baseUrl: `http://127.0.0.1:${address.port}`,
      log: (msg) => logs.push(msg),
    });

    const target = managedPgschemaPath(root, asset);
    expect(target).toBe(
      join(root, "node_modules/.cache/sqlx-js/pgschema", `v${PGSCHEMA_VERSION}`, asset.key, "pgschema"),
    );
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(body.toString());
    expect(readFileSync(`${target}.json`, "utf8")).toContain(PGSCHEMA_VERSION);
    expect(logs.join("\n")).toContain("installed pgschema");
    expect(hits).toBe(1);

    await runPgschemaInstall({
      root,
      asset,
      baseUrl: `http://127.0.0.1:${address.port}`,
      log: (msg) => logs.push(msg),
    });

    expect(hits).toBe(1);
    expect(logs.join("\n")).toContain("already installed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema materializer receives the disposable database as its workflow boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-materializer-"));
  const command = join(root, "materialize.sh");
  const capture = join(root, "capture.txt");
  const shadowUrl = "postgres://shadow:secret@localhost:5544/shadow";
  try {
    writeFileSync(join(root, "schema.sql"), "SELECT 1;\n");
    writeFileSync(command, `#!/bin/sh
printf 'cwd=%s\n' "$PWD" > "$CAPTURE"
printf 'database=%s\n' "$DATABASE_URL" >> "$CAPTURE"
printf 'shadow=%s\n' "$SQLX_JS_SHADOW_DATABASE_URL" >> "$CAPTURE"
printf 'root=%s\n' "$SQLX_JS_PROJECT_ROOT" >> "$CAPTURE"
printf 'schema=%s\n' "$SQLX_JS_SCHEMA_FILE" >> "$CAPTURE"
printf 'args=%s\n' "$*" >> "$CAPTURE"
`);
    chmodSync(command, 0o755);
    const previousCapture = process.env.CAPTURE;
    const previousPassword = process.env.PGPASSWORD;
    process.env.CAPTURE = capture;
    delete process.env.PGPASSWORD;
    try {
      runSchemaMaterializer({
        root,
        databaseUrl: "postgres://target:secret@localhost/target",
        config: {
          schema: {
            provider: "pgschema",
            file: "schema.sql",
            materializer: { command, args: ["expand", "apply"] },
          },
        },
        cacheDir: join(root, ".sqlx-js"),
        dtsPath: join(root, "sqlx-js-env.d.ts"),
        snapshotPath: join(root, "schema.snapshot.json"),
      }, shadowUrl);
    } finally {
      if (previousCapture === undefined) delete process.env.CAPTURE;
      else process.env.CAPTURE = previousCapture;
      if (previousPassword === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = previousPassword;
    }
    expect(readFileSync(capture, "utf8")).toBe(
      `cwd=${root}\n`
      + `database=${shadowUrl}\n`
      + `shadow=${shadowUrl}\n`
      + `root=${root}\n`
      + `schema=${join(root, "schema.sql")}\n`
      + "args=expand apply\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema materializer preserves its command exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-materializer-exit-"));
  const command = join(root, "materialize.sh");
  try {
    writeFileSync(command, "#!/bin/sh\nexit 7\n");
    chmodSync(command, 0o755);
    let failure: unknown;
    try {
      runSchemaMaterializer({
        root,
        databaseUrl: "postgres://target@localhost/target",
        config: { schema: { provider: "pgschema", materializer: { command } } },
        cacheDir: join(root, ".sqlx-js"),
        dtsPath: join(root, "sqlx-js-env.d.ts"),
        snapshotPath: join(root, "schema.snapshot.json"),
      }, "postgres://shadow@localhost/shadow");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SchemaMaterializerCommandError);
    expect(failure).toMatchObject({ exitCode: 7 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pgschema uses the resolved endpoint and password-file identity", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-resolver-"));
  const command = join(root, "pgschema.sh");
  const capture = join(root, "capture.txt");
  const passfile = join(root, "pgpass");
  try {
    writeFileSync(join(root, "schema.sql"), "SELECT 1;\n");
    writeFileSync(passfile, "db.internal:5544:app:app:from-pgpass\n", { mode: 0o600 });
    writeFileSync(command, `#!/bin/sh
printf 'args=%s\n' "$*" > "$CAPTURE"
printf 'password=%s\n' "$PGPASSWORD" >> "$CAPTURE"
printf 'passfile=%s\n' "$PGPASSFILE" >> "$CAPTURE"
printf 'options=%s\n' "$PGOPTIONS" >> "$CAPTURE"
`);
    chmodSync(command, 0o755);
    const previousCapture = process.env.CAPTURE;
    process.env.CAPTURE = capture;
    try {
      runPgschemaCommand({
        root,
        databaseUrl: `postgresql://app@db.internal:5544/app?hostaddr=127.0.0.1&passfile=${encodeURIComponent(passfile)}&sslmode=disable&role=app_reader`,
        config: { schema: { provider: "pgschema", command } },
        subcommand: "plan",
      });
    } finally {
      if (previousCapture === undefined) delete process.env.CAPTURE;
      else process.env.CAPTURE = previousCapture;
    }
    expect(readFileSync(capture, "utf8")).toContain(
      "args=plan --host 127.0.0.1 --port 5544 --db app --user app",
    );
    expect(readFileSync(capture, "utf8")).toContain("password=from-pgpass");
    expect(readFileSync(capture, "utf8")).toContain("passfile=\n");
    expect(readFileSync(capture, "utf8")).toContain("options=-c role=app_reader");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pgschema fails before execution when TLS cannot preserve the logical host", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-hostaddr-"));
  const command = join(root, "pgschema.sh");
  const marker = join(root, "executed");
  try {
    writeFileSync(join(root, "schema.sql"), "SELECT 1;\n");
    writeFileSync(command, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`);
    chmodSync(command, 0o755);

    for (const sslmode of ["require", "verify-ca", "verify-full"]) {
      expect(() => runPgschemaCommand({
        root,
        databaseUrl: `postgresql://app@db.internal/app?hostaddr=127.0.0.1&sslmode=${sslmode}`,
        config: { schema: { provider: "pgschema", command } },
        subcommand: "plan",
      })).toThrow("cannot preserve the TLS server name");
    }
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pgschema seals an unresolved empty password against another password-file lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-empty-password-"));
  const command = join(root, "pgschema.sh");
  const capture = join(root, "capture.txt");
  const passfile = join(root, "pgpass");
  try {
    writeFileSync(join(root, "schema.sql"), "SELECT 1;\n");
    writeFileSync(passfile, "other.internal:5432:other:other:wrong\n", { mode: 0o600 });
    writeFileSync(command, `#!/bin/sh
printf 'password=%s\n' "$PGPASSWORD" > "$CAPTURE"
printf 'passfile=%s\n' "$PGPASSFILE" >> "$CAPTURE"
`);
    chmodSync(command, 0o755);
    const previousCapture = process.env.CAPTURE;
    process.env.CAPTURE = capture;
    try {
      runPgschemaCommand({
        root,
        databaseUrl: `postgresql://app@db.internal/app?passfile=${encodeURIComponent(passfile)}&sslmode=disable`,
        config: { schema: { provider: "pgschema", command } },
        subcommand: "plan",
      });
    } finally {
      if (previousCapture === undefined) delete process.env.CAPTURE;
      else process.env.CAPTURE = previousCapture;
    }
    expect(readFileSync(capture, "utf8")).toMatch(
      /^password=sqlx-js-no-password-[0-9a-f]{32}\npassfile=\n$/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pgschema passthrough cannot replace sqlx-js-owned targets or credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-passthrough-"));
  const command = join(root, "pgschema.sh");
  const marker = join(root, "executed");
  const previousPlanHost = process.env.PGSCHEMA_PLAN_HOST;
  try {
    writeFileSync(join(root, "schema.sql"), "SELECT 1;\n");
    writeFileSync(command, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`);
    chmodSync(command, 0o755);

    for (const argument of ["--host=other.invalid", "--password", "--plan-host"]) {
      expect(() => runPgschemaCommand({
        root,
        databaseUrl: "postgresql://app@db.internal/app?sslmode=disable",
        config: { schema: { provider: "pgschema", command } },
        subcommand: "plan",
        passthrough: [argument],
      })).toThrow("is owned by the sqlx-js connection and schema configuration");
    }
    process.env.PGSCHEMA_PLAN_HOST = "wrong-plan.invalid";
    expect(() => runPgschemaCommand({
      root,
      databaseUrl: "postgresql://app@db.internal/app?sslmode=disable",
      config: { schema: { provider: "pgschema", command } },
      subcommand: "plan",
    })).toThrow("PGSCHEMA_PLAN_HOST is not supported by the unified connection adapter");
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (previousPlanHost === undefined) delete process.env.PGSCHEMA_PLAN_HOST;
    else process.env.PGSCHEMA_PLAN_HOST = previousPlanHost;
    rmSync(root, { recursive: true, force: true });
  }
});
