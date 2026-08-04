import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPackageIdentity, type PackageIdentity } from "../src/package-identity";

test("package identity reports the package resolved from the requested root", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-package-identity-"));
  try {
    const packageDir = join(root, "node_modules/@onreza/sqlx-js");
    mkdirSync(packageDir, { recursive: true });
    const targetPath = join(packageDir, "package.json");
    writeFileSync(targetPath, JSON.stringify({ name: "@onreza/sqlx-js", version: "0.26.0" }));
    const running: PackageIdentity = { version: "0.26.0", packageJsonPath: "/opt/sqlx-js/package.json" };

    const match = inspectPackageIdentity(root, running);
    expect(match).toMatchObject({
      status: "match",
      running: { version: "0.26.0" },
      target: { version: "0.26.0", packageJsonPath: targetPath },
    });

    const mismatch = inspectPackageIdentity(root, { ...running, version: "0.13.1" });
    expect(mismatch).toMatchObject({
      status: "mismatch",
      running: { version: "0.13.1" },
      target: { version: "0.26.0" },
    });
    expect(mismatch.message).toContain("Run the package-local sqlx-js script");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package identity rejects an invalid nearest installation instead of using a parent", () => {
  const parent = mkdtempSync(join(tmpdir(), "sqlx-js-package-identity-invalid-"));
  const root = join(parent, "project");
  try {
    const parentPackage = join(parent, "node_modules/@onreza/sqlx-js");
    const nearestPackage = join(root, "node_modules/@onreza/sqlx-js");
    mkdirSync(parentPackage, { recursive: true });
    mkdirSync(nearestPackage, { recursive: true });
    writeFileSync(join(parentPackage, "package.json"), JSON.stringify({
      name: "@onreza/sqlx-js",
      version: "0.26.0",
    }));
    writeFileSync(join(nearestPackage, "package.json"), JSON.stringify({
      name: "not-sqlx-js",
      version: "0.26.0",
    }));

    const result = inspectPackageIdentity(root, {
      version: "0.26.0",
      packageJsonPath: "/opt/sqlx-js/package.json",
    });
    expect(result.status).toBe("invalid");
    expect(result.message).toContain(`nearest @onreza/sqlx-js installation at ${nearestPackage}`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
