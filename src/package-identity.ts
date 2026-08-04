import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PackageIdentity = {
  version: string;
  packageJsonPath: string;
};

export type PackageIdentityCheck = {
  status: "match" | "mismatch" | "invalid" | "unresolved";
  message: string;
  running: PackageIdentity;
  target?: PackageIdentity;
  root: string;
};

export function runningPackageIdentity(moduleUrl: string): PackageIdentity {
  const here = dirname(fileURLToPath(moduleUrl));
  for (const path of [join(here, "../package.json"), join(here, "../../package.json")]) {
    const identity = readPackageIdentity(path, true);
    if (identity) return identity;
  }
  throw new Error("sqlx-js: cannot locate package.json for the running CLI");
}

export function inspectPackageIdentity(root: string, running: PackageIdentity): PackageIdentityCheck {
  const resolvedRoot = resolve(root);
  let target: PackageIdentity | undefined;
  try {
    target = resolveProjectPackageIdentity(resolvedRoot);
  } catch (error) {
    return {
      status: "invalid",
      message: `sqlx-js: ${(error as Error).message}`,
      running,
      root: resolvedRoot,
    };
  }
  if (!target) {
    return {
      status: "unresolved",
      message: `@onreza/sqlx-js is not installed from ${resolvedRoot}; CLI identity could not be compared`,
      running,
      root: resolvedRoot,
    };
  }
  if (target.version !== running.version) {
    return {
      status: "mismatch",
      message:
        `sqlx-js: running CLI ${running.version} at ${running.packageJsonPath} does not match `
        + `@onreza/sqlx-js ${target.version} resolved from --root ${resolvedRoot} at ${target.packageJsonPath}. `
        + "Run the package-local sqlx-js script or reinstall workspace dependencies.",
      running,
      target,
      root: resolvedRoot,
    };
  }
  return {
    status: "match",
    message:
      `running CLI ${running.version} at ${running.packageJsonPath} matches `
      + `the package resolved from ${resolvedRoot} at ${target.packageJsonPath}`,
    running,
    target,
    root: resolvedRoot,
  };
}

function resolveProjectPackageIdentity(root: string): PackageIdentity | undefined {
  const rootPackage = readPackageIdentity(join(root, "package.json"), true);
  if (rootPackage) return rootPackage;
  let current = root;
  while (true) {
    const packageDir = join(current, "node_modules/@onreza/sqlx-js");
    if (pathEntryExists(packageDir)) {
      const packageJsonPath = join(packageDir, "package.json");
      const installed = readPackageIdentity(packageJsonPath, true);
      if (!installed) {
        throw new Error(
          `the nearest @onreza/sqlx-js installation at ${packageDir} has an invalid package.json. `
          + "Reinstall workspace dependencies.",
        );
      }
      return installed;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function readPackageIdentity(path: string, requireSqlxName = false): PackageIdentity | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: { name?: unknown; version?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  } catch {
    return undefined;
  }
  if (requireSqlxName && parsed.name !== "@onreza/sqlx-js") return undefined;
  if (typeof parsed.version !== "string" || parsed.version.length === 0) return undefined;
  return { version: parsed.version, packageJsonPath: realpathSync(path) };
}
