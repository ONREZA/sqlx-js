import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { SqlxJsConfig } from "../config";
import {
  parseDatabaseUrl,
  postgresResolvedPasswordEnvironment,
  type ConnConfig,
} from "../pg/wire";
import { runSchemaWorkflow } from "./schema-workflow";
import {
  managedPgschemaCommand,
  PGSCHEMA_WINDOWS_UNSUPPORTED,
} from "./pgschema-tool";

export {
  managedPgschemaPath,
  PGSCHEMA_LOCK_FILENAME,
  PGSCHEMA_VERSION_RANGE,
  pgschemaLockPath,
  readPgschemaLock,
  resolveLatestPgschemaLock,
  resolvePgschemaAsset,
  runPgschemaInstall,
  runPgschemaUpdate,
  type PgschemaAsset,
  type PgschemaInstallOptions,
  type PgschemaLock,
} from "./pgschema-tool";

export type PgschemaSubcommand = "plan" | "apply";

export type PgschemaCommandOptions = {
  root: string;
  databaseUrl: string;
  config: SqlxJsConfig;
  subcommand: PgschemaSubcommand;
  passthrough?: string[];
};

export type PgschemaExecOptions = {
  root: string;
  config: SqlxJsConfig;
  args: string[];
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

function pgschemaConfig(config: SqlxJsConfig): NonNullable<SqlxJsConfig["schema"]> {
  if (config.schema?.provider !== "pgschema") {
    throw new Error("sqlx-js pgschema: set schema.provider = \"pgschema\" in sqlx-js.config.ts");
  }
  return config.schema;
}

function effectivePgschemaCommand(
  root: string,
  config: NonNullable<SqlxJsConfig["schema"]>,
): { command: string; version?: string } {
  if (process.platform === "win32") throw new Error(PGSCHEMA_WINDOWS_UNSUPPORTED);
  if (config.command) return { command: config.command };
  return managedPgschemaCommand(root);
}

export function probePgschema(root: string, config: SqlxJsConfig): PgschemaProbe {
  try {
    const schema = pgschemaConfig(config);
    const effective = effectivePgschemaCommand(root, schema);
    const command = effective.command;
    const child = spawnSync(command, ["--help"], {
      cwd: root,
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
    if (child.signal) {
      return { ok: false, command, message: `${command} --help terminated by signal ${child.signal}` };
    }
    if (child.status !== 0) {
      return { ok: false, command, message: `${command} --help exited with ${child.status}` };
    }
    return {
      ok: true,
      command,
      message: effective.version
        ? `managed pgschema v${effective.version} is available: ${command}`
        : `pgschema is available through schema.command: ${command}`,
    };
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
  return `sqlx-js pgschema: ${command} was not found. Fix or remove schema.command; without an override, run sqlx-js pgschema install.`;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): void {
  const child = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(installHint(command));
    throw child.error;
  }
  if (child.signal) throw new Error(`sqlx-js pgschema: ${command} terminated by signal ${child.signal}`);
  if (child.status !== null && child.status !== 0) throw new PgschemaCommandError(child.status, command);
}

export function runPgschemaExec(opts: PgschemaExecOptions): void {
  const command = effectivePgschemaCommand(opts.root, pgschemaConfig(opts.config)).command;
  run(command, opts.args, process.env, opts.root);
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

function assertPgschemaConnectionBoundary(db: ConnConfig): void {
  const unsupported = db.startupOptions !== undefined
    ? "options"
    : db.startupParameters?.role !== undefined
      ? "role"
      : db.statementTimeoutMs !== undefined
        ? "statement_timeout"
        : db.applicationName !== undefined
          ? "application_name"
          : undefined;
  if (unsupported !== undefined) {
    throw new Error(
      `sqlx-js pgschema: ${unsupported} cannot be preserved independently from pgschema's plan database; remove it from the target connection or use the built-in schema workflow`,
    );
  }
}

export function runPgschemaCommand(opts: PgschemaCommandOptions): void {
  const config = pgschemaConfig(opts.config);
  const command = effectivePgschemaCommand(opts.root, config).command;

  if (!opts.databaseUrl) throw new Error("DATABASE_URL is required for sqlx-js pgschema commands");
  assertPgschemaPassthrough(opts.passthrough ?? []);
  const file = appliesPlan(opts.subcommand, opts.passthrough) ? undefined : schemaFile(opts.root, config);
  if (file && !existsSync(file)) throw new Error(`sqlx-js pgschema: schema file not found: ${file}`);

  const db = parseDatabaseUrl(opts.databaseUrl);
  assertPgschemaConnectionBoundary(db);
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

  run(command, args, postgresResolvedPasswordEnvironment(db), opts.root);
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
    throw new Error("sqlx-js pgschema: the supported pgschema range supports exactly one --schema value; split plan/apply per schema or use a single schema in sqlx-js.config.ts");
  }
  return schemas;
}
