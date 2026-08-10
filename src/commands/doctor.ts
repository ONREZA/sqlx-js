import { existsSync, readFileSync } from "node:fs";
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
import { validateColumnAssertions } from "../config-column-assertions";
import { scanProject, type QueryCallSite } from "../scan/scanner";
import { embeddedSqlOutputPath } from "../embedded-sql";
import { enumCatalogOutputPath } from "../enum-catalog";
import { assertDistinctPrepareGeneratedOutputs } from "../prepare-artifacts";
import { queryId } from "../query-id";
import type { PackageIdentityCheck } from "../package-identity";
import { runtimeDescriptorPath } from "../runtime-descriptor-artifact";
import { assertProfileConnection } from "../postgres-client-options";
import {
  prepareRuntimeDescriptors,
  type RuntimeQueryDescriptors,
} from "../runtime-descriptors";
import { ensureGeneratedGitAttributes } from "../generated-git-attributes";
import { inspectGitAttributesDoctorCheck } from "./doctor-git-attributes";
import { probePgschema, probeSchemaMaterializer } from "./pgschema";

export type DoctorCheck = {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
  fixable?: boolean;
  details?: Record<string, unknown>;
};

export type DoctorOptions = {
  root: string;
  databaseUrl: string;
  cacheDir: string;
  dtsPath: string;
  json?: boolean;
  fix?: boolean;
  envError?: string;
  packageIdentityCheck?: PackageIdentityCheck;
};

function configuredGeneratedPaths(
  root: string,
  config: Awaited<ReturnType<typeof loadConfigInfo>>["config"],
): string[] {
  return [
    enumCatalogOutputPath(root, config),
    embeddedSqlOutputPath(root, config),
  ].filter((path): path is string => path !== undefined);
}

function decodeBoolean(value: Uint8Array | null | undefined): boolean {
  const text = decodeText(value ?? null);
  return text === "t" || text === "true" || text === "1";
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

type RlsCommand = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

type RlsPolicyAudit = {
  name: string;
  command: "ALL" | RlsCommand;
  permissive: boolean;
  roles: string[];
};

type RawRlsTableAudit = {
  schema: string;
  table: string;
  owner: string;
  ownerRolePrivileges: boolean;
  forced: boolean;
  privileges: RlsCommand[];
  policies: RlsPolicyAudit[];
};

type RlsTableAudit = RawRlsTableAudit & {
  ownerBypass: boolean;
  missingPermissivePolicies: RlsCommand[];
};

type RlsProfileAudit = {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  tables: RlsTableAudit[];
};

type RlsIssue =
  | {
    kind: "role-bypasses-rls";
    profile: string;
    role: string;
    reason: "superuser" | "bypassrls";
  }
  | {
    kind: "table-owner-bypasses-rls";
    profile: string;
    role: string;
    schema: string;
    table: string;
  }
  | {
    kind: "missing-permissive-policy";
    profile: string;
    role: string;
    schema: string;
    table: string;
    commands: RlsCommand[];
  };

const RLS_AUDIT_QUERY = `
WITH role_info AS (
  SELECT rolname, rolsuper, rolbypassrls
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user
),
rls_tables AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS table_name,
    owner.rolname AS owner,
    pg_catalog.pg_has_role(current_user, relation.relowner, 'USAGE') AS owner_role_privileges,
    relation.relforcerowsecurity AS forced,
    access.commands AS privileges,
    COALESCE((
      SELECT pg_catalog.json_agg(
        pg_catalog.json_build_object(
          'name', policy.polname,
          'command', CASE policy.polcmd
            WHEN '*' THEN 'ALL'
            WHEN 'r' THEN 'SELECT'
            WHEN 'a' THEN 'INSERT'
            WHEN 'w' THEN 'UPDATE'
            WHEN 'd' THEN 'DELETE'
          END,
          'permissive', policy.polpermissive,
          'roles', COALESCE((
            SELECT pg_catalog.json_agg(
              CASE WHEN policy_role.oid = 0 THEN 'PUBLIC' ELSE policy_role_name.rolname END
              ORDER BY CASE WHEN policy_role.oid = 0 THEN 'PUBLIC' ELSE policy_role_name.rolname END
            )
            FROM pg_catalog.unnest(policy.polroles) AS policy_role(oid)
            LEFT JOIN pg_catalog.pg_roles AS policy_role_name ON policy_role_name.oid = policy_role.oid
          ), '[]'::pg_catalog.json)
        )
        ORDER BY policy.polname
      )
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = relation.oid
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(policy.polroles) AS applicable_role(oid)
          WHERE CASE
            WHEN applicable_role.oid = 0 THEN true
            ELSE pg_catalog.pg_has_role(current_user, applicable_role.oid, 'USAGE')
          END
        )
    ), '[]'::pg_catalog.json) AS policies
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  CROSS JOIN LATERAL (
    SELECT pg_catalog.array_remove(ARRAY[
      CASE WHEN
        pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'SELECT')
      THEN 'SELECT' END,
      CASE WHEN
        pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'INSERT')
      THEN 'INSERT' END,
      CASE WHEN
        pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
        OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'UPDATE')
      THEN 'UPDATE' END,
      CASE WHEN pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE') THEN 'DELETE' END
    ]::pg_catalog.text[], NULL) AS commands
  ) AS access
  WHERE relation.relkind IN ('r', 'p')
    AND relation.relrowsecurity
    AND namespace.nspname <> 'information_schema'
    AND namespace.nspname NOT LIKE 'pg_%'
    AND pg_catalog.cardinality(access.commands) > 0
)
SELECT pg_catalog.json_build_object(
  'role', role_info.rolname,
  'superuser', role_info.rolsuper,
  'bypassRls', role_info.rolbypassrls,
  'tables', COALESCE((
    SELECT pg_catalog.json_agg(
      pg_catalog.json_build_object(
        'schema', rls_tables.schema_name,
        'table', rls_tables.table_name,
        'owner', rls_tables.owner,
        'ownerRolePrivileges', rls_tables.owner_role_privileges,
        'forced', rls_tables.forced,
        'privileges', rls_tables.privileges,
        'policies', rls_tables.policies
      )
      ORDER BY rls_tables.schema_name, rls_tables.table_name
    )
    FROM rls_tables
  ), '[]'::pg_catalog.json)
)::pg_catalog.text
FROM role_info
`.trim();

async function inspectRlsProfile(client: PgClient): Promise<RlsProfileAudit> {
  const result = await client.simpleQuery(RLS_AUDIT_QUERY);
  const json = decodeText(result.rows[0]?.[0] ?? null);
  if (!json) throw new Error("PostgreSQL returned no RLS audit data");
  const raw = JSON.parse(json) as Omit<RlsProfileAudit, "tables"> & { tables: RawRlsTableAudit[] };
  return {
    ...raw,
    tables: raw.tables.map((table) => {
      const ownerBypass = table.ownerRolePrivileges && !table.forced;
      const missingPermissivePolicies = table.privileges.filter((command) =>
        !table.policies.some((policy) =>
          policy.permissive && (policy.command === "ALL" || policy.command === command)
        )
      );
      return { ...table, ownerBypass, missingPermissivePolicies };
    }),
  };
}

function rlsDoctorCheck(profiles: Record<string, RlsProfileAudit>): DoctorCheck {
  const issues: RlsIssue[] = [];
  for (const [profile, audit] of Object.entries(profiles)) {
    if (audit.superuser || audit.bypassRls) {
      issues.push({
        kind: "role-bypasses-rls",
        profile,
        role: audit.role,
        reason: audit.superuser ? "superuser" : "bypassrls",
      });
      continue;
    }
    for (const table of audit.tables) {
      if (table.ownerBypass) {
        issues.push({
          kind: "table-owner-bypasses-rls",
          profile,
          role: audit.role,
          schema: table.schema,
          table: table.table,
        });
        continue;
      }
      if (table.missingPermissivePolicies.length > 0) {
        issues.push({
          kind: "missing-permissive-policy",
          profile,
          role: audit.role,
          schema: table.schema,
          table: table.table,
          commands: table.missingPermissivePolicies,
        });
      }
    }
  }
  const tableCount = Object.values(profiles).reduce((sum, profile) => sum + profile.tables.length, 0);
  return issues.length > 0
    ? {
      name: "rls",
      status: "warning",
      message: `${issues.length} RLS configuration warning(s) across ${tableCount} accessible table(s)`,
      details: { profiles, issues },
    }
    : {
      name: "rls",
      status: "ok",
      message: `${tableCount} accessible RLS-enabled table(s) have no detected role-bypass or missing-policy risks`,
      details: { profiles, issues },
    };
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
  if (opts.packageIdentityCheck) {
    const identity = opts.packageIdentityCheck;
    checks.push({
      name: "packageIdentity",
      status: identity.status === "match"
        ? "ok"
        : identity.status === "unresolved"
          ? "warning"
          : "error",
      message: identity.message,
      details: {
        root: identity.root,
        runningVersion: identity.running.version,
        runningPackageJson: identity.running.packageJsonPath,
        targetVersion: identity.target?.version ?? null,
        targetPackageJson: identity.target?.packageJsonPath ?? null,
      },
    });
  }

  let config: Awaited<ReturnType<typeof loadConfigInfo>>["config"] = {};
  let configPath: string | undefined;
  let configLoaded = true;
  try {
    const info = await loadConfigInfo(opts.root);
    config = info.config;
    configPath = info.path;
    assertDistinctPrepareGeneratedOutputs({
      root: opts.root,
      config,
      dtsPath: opts.dtsPath,
    });
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

  checks.push(inspectGitAttributesDoctorCheck(
    opts.root,
    opts.dtsPath,
    configLoaded ? configuredGeneratedPaths(opts.root, config) : [],
  ));

  const tsconfig = tsconfigIncludes(opts.root, opts.dtsPath);
  checks.push({
    name: "tsconfig",
    status: tsconfig.ok ? "ok" : "error",
    message: tsconfig.message,
  });

  if (configLoaded) {
    try {
      const parameterized = scanProject(opts.root, config.scan, config.profiles)
        .filter((site) => site.paramCount > 0);
      const definitions = parameterized.filter((site) => site.origin === "definition");
      const executions = parameterized.filter((site) => site.origin === "execution");
      const descriptorConfigured = executions.filter((site) => site.execution === "descriptor");
      const adaptive = executions.filter((site) => site.execution === "adaptive");
      const unknown = executions.filter((site) =>
        site.execution === undefined || site.execution === "unknown"
      );
      const fallbackLocations = [...adaptive, ...unknown].map((site) =>
        `${site.file}:${site.line}:${site.column}`
      );
      const queryTargets = new Map<string, {
        site: QueryCallSite;
        profileName?: string;
        queryId: string;
      }>();
      for (const site of parameterized) {
        const profileNames = site.profiles?.length ? site.profiles : [undefined];
        for (const profileName of profileNames) {
          const id = queryId(site.query);
          const key = `${profileName ?? ""}\0${id}`;
          if (!queryTargets.has(key)) {
            queryTargets.set(key, {
              site,
              ...(profileName ? { profileName } : {}),
              queryId: id,
            });
          }
        }
      }
      const descriptorQueries = new Map<string, ReadonlyMap<string, unknown>>();
      let artifactError: string | undefined;
      if (queryTargets.size > 0) {
        const path = runtimeDescriptorPath(opts.cacheDir);
        try {
          const artifact = JSON.parse(readFileSync(path, "utf8")) as RuntimeQueryDescriptors;
          if (artifact.configHash !== prepareConfigHash(config)) {
            throw new Error(
              `sqlx-js: runtime descriptor config hash is stale: ${path}. Run \`sqlx-js prepare\`.`,
            );
          }
          for (const { profileName } of queryTargets.values()) {
            const key = profileName ?? "";
            if (descriptorQueries.has(key)) continue;
            const profile = profileName ? config.profiles?.[profileName] : undefined;
            descriptorQueries.set(key, prepareRuntimeDescriptors(artifact, profile).queries);
          }
        } catch (error) {
          artifactError = existsSync(path)
            ? (error as Error).message
            : `runtime descriptor not found at ${path}; run sqlx-js prepare`;
        }
      }
      const covered: Array<{
        site: QueryCallSite;
        profileName?: string;
        queryId: string;
      }> = [];
      const missing: typeof covered = [];
      for (const target of queryTargets.values()) {
        const available = !artifactError
          && descriptorQueries.get(target.profileName ?? "")?.has(target.queryId);
        (available ? covered : missing).push(target);
      }
      const missingLocations = missing.map(({ site }) =>
        `${site.file}:${site.line}:${site.column}`
      );
      const staticExecutionNote = definitions.length > 0 && executions.length === 0
        ? "; no direct execution sites were statically observable"
        : "";
      const sourceSiteNote = `; discovered ${parameterized.length} parameterized source `
        + `${parameterized.length === 1 ? "site" : "sites"} `
        + `(${definitions.length} definition ${definitions.length === 1 ? "site" : "sites"}, `
        + `${executions.length} execution ${executions.length === 1 ? "site" : "sites"})`;
      const status = artifactError || missing.length > 0
        ? "error"
        : fallbackLocations.length > 0
          ? "warning"
          : "ok";
      let message: string;
      if (artifactError) {
        message = `cannot validate descriptor coverage: ${artifactError}`;
      } else if (parameterized.length === 0) {
        message = "no parameterized queries require runtime descriptors";
      } else if (missing.length > 0) {
        message = `${covered.length}/${queryTargets.size} unique query/profile contracts are present in the runtime descriptor; `
          + `${missing.length} are absent${sourceSiteNote}`;
      } else if (fallbackLocations.length > 0) {
        message = `${covered.length}/${queryTargets.size} unique query/profile contracts are present in the runtime descriptor; `
          + `${fallbackLocations.length} execution site(s) remain adaptive or cannot be classified`
          + sourceSiteNote;
      } else {
        message = `${covered.length}/${queryTargets.size} unique query/profile contracts are present in the runtime descriptor`
          + sourceSiteNote + staticExecutionNote;
      }
      checks.push({
        name: "descriptorCoverage",
        status,
        message,
        details: {
          parameterized: parameterized.length,
          queryContracts: queryTargets.size,
          descriptor: covered.length,
          descriptorConfigured: descriptorConfigured.length,
          missing: missing.length,
          definitions: definitions.length,
          executionSites: executions.length,
          adaptive: adaptive.length,
          unknown: unknown.length,
          locations: fallbackLocations,
          missingLocations,
          countSemantics: {
            parameterized: "parameterized source sites before query/profile deduplication",
            queryContracts: "unique SQL fingerprint and connection-profile contracts",
            descriptor: "unique query/profile contracts present in the runtime descriptor",
            descriptorConfigured: "direct execution source sites statically configured for descriptors",
            missing: "unique query/profile contracts absent from the runtime descriptor",
            definitions: "reusable parameterized definition source sites",
            executionSites: "direct parameterized execution source sites",
            adaptive: "direct execution source sites explicitly configured for adaptive execution",
            unknown: "direct execution source sites whose execution mode cannot be classified statically",
          },
          ...(artifactError ? { artifactError } : {}),
        },
      });
    } catch (error) {
      checks.push({
        name: "descriptorCoverage",
        status: "error",
        message: `cannot inspect runtime query sites: ${(error as Error).message}`,
      });
    }
  } else {
    checks.push({
      name: "descriptorCoverage",
      status: "warning",
      message: "descriptor coverage check skipped because config failed to load",
    });
  }

  if (configLoaded && config.enumCatalog) {
    try {
      const output = enumCatalogOutputPath(opts.root, config)!;
      checks.push(existsSync(output)
        ? {
            name: "enumCatalog",
            status: "ok",
            message: `generated enum catalog exists at ${output}`,
          }
        : {
            name: "enumCatalog",
            status: "error",
            message: `generated enum catalog not found at ${output}; run sqlx-js prepare`,
          });
    } catch (error) {
      checks.push({ name: "enumCatalog", status: "error", message: (error as Error).message });
    }
  }

  if (configLoaded && config.sqlFiles) {
    const output = embeddedSqlOutputPath(opts.root, config)!;
    checks.push(existsSync(output)
      ? {
          name: "embeddedSql",
          status: "ok",
          message: `generated embedded SQL module exists at ${output}`,
        }
      : {
          name: "embeddedSql",
          status: "error",
          message: `generated embedded SQL module not found at ${output}; run sqlx-js prepare`,
        });
  }

  if (!opts.databaseUrl) {
    checks.push({ name: "database", status: "error", message: "DATABASE_URL is required for the database check" });
  } else {
    let client: PgClient | undefined;
    try {
      const connection = parseDatabaseUrl(opts.databaseUrl);
      client = new PgClient(connection);
      await client.connect();
      await client.describe("SELECT 1");
      const result = await client.simpleQueryAll(`
        SELECT current_setting('server_version'), current_user, current_database(),
          (SELECT (rolcreatedb OR rolsuper)::text FROM pg_roles WHERE rolname = current_user),
          COALESCE(has_schema_privilege(current_user, current_schema(), 'USAGE'), false)::text
      `);
      const row = result.rows[0]!;
      const databaseRole = decodeText(row[1]!);
      if (!databaseRole) throw new Error("PostgreSQL returned an empty current_user");
      const canCreateDatabase = decodeBoolean(row[3]);
      const hasSchemaUsage = decodeBoolean(row[4]);
      const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;
      const shadowAdminDatabaseUrl = process.env.SHADOW_ADMIN_DATABASE_URL;
      const hasShadowFallback = Boolean(shadowDatabaseUrl || shadowAdminDatabaseUrl);
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
        status: hasSchemaUsage && (canCreateDatabase || hasShadowFallback) ? "ok" : "warning",
        message: !hasSchemaUsage
          ? "current user lacks USAGE on the current schema"
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
      if (configLoaded && config.profiles) {
        const roles: Record<string, string> = {};
        const rlsProfiles: Record<string, RlsProfileAudit> = {};
        let profileError: Error | undefined;
        let rlsError: Error | undefined;
        for (const profile of Object.values(config.profiles)) {
          let phase: "profile" | "rls" = "profile";
          try {
            assertProfileConnection(profile, connection);
            await client.simpleQuery(`SET ROLE ${quoteIdentifier(profile.role)}`);
            const roleResult = await client.simpleQuery("SELECT current_user");
            const currentRole = decodeText(roleResult.rows[0]![0]!);
            if (!currentRole) throw new Error("PostgreSQL returned an empty current_user");
            roles[profile.name] = currentRole;
            phase = "rls";
            rlsProfiles[profile.name] = await inspectRlsProfile(client);
          } catch (error) {
            if (phase === "profile") {
              profileError = new Error(
                `profile ${profile.name} cannot use PostgreSQL role ${profile.role}: ${(error as Error).message}`,
                { cause: error },
              );
              break;
            } else {
              rlsError ??= new Error(
                `cannot audit RLS for profile ${profile.name}: ${(error as Error).message}`,
                { cause: error },
              );
            }
          } finally {
            await client.simpleQuery(`SET ROLE ${quoteIdentifier(databaseRole)}`).catch(() => {});
          }
        }
        checks.push(profileError
          ? { name: "profiles", status: "error", message: profileError.message, details: { roles } }
          : {
              name: "profiles",
              status: "ok",
              message: `${Object.keys(roles).length} connection profile role(s) are available`,
              details: { roles },
            });
        const rlsCheck = rlsDoctorCheck(rlsProfiles);
        checks.push(profileError
          ? {
            name: "rls",
            status: "warning",
            message: "RLS audit is incomplete because profile role validation failed",
            details: { ...rlsCheck.details, incomplete: true },
          }
          : rlsError
            ? {
              name: "rls",
              status: "error",
              message: rlsError.message,
              details: { ...rlsCheck.details, incomplete: true },
            }
            : rlsCheck);
      }
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
        try {
          await validateColumnAssertions(config, configPath, schema);
          checks.push({
            name: "columnAssertions",
            status: "ok",
            message: "column type assertions resolve to exact PostgreSQL columns",
          });
        } catch (error) {
          checks.push({ name: "columnAssertions", status: "error", message: (error as Error).message });
        }
      } else {
        checks.push({
          name: "runtimeTypes",
          status: "warning",
          message: "runtime type check skipped because config failed to load",
        });
        checks.push({
          name: "columnAssertions",
          status: "warning",
          message: "column assertion check skipped because config failed to load",
        });
      }
    } catch (e) {
      checks.push({ name: "database", status: "error", message: (e as Error).message });
    } finally {
      await client?.end().catch(() => {});
    }
  }

  if (!configLoaded) {
    checks.push({ name: "pgschema", status: "warning", message: "schema-provider check skipped because config failed to load" });
  } else if (config.schema?.provider === "pgschema") {
    const probe = probePgschema(opts.root, config);
    checks.push({
      name: "pgschema",
      status: probe.ok ? "ok" : "error",
      message: probe.message,
      details: {
        configuredProvider: "pgschema",
        ddlOwnership: "sqlx-js-pgschema-workflow",
        effectiveDevVerifyProvider: config.schema.materializer ? "custom-materializer" : "pgschema",
      },
    });
    if (config.schema.materializer) {
      const materializerProbe = probeSchemaMaterializer(opts.root, config);
      checks.push({
        name: "schemaMaterializer",
        status: materializerProbe.ok ? "ok" : "error",
        message: materializerProbe.message,
        details: {
          command: materializerProbe.command ?? config.schema.materializer.command,
          workflow: "dev-verify-shadow-materialization",
        },
      });
    }
  } else if (config.schema?.provider === "builtin") {
    checks.push({
      name: "pgschema",
      status: "ok",
      message: "schema.provider is explicitly builtin; sqlx-js owns the configured migration workflow",
      details: {
        configuredProvider: "builtin",
        ddlOwnership: "sqlx-js-builtin-migration-workflow",
        effectiveDevVerifyProvider: "builtin",
      },
    });
  } else {
    checks.push({
      name: "pgschema",
      status: "ok",
      message: "schema.provider is not configured; DDL ownership is external or unspecified, while dev and verify default to built-in migrations",
      details: {
        configuredProvider: null,
        ddlOwnership: "external-or-unspecified",
        effectiveDevVerifyProvider: "builtin",
      },
    });
  }

  return checks;
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  let fixed: ReturnType<typeof ensureGeneratedGitAttributes> | undefined;
  let fixError: Error | undefined;
  if (opts.fix) {
    if (opts.packageIdentityCheck?.status === "mismatch" || opts.packageIdentityCheck?.status === "invalid") {
      fixError = new Error("package identity must be valid and match before doctor --fix can write the worktree");
    } else {
      let generatedPaths: string[] = [];
      try {
        const info = await loadConfigInfo(opts.root);
        generatedPaths = configuredGeneratedPaths(opts.root, info.config);
      } catch {}
      try {
        fixed = ensureGeneratedGitAttributes(opts.root, opts.dtsPath, generatedPaths);
      } catch (error) {
        fixError = error as Error;
      }
    }
  }
  const checks = await inspectDoctor(opts);
  const check = checks.find((candidate) => candidate.name === "gitAttributes");
  if (check) {
    if (fixError) {
      check.status = "error";
      check.message = `cannot update generated Git attributes: ${fixError.message}`;
      check.details = { ...check.details, fixError: fixError.message };
    } else if (fixed?.changed) {
      check.message += `; added ${fixed.added.length} ${fixed.added.length === 1 ? "rule" : "rules"}`;
      check.details = { ...check.details, fixed: fixed.added };
    }
  }
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
