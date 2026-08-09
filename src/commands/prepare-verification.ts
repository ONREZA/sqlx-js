import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { compareArtifacts } from "../artifacts";
import { embeddedSqlOutputPath } from "../embedded-sql";
import { enumCatalogOutputPath } from "../enum-catalog";
import { prepareGeneratedOutputPaths } from "../prepare-artifacts";
import { fatal } from "./prepare-diagnostics";
import {
  closePrepareSession,
  openSession,
  prepareOnce,
  type PrepareOptions,
  type PrepareResult,
  type PrepareSession,
} from "./prepare";

export async function writePrepareArtifacts(
  opts: PrepareOptions,
  log: (msg: string) => void = console.log,
  err: (msg: string) => void = console.error,
): Promise<boolean> {
  const session = await openSession(opts);
  try {
    const result = await prepareOnce(opts, session, log, err);
    if (result.failures > 0) {
      err(`\n${result.failures} query/queries failed to prepare`);
      return false;
    }
    const outputs = prepareGeneratedOutputPaths({ ...opts, config: session.userCfg }).join(", ");
    log(
      `\nprepared ${result.entries} unique query/queries, ${result.functions} function(s), ${result.enums} enum(s) `
      + `→ ${outputs}`,
    );
    return true;
  } finally {
    await closePrepareSession(session);
  }
}

export type VerifyPrepareMessages = {
  command: string;
  regenerateCommand: string;
};

export async function verifyPrepareArtifacts(
  opts: PrepareOptions,
  log: (msg: string) => void = console.log,
  err: (msg: string) => void = console.error,
  messages: VerifyPrepareMessages = {
    command: "sqlx-js prepare --verify",
    regenerateCommand: "sqlx-js prepare",
  },
): Promise<{ ok: boolean; result: PrepareResult; changed: string[] }> {
  const tmp = mkdtempSync(join(tmpdir(), "sqlx-js-verify-"));
  const cacheDir = join(tmp, "cache");
  const dtsPath = join(tmp, "sqlx-js-env.d.ts");
  const verifyOpts: PrepareOptions = {
    ...opts,
    cacheDir,
    dtsPath,
    check: false,
    verify: false,
    prune: true,
  };
  let session: PrepareSession | undefined;
  try {
    session = await openSession(opts);
    const expectedEnumOutput = enumCatalogOutputPath(opts.root, session.userCfg, opts.enumOutputPath);
    const generatedEnumOutput = expectedEnumOutput ? join(tmp, "sqlx-js-enums.ts") : undefined;
    verifyOpts.enumOutputPath = generatedEnumOutput;
    const expectedEmbeddedSqlOutput = embeddedSqlOutputPath(
      opts.root,
      session.userCfg,
      opts.sqlFilesOutputPath,
    );
    const generatedEmbeddedSqlOutput = expectedEmbeddedSqlOutput
      ? join(tmp, "sqlx-js-sql-files.ts")
      : undefined;
    verifyOpts.sqlFilesOutputPath = generatedEmbeddedSqlOutput;
    const result = await prepareOnce(verifyOpts, session, log, err);
    if (result.failures > 0) {
      err(`\n${result.failures} query/queries failed to prepare`);
      return { ok: false, result, changed: [] };
    }
    let comparison: ReturnType<typeof compareArtifacts>;
    try {
      comparison = compareArtifacts(
        {
          cacheDir: opts.cacheDir,
          dtsPath: opts.dtsPath,
          enumOutputPath: expectedEnumOutput,
          enumArtifactName: expectedEnumOutput
            ? relative(opts.root, expectedEnumOutput).replace(/\\/g, "/")
            : undefined,
          embeddedSqlOutputPath: expectedEmbeddedSqlOutput,
          embeddedSqlArtifactName: expectedEmbeddedSqlOutput
            ? relative(opts.root, expectedEmbeddedSqlOutput).replace(/\\/g, "/")
            : undefined,
        },
        {
          cacheDir,
          dtsPath,
          enumOutputPath: generatedEnumOutput,
          enumArtifactName: expectedEnumOutput
            ? relative(opts.root, expectedEnumOutput).replace(/\\/g, "/")
            : undefined,
          embeddedSqlOutputPath: generatedEmbeddedSqlOutput,
          embeddedSqlArtifactName: expectedEmbeddedSqlOutput
            ? relative(opts.root, expectedEmbeddedSqlOutput).replace(/\\/g, "/")
            : undefined,
        },
      );
    } catch (error) {
      throw fatal("verify", error);
    }
    if (!comparison.ok) {
      err(`${messages.command}: generated artifacts are stale:`);
      for (const file of comparison.changed) err(`  ${file}`);
      err(`Run \`${messages.regenerateCommand}\` and commit the regenerated artifacts.`);
      return { ok: false, result, changed: comparison.changed };
    }
    log(
      `verified ${result.entries} query/queries, ${result.functions} function(s), and ${result.enums} enum(s); `
      + "generated artifacts are current",
    );
    return { ok: true, result, changed: [] };
  } finally {
    if (session) await closePrepareSession(session);
    rmSync(tmp, { recursive: true, force: true });
  }
}
