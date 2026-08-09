import { existsSync } from "node:fs";
import type { ShadowDatabaseOptions } from "./shadow";
import { withWorkflowShadowDatabase } from "./shadow";

export type SchemaWorkflowOptions = ShadowDatabaseOptions & {
  root: string;
  cacheDir: string;
  dtsPath: string;
  snapshotPath: string;
  prune?: boolean;
  strictInference?: boolean;
};

export type SchemaWorkflowAdapter = {
  validate: () => void | Promise<void>;
  materialize: (databaseUrl: string) => void | Promise<void>;
};

export async function runSchemaWorkflow(
  mode: "dev" | "verify",
  opts: SchemaWorkflowOptions,
  adapter: SchemaWorkflowAdapter,
): Promise<boolean> {
  await adapter.validate();
  return await withWorkflowShadowDatabase(opts, async (shadowDatabaseUrl) => {
    await adapter.materialize(shadowDatabaseUrl);
    if (mode === "verify" && existsSync(opts.snapshotPath)) {
      const { runSchemaCheck } = await import("./schema");
      await runSchemaCheck({ databaseUrl: shadowDatabaseUrl, snapshotPath: opts.snapshotPath });
    }
    const prepareOptions = {
      root: opts.root,
      databaseUrl: shadowDatabaseUrl,
      cacheDir: opts.cacheDir,
      dtsPath: opts.dtsPath,
      check: false,
      prune: mode === "dev" ? opts.prune : true,
      strictInference: opts.strictInference,
    };
    if (mode === "dev") {
      const { writePrepareArtifacts } = await import("./prepare-verification");
      return await writePrepareArtifacts(prepareOptions);
    }
    const { verifyPrepareArtifacts } = await import("./prepare-verification");
    const verification = await verifyPrepareArtifacts(
      { ...prepareOptions, verify: true },
      console.log,
      console.error,
      { command: "sqlx-js verify", regenerateCommand: "sqlx-js dev" },
    );
    return verification.ok;
  });
}
