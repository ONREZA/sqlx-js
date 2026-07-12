import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { assertCacheManifest } from "../cache";
import {
  assertSupportedRuntime,
  envFilePath,
  loadConfigInfo,
  nativeTypeScriptEnabled,
  prepareConfigHash,
  runtimeVersion,
} from "../config";
import { decodeText, parseDatabaseUrl, PgClient } from "../pg/wire";
import { mergeExtensionTypes } from "../pg/extensions";
import { SchemaCache } from "../pg/schema";
import { probePgschema } from "./pgschema";

export type DoctorCheck = {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
};

export type DoctorOptions = {
  root: string;
  databaseUrl: string;
  cacheDir: string;
  dtsPath: string;
  json?: boolean;
  envError?: string;
};

function decodeBoolean(value: Uint8Array | null | undefined): boolean {
  const text = decodeText(value ?? null);
  return text === "t" || text === "true" || text === "1";
}

function tsconfigIncludes(root: string, file: string): { ok: boolean; message: string } {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) return { ok: false, message: `tsconfig.json not found at ${path}` };
  const target = resolve(file);
  const visited = new Set<string>();
  const visit = (configPath: string): { included: boolean; error?: string } => {
    const resolvedConfig = resolve(configPath);
    if (visited.has(resolvedConfig)) return { included: false };
    visited.add(resolvedConfig);
    const read = ts.readConfigFile(resolvedConfig, ts.sys.readFile);
    if (read.error) {
      return { included: false, error: ts.flattenDiagnosticMessageText(read.error.messageText, "\n") };
    }
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      resolve(resolvedConfig, ".."),
      undefined,
      resolvedConfig,
    );
    if (parsed.errors.length > 0) {
      return {
        included: false,
        error: parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; "),
      };
    }
    if (parsed.fileNames.some((name) => resolve(name) === target)) return { included: true };
    for (const reference of parsed.projectReferences ?? []) {
      const result = visit(ts.resolveProjectReferencePath(reference));
      if (result.included || result.error) return result;
    }
    return { included: false };
  };
  const result = visit(path);
  if (result.error) return { ok: false, message: result.error };
  const included = result.included;
  return included
    ? { ok: true, message: `${file} is included by tsconfig.json` }
    : { ok: false, message: `${file} is not included by tsconfig.json` };
}

export async function inspectDoctor(opts: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const runtime = runtimeVersion();
  try {
    assertSupportedRuntime();
    checks.push({
      name: "runtime",
      status: "ok",
      message: `${runtime.runtime} ${runtime.version} satisfies the supported baseline`,
    });
  } catch (e) {
    checks.push({ name: "runtime", status: "error", message: (e as Error).message });
  }

  let config: Awaited<ReturnType<typeof loadConfigInfo>>["config"] = {};
  let configLoaded = true;
  try {
    const info = await loadConfigInfo(opts.root);
    config = info.config;
    const nativeTs = nativeTypeScriptEnabled();
    if (info.path && /\.m?ts$/.test(info.path) && nativeTs === false) {
      checks.push({ name: "config", status: "error", message: "native TypeScript execution is disabled" });
    } else {
      checks.push({
        name: "config",
        status: "ok",
        message: info.path ? `loaded ${info.path}` : "no config file; defaults are active",
      });
    }
  } catch (e) {
    configLoaded = false;
    checks.push({ name: "config", status: "error", message: (e as Error).message });
  }

  const envPath = envFilePath(opts.root);
  checks.push(opts.envError
    ? { name: "env", status: "error", message: opts.envError }
    : existsSync(envPath) && !opts.databaseUrl
      ? { name: "env", status: "error", message: `${envPath} exists but DATABASE_URL is missing` }
      : existsSync(envPath)
      ? { name: "env", status: "ok", message: `loaded environment file ${envPath}` }
      : opts.databaseUrl
        ? { name: "env", status: "ok", message: "DATABASE_URL is provided by the process environment" }
        : { name: "env", status: "error", message: `DATABASE_URL is missing and ${envPath} does not exist` });

  if (!configLoaded) {
    checks.push({ name: "cache", status: "warning", message: "cache config-hash check skipped because config failed to load" });
  } else {
    try {
      assertCacheManifest(opts.cacheDir, prepareConfigHash(config));
      checks.push({ name: "cache", status: "ok", message: "cache manifest and config hash are current" });
    } catch (e) {
      checks.push({ name: "cache", status: "error", message: (e as Error).message });
    }
  }

  const tsconfig = tsconfigIncludes(opts.root, opts.dtsPath);
  checks.push({
    name: "tsconfig",
    status: tsconfig.ok ? "ok" : "error",
    message: tsconfig.message,
  });

  if (!opts.databaseUrl) {
    checks.push({ name: "database", status: "error", message: "DATABASE_URL is required for the database check" });
  } else {
    const client = new PgClient(parseDatabaseUrl(opts.databaseUrl));
    try {
      await client.connect();
      await client.describe("SELECT 1");
      const result = await client.simpleQueryAll(`
        SELECT current_setting('server_version'), current_user, current_database(),
          (SELECT (rolcreatedb OR rolsuper)::text FROM pg_roles WHERE rolname = current_user),
          COALESCE(has_schema_privilege(current_user, current_schema(), 'USAGE'), false)::text
      `);
      const row = result.rows[0]!;
      const canCreateDatabase = decodeBoolean(row[3]);
      const hasSchemaUsage = decodeBoolean(row[4]);
      const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;
      const shadowAdminDatabaseUrl = process.env.SHADOW_ADMIN_DATABASE_URL;
      const hasShadowFallback = Boolean(shadowDatabaseUrl || shadowAdminDatabaseUrl);
      const needsShadowCreate = config.schema?.provider !== "pgschema";
      checks.push({
        name: "database",
        status: "ok",
        message: `connected to ${decodeText(row[2]!)} as ${decodeText(row[1]!)}`,
        details: {
          serverVersion: decodeText(row[0]!),
          describe: true,
          schemaUsage: hasSchemaUsage,
        },
      });
      checks.push({
        name: "permissions",
        status: hasSchemaUsage && (!needsShadowCreate || canCreateDatabase || hasShadowFallback) ? "ok" : "warning",
        message: !hasSchemaUsage
          ? "current user lacks USAGE on the current schema"
          : !needsShadowCreate
            ? "current user can use the current schema; pgschema does not require shadow-database creation"
            : canCreateDatabase
            ? "current user can use the current schema and create shadow databases"
            : hasShadowFallback
              ? "current user cannot create databases; a shadow database fallback is configured"
              : "current user cannot create shadow databases; configure SHADOW_ADMIN_DATABASE_URL or SHADOW_DATABASE_URL",
        details: {
          schemaUsage: hasSchemaUsage,
          createDatabase: canCreateDatabase,
          shadowDatabaseConfigured: Boolean(shadowDatabaseUrl),
          shadowAdminConfigured: Boolean(shadowAdminDatabaseUrl),
        },
      });
      if (configLoaded) {
        const schema = new SchemaCache(client);
        schema.setTypeRegistry(mergeExtensionTypes(config.customTypes), config.customTypes);
        try {
          await schema.validateUserTypeRegistry();
          checks.push({
            name: "runtimeTypes",
            status: "ok",
            message: "customTypes match runtime-addressable PostgreSQL types",
          });
        } catch (error) {
          checks.push({ name: "runtimeTypes", status: "error", message: (error as Error).message });
        }
      } else {
        checks.push({
          name: "runtimeTypes",
          status: "warning",
          message: "runtime type check skipped because config failed to load",
        });
      }
    } catch (e) {
      checks.push({ name: "database", status: "error", message: (e as Error).message });
    } finally {
      await client.end().catch(() => {});
    }
  }

  if (!configLoaded) {
    checks.push({ name: "pgschema", status: "warning", message: "schema-provider check skipped because config failed to load" });
  } else if (config.schema?.provider === "pgschema") {
    const probe = probePgschema(opts.root, config);
    checks.push({ name: "pgschema", status: probe.ok ? "ok" : "error", message: probe.message });
  } else {
    checks.push({ name: "pgschema", status: "ok", message: "built-in migration provider is active" });
  }

  return checks;
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  const checks = await inspectDoctor(opts);
  const ok = checks.every((check) => check.status !== "error");
  if (opts.json) {
    console.log(JSON.stringify({ formatVersion: 1, ok, checks }, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${check.status.padEnd(7)} ${check.name}: ${check.message}`);
    }
  }
  if (!ok) process.exitCode = 1;
}
