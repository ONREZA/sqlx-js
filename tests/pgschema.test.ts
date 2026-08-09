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
  resolvePgschemaAsset,
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
    process.env.CAPTURE = capture;
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
