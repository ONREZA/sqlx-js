import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const PGSCHEMA_COMPATIBLE_MAJOR = 1;
const PGSCHEMA_COMPATIBLE_MINOR = 12;

export const PGSCHEMA_VERSION_RANGE =
  `>=${PGSCHEMA_COMPATIBLE_MAJOR}.${PGSCHEMA_COMPATIBLE_MINOR} <${PGSCHEMA_COMPATIBLE_MAJOR}.${PGSCHEMA_COMPATIBLE_MINOR + 1}`;
export const PGSCHEMA_LOCK_FILENAME = "pgschema.lock.json";
export const PGSCHEMA_WINDOWS_UNSUPPORTED =
  "sqlx-js pgschema: pgschema is not supported on Windows. Run sqlx-js under WSL/Linux/macOS or use the built-in migration workflow.";

const PGSCHEMA_RELEASES_URL = "https://api.github.com/repos/pgplex/pgschema/releases?per_page=100";
const PGSCHEMA_DOWNLOAD_BASE_URL = "https://github.com/pgplex/pgschema/releases/download";
const PGSCHEMA_LOCK_VERSION = 1;
const PGSCHEMA_LOCK_SOURCE = "github:pgplex/pgschema";

const PGSCHEMA_PLATFORM_KEYS = {
  "darwin:x64": "darwin-amd64",
  "darwin:arm64": "darwin-arm64",
  "linux:x64": "linux-amd64",
  "linux:arm64": "linux-arm64",
} as const;

type PgschemaPlatformKey = typeof PGSCHEMA_PLATFORM_KEYS[keyof typeof PGSCHEMA_PLATFORM_KEYS];

export type PgschemaAsset = {
  key: string;
  name: string;
  sha256: string;
};

export type PgschemaLock = {
  lockfileVersion: typeof PGSCHEMA_LOCK_VERSION;
  source: typeof PGSCHEMA_LOCK_SOURCE;
  version: string;
  assets: Record<PgschemaPlatformKey, { name: string; sha256: string }>;
};

export type PgschemaInstallOptions = {
  root: string;
  frozen?: boolean;
  releasesUrl?: string;
  downloadBaseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
};

type GitHubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
};

type GitHubReleaseAsset = {
  name?: unknown;
  digest?: unknown;
};

export function pgschemaLockPath(root: string): string {
  return join(root, PGSCHEMA_LOCK_FILENAME);
}

function parseCompatiblePgschemaVersion(version: string): [major: number, minor: number, patch: number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) {
    throw new Error(`sqlx-js pgschema: version ${JSON.stringify(version)} is not a stable semantic version`);
  }
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (parsed.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`sqlx-js pgschema: version ${version} exceeds the supported integer range`);
  }
  if (parsed[0] !== PGSCHEMA_COMPATIBLE_MAJOR || parsed[1] !== PGSCHEMA_COMPATIBLE_MINOR) {
    throw new Error(
      `sqlx-js pgschema: version ${version} is outside the supported range ${PGSCHEMA_VERSION_RANGE}`,
    );
  }
  return [...parsed];
}

function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): PgschemaPlatformKey {
  if (platform === "win32") throw new Error(PGSCHEMA_WINDOWS_UNSUPPORTED);
  const key = PGSCHEMA_PLATFORM_KEYS[`${platform}:${arch}` as keyof typeof PGSCHEMA_PLATFORM_KEYS];
  if (!key) throw new Error(`sqlx-js pgschema install: unsupported platform ${platform}/${arch}`);
  return key;
}

function validatePgschemaLock(value: unknown, path: string): PgschemaLock {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`sqlx-js pgschema: ${path} must contain an object`);
  }
  const lock = value as Record<string, unknown>;
  if (lock.lockfileVersion !== PGSCHEMA_LOCK_VERSION) {
    throw new Error(`sqlx-js pgschema: ${path} has unsupported lockfileVersion ${JSON.stringify(lock.lockfileVersion)}`);
  }
  if (lock.source !== PGSCHEMA_LOCK_SOURCE) {
    throw new Error(`sqlx-js pgschema: ${path} has unsupported source ${JSON.stringify(lock.source)}`);
  }
  if (typeof lock.version !== "string") {
    throw new Error(`sqlx-js pgschema: ${path} version must be a string`);
  }
  parseCompatiblePgschemaVersion(lock.version);
  if (!lock.assets || typeof lock.assets !== "object" || Array.isArray(lock.assets)) {
    throw new Error(`sqlx-js pgschema: ${path} assets must be an object`);
  }

  const assets = lock.assets as Record<string, unknown>;
  for (const key of Object.values(PGSCHEMA_PLATFORM_KEYS)) {
    const value = assets[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`sqlx-js pgschema: ${path} is missing asset ${key}`);
    }
    const asset = value as Record<string, unknown>;
    const expectedName = `pgschema-${lock.version}-${key}`;
    if (asset.name !== expectedName) {
      throw new Error(`sqlx-js pgschema: ${path} asset ${key} must be named ${expectedName}`);
    }
    if (typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      throw new Error(`sqlx-js pgschema: ${path} asset ${key} must have a lowercase SHA-256 digest`);
    }
  }
  const expectedKeys = new Set<string>(Object.values(PGSCHEMA_PLATFORM_KEYS));
  const unexpected = Object.keys(assets).find((key) => !expectedKeys.has(key));
  if (unexpected) throw new Error(`sqlx-js pgschema: ${path} has unsupported asset ${unexpected}`);
  return lock as PgschemaLock;
}

export function readPgschemaLock(root: string): PgschemaLock {
  const path = pgschemaLockPath(root);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`sqlx-js pgschema: ${path} was not found. Run sqlx-js pgschema install.`);
    }
    throw new Error(`sqlx-js pgschema: failed to read ${path}: ${(error as Error).message}`);
  }
  return validatePgschemaLock(value, path);
}

export function resolvePgschemaAsset(
  lock: PgschemaLock,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): PgschemaAsset {
  const key = platformKey(platform, arch);
  return { key, ...lock.assets[key] };
}

export function managedPgschemaPath(
  root: string,
  lock: PgschemaLock,
  asset = resolvePgschemaAsset(lock),
): string {
  return join(root, "node_modules/.cache/sqlx-js/pgschema", `v${lock.version}`, asset.key, "pgschema");
}

export function managedPgschemaCommand(root: string): { command: string; version: string } {
  const lock = readPgschemaLock(root);
  const asset = resolvePgschemaAsset(lock);
  const managed = managedPgschemaPath(root, lock, asset);
  if (!existsSync(managed) || !statSync(managed).isFile()) {
    throw new Error(`sqlx-js pgschema: managed pgschema v${lock.version} is not installed. Run sqlx-js pgschema install.`);
  }
  if (sha256(readFileSync(managed)) !== asset.sha256) {
    throw new Error(`sqlx-js pgschema: managed binary checksum mismatch at ${managed}. Run sqlx-js pgschema install.`);
  }
  try {
    accessSync(managed, constants.X_OK);
  } catch {
    throw new Error(`sqlx-js pgschema: managed binary is not executable at ${managed}. Run sqlx-js pgschema install.`);
  }
  return { command: managed, version: lock.version };
}

function sha256(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function temporarySibling(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

function assertProjectRoot(root: string): void {
  try {
    if (statSync(root).isDirectory()) return;
  } catch {}
  throw new Error(`sqlx-js pgschema: project root is not a directory: ${root}`);
}

function writePgschemaLock(root: string, lock: PgschemaLock): void {
  const path = pgschemaLockPath(root);
  const tmp = temporarySibling(path);
  try {
    writeFileSync(tmp, JSON.stringify(lock, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function samePgschemaAssets(left: PgschemaLock["assets"], right: PgschemaLock["assets"]): boolean {
  return Object.values(PGSCHEMA_PLATFORM_KEYS).every(
    (key) => left[key].name === right[key].name && left[key].sha256 === right[key].sha256,
  );
}

function releaseVersion(release: GitHubRelease): string | undefined {
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") return undefined;
  const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : release.tag_name;
  try {
    parseCompatiblePgschemaVersion(version);
    return version;
  } catch {
    return undefined;
  }
}

function lockFromRelease(release: GitHubRelease, version: string): PgschemaLock {
  if (!Array.isArray(release.assets)) {
    throw new Error(`sqlx-js pgschema: release v${version} has no assets`);
  }
  const releaseAssets = release.assets as GitHubReleaseAsset[];
  const assets = {} as PgschemaLock["assets"];
  for (const key of Object.values(PGSCHEMA_PLATFORM_KEYS)) {
    const name = `pgschema-${version}-${key}`;
    const matches = releaseAssets.filter((asset) => asset?.name === name);
    if (matches.length !== 1) {
      throw new Error(`sqlx-js pgschema: release v${version} must contain exactly one asset ${name}`);
    }
    const digest = matches[0]!.digest;
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`sqlx-js pgschema: asset ${name} has no valid GitHub SHA-256 digest`);
    }
    assets[key] = { name, sha256: digest.slice("sha256:".length) };
  }
  return validatePgschemaLock({
    lockfileVersion: PGSCHEMA_LOCK_VERSION,
    source: PGSCHEMA_LOCK_SOURCE,
    version,
    assets,
  }, `resolved pgschema v${version}`);
}

export async function resolveLatestPgschemaLock(
  opts: Pick<PgschemaInstallOptions, "releasesUrl" | "fetchImpl"> = {},
): Promise<PgschemaLock> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(opts.releasesUrl ?? PGSCHEMA_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`sqlx-js pgschema: failed to resolve releases: HTTP ${response.status}`);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new Error(`sqlx-js pgschema: failed to parse GitHub releases response: ${(error as Error).message}`);
  }
  if (!Array.isArray(value)) throw new Error("sqlx-js pgschema: GitHub releases response must be an array");
  const compatible = (value as GitHubRelease[])
    .map((release) => ({ release, version: releaseVersion(release) }))
    .filter((entry): entry is { release: GitHubRelease; version: string } => entry.version !== undefined)
    .sort((a, b) => parseCompatiblePgschemaVersion(b.version)[2] - parseCompatiblePgschemaVersion(a.version)[2]);
  const latest = compatible[0];
  if (!latest) {
    throw new Error(`sqlx-js pgschema: no stable release in supported range ${PGSCHEMA_VERSION_RANGE}`);
  }
  return lockFromRelease(latest.release, latest.version);
}

async function installPgschemaLock(opts: PgschemaInstallOptions, lock: PgschemaLock): Promise<void> {
  const asset = resolvePgschemaAsset(lock);
  const baseUrl = opts.downloadBaseUrl ?? PGSCHEMA_DOWNLOAD_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? console.log;
  const target = managedPgschemaPath(opts.root, lock, asset);

  if (existsSync(target) && statSync(target).isFile() && sha256(readFileSync(target)) === asset.sha256) {
    chmodSync(target, 0o755);
    log(`pgschema v${lock.version} already installed at ${target}`);
    return;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/v${lock.version}/${asset.name}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`sqlx-js pgschema install: failed to download pgschema v${lock.version}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    throw new Error(`sqlx-js pgschema install: checksum mismatch for ${asset.name}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  const tmp = temporarySibling(target);
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  log(`installed pgschema v${lock.version} to ${target}`);
}

export async function runPgschemaInstall(opts: PgschemaInstallOptions): Promise<void> {
  assertProjectRoot(opts.root);
  const path = pgschemaLockPath(opts.root);
  if (existsSync(path)) {
    await installPgschemaLock(opts, readPgschemaLock(opts.root));
    return;
  }
  if (opts.frozen) {
    throw new Error(`sqlx-js pgschema install: ${path} is required with --frozen`);
  }
  const lock = await resolveLatestPgschemaLock(opts);
  await installPgschemaLock(opts, lock);
  writePgschemaLock(opts.root, lock);
  (opts.log ?? console.log)(`created ${path} for pgschema v${lock.version}`);
}

export async function runPgschemaUpdate(opts: PgschemaInstallOptions): Promise<void> {
  assertProjectRoot(opts.root);
  const path = pgschemaLockPath(opts.root);
  const previous = existsSync(path) ? readPgschemaLock(opts.root) : undefined;
  const lock = await resolveLatestPgschemaLock(opts);
  if (previous) {
    const previousPatch = parseCompatiblePgschemaVersion(previous.version)[2];
    const nextPatch = parseCompatiblePgschemaVersion(lock.version)[2];
    if (nextPatch < previousPatch) {
      throw new Error(`sqlx-js pgschema update: refusing to downgrade v${previous.version} to v${lock.version}`);
    }
    if (nextPatch === previousPatch && !samePgschemaAssets(previous.assets, lock.assets)) {
      throw new Error(`sqlx-js pgschema update: release asset digests changed for locked v${lock.version}`);
    }
  }
  await installPgschemaLock(opts, lock);
  const log = opts.log ?? console.log;
  if (previous?.version === lock.version) {
    log(`pgschema lock already uses latest compatible v${lock.version}`);
    return;
  }
  writePgschemaLock(opts.root, lock);
  log(`updated ${path} from ${previous ? `v${previous.version}` : "no lock"} to v${lock.version}`);
}
