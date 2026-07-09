import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SqlxJsConfig } from "../config";
import { parseDatabaseUrl, type ConnConfig } from "../pg/wire";

export type PgschemaSubcommand = "check" | "plan" | "apply";

export const PGSCHEMA_VERSION = "1.12.0";

const PGSCHEMA_BASE_URL = `https://github.com/pgplex/pgschema/releases/download/v${PGSCHEMA_VERSION}`;
const WINDOWS_UNSUPPORTED =
  "sqlx-js db: pgschema is not supported on Windows. Run sqlx-js under WSL/Linux/macOS or use the built-in sqlx-js migrate workflow.";

export type PgschemaAsset = {
  key: string;
  name: string;
  sha256: string;
};

const PGSCHEMA_ASSETS: Record<string, PgschemaAsset> = {
  "darwin:x64": {
    key: "darwin-amd64",
    name: `pgschema-${PGSCHEMA_VERSION}-darwin-amd64`,
    sha256: "c64b2ac24c4246344908910e892c4123be282bbb449f0b535079ff41d0f47c8f",
  },
  "darwin:arm64": {
    key: "darwin-arm64",
    name: `pgschema-${PGSCHEMA_VERSION}-darwin-arm64`,
    sha256: "f01ea488f21700752d5747bc013c406daa583a68b631739f33af430d5d3ec449",
  },
  "linux:x64": {
    key: "linux-amd64",
    name: `pgschema-${PGSCHEMA_VERSION}-linux-amd64`,
    sha256: "12610adf748b0dafe4e488ee7e9e68e6ffbef1f4e0f038dda36cf0138eede598",
  },
  "linux:arm64": {
    key: "linux-arm64",
    name: `pgschema-${PGSCHEMA_VERSION}-linux-arm64`,
    sha256: "58ec57023954a0239cf9d607c4e5432da6dd0b279399d1c318204120619a221d",
  },
};

export type PgschemaCommandOptions = {
  root: string;
  databaseUrl: string;
  config: SqlxJsConfig;
  subcommand: PgschemaSubcommand;
  passthrough?: string[];
};

export type PgschemaInstallOptions = {
  root: string;
  asset?: PgschemaAsset;
  baseUrl?: string;
  log?: (msg: string) => void;
};

export function resolvePgschemaAsset(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): PgschemaAsset {
  if (platform === "win32") throw new Error(WINDOWS_UNSUPPORTED);
  const asset = PGSCHEMA_ASSETS[`${platform}:${arch}`];
  if (!asset) throw new Error(`sqlx-js db install: unsupported platform ${platform}/${arch}`);
  return asset;
}

function pgschemaConfig(config: SqlxJsConfig): NonNullable<SqlxJsConfig["schema"]> {
  if (config.schema?.provider !== "pgschema") {
    throw new Error("sqlx-js db: set schema.provider = \"pgschema\" in sqlx-js.config.ts");
  }
  return config.schema;
}

export function managedPgschemaPath(root: string, asset = resolvePgschemaAsset()): string {
  return join(root, "node_modules/.cache/sqlx-js/pgschema", `v${PGSCHEMA_VERSION}`, asset.key, "pgschema");
}

function maybeManagedPgschemaPath(root: string): string | undefined {
  try {
    const asset = resolvePgschemaAsset();
    const managed = managedPgschemaPath(root, asset);
    if (!existsSync(managed)) return undefined;
    if (sha256(readFileSync(managed)) !== asset.sha256) {
      throw new Error(`sqlx-js db: managed pgschema checksum mismatch at ${managed}. Run sqlx-js db install.`);
    }
    chmodSync(managed, 0o755);
    return managed;
  } catch (e) {
    if ((e as Error).message.includes("checksum mismatch")) throw e;
    return undefined;
  }
}

function commandName(root: string, config: NonNullable<SqlxJsConfig["schema"]>): string {
  if (process.platform === "win32") throw new Error(WINDOWS_UNSUPPORTED);
  if (config.command) return config.command;
  const managed = maybeManagedPgschemaPath(root);
  if (managed && existsSync(managed)) return managed;
  return "pgschema";
}

function schemaFile(root: string, config: NonNullable<SqlxJsConfig["schema"]>): string {
  return resolve(root, config.file ?? "schema.sql");
}

function appliesPlan(subcommand: PgschemaSubcommand, passthrough: string[] | undefined): boolean {
  return subcommand === "apply" && (passthrough ?? []).some((arg) => arg === "--plan" || arg.startsWith("--plan="));
}

function installHint(command: string): string {
  return `sqlx-js db: ${command} was not found. Run sqlx-js db install or set schema.command in sqlx-js.config.ts.`;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const child = spawnSync(command, args, { encoding: "utf8", env, stdio: "inherit" });
  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(installHint(command));
    throw child.error;
  }
  if (child.signal) throw new Error(`sqlx-js db: ${command} terminated by signal ${child.signal}`);
  if (child.status && child.status !== 0) process.exit(child.status);
}

function pgschemaEnv(db: ConnConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(db.password ? { PGPASSWORD: db.password } : {}),
    ...(db.sslmode ? { PGSSLMODE: db.sslmode } : {}),
    ...(db.sslRootCert ? { PGSSLROOTCERT: db.sslRootCert } : {}),
    ...(db.sslCert ? { PGSSLCERT: db.sslCert } : {}),
    ...(db.sslKey ? { PGSSLKEY: db.sslKey } : {}),
  };
}

function sha256(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function runPgschemaInstall(opts: PgschemaInstallOptions): Promise<void> {
  const asset = opts.asset ?? resolvePgschemaAsset();
  const baseUrl = opts.baseUrl ?? PGSCHEMA_BASE_URL;
  const log = opts.log ?? console.log;
  const target = managedPgschemaPath(opts.root, asset);

  if (existsSync(target) && sha256(readFileSync(target)) === asset.sha256) {
    chmodSync(target, 0o755);
    log(`pgschema v${PGSCHEMA_VERSION} already installed at ${target}`);
    return;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/${asset.name}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`sqlx-js db install: failed to download pgschema v${PGSCHEMA_VERSION}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    throw new Error(`sqlx-js db install: checksum mismatch for ${asset.name}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }

  writeFileSync(
    `${target}.json`,
    JSON.stringify({ version: PGSCHEMA_VERSION, asset: asset.name, sha256: asset.sha256 }, null, 2) + "\n",
  );
  log(`installed pgschema v${PGSCHEMA_VERSION} to ${target}`);
}

export function runPgschemaCommand(opts: PgschemaCommandOptions): void {
  const config = pgschemaConfig(opts.config);
  const command = commandName(opts.root, config);

  if (opts.subcommand === "check") {
    run(command, ["--help"], process.env);
    return;
  }

  if (!opts.databaseUrl) throw new Error("DATABASE_URL is required for sqlx-js db commands");
  const file = appliesPlan(opts.subcommand, opts.passthrough) ? undefined : schemaFile(opts.root, config);
  if (file && !existsSync(file)) throw new Error(`sqlx-js db: schema file not found: ${file}`);

  const db = parseDatabaseUrl(opts.databaseUrl);
  const schemas = pgschemaSchemas(config);
  const args = [
    opts.subcommand,
    "--host", db.host,
    "--port", String(db.port),
    "--db", db.database,
    "--user", db.user,
  ];
  if (file) args.push("--file", file);
  args.push("--schema", schemas[0]!);
  args.push(...opts.passthrough ?? []);

  run(command, args, pgschemaEnv(db));
}

function pgschemaSchemas(config: NonNullable<SqlxJsConfig["schema"]>): string[] {
  const schemas = config.schemas?.length ? config.schemas : ["public"];
  if (schemas.length > 1) {
    throw new Error("sqlx-js db: pgschema 1.12.0 supports exactly one --schema value; split plan/apply per schema or use a single schema in sqlx-js.config.ts");
  }
  return schemas;
}
