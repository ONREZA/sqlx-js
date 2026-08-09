import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { assertCacheManifest, Cache, type CacheEntry } from "../cache";
import { emitDts } from "../codegen";
import { loadConfig, prepareConfigHash, type SqlxJsConfig } from "../config";
import {
  enumCatalogCacheExists,
  enumCatalogOutputPath,
  readEnumCatalogCache,
  renderEnumCatalog,
  selectedEnumCatalogCount,
  type EnumCatalogEntry,
} from "../enum-catalog";
import { embeddedSqlOutputPath, renderEmbeddedSqlModule } from "../embedded-sql";
import { functionCacheExists, readFunctionCache, type FunctionEntry } from "../function-cache";
import {
  assertDistinctPrepareGeneratedOutputs,
  prepareGeneratedOutputPaths,
  publishOfflinePrepareArtifacts,
} from "../prepare-artifacts";
import {
  nullableParamOverrides as collectNullableParamOverrides,
  resultElementNonNullOverrides as collectResultElementNonNullOverrides,
  sameNullableParamOverrides,
  sameResultElementNonNullOverrides,
} from "../query-source-intent";
import { renderRuntimeDescriptors, runtimeDescriptorPath } from "../runtime-descriptor-artifact";
import { scanProject, type QueryCallSite } from "../scan/scanner";
import {
  addFunctionContractDiagnostics,
  executionIntentDiagnostics,
  fatal,
  formatPrepareDiagnostic,
  formatPrepareDiagnosticCounts,
  formatPrepareTotals,
  formatQuerySnippet,
  formatQueryTotals,
  formatSite,
  inferenceDiagnostics,
  planningDiagnostics,
  reportPrepareDiagnostics,
  siteDiagnostic,
  temporalPolicyDiagnostics,
  withOutputHints,
  type PrepareDiagnostic,
} from "./prepare-diagnostics";
import {
  closePrepareSession,
  defaultPrepareConcurrency,
  expandProfileSites,
  openSession,
  prepareOnce,
  siteCacheKey,
  siteProfile,
  siteUsage,
  type PrepareOptions,
} from "./prepare";
import { verifyPrepareArtifacts } from "./prepare-verification";

export async function runPrepare(opts: PrepareOptions): Promise<void> {
  if (opts.verify) {
    const compact = opts.json || !opts.verbose;
    const verification = await verifyPrepareArtifacts(
      opts,
      compact ? () => {} : console.log,
      compact ? () => {} : console.error,
    );
    if (opts.json) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: verification.ok,
        mode: "verify",
        ...verification.result,
        changed: verification.changed,
      }, null, 2));
    } else if (!opts.verbose) {
      reportPrepareDiagnostics(verification.result.diagnostics, opts.warnings);
      if (verification.changed.length > 0) {
        console.error("sqlx-js prepare --verify: generated artifacts are stale:");
        for (const file of verification.changed) console.error(`  ${file}`);
        console.error("Run `sqlx-js prepare` and commit the regenerated artifacts.");
      }
      const message = verification.ok
        ? `verified ${formatPrepareTotals(verification.result)}; `
          + `${formatPrepareDiagnosticCounts(verification.result.diagnostics)}; generated artifacts are current`
        : `verify failed — prepared ${formatPrepareTotals(verification.result)}; `
          + formatPrepareDiagnosticCounts(verification.result.diagnostics);
      (verification.ok ? console.log : console.error)(
        withOutputHints(message, verification.result.diagnostics, opts.warnings),
      );
    }
    if (!verification.ok) process.exitCode = 1;
    return;
  }
  if (opts.check || opts.offline) {
    const mode = opts.offline ? "offline" : "check";
    let userCfg: SqlxJsConfig;
    try {
      userCfg = await loadConfig(opts.root);
    } catch (error) {
      throw fatal("config", error);
    }
    try {
      assertDistinctPrepareGeneratedOutputs({ ...opts, config: userCfg });
    } catch (error) {
      throw fatal("config", error);
    }
    let sites: QueryCallSite[];
    try {
      sites = scanProject(opts.root, userCfg.scan, userCfg.profiles ?? {});
    } catch (error) {
      throw fatal("scan", error);
    }
    if (!opts.json && opts.verbose) console.log(`scanned: found ${sites.length} sql() call site(s)`);
    const cache = new Cache(opts.cacheDir);
    try {
      assertCacheManifest(opts.cacheDir, prepareConfigHash(userCfg));
    } catch (error) {
      throw fatal("cache", error);
    }
    const unique = new Map<string, {
      fp: string;
      profile?: string;
      query: string;
      sites: QueryCallSite[];
    }>();
    for (const s of expandProfileSites(sites)) {
      const fp = siteCacheKey(s);
      const existing = unique.get(fp);
      if (existing) existing.sites.push(s);
      else unique.set(fp, { fp, profile: siteProfile(s), query: s.query, sites: [s] });
    }
    const diagnostics: PrepareDiagnostic[] = [];
    for (const { fp, query, sites: ss } of unique.values()) {
      if (!cache.has(fp)) {
        const site = ss[0]!;
        diagnostics.push({
          severity: "error",
          phase: "cache",
          message: "query is not in the offline cache",
          ...siteDiagnostic(site),
        });
        if (!opts.json && opts.verbose) {
          console.error(`stale: ${formatSite(site)} — query not in cache`);
          console.error(`       query: ${formatQuerySnippet(query)}`);
        }
      }
    }
    if (diagnostics.length > 0) {
      if (opts.json) {
        console.log(JSON.stringify({
          formatVersion: 1,
          ok: false,
          mode,
          sites: sites.length,
          entries: [...unique.keys()].filter((fp) => cache.has(fp)).length,
          failures: diagnostics.length,
          pruned: 0,
          functions: 0,
          enums: 0,
          diagnostics,
        }, null, 2));
      } else if (!opts.verbose) {
        reportPrepareDiagnostics(diagnostics, opts.warnings);
        console.error(
          `${mode} failed — ${formatQueryTotals(
            sites.length,
            [...unique.keys()].filter((fp) => cache.has(fp)).length,
          )}; `
          + withOutputHints(formatPrepareDiagnosticCounts(diagnostics), diagnostics, opts.warnings),
        );
      } else {
        console.error(`\nsqlx-js prepare --${mode}: ${diagnostics.length} stale/missing entries. Run \`sqlx-js prepare\` against a live DB.`);
      }
      process.exitCode = 1;
      return;
    }
    const entries: CacheEntry[] = [];
    let inferenceFailures = 0;
    let functions: FunctionEntry[];
    let enums: EnumCatalogEntry[] = [];
    let enumCount = 0;
    const enumOutput = enumCatalogOutputPath(opts.root, userCfg, opts.enumOutputPath);
    const embeddedOutput = embeddedSqlOutputPath(opts.root, userCfg, opts.sqlFilesOutputPath);
    try {
      for (const u of unique.values()) {
        const entry = cache.read(u.fp);
        if (!entry) continue;
        if (entry.profile !== u.profile) {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "cache entry profile does not match the scanned connection profile; run live `sqlx-js prepare`",
            ...siteDiagnostic(u.sites[0]!),
          });
          inferenceFailures++;
          continue;
        }
        if (!entry.validation) {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "cache entry is missing planner validation metadata; run live `sqlx-js prepare`",
            ...siteDiagnostic(u.sites[0]!),
          });
          inferenceFailures++;
          continue;
        }
        const nullableParamOverrides = collectNullableParamOverrides(u.sites);
        if (!sameNullableParamOverrides(entry.nullableParamOverrides, nullableParamOverrides)) {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "source nullable parameter contract changed; run live `sqlx-js prepare`",
            ...siteDiagnostic(u.sites[0]!),
          });
          inferenceFailures++;
          continue;
        }
        const resultElementNonNullOverrides = collectResultElementNonNullOverrides(u.sites);
        if (!sameResultElementNonNullOverrides(
          entry.resultElementNonNullOverrides,
          resultElementNonNullOverrides,
        )) {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "source result assertion contract changed; run live `sqlx-js prepare`",
            ...siteDiagnostic(u.sites[0]!),
          });
          inferenceFailures++;
          continue;
        }
        const current = { ...entry, ...siteUsage(u.sites) };
        const entryDiagnostics = inferenceDiagnostics(current, u.sites[0]!, opts.strictInference === true);
        const intentDiagnostics = executionIntentDiagnostics(current, u.sites, opts.strictInference === true);
        const temporalDiagnostics = temporalPolicyDiagnostics(current, u.sites, userCfg.temporal);
        diagnostics.push(...entryDiagnostics, ...intentDiagnostics, ...temporalDiagnostics);
        const planIssues = planningDiagnostics(current.validation, u.sites, opts.strictInference === true);
        diagnostics.push(...planIssues);
        if (
          (opts.strictInference && entryDiagnostics.length > 0)
          || intentDiagnostics.some((diagnostic) => diagnostic.severity === "error")
          || temporalDiagnostics.some((diagnostic) => diagnostic.severity === "error")
          || planIssues.some((diagnostic) => diagnostic.severity === "error")
        ) {
          inferenceFailures++;
          continue;
        }
        entries.push(current);
      }
      functions = readFunctionCache(opts.cacheDir);
      if (!functionCacheExists(opts.cacheDir)) {
        diagnostics.push({
          severity: "error",
          phase: "cache",
          message: "function cache is missing",
        });
        inferenceFailures++;
      }
      addFunctionContractDiagnostics(functions, diagnostics);
      if (userCfg.enumCatalog) {
        if (enumCatalogCacheExists(opts.cacheDir)) {
          enums = readEnumCatalogCache(opts.cacheDir);
          enumCount = selectedEnumCatalogCount(enums, userCfg.enumCatalog);
        } else {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "enum catalog cache is missing",
          });
          inferenceFailures++;
        }
      } else if (enumCatalogCacheExists(opts.cacheDir)) {
        diagnostics.push({
          severity: "error",
          phase: "cache",
          message: "enum catalog cache exists but enumCatalog is disabled; run live `sqlx-js prepare`",
        });
        inferenceFailures++;
      }
      if (opts.check && inferenceFailures === 0) {
        const tmp = mkdtempSync(join(tmpdir(), "sqlx-js-check-"));
        const generatedDts = join(tmp, "sqlx-js-env.d.ts");
        try {
          emitDts(
            generatedDts,
            entries,
            functions,
            userCfg.customTypes,
            userCfg.profiles,
            userCfg.temporal,
          );
          if (!existsSync(opts.dtsPath) || readFileSync(opts.dtsPath, "utf8") !== readFileSync(generatedDts, "utf8")) {
            diagnostics.push({
              severity: "error",
              phase: "cache",
              message: "generated declaration is stale or missing",
              file: relative(opts.root, opts.dtsPath).replace(/\\/g, "/"),
            });
            inferenceFailures++;
          }
          const expectedDescriptors = renderRuntimeDescriptors(
            entries,
            prepareConfigHash(userCfg),
            userCfg.profiles,
            userCfg.temporal,
          );
          const descriptorPath = runtimeDescriptorPath(opts.cacheDir);
          if (!existsSync(descriptorPath) || readFileSync(descriptorPath, "utf8") !== expectedDescriptors) {
            diagnostics.push({
              severity: "error",
              phase: "cache",
              message: "generated runtime descriptor is stale or missing",
              file: relative(opts.root, descriptorPath).replace(/\\/g, "/"),
            });
            inferenceFailures++;
          }
          if (enumOutput) {
            const generatedEnums = renderEnumCatalog(enums, userCfg.enumCatalog);
            if (!existsSync(enumOutput) || readFileSync(enumOutput, "utf8") !== generatedEnums) {
              diagnostics.push({
                severity: "error",
                phase: "cache",
                message: "generated enum catalog is stale or missing",
                file: relative(opts.root, enumOutput).replace(/\\/g, "/"),
              });
              inferenceFailures++;
            }
          }
          if (embeddedOutput) {
            const generatedSqlFiles = renderEmbeddedSqlModule(entries);
            if (!existsSync(embeddedOutput) || readFileSync(embeddedOutput, "utf8") !== generatedSqlFiles) {
              diagnostics.push({
                severity: "error",
                phase: "cache",
                message: "generated embedded SQL module is stale or missing",
                file: relative(opts.root, embeddedOutput).replace(/\\/g, "/"),
              });
              inferenceFailures++;
            }
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
      if (inferenceFailures > 0) {
        if (opts.json) {
          console.log(JSON.stringify({
            formatVersion: 1,
            ok: false,
            mode,
            sites: sites.length,
            entries: entries.length,
            failures: inferenceFailures,
            pruned: 0,
            functions: functions.length,
            enums: enumCount,
            diagnostics,
          }, null, 2));
        } else if (!opts.verbose) {
          reportPrepareDiagnostics(diagnostics, opts.warnings);
          console.error(
            `${mode} failed — ${formatQueryTotals(sites.length, entries.length)}; `
            + withOutputHints(formatPrepareDiagnosticCounts(diagnostics), diagnostics, opts.warnings),
          );
        } else {
          for (const diagnostic of diagnostics) {
            if (diagnostic.severity === "warning") {
              console.error(formatPrepareDiagnostic(diagnostic));
              continue;
            }
            const location = diagnostic.file
              ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""} — `
              : "";
            console.error(`${diagnostic.phase} failed: ${location}${diagnostic.message}`);
          }
        }
        process.exitCode = 1;
        return;
      }
      if (opts.offline) {
        publishOfflinePrepareArtifacts({
          cacheDir: opts.cacheDir,
          dtsPath: opts.dtsPath,
          entries,
          functions,
          enumModule: enumOutput
            ? { path: enumOutput, content: renderEnumCatalog(enums, userCfg.enumCatalog) }
            : undefined,
          embeddedSqlModule: embeddedOutput
            ? { path: embeddedOutput, content: renderEmbeddedSqlModule(entries) }
            : undefined,
          configHash: prepareConfigHash(userCfg),
          customTypes: userCfg.customTypes,
          profiles: userCfg.profiles,
          temporal: userCfg.temporal,
        });
      }
    } catch (error) {
      throw fatal("cache", error);
    }
    if (opts.json) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: true,
        mode,
        sites: sites.length,
        entries: entries.length,
        failures: 0,
        pruned: 0,
        functions: functions.length,
        enums: enumCount,
        diagnostics,
      }, null, 2));
    } else if (!opts.verbose) {
      reportPrepareDiagnostics(diagnostics, opts.warnings);
      const suffix = opts.offline ? "generated files regenerated" : "generated artifacts are current";
      console.log(
        `ok — ${formatPrepareTotals({
          sites: sites.length,
          entries: entries.length,
          functions: functions.length,
          enums: enumCount,
        })}; `
        + withOutputHints(`${formatPrepareDiagnosticCounts(diagnostics)}; ${suffix}`, diagnostics, opts.warnings),
      );
    } else {
      for (const diagnostic of diagnostics) {
        console.error(formatPrepareDiagnostic(diagnostic));
      }
      const suffix = opts.offline ? ", generated files regenerated" : ", generated artifacts are current";
      console.log(`ok — ${entries.length} unique queries, ${functions.length} function(s), ${enumCount} enum(s)${suffix}`);
    }
    return;
  }

  const session = await openSession(opts);
  try {
    let focused: import("./prepare-focus").FocusedPrepareSelection | undefined;
    if (opts.focus) {
      try {
        assertCacheManifest(
          opts.cacheDir,
          prepareConfigHash(session.userCfg),
          { allowIncomplete: true },
        );
      } catch (error) {
        throw fatal("cache", error);
      }
      const {
        assertFocusedPrepareCatalogs,
        selectFocusedPrepareInput,
      } = await import("./prepare-focus");
      try {
        assertFocusedPrepareCatalogs(session.userCfg, opts.cacheDir);
      } catch (error) {
        throw fatal("cache", error);
      }
      try {
        focused = selectFocusedPrepareInput(
          opts.root,
          session.userCfg,
          opts.cacheDir,
          opts.focus,
        );
      } catch (error) {
        throw fatal("scan", error);
      }
    }
    const compact = opts.json || !opts.verbose;
    const r = await prepareOnce(
      focused ? { ...opts, prune: false } : opts,
      session,
      compact ? () => {} : console.log,
      compact ? () => {} : console.error,
      defaultPrepareConcurrency(),
      focused?.input,
    );
    if (focused && r.failures === 0) {
      r.diagnostics.push({
        severity: "warning",
        phase: "cache",
        message: "focused prepare artifacts are incomplete; run a full `sqlx-js prepare` before check or release",
      });
    }
    if (opts.json) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: r.failures === 0,
        mode: focused ? "prepare-focused" : "prepare",
        artifactState: focused ? "incomplete" : "complete",
        ...(focused ? {
          projectSites: focused.projectSites,
          selectedSites: focused.selectedSites,
          omittedSites: focused.omittedSites,
          omittedContracts: focused.omittedContracts,
        } : {}),
        ...r,
      }, null, 2));
    } else if (!opts.verbose) {
      reportPrepareDiagnostics(r.diagnostics, opts.warnings);
    }
    if (r.failures > 0) {
      if (!opts.json && !opts.verbose) {
        console.error(
          withOutputHints(
            `prepare failed — ${formatPrepareTotals(r)}; ${formatPrepareDiagnosticCounts(r.diagnostics)}`,
            r.diagnostics,
            opts.warnings,
          ),
        );
      } else if (!opts.json) {
        console.error(`\n${r.failures} query/queries failed to prepare`);
      }
      process.exitCode = 1;
      return;
    }
    if (!opts.json && !opts.verbose) {
      const outputs = prepareGeneratedOutputPaths({ ...opts, config: session.userCfg }).join(", ");
      const message = focused
        ? `focused prepare validated ${focused.selectedSites}/${focused.projectSites} source site(s); `
          + `${focused.omittedContracts} uncached unselected query/profile contract(s) omitted; `
          + `artifacts are incomplete → ${outputs}`
        : `prepared ${formatPrepareTotals(r)}; `
          + `${formatPrepareDiagnosticCounts(r.diagnostics)} → ${outputs}`;
      console.log(withOutputHints(message, r.diagnostics, opts.warnings));
    } else if (!opts.json) {
      const outputs = prepareGeneratedOutputPaths({ ...opts, config: session.userCfg }).join(", ");
      console.log(focused
        ? `\nfocused prepare validated ${focused.selectedSites}/${focused.projectSites} source site(s); `
          + `${focused.omittedContracts} uncached unselected query/profile contract(s) omitted; `
          + `artifacts are incomplete → ${outputs}`
        : `\nprepared ${r.entries} unique query/queries, ${r.functions} function(s), ${r.enums} enum(s) `
          + `→ ${outputs}`);
    }
  } finally {
    await closePrepareSession(session);
  }
}
