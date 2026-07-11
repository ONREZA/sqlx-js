import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { SqlxJsConfig } from "../config";

export type CiStep = {
  name: string;
  args: string[];
};

export type CiStepResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

export type CiOptions = {
  executable: string;
  cliPath: string;
  root: string;
  config: SqlxJsConfig;
  schemaPath: string;
  json?: boolean;
  shadowUrl?: string;
  shadowAdminUrl?: string;
  migrationsDir?: string;
};

export function buildCiSteps(opts: Pick<CiOptions, "config" | "root" | "schemaPath" | "shadowUrl" | "shadowAdminUrl" | "migrationsDir">): CiStep[] {
  const root = ["--root", opts.root];
  const shadow = opts.shadowUrl ? ["--shadow-url", opts.shadowUrl] : [];
  const shadowAdmin = opts.shadowAdminUrl ? ["--shadow-admin-url", opts.shadowAdminUrl] : [];
  const migrations = opts.migrationsDir ? ["--migrations", opts.migrationsDir] : [];
  const steps: CiStep[] = opts.config.schema?.provider === "pgschema"
    ? [
        { name: "pgschema", args: ["db", "check", ...root] },
        { name: "prepare-live", args: ["prepare", "--verify", "--strict-inference", ...shadow, ...root] },
      ]
    : [{
        name: "migrations",
        args: ["migrate", "verify", "--strict-inference", ...shadow, ...shadowAdmin, ...migrations, ...root],
      }];
  steps.push({ name: "prepare-offline", args: ["prepare", "--check", "--strict-inference", ...root] });
  if (existsSync(opts.schemaPath)) {
    steps.push({ name: "schema", args: ["schema", "check", ...shadow, "--schema", opts.schemaPath, ...migrations, ...root] });
  }
  return steps;
}

export function runCi(opts: CiOptions): void {
  const results: CiStepResult[] = [];
  for (const step of buildCiSteps(opts)) {
    if (!opts.json) console.log(`ci: ${step.name}`);
    const started = performance.now();
    const result = spawnSync(opts.executable, [opts.cliPath, ...step.args], {
      encoding: "utf8",
      env: process.env,
      stdio: opts.json ? "pipe" : "inherit",
    });
    const exitCode = result.status ?? 1;
    results.push({
      name: step.name,
      ok: exitCode === 0,
      durationMs: Math.round(performance.now() - started),
      exitCode,
      ...(opts.json && exitCode !== 0 && result.stdout ? { stdout: result.stdout.trim() } : {}),
      ...(opts.json && exitCode !== 0 && result.stderr ? { stderr: result.stderr.trim() } : {}),
    });
    if (exitCode !== 0) break;
  }
  const ok = results.length > 0 && results.every((result) => result.ok);
  if (opts.json) console.log(JSON.stringify({ formatVersion: 1, ok, results }, null, 2));
  else if (ok) console.log(`ci: ok — ${results.length} check(s) passed`);
  if (!ok) process.exitCode = 1;
}
