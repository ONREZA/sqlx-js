#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { JsonAuditReport } from "../src/commands/json-audit";
import type { PgschemaSubcommand } from "../src/commands/pgschema";
import type { PrepareDiagnosticPhase } from "../src/commands/prepare";
import type { DatabaseTargetSummary } from "../src/pg/target-summary";
import { JSON_PROTOCOL_VERSION } from "../src/artifact-versions";
import { assertSupportedRuntime, loadConfig, loadRootEnv } from "../src/config";
import { inspectPackageIdentity, runningPackageIdentity } from "../src/package-identity";
import { optionsFor } from "./sqlx-js-options";
import { helpText, type HelpScope } from "./sqlx-js-help";

const CLI_IDENTITY = runningPackageIdentity(import.meta.url);
const VERSION = CLI_IDENTITY.version;

function printHelp(scope: HelpScope, error = false, args: string[] = []): void {
  (error ? console.error : console.log)(helpText(VERSION, scope, args));
}

function exitHelp(scope: HelpScope, args: string[] = []): never {
  printHelp(scope, false, args);
  process.exit(0);
}

const rawArgv = process.argv.slice(2);
const passthroughIndex = rawArgv.indexOf("--");
const cliArgv = passthroughIndex >= 0 ? rawArgv.slice(0, passthroughIndex) : rawArgv;
const passthroughArgs = passthroughIndex >= 0 ? rawArgv.slice(passthroughIndex + 1) : [];
const cmd = cliArgv[0];
const commandArgv = cliArgv.slice(1);

function usageError(message: string, scope: HelpScope = "root", args: string[] = []): never {
  if (cmd === "json" && cliArgv.includes("--json")) {
    printJsonAuditFailure(`sqlx-js: ${message}`);
    process.exit(2);
  }
  console.error(`sqlx-js: ${message}`);
  printHelp(scope, true, args);
  process.exit(2);
}

const scopes = new Set<HelpScope>([
  "init",
  "dev",
  "verify",
  "doctor",
  "ci",
  "json",
  "pgschema",
  "prepare",
  "queries",
  "migrate",
  "snapshot",
]);

if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (!cmd || cmd === "--help" || cmd === "-h") exitHelp("root");
if (!scopes.has(cmd as HelpScope)) usageError(`unknown command ${JSON.stringify(cmd)}`);
const scope = cmd as Exclude<HelpScope, "root">;
if (cliArgv.includes("--help") || cliArgv.includes("-h")) exitHelp(scope, commandArgv);
if (passthroughIndex >= 0 && cmd !== "pgschema") {
  usageError("arguments after -- are only supported by sqlx-js pgschema", scope, commandArgv);
}

const subcommand = commandArgv[0]?.startsWith("-") ? undefined : commandArgv[0];
let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    args: commandArgv,
    options: optionsFor(cmd, subcommand),
    strict: true,
    allowPositionals: true,
  });
} catch (error) {
  usageError((error as Error).message, scope, commandArgv);
}
const values = parsed.values;
const positionals = parsed.positionals;

function arg(name: string, def?: string): string | undefined {
  const value = values[name.replace(/^--/, "")];
  return typeof value === "string" ? value : def;
}

function flag(name: string): boolean {
  return values[name.replace(/^--/, "")] === true;
}

function args(name: string): string[] {
  const value = values[name.replace(/^--/, "")];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function requirePositionals(min: number, max: number, label: string): void {
  if (positionals.length < min || positionals.length > max) {
    usageError(
      `${label}: expected ${min === max ? min : `${min} to ${max}`} positional argument(s)`,
      scope,
      commandArgv,
    );
  }
}

function validateInvocation(): void {
  if (
    cmd === "init" ||
    cmd === "dev" ||
    cmd === "verify" ||
    cmd === "doctor" ||
    cmd === "ci" ||
    cmd === "prepare" ||
    cmd === "queries"
  ) {
    if (cmd === "queries") {
      const queryCommand = positionals[0];
      if (queryCommand === "explain") {
        requirePositionals(2, 2, "queries explain");
      } else if (queryCommand === "audit" || queryCommand === "similarities") {
        requirePositionals(1, 1, `queries ${queryCommand}`);
      } else if (queryCommand) {
        usageError(`unknown queries command ${JSON.stringify(queryCommand)}`, "queries", commandArgv);
      } else {
        requirePositionals(0, 0, "queries");
      }
      const similarityOptions = [arg("--functions"), arg("--min-nodes"), arg("--limit")].some(
        (value) => value !== undefined,
      );
      if (queryCommand !== "similarities" && similarityOptions) {
        usageError(
          "--functions, --min-nodes, and --limit are only supported by queries similarities",
          "queries",
          commandArgv,
        );
      }
      return;
    }
    requirePositionals(0, 0, cmd);
    return;
  }
  if (cmd === "json") {
    requirePositionals(1, 1, "json");
    if (positionals[0] !== "audit") {
      usageError(`unknown json command ${JSON.stringify(positionals[0])}`, "json", commandArgv);
    }
    return;
  }
  if (cmd === "pgschema") {
    requirePositionals(1, 1, "pgschema");
    const sub = positionals[0];
    if (sub !== "install" && sub !== "plan" && sub !== "apply") {
      usageError(`unknown pgschema command ${JSON.stringify(sub)}`, "pgschema", commandArgv);
    }
    if (passthroughArgs.length > 0 && sub !== "plan" && sub !== "apply") {
      usageError(`pgschema ${sub} does not accept arguments after --`, "pgschema", commandArgv);
    }
    return;
  }
  if (cmd === "snapshot") {
    requirePositionals(1, 1, "snapshot");
    const sub = positionals[0];
    if (sub !== "dump" && sub !== "check") {
      usageError(`unknown snapshot command ${JSON.stringify(sub)}`, "snapshot", commandArgv);
    }
    return;
  }
  const sub = positionals[0];
  if (!sub) usageError("migrate command is required", "migrate");
  if (["run", "info", "check", "revert"].includes(sub)) {
    requirePositionals(1, 1, `migrate ${sub}`);
    return;
  }
  if (sub === "add" || sub === "squash") {
    requirePositionals(2, 2, `migrate ${sub}`);
    return;
  }
  if (sub === "archive") {
    const action = positionals[1];
    if (action === "list") {
      requirePositionals(2, 2, "migrate archive list");
      if (flag("--force")) {
        usageError("--force is only supported by migrate archive restore", "migrate", commandArgv);
      }
    } else if (action === "restore") requirePositionals(3, 3, "migrate archive restore");
    else usageError(`unknown migrate archive command ${JSON.stringify(action)}`, "migrate", commandArgv);
    return;
  }
  usageError(`unknown migrate command ${JSON.stringify(sub)}`, "migrate", commandArgv);
}

validateInvocation();

const root = resolve(arg("--root", process.cwd())!);
function prepareMode(): "prepare" | "prepare-focused" | "check" | "offline" | "verify" {
  if (flag("--verify")) return "verify";
  if (flag("--check")) return "check";
  if (flag("--offline")) return "offline";
  return args("--include").length > 0 || args("--query").length > 0
    ? "prepare-focused"
    : "prepare";
}

function printPrepareFailure(
  message: string,
  phase: PrepareDiagnosticPhase,
  location: { file?: string; line?: number; column?: number } = {},
  target?: DatabaseTargetSummary,
  targetText?: string,
): void {
  if (flag("--jsonl")) {
    console.log(JSON.stringify({
      formatVersion: 1,
      event: "error",
      timestamp: new Date().toISOString(),
      ...(target === undefined ? {} : { target }),
      diagnostic: { severity: "error", phase, message, ...location },
    }));
  } else if (flag("--json")) {
    console.log(JSON.stringify({
      formatVersion: 1,
      ok: false,
      mode: prepareMode(),
      ...(target === undefined ? {} : { target }),
      sites: 0,
      entries: 0,
      failures: 1,
      pruned: 0,
      functions: 0,
      enums: 0,
      diagnostics: [{ severity: "error", phase, message, ...location }],
    }, null, 2));
  } else if (!flag("--verbose")) {
    if (targetText !== undefined) console.log(targetText);
    const locationText = location.file
      ? `${location.file}${location.line ? `:${location.line}:${location.column ?? 1}` : ""}`
      : "";
    const embeddedLocation = locationText ? `sqlx-js: ${locationText} — ` : "";
    const detail = embeddedLocation && message.startsWith(embeddedLocation)
      ? message.slice(embeddedLocation.length)
      : message;
    console.error(`${phase} failed: ${locationText ? `${locationText} — ` : ""}${detail}`);
    console.error(`summary: 0 warnings, 1 error (${phase}: 1)`);
  } else {
    if (targetText !== undefined) console.log(targetText);
    console.error(message);
  }
}

function printJsonAuditFailure(message: string): void {
  const report = {
    formatVersion: 1,
    protocolVersion: JSON_PROTOCOL_VERSION,
    ok: false,
    complete: false,
    columns: [],
    dependencies: [],
    sourceUsages: [],
    summary: {
      columns: 0,
      scannedColumns: 0,
      collisionRows: 0,
      duplicateKeyRows: 0,
      invalidNumberRows: 0,
      errors: 1,
      dependencies: 0,
      sourceUsages: 0,
      reviewRequired: true,
    },
    diagnostics: [{ severity: "error", message }],
  } satisfies JsonAuditReport & {
    diagnostics: Array<{ severity: "error"; message: string }>;
  };
  console.log(JSON.stringify(report, null, 2));
}

function failPreflight(message: string, phase: PrepareDiagnosticPhase = "config"): never {
  if (cmd === "ci" && flag("--json")) {
    console.log(JSON.stringify({
      formatVersion: 1,
      ok: false,
      results: [{ name: "preflight", ok: false, durationMs: 0, exitCode: 2, stderr: message }],
    }, null, 2));
  } else if (cmd === "queries" && flag("--json")) {
    console.log(JSON.stringify({
      formatVersion: 1,
      ok: false,
      diagnostics: [{ severity: "error", phase, message }],
    }, null, 2));
  } else if (cmd === "json" && flag("--json")) {
    printJsonAuditFailure(message);
  } else if (cmd === "prepare") {
    printPrepareFailure(message, phase);
  } else {
    console.error(message);
  }
  process.exit(2);
}
const packageIdentityCheck = inspectPackageIdentity(root, CLI_IDENTITY);
if (
  (packageIdentityCheck.status === "mismatch" || packageIdentityCheck.status === "invalid")
  && cmd !== "doctor"
) {
  failPreflight(packageIdentityCheck.message);
}
if (cmd !== "doctor") {
  try {
    assertSupportedRuntime();
  } catch (e) {
    failPreflight((e as Error).message);
  }
}
const needsTypeScript =
  cmd === "doctor" ||
  cmd === "ci" ||
  cmd === "prepare" ||
  cmd === "queries" ||
  cmd === "json" ||
  cmd === "dev" ||
  cmd === "verify";
if (needsTypeScript) {
  let typescriptError: string | undefined;
  try {
    const typescript = (await import("typescript")).default;
    if (typeof typescript.createSourceFile !== "function") {
      typescriptError =
        "sqlx-js: TypeScript 7 does not expose the compiler API used for source scanning. " +
        "Install TypeScript 5.4–6.x with `npm install --save-dev \"typescript@>=5.4 <7\"` " +
        "or `bun add --dev \"typescript@>=5.4 <7\"`.";
    }
  } catch {
    typescriptError =
      "sqlx-js: TypeScript is required for source scanning. Install it with " +
      "`npm install --save-dev \"typescript@>=5.4 <7\"` or `bun add --dev \"typescript@>=5.4 <7\"`.";
  }
  if (typescriptError) {
    if (cmd === "doctor" && flag("--json")) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: false,
        checks: [{ name: "typescript", status: "error", message: typescriptError }],
      }, null, 2));
    } else {
      if (cmd === "ci" || cmd === "json") failPreflight(typescriptError);
      console.error(typescriptError);
    }
    process.exit(2);
  }
}
let envError: string | undefined;
const needsEnvironment =
  cmd === "doctor" ||
  cmd === "ci" ||
  cmd === "snapshot" ||
  cmd === "json" ||
  cmd === "dev" ||
  cmd === "verify" ||
  (cmd === "pgschema" && (positionals[0] === "plan" || positionals[0] === "apply")) ||
  (cmd === "prepare" && !flag("--check") && !flag("--offline")) ||
  (cmd === "migrate" && !["add", "check", "archive"].includes(positionals[0]!));
if (needsEnvironment) {
  try {
    loadRootEnv(root);
  } catch (e) {
    envError = (e as Error).message;
    if (cmd !== "doctor") {
      failPreflight(envError);
    }
  }
}
const databaseUrl = process.env.DATABASE_URL ?? "";
const shadowUrlArg = arg("--shadow-url");
const shadowAdminUrlArg = arg("--shadow-admin-url");
if (shadowUrlArg !== undefined && shadowAdminUrlArg !== undefined) {
  usageError("--shadow-url and --shadow-admin-url are mutually exclusive", scope, commandArgv);
}
const shadowUrl = shadowUrlArg ?? (shadowAdminUrlArg === undefined ? process.env.SHADOW_DATABASE_URL : undefined);
const shadowAdminUrl = shadowUrl === undefined
  ? shadowAdminUrlArg ?? process.env.SHADOW_ADMIN_DATABASE_URL
  : undefined;
const cacheDir = join(root, ".sqlx-js");
const dtsArg = arg("--dts");
const dtsPath = dtsArg ? resolve(root, dtsArg) : join(root, "sqlx-js-env.d.ts");
const migrationsDir = join(root, arg("--migrations", "migrations")!);
const schemaArg = arg("--schema");
const schemaPath = schemaArg ? resolve(root, schemaArg) : join(root, ".sqlx-js/schema/schema.json");
const manifestArg = arg("--manifest");
const manifestPath = manifestArg ? resolve(root, manifestArg) : join(root, ".sqlx-js/schema/schema.md");

function parseLockTimeout(): number | undefined {
  const raw = arg("--lock-timeout");
  const timeout = raw ? Number(raw) : undefined;
  if (timeout !== undefined && !Number.isFinite(timeout)) {
    usageError("--lock-timeout must be a finite number of milliseconds", scope, commandArgv);
  }
  return timeout;
}

function failCommand(error: unknown, exitCode = 1): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(exitCode);
}

function failJsonAudit(error: unknown, exitCode = 1): never {
  const message = error instanceof Error ? error.message : String(error);
  if (flag("--json")) printJsonAuditFailure(message);
  else console.error(message);
  process.exit(exitCode);
}

if (cmd === "init") {
  const { runInit } = await import("../src/commands/init");
  const provider = arg("--schema-provider", "builtin");
  if (provider !== "builtin" && provider !== "pgschema") {
    console.error("--schema-provider must be builtin or pgschema");
    process.exit(2);
  }
  try {
    runInit({ root, schemaProvider: provider });
  } catch (error) {
    failCommand(error);
  }
} else if (cmd === "dev" || cmd === "verify") {
  if (!databaseUrl && !shadowUrl) {
    console.error(`DATABASE_URL is required for ${cmd} (or pass --shadow-url)`);
    process.exit(2);
  }
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(root);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const lockTimeoutMs = parseLockTimeout();
  if (config.schema?.provider === "pgschema") {
    if (arg("--migrations") !== undefined || arg("--lock-timeout") !== undefined) {
      usageError("--migrations and --lock-timeout require schema.provider \"builtin\"", scope, commandArgv);
    }
    const {
      PgschemaCommandError,
      SchemaMaterializerCommandError,
      runPgschemaDev,
      runPgschemaVerify,
    } = await import("../src/commands/pgschema");
    try {
      const opts = {
        root,
        databaseUrl,
        config,
        cacheDir,
        dtsPath,
        snapshotPath: schemaPath,
        shadowUrl,
        shadowAdminUrl,
        strictInference: flag("--strict-inference"),
      };
      const ok = cmd === "dev"
        ? await runPgschemaDev({ ...opts, prune: !flag("--no-prune") })
        : await runPgschemaVerify(opts);
      if (!ok) process.exit(1);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(
        error instanceof PgschemaCommandError || error instanceof SchemaMaterializerCommandError
          ? error.exitCode
          : 2,
      );
    }
  } else {
    const { migrateDev, migrateVerify } = await import("../src/commands/migrate");
    const opts = {
      root,
      databaseUrl,
      migrationsDir,
      cacheDir,
      dtsPath,
      snapshotPath: schemaPath,
      shadowUrl,
      shadowAdminUrl,
      lockTimeoutMs,
      strictInference: flag("--strict-inference"),
    };
    try {
      if (cmd === "dev") await migrateDev({ ...opts, prune: !flag("--no-prune") });
      else await migrateVerify(opts);
    } catch (error) {
      failCommand(error);
    }
  }
} else if (cmd === "doctor") {
  const { runDoctor } = await import("../src/commands/doctor");
  try {
    await runDoctor({
      root,
      databaseUrl,
      cacheDir,
      dtsPath,
      json: flag("--json"),
      fix: flag("--fix"),
      envError,
      packageIdentityCheck,
    });
  } catch (error) {
    failCommand(error);
  }
} else if (cmd === "ci") {
  const { runCi } = await import("../src/commands/ci");
  runCi({
    executable: process.execPath,
    cliPath: fileURLToPath(import.meta.url),
    root,
    json: flag("--json"),
    shadowUrl,
    shadowAdminUrl,
    migrationsDir: arg("--migrations"),
    dtsPath: dtsArg ? dtsPath : undefined,
  });
} else if (cmd === "json") {
  if (!databaseUrl) {
    failJsonAudit("DATABASE_URL is required for json audit", 2);
  }
  const { runJsonAudit } = await import("../src/commands/json-audit");
  try {
    await runJsonAudit({
      root,
      databaseUrl,
      config: await loadConfig(root),
      json: flag("--json"),
    });
  } catch (error) {
    failJsonAudit(error);
  }
} else if (cmd === "pgschema") {
  const {
    PgschemaCommandError,
    runPgschemaCommand,
    runPgschemaInstall,
  } = await import("../src/commands/pgschema");
  const sub = positionals[0];
  const failPgschema = (error: unknown): never => {
    failCommand(error, error instanceof PgschemaCommandError ? error.exitCode : 2);
  };
  if (sub === "install") {
    try {
      await runPgschemaInstall({ root });
    } catch (e) {
      failPgschema(e);
    }
  } else {
    try {
      runPgschemaCommand({
        root,
        databaseUrl,
        config: await loadConfig(root),
        subcommand: sub as PgschemaSubcommand,
        passthrough: passthroughArgs,
      });
    } catch (e) {
      failPgschema(e);
    }
  }
} else if (cmd === "prepare") {
  const { PrepareFatalError } = await import("../src/commands/prepare");
  const { runPrepare } = await import("../src/commands/prepare-command");
  const prepareCheck = flag("--check");
  const prepareOffline = flag("--offline");
  const prepareVerify = flag("--verify");
  const prepareWatch = flag("--watch");
  const prepareJson = flag("--json");
  const prepareJsonl = flag("--jsonl");
  const prepareWarnings = flag("--warnings");
  const prepareVerbose = flag("--verbose");
  const prepareIncludes = args("--include");
  const prepareQueries = args("--query");
  const prepareFocused = prepareIncludes.length > 0 || prepareQueries.length > 0;
  const failPrepare = (
    message: string,
    phase: PrepareDiagnosticPhase,
    exitCode = 2,
    location: { file?: string; line?: number; column?: number } = {},
    target?: DatabaseTargetSummary,
    targetText?: string,
  ): never => {
    printPrepareFailure(message, phase, location, target, targetText);
    process.exit(exitCode);
  };
  if ([prepareCheck, prepareOffline, prepareVerify, prepareWatch].filter(Boolean).length > 1) {
    failPrepare("--check, --offline, --verify, and --watch are mutually exclusive", "config");
  }
  if (prepareWatch && prepareJson) {
    failPrepare("--watch and --json are mutually exclusive", "config");
  }
  if (prepareJson && prepareJsonl) {
    failPrepare("--json and --jsonl are mutually exclusive", "config");
  }
  if ([prepareWarnings, prepareVerbose, prepareJson, prepareJsonl].filter(Boolean).length > 1) {
    failPrepare("--warnings, --verbose, --json, and --jsonl are mutually exclusive", "config");
  }
  if ((prepareWarnings || prepareVerbose) && prepareWatch) {
    failPrepare(`${prepareWarnings ? "--warnings" : "--verbose"} is unnecessary with prepare --watch`, "config");
  }
  if (prepareJsonl && !prepareWatch) {
    failPrepare("--jsonl is only supported by prepare --watch", "config");
  }
  if ((prepareCheck || prepareOffline || prepareVerify) && flag("--no-prune")) {
    failPrepare("--no-prune is only supported by live prepare and prepare --watch", "config");
  }
  if ([...prepareIncludes, ...prepareQueries].some((value) => value.trim() === "")) {
    failPrepare("--include and --query values must be non-empty", "config");
  }
  if (prepareFocused && (prepareCheck || prepareOffline || prepareVerify || prepareWatch)) {
    failPrepare("--include and --query are only supported by live prepare", "config");
  }
  if (prepareFocused && flag("--no-prune")) {
    failPrepare("focused prepare already preserves unselected cache entries; remove --no-prune", "config");
  }
  if (!prepareCheck && !prepareOffline && !databaseUrl) {
    failPrepare("DATABASE_URL is required for prepare (use --check or --offline without a database)", "connect");
  }
  const opts = {
    root,
    databaseUrl,
    cacheDir,
    dtsPath,
    check: prepareCheck,
    offline: prepareOffline,
    verify: prepareVerify,
    json: prepareJson,
    warnings: prepareWarnings,
    verbose: prepareVerbose,
    prune: !flag("--no-prune"),
    strictInference: flag("--strict-inference"),
    ...(prepareFocused ? { focus: { include: prepareIncludes, query: prepareQueries } } : {}),
  };
  if (prepareWatch) {
    const { runWatch } = await import("../src/commands/watch");
    await runWatch({
      ...opts,
      jsonl: prepareJsonl,
    });
  } else {
    try {
      await runPrepare(opts);
    } catch (e) {
      const message = (e as Error).message;
      const phase = e instanceof PrepareFatalError
        ? e.phase
        : prepareVerify
          ? "verify"
          : "scan";
      const target = e instanceof PrepareFatalError ? e.target : undefined;
      const targetText = target === undefined
        ? undefined
        : (await import("../src/pg/target-summary")).formatDatabaseTarget(target);
      failPrepare(
        message,
        phase,
        1,
        e instanceof PrepareFatalError
          ? { file: e.file, line: e.line, column: e.column }
          : {},
        target,
        targetText,
      );
    }
  }
} else if (cmd === "queries") {
  const { QueriesError, runQueries } = await import("../src/commands/queries");
  const queryCommand = positionals[0];
  const positiveIntegerOption = (name: "--min-nodes" | "--limit"): number | undefined => {
    const value = arg(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      usageError(`${name} must be a positive integer`, "queries", commandArgv);
    }
    return parsed;
  };
  try {
    if (queryCommand === "audit") {
      const { runExactQueryAudit } = await import("../src/commands/query-audit");
      await runExactQueryAudit({ root, json: flag("--json") });
    } else if (queryCommand === "similarities") {
      const { runQuerySimilarities } = await import("../src/commands/query-audit");
      await runQuerySimilarities({
        root,
        json: flag("--json"),
        functionsPath: arg("--functions"),
        minNodes: positiveIntegerOption("--min-nodes"),
        limit: positiveIntegerOption("--limit"),
      });
    } else {
      await runQueries({
        root,
        cacheDir,
        json: flag("--json"),
        explainQueryId: queryCommand === "explain" ? positionals[1] : undefined,
      });
    }
  } catch (error) {
    if (flag("--json")) {
      const diagnostic = error instanceof QueriesError
        ? {
            severity: "error",
            phase: error.phase,
            message: error.message,
            ...(error.file === undefined ? {} : { file: error.file }),
            ...(error.line === undefined ? {} : { line: error.line }),
            ...(error.column === undefined ? {} : { column: error.column }),
          }
        : { severity: "error", phase: "scan", message: (error as Error).message };
      console.log(JSON.stringify({ formatVersion: 1, ok: false, diagnostics: [diagnostic] }, null, 2));
    } else {
      console.error((error as Error).message);
    }
    process.exit(2);
  }
} else if (cmd === "snapshot") {
  const { runSchemaCheck, runSchemaDump } = await import("../src/commands/schema");
  const sub = positionals[0];
  const schemaDatabaseUrl = shadowUrlArg ?? databaseUrl;
  if (!schemaDatabaseUrl) {
    console.error("DATABASE_URL is required for snapshot commands (or pass --shadow-url)");
    process.exit(2);
  }
  const opts = {
    databaseUrl: schemaDatabaseUrl,
    cacheDir,
    snapshotPath: schemaPath,
    manifestPath,
    writeManifest: !flag("--no-manifest"),
  };
  try {
    if (sub === "dump") await runSchemaDump(opts);
    else if (sub === "check") await runSchemaCheck(opts);
  } catch (error) {
    failCommand(error);
  }
} else if (cmd === "migrate") {
  const {
    migrateArchiveList,
    migrateArchiveRestore,
    migrateCheck,
    migrateRun,
    migrateInfo,
    migrateRevert,
    migrateAdd,
    migrateSquash,
  } = await import("../src/commands/migrate");
  const sub = positionals[0];
  const revertDryRun = sub === "revert" && flag("--dry-run");
  const workflowShadowOnly = (sub === "squash" && !!shadowUrl) || (revertDryRun && !!shadowUrl);
  if (!databaseUrl && sub !== "add" && sub !== "check" && sub !== "archive" && !workflowShadowOnly) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const lockTimeoutMs = parseLockTimeout();
  try {
    if (sub === "run") {
      await migrateRun({ databaseUrl, migrationsDir, lockTimeoutMs, dryRun: flag("--dry-run"), json: flag("--json") });
    } else if (sub === "info") {
      await migrateInfo({ databaseUrl, migrationsDir, json: flag("--json") });
    } else if (sub === "check") {
      migrateCheck({ migrationsDir, json: flag("--json") });
    } else if (sub === "revert") {
      await migrateRevert({
        databaseUrl,
        migrationsDir,
        lockTimeoutMs,
        dryRun: flag("--dry-run"),
        shadowUrl,
        shadowAdminUrl,
        json: flag("--json"),
      });
    } else if (sub === "add") {
      const name = positionals[1]!;
      migrateAdd({ databaseUrl, migrationsDir, name });
    } else if (sub === "squash") {
      const name = positionals[1]!;
      await migrateSquash({
        databaseUrl,
        migrationsDir,
        name,
        shadowUrl,
        shadowAdminUrl,
        replace: flag("--replace"),
        pgDumpPath: arg("--pg-dump"),
        lockTimeoutMs,
      });
    } else if (sub === "archive") {
      const action = positionals[1];
      if (action === "list") {
        migrateArchiveList({ migrationsDir });
      } else if (action === "restore") {
        const name = positionals[2]!;
        migrateArchiveRestore({ migrationsDir, name, force: flag("--force") });
      }
    }
  } catch (error) {
    failCommand(error);
  }
} else {
  usageError(`unknown command ${JSON.stringify(cmd)}`);
}
