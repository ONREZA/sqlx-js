import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { SqlxJsConfig } from "../config";
import {
  parseDatabaseUrl,
  postgresConnectionEnvironment,
  resolveConnectionPassword,
  type ConnConfig,
} from "../pg/wire";
import { withWorkflowShadowDatabase } from "./shadow";
import { runSchemaWorkflow } from "./schema-workflow";

export type PgschemaSubcommand = "plan" | "apply";

export const PGSCHEMA_VERSION = "1.12.2";

const PGSCHEMA_BASE_URL = `https://github.com/pgplex/pgschema/releases/download/v${PGSCHEMA_VERSION}`;
const WINDOWS_UNSUPPORTED =
  "sqlx-js pgschema: pgschema is not supported on Windows. Run sqlx-js under WSL/Linux/macOS or use the built-in migration workflow.";

export type PgschemaAsset = {
  key: string;
  name: string;
  sha256: string;
};

const PGSCHEMA_ASSETS: Record<string, PgschemaAsset> = {
  "darwin:x64": {
    key: "darwin-amd64",
    name: `pgschema-${PGSCHEMA_VERSION}-darwin-amd64`,
    sha256: "6e43b853595ace6b6ef042f58301e2398d5c52bf7908dd6263e1b55b3bb5d123",
  },
  "darwin:arm64": {
    key: "darwin-arm64",
    name: `pgschema-${PGSCHEMA_VERSION}-darwin-arm64`,
    sha256: "5671bb75b1d66ca5a65efa04ac7bf4a1047da00c2612ce44e8ed1a640925fb0a",
  },
  "linux:x64": {
    key: "linux-amd64",
    name: `pgschema-${PGSCHEMA_VERSION}-linux-amd64`,
    sha256: "6b864bd497ab312f131512f1aca8b2b329931fe25097a4a195a1dc3b5d88e7b8",
  },
  "linux:arm64": {
    key: "linux-arm64",
    name: `pgschema-${PGSCHEMA_VERSION}-linux-arm64`,
    sha256: "94f47bb57501b5efb7a19087b6074acb0fc2002fdff9fe6b203fc065a993abd9",
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

export type PgschemaWorkflowOptions = {
  root: string;
  databaseUrl: string;
  config: SqlxJsConfig;
  cacheDir: string;
  dtsPath: string;
  snapshotPath: string;
  shadowUrl?: string;
  shadowAdminUrl?: string;
  prune?: boolean;
  strictInference?: boolean;
};

export type PgschemaProbe = {
  ok: boolean;
  command?: string;
  message: string;
};

export class PgschemaCommandError extends Error {
  constructor(public readonly exitCode: number, command: string) {
    super(`sqlx-js pgschema: ${command} exited with ${exitCode}`);
    this.name = "PgschemaCommandError";
  }
}

export class SchemaMaterializerCommandError extends Error {
  constructor(public readonly exitCode: number, command: string) {
    super(`sqlx-js schema materializer: ${command} exited with ${exitCode}`);
    this.name = "SchemaMaterializerCommandError";
  }
}

export function resolvePgschemaAsset(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): PgschemaAsset {
  if (platform === "win32") throw new Error(WINDOWS_UNSUPPORTED);
  const asset = PGSCHEMA_ASSETS[`${platform}:${arch}`];
  if (!asset) throw new Error(`sqlx-js pgschema install: unsupported platform ${platform}/${arch}`);
  return asset;
}

function pgschemaConfig(config: SqlxJsConfig): NonNullable<SqlxJsConfig["schema"]> {
  if (config.schema?.provider !== "pgschema") {
    throw new Error("sqlx-js pgschema: set schema.provider = \"pgschema\" in sqlx-js.config.ts");
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
      throw new Error(`sqlx-js pgschema: managed binary checksum mismatch at ${managed}. Run sqlx-js pgschema install.`);
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

export function probePgschema(root: string, config: SqlxJsConfig): PgschemaProbe {
  try {
    const schema = pgschemaConfig(config);
    const command = commandName(root, schema);
    const child = spawnSync(command, ["--help"], {
      encoding: "utf8",
      env: process.env,
      timeout: 5_000,
    });
    if (child.error) {
      const code = (child.error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        command,
        message: code === "ENOENT"
          ? installHint(command)
          : code === "ETIMEDOUT"
            ? `${command} --help timed out after 5000ms`
            : child.error.message,
      };
    }
    if (child.status !== 0) {
      return { ok: false, command, message: `${command} --help exited with ${child.status}` };
    }
    return { ok: true, command, message: `pgschema is available: ${command}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

function resolveExecutable(command: string, root: string): string | undefined {
  const pathEntries = command.includes("/") || command.includes("\\")
    ? [isAbsolute(command) ? "" : root]
    : (process.env.PATH ?? "").split(delimiter).map((entry) => entry || root);
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
    : [""];

  for (const pathEntry of pathEntries) {
    for (const extension of extensions) {
      const candidate = isAbsolute(command)
        ? `${command}${extension}`
        : resolve(isAbsolute(pathEntry) ? pathEntry : resolve(root, pathEntry), `${command}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

export function probeSchemaMaterializer(root: string, config: SqlxJsConfig): PgschemaProbe {
  try {
    const materializer = pgschemaConfig(config).materializer;
    if (!materializer) {
      return { ok: false, message: "sqlx-js schema materializer: schema.materializer is not configured" };
    }
    const resolved = resolveExecutable(materializer.command, root);
    if (!resolved) {
      return {
        ok: false,
        command: materializer.command,
        message: `sqlx-js schema materializer: command not found or not executable: ${materializer.command}`,
      };
    }
    return {
      ok: true,
      command: materializer.command,
      message: `schema materializer is available: ${materializer.command}`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

function schemaFile(root: string, config: NonNullable<SqlxJsConfig["schema"]>): string {
  return resolve(root, config.file ?? "schema.sql");
}

function appliesPlan(subcommand: PgschemaSubcommand, passthrough: string[] | undefined): boolean {
  return subcommand === "apply" && (passthrough ?? []).some((arg) => arg === "--plan" || arg.startsWith("--plan="));
}

function installHint(command: string): string {
  return `sqlx-js pgschema: ${command} was not found. Run sqlx-js pgschema install or set schema.command in sqlx-js.config.ts.`;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const child = spawnSync(command, args, { encoding: "utf8", env, stdio: "inherit" });
  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(installHint(command));
    throw child.error;
  }
  if (child.signal) throw new Error(`sqlx-js pgschema: ${command} terminated by signal ${child.signal}`);
  if (child.status !== null && child.status !== 0) throw new PgschemaCommandError(child.status, command);
}

const OWNED_PGSCHEMA_OPTIONS = new Set([
  "--host",
  "--port",
  "--db",
  "--user",
  "--password",
  "--sslmode",
  "--application-name",
  "--schema",
  "--file",
  "--plan-host",
  "--plan-port",
  "--plan-db",
  "--plan-user",
  "--plan-password",
  "--plan-sslmode",
]);

function assertPgschemaPassthrough(args: readonly string[]): void {
  for (const argument of args) {
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (OWNED_PGSCHEMA_OPTIONS.has(name)) {
      throw new Error(
        `sqlx-js pgschema: ${name} is owned by the sqlx-js connection and schema configuration`,
      );
    }
  }
}

const PGSCHEMA_PLAN_CONNECTION_ENVIRONMENT = [
  "PGSCHEMA_PLAN_HOST",
  "PGSCHEMA_PLAN_PORT",
  "PGSCHEMA_PLAN_DB",
  "PGSCHEMA_PLAN_USER",
  "PGSCHEMA_PLAN_PASSWORD",
  "PGSCHEMA_PLAN_SSLMODE",
] as const;

function pgschemaEnv(db: ConnConfig): NodeJS.ProcessEnv {
  const env = postgresConnectionEnvironment(db);
  for (const name of PGSCHEMA_PLAN_CONNECTION_ENVIRONMENT) {
    if (env[name]) {
      throw new Error(`sqlx-js pgschema: ${name} is not supported by the unified connection adapter`);
    }
    delete env[name];
  }
  const password = resolveConnectionPassword(db);
  // Empty PGPASSWORD lets pgx retry .pgpass with its own endpoint identity.
  env.PGPASSWORD = password === ""
    ? `sqlx-js-no-password-${randomBytes(16).toString("hex")}`
    : password;
  delete env.PGPASSFILE;
  return env;
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
    throw new Error(`sqlx-js pgschema install: failed to download pgschema v${PGSCHEMA_VERSION}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    throw new Error(`sqlx-js pgschema install: checksum mismatch for ${asset.name}`);
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

  if (!opts.databaseUrl) throw new Error("DATABASE_URL is required for sqlx-js pgschema commands");
  assertPgschemaPassthrough(opts.passthrough ?? []);
  const file = appliesPlan(opts.subcommand, opts.passthrough) ? undefined : schemaFile(opts.root, config);
  if (file && !existsSync(file)) throw new Error(`sqlx-js pgschema: schema file not found: ${file}`);

  const db = parseDatabaseUrl(opts.databaseUrl);
  const sslmode = db.sslmode ?? "prefer";
  if (db.hostaddr !== undefined && db.hostaddr !== db.host && sslmode !== "disable") {
    throw new Error(
      `sqlx-js pgschema: pgschema cannot preserve the TLS server name when hostaddr differs from host with sslmode=${sslmode}; use sslmode=disable only on a trusted path, the built-in migration workflow, or a hostname-preserving network path`,
    );
  }
  const schemas = pgschemaSchemas(config);
  const args = [
    opts.subcommand,
    "--host", db.hostaddr ?? db.host,
    "--port", String(db.port),
    "--db", db.database,
    "--user", db.user,
  ];
  if (file) args.push("--file", file);
  args.push("--schema", schemas[0]!);
  args.push(...opts.passthrough ?? []);

  run(command, args, pgschemaEnv(db));
}

function validatePgschemaWorkflow(opts: PgschemaWorkflowOptions): void {
  const config = pgschemaConfig(opts.config);
  if (config.materializer) return;
  const file = schemaFile(opts.root, config);
  if (!existsSync(file)) throw new Error(`sqlx-js pgschema: schema file not found: ${file}`);
  pgschemaSchemas(config);
}

function applyDesiredSchema(opts: PgschemaWorkflowOptions, databaseUrl: string): void {
  if (opts.config.schema?.materializer) {
    runSchemaMaterializer(opts, databaseUrl);
    return;
  }
  runPgschemaCommand({
    root: opts.root,
    databaseUrl,
    config: opts.config,
    subcommand: "apply",
    passthrough: ["--auto-approve", "--no-color"],
  });
}

export function runSchemaMaterializer(opts: PgschemaWorkflowOptions, databaseUrl: string): void {
  const materializer = pgschemaConfig(opts.config).materializer;
  if (!materializer) throw new Error("sqlx-js pgschema: schema.materializer is not configured");
  const file = schemaFile(opts.root, opts.config.schema!);
  const child = spawnSync(materializer.command, materializer.args ?? [], {
    cwd: opts.root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SQLX_JS_SHADOW_DATABASE_URL: databaseUrl,
      SQLX_JS_PROJECT_ROOT: opts.root,
      ...(existsSync(file) ? { SQLX_JS_SCHEMA_FILE: file } : {}),
    },
    stdio: "inherit",
  });
  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`sqlx-js schema materializer: command not found: ${materializer.command}`);
    }
    throw child.error;
  }
  if (child.signal) {
    throw new Error(`sqlx-js schema materializer: ${materializer.command} terminated by signal ${child.signal}`);
  }
  if (child.status === null) {
    throw new Error(`sqlx-js schema materializer: ${materializer.command} ended without an exit status`);
  }
  if (child.status !== 0) {
    throw new SchemaMaterializerCommandError(child.status, materializer.command);
  }
}

export async function runPgschemaDev(opts: PgschemaWorkflowOptions): Promise<boolean> {
  return await runSchemaWorkflow("dev", opts, {
    validate: () => validatePgschemaWorkflow(opts),
    materialize: (databaseUrl) => applyDesiredSchema(opts, databaseUrl),
  });
}

export async function runPgschemaVerify(opts: PgschemaWorkflowOptions): Promise<boolean> {
  return await runSchemaWorkflow("verify", opts, {
    validate: () => validatePgschemaWorkflow(opts),
    materialize: (databaseUrl) => applyDesiredSchema(opts, databaseUrl),
  });
}

function pgschemaSchemas(config: NonNullable<SqlxJsConfig["schema"]>): string[] {
  const schemas = config.schemas?.length ? config.schemas : ["public"];
  if (schemas.length > 1) {
    throw new Error(`sqlx-js pgschema: pgschema ${PGSCHEMA_VERSION} supports exactly one --schema value; split plan/apply per schema or use a single schema in sqlx-js.config.ts`);
  }
  return schemas;
}
