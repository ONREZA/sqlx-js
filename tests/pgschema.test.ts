import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  managedPgschemaPath,
  PGSCHEMA_VERSION,
  resolvePgschemaAsset,
  runPgschemaInstall,
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
