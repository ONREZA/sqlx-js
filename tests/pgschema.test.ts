import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  managedPgschemaPath,
  pgschemaLockPath,
  probePgschema,
  readPgschemaLock,
  resolveLatestPgschemaLock,
  probeSchemaMaterializer,
  resolvePgschemaAsset,
  runPgschemaCommand,
  runPgschemaExec,
  runPgschemaInstall,
  runPgschemaUpdate,
  runSchemaMaterializer,
  SchemaMaterializerCommandError,
  type PgschemaLock,
  type PgschemaAsset,
} from "../src/commands/pgschema";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function pgschemaLock(version: string, digest: string): PgschemaLock {
  return {
    lockfileVersion: 1,
    source: "github:pgplex/pgschema",
    version,
    assets: Object.fromEntries(
      ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"].map((key) => [
        key,
        { name: `pgschema-${version}-${key}`, sha256: digest },
      ]),
    ) as PgschemaLock["assets"],
  };
}

function githubRelease(version: string, digest: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"].map((key) => ({
      name: `pgschema-${version}-${key}`,
      digest: `sha256:${digest}`,
    })),
    ...extra,
  };
}

test("resolvePgschemaAsset rejects Windows", () => {
  expect(() => resolvePgschemaAsset(pgschemaLock("1.12.3", "0".repeat(64)), "win32", "x64")).toThrow("WSL");
});

test("resolveLatestPgschemaLock selects the newest stable compatible patch", async () => {
  const digest = "a".repeat(64);
  const lock = await resolveLatestPgschemaLock({
    fetchImpl: async () => new Response(JSON.stringify([
      githubRelease("1.13.0", digest),
      githubRelease("1.12.5", digest, { prerelease: true }),
      githubRelease("1.12.2", digest),
      githubRelease("1.12.3", digest),
    ])),
  });

  expect(lock.version).toBe("1.12.3");
  expect(Object.keys(lock.assets)).toEqual([
    "darwin-amd64",
    "darwin-arm64",
    "linux-amd64",
    "linux-arm64",
  ]);
});

test("resolveLatestPgschemaLock requires every GitHub asset digest", async () => {
  const release = githubRelease("1.12.3", "a".repeat(64));
  (release.assets as Array<Record<string, unknown>>)[0]!.digest = null;
  await expect(resolveLatestPgschemaLock({
    fetchImpl: async () => new Response(JSON.stringify([release])),
  })).rejects.toThrow("has no valid GitHub SHA-256 digest");
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

test("probePgschema requires the locked managed binary unless command is explicit", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-probe-"));
  const command = join(root, "pgschema");
  const previousPath = process.env.PATH;
  try {
    writeFileSync(pgschemaLockPath(root), JSON.stringify(pgschemaLock("1.12.3", "e".repeat(64))));
    writeFileSync(command, "#!/bin/sh\nexit 0\n");
    chmodSync(command, 0o755);
    process.env.PATH = root;
    expect(probePgschema(root, { schema: { provider: "pgschema" } })).toMatchObject({
      ok: false,
      message: expect.stringContaining("managed pgschema v1.12.3 is not installed"),
    });

    expect(probePgschema(root, { schema: { provider: "pgschema", command: "./pgschema" } })).toMatchObject({
      ok: true,
      command: "./pgschema",
      message: expect.stringContaining("through schema.command"),
    });
    expect(probePgschema(root, { schema: { provider: "pgschema", command: "./missing" } })).toMatchObject({
      ok: false,
      command: "./missing",
      message: expect.stringContaining("Fix or remove schema.command"),
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPgschemaExec uses the checksum-verified managed binary", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-managed-exec-"));
  const capture = join(root, "capture.txt");
  const body = Buffer.from("#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\" > \"$CAPTURE\"\n");
  const lock = pgschemaLock("1.12.3", sha256(body));
  const target = managedPgschemaPath(root, lock);
  const previousCapture = process.env.CAPTURE;
  try {
    writeFileSync(pgschemaLockPath(root), JSON.stringify(lock));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { mode: 0o755 });
    process.env.CAPTURE = capture;
    runPgschemaExec({
      root,
      config: { schema: { provider: "pgschema" } },
      args: ["--help", "custom"],
    });
    expect(readFileSync(capture, "utf8")).toBe(`${root}\n--help\ncustom\n`);
  } finally {
    if (previousCapture === undefined) delete process.env.CAPTURE;
    else process.env.CAPTURE = previousCapture;
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed probes stay read-only and install repairs executable mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-managed-mode-"));
  const body = Buffer.from("#!/bin/sh\nexit 0\n");
  const lock = pgschemaLock("1.12.3", sha256(body));
  const target = managedPgschemaPath(root, lock);
  try {
    writeFileSync(pgschemaLockPath(root), JSON.stringify(lock));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { mode: 0o644 });

    expect(probePgschema(root, { schema: { provider: "pgschema" } })).toMatchObject({
      ok: false,
      message: expect.stringContaining("managed binary is not executable"),
    });
    expect(statSync(target).mode & 0o777).toBe(0o644);

    await runPgschemaInstall({ root, log: () => {} });
    expect(statSync(target).mode & 0o111).not.toBe(0);
    expect(probePgschema(root, { schema: { provider: "pgschema" } }).ok).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPgschemaInstall downloads and verifies the project-locked binary", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-install-"));
  const body = Buffer.from("#!/bin/sh\nprintf 'pgschema test\\n'\n");
  const lock = pgschemaLock("1.12.3", sha256(body));
  const asset: PgschemaAsset = resolvePgschemaAsset(lock);
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.url !== `/v${lock.version}/${asset.name}`) {
      res.writeHead(404).end();
      return;
    }
    hits += 1;
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
  });

  try {
    writeFileSync(pgschemaLockPath(root), JSON.stringify(lock));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const logs: string[] = [];

    await runPgschemaInstall({
      root,
      downloadBaseUrl: `http://127.0.0.1:${address.port}`,
      log: (msg) => logs.push(msg),
    });

    const target = managedPgschemaPath(root, lock, asset);
    expect(target).toBe(
      join(root, "node_modules/.cache/sqlx-js/pgschema", `v${lock.version}`, asset.key, "pgschema"),
    );
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(body.toString());
    expect(logs.join("\n")).toContain("installed pgschema");
    expect(hits).toBe(1);

    await runPgschemaInstall({
      root,
      downloadBaseUrl: `http://127.0.0.1:${address.port}`,
      log: (msg) => logs.push(msg),
    });

    expect(hits).toBe(1);
    expect(logs.join("\n")).toContain("already installed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPgschemaInstall creates a missing lock unless frozen", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-first-install-"));
  const body = Buffer.from("#!/bin/sh\nprintf 'pgschema first install\\n'\n");
  const digest = sha256(body);
  const releaseUrl = "https://releases.test/pgschema";
  const downloadBaseUrl = "https://downloads.test/pgschema";
  let fetches = 0;
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    fetches += 1;
    const url = String(input);
    if (url === releaseUrl) return new Response(JSON.stringify([githubRelease("1.12.3", digest)]));
    if (url.startsWith(`${downloadBaseUrl}/v1.12.3/`)) return new Response(body);
    return new Response(null, { status: 404 });
  };

  try {
    await expect(runPgschemaInstall({ root, frozen: true, fetchImpl })).rejects.toThrow("required with --frozen");
    expect(fetches).toBe(0);

    await runPgschemaInstall({ root, releasesUrl: releaseUrl, downloadBaseUrl, fetchImpl, log: () => {} });
    expect(readPgschemaLock(root).version).toBe("1.12.3");
    expect(fetches).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pgschema install and update reject a missing project root before network access", async () => {
  const parent = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-missing-root-"));
  const root = join(parent, "missing");
  let fetches = 0;
  const fetchImpl = async (): Promise<Response> => {
    fetches += 1;
    return new Response(null, { status: 500 });
  };
  try {
    await expect(runPgschemaInstall({ root, fetchImpl })).rejects.toThrow("project root is not a directory");
    await expect(runPgschemaUpdate({ root, fetchImpl })).rejects.toThrow("project root is not a directory");
    expect(fetches).toBe(0);
    expect(existsSync(root)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runPgschemaUpdate installs before atomically replacing the project lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-update-"));
  const oldLock = pgschemaLock("1.12.2", "b".repeat(64));
  const body = Buffer.from("#!/bin/sh\nprintf 'pgschema updated\\n'\n");
  const nextDigest = sha256(body);
  const releaseUrl = "https://releases.test/pgschema";
  const downloadBaseUrl = "https://downloads.test/pgschema";
  const logs: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === releaseUrl) return new Response(JSON.stringify([githubRelease("1.12.3", nextDigest)]));
    if (url.startsWith(`${downloadBaseUrl}/v1.12.3/`)) return new Response(body);
    return new Response(null, { status: 404 });
  };

  try {
    writeFileSync(pgschemaLockPath(root), JSON.stringify(oldLock));
    await runPgschemaUpdate({ root, releasesUrl: releaseUrl, downloadBaseUrl, fetchImpl, log: (msg) => logs.push(msg) });

    const lock = readPgschemaLock(root);
    expect(lock.version).toBe("1.12.3");
    expect(readFileSync(managedPgschemaPath(root, lock), "utf8")).toBe(body.toString());
    expect(logs.join("\n")).toContain("from v1.12.2 to v1.12.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPgschemaUpdate preserves the previous lock when binary verification fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-failed-update-"));
  const oldLock = pgschemaLock("1.12.2", "b".repeat(64));
  const releaseUrl = "https://releases.test/pgschema";
  const downloadBaseUrl = "https://downloads.test/pgschema";
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === releaseUrl) return new Response(JSON.stringify([githubRelease("1.12.3", "c".repeat(64))]));
    if (url.startsWith(`${downloadBaseUrl}/v1.12.3/`)) return new Response("wrong binary");
    return new Response(null, { status: 404 });
  };

  try {
    writeFileSync(pgschemaLockPath(root), JSON.stringify(oldLock));
    await expect(runPgschemaUpdate({ root, releasesUrl: releaseUrl, downloadBaseUrl, fetchImpl })).rejects.toThrow(
      "checksum mismatch",
    );
    expect(readPgschemaLock(root).version).toBe("1.12.2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPgschemaUpdate leaves an already-current lock byte-for-byte unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-current-update-"));
  const body = Buffer.from("#!/bin/sh\nprintf 'pgschema current\\n'\n");
  const lock = pgschemaLock("1.12.3", sha256(body));
  const original = JSON.stringify(lock);
  const releaseUrl = "https://releases.test/pgschema";
  const downloadBaseUrl = "https://downloads.test/pgschema";
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === releaseUrl) return new Response(JSON.stringify([githubRelease(lock.version, sha256(body))]));
    if (url.startsWith(`${downloadBaseUrl}/v${lock.version}/`)) return new Response(body);
    return new Response(null, { status: 404 });
  };

  try {
    writeFileSync(pgschemaLockPath(root), original);
    await runPgschemaUpdate({ root, releasesUrl: releaseUrl, downloadBaseUrl, fetchImpl, log: () => {} });
    expect(readFileSync(pgschemaLockPath(root), "utf8")).toBe(original);
    expect(readFileSync(managedPgschemaPath(root, lock), "utf8")).toBe(body.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPgschemaLock rejects versions outside the supported minor line", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-range-"));
  try {
    writeFileSync(pgschemaLockPath(root), JSON.stringify(pgschemaLock("1.13.0", "d".repeat(64))));
    expect(() => readPgschemaLock(root)).toThrow("outside the supported range >=1.12 <1.13");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPgschemaLock rejects malformed lock authority fields", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-invalid-lock-"));
  const valid = pgschemaLock("1.12.3", "d".repeat(64));
  const cases: Array<[value: unknown, message: string]> = [
    [{ ...valid, lockfileVersion: 2 }, "unsupported lockfileVersion"],
    [{ ...valid, source: "https://example.invalid" }, "unsupported source"],
    [{ ...valid, assets: { ...valid.assets, "linux-amd64": undefined } }, "missing asset linux-amd64"],
    [{
      ...valid,
      assets: { ...valid.assets, "linux-amd64": { ...valid.assets["linux-amd64"], sha256: "ABC" } },
    }, "lowercase SHA-256 digest"],
    [{ ...valid, assets: { ...valid.assets, "freebsd-amd64": { name: "pgschema", sha256: "d".repeat(64) } } },
      "unsupported asset freebsd-amd64"],
  ];
  try {
    for (const [value, message] of cases) {
      writeFileSync(pgschemaLockPath(root), JSON.stringify(value));
      expect(() => readPgschemaLock(root)).toThrow(message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPgschemaUpdate refuses downgrades and mutated assets for the same release", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-monotonic-update-"));
  const releaseUrl = "https://releases.test/pgschema";
  try {
    writeFileSync(pgschemaLockPath(root), JSON.stringify(pgschemaLock("1.12.4", "a".repeat(64))));
    await expect(runPgschemaUpdate({
      root,
      releasesUrl: releaseUrl,
      fetchImpl: async () => new Response(JSON.stringify([githubRelease("1.12.3", "a".repeat(64))])),
    })).rejects.toThrow("refusing to downgrade v1.12.4 to v1.12.3");

    writeFileSync(pgschemaLockPath(root), JSON.stringify(pgschemaLock("1.12.3", "a".repeat(64))));
    await expect(runPgschemaUpdate({
      root,
      releasesUrl: releaseUrl,
      fetchImpl: async () => new Response(JSON.stringify([githubRelease("1.12.3", "b".repeat(64))])),
    })).rejects.toThrow("release asset digests changed for locked v1.12.3");
  } finally {
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
printf 'cwd=%s\n' "$PWD" > "$CAPTURE"
printf 'args=%s\n' "$*" >> "$CAPTURE"
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
        databaseUrl: `postgresql://app@db.internal:5544/app?hostaddr=127.0.0.1&passfile=${encodeURIComponent(passfile)}&sslmode=disable`,
        config: { schema: { provider: "pgschema", command: "./pgschema.sh" } },
        subcommand: "plan",
      });
    } finally {
      if (previousCapture === undefined) delete process.env.CAPTURE;
      else process.env.CAPTURE = previousCapture;
    }
    expect(readFileSync(capture, "utf8")).toContain(`cwd=${root}\n`);
    expect(readFileSync(capture, "utf8")).toContain(
      "args=plan --host 127.0.0.1 --port 5544 --db app --user app",
    );
    expect(readFileSync(capture, "utf8")).toContain("password=from-pgpass");
    expect(readFileSync(capture, "utf8")).toContain("passfile=\n");
    expect(readFileSync(capture, "utf8")).toContain(
      "options=-c client_encoding=UTF8 -c DateStyle=ISO -c TimeZone=UTC",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pgschema rejects target session settings it cannot isolate from the plan database", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-pgschema-session-settings-"));
  const command = join(root, "pgschema.sh");
  const marker = join(root, "executed");
  try {
    writeFileSync(join(root, "schema.sql"), "SELECT 1;\n");
    writeFileSync(command, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`);
    chmodSync(command, 0o755);

    for (const [parameter, expected] of [
      ["options=-c%20search_path%3Dapp", "options"],
      ["role=app_reader", "role"],
      ["statement_timeout=5000", "statement_timeout"],
      ["application_name=deploy", "application_name"],
    ] as const) {
      expect(() => runPgschemaCommand({
        root,
        databaseUrl: `postgresql://app@db.internal/app?sslmode=disable&${parameter}`,
        config: { schema: { provider: "pgschema", command } },
        subcommand: "plan",
      })).toThrow(`${expected} cannot be preserved independently from pgschema's plan database`);
    }
    expect(existsSync(marker)).toBe(false);
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
  const capture = join(root, "capture.txt");
  const previousPlanHost = process.env.PGSCHEMA_PLAN_HOST;
  const previousCapture = process.env.CAPTURE;
  try {
    writeFileSync(join(root, "schema.sql"), "SELECT 1;\n");
    writeFileSync(command, `#!/bin/sh
printf 'args=%s\n' "$*" > "$CAPTURE"
printf 'plan_host=%s\n' "$PGSCHEMA_PLAN_HOST" >> "$CAPTURE"
`);
    chmodSync(command, 0o755);

    for (const argument of ["--host=other.invalid", "--password", "--schema=other", "--file=other.sql"]) {
      expect(() => runPgschemaCommand({
        root,
        databaseUrl: "postgresql://app@db.internal/app?sslmode=disable",
        config: { schema: { provider: "pgschema", command } },
        subcommand: "plan",
        passthrough: [argument],
      })).toThrow("is owned by the sqlx-js connection and schema configuration");
    }
    process.env.CAPTURE = capture;
    process.env.PGSCHEMA_PLAN_HOST = "plan.internal";
    runPgschemaCommand({
      root,
      databaseUrl: "postgresql://app@db.internal/app?sslmode=disable",
      config: { schema: { provider: "pgschema", command } },
      subcommand: "plan",
      passthrough: ["--plan-host", "plan-override.internal"],
    });
    expect(readFileSync(capture, "utf8")).toBe(
      "args=plan --host db.internal --port 5432 --db app --user app --file "
      + `${join(root, "schema.sql")} --schema public --plan-host plan-override.internal\n`
      + "plan_host=plan.internal\n",
    );
  } finally {
    if (previousPlanHost === undefined) delete process.env.PGSCHEMA_PLAN_HOST;
    else process.env.PGSCHEMA_PLAN_HOST = previousPlanHost;
    if (previousCapture === undefined) delete process.env.CAPTURE;
    else process.env.CAPTURE = previousCapture;
    rmSync(root, { recursive: true, force: true });
  }
});
