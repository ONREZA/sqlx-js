import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlxJsConfig } from "../config";

export type CiStep = {
  name: string;
  args: string[];
  check?: "pgschema-plan";
};

const PLAN_PATH = "{sqlx-js-ci-plan}";

export type CiStepResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  exitCode: number;
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
  dtsPath?: string;
};

export function buildCiSteps(opts: Pick<CiOptions, "config" | "root" | "schemaPath" | "shadowUrl" | "shadowAdminUrl" | "migrationsDir" | "dtsPath">): CiStep[] {
  const root = ["--root", opts.root];
  const shadow = opts.shadowUrl ? ["--shadow-url", opts.shadowUrl] : [];
  const shadowAdmin = opts.shadowAdminUrl ? ["--shadow-admin-url", opts.shadowAdminUrl] : [];
  const migrations = opts.migrationsDir ? ["--migrations", opts.migrationsDir] : [];
  const dts = opts.dtsPath ? ["--dts", opts.dtsPath] : [];
  const steps: CiStep[] = opts.config.schema?.provider === "pgschema"
    ? [
        { name: "pgschema", args: ["db", "check", ...root] },
        {
          name: "pgschema-plan",
          args: ["db", "plan", ...root, "--", "--output-json", PLAN_PATH, "--no-color"],
          check: "pgschema-plan",
        },
        { name: "prepare-live", args: ["prepare", "--verify", "--strict-inference", ...shadow, ...dts, ...root] },
      ]
    : [{
        name: "migrations",
        args: ["migrate", "verify", "--strict-inference", ...shadow, ...shadowAdmin, ...migrations, ...dts, ...root],
      }];
  steps.push({ name: "prepare-offline", args: ["prepare", "--check", "--strict-inference", ...dts, ...root] });
  if (existsSync(opts.schemaPath)) {
    steps.push({ name: "schema", args: ["schema", "check", ...shadow, "--schema", opts.schemaPath, ...migrations, ...root] });
  }
  return steps;
}

export function assertPgschemaPlanClean(path: string): void {
  const plan = JSON.parse(readFileSync(path, "utf8")) as { groups?: unknown };
  if (plan.groups === null) return;
  if (!Array.isArray(plan.groups)) throw new Error("plan JSON does not contain groups as an array or null");
  if (plan.groups.length > 0) throw new Error(`pgschema plan contains ${plan.groups.length} unapplied change group(s)`);
}

export function runCi(opts: CiOptions): void {
  const results: CiStepResult[] = [];
  const temp = mkdtempSync(join(tmpdir(), "sqlx-js-ci-"));
  try {
    for (const step of buildCiSteps(opts)) {
      if (!opts.json) console.log(`ci: ${step.name}`);
      const started = performance.now();
      const planPath = join(temp, "pgschema-plan.json");
      const args = step.args.map((arg) => arg === PLAN_PATH ? planPath : arg);
      const result = spawnSync(opts.executable, [opts.cliPath, ...args], {
        encoding: "utf8",
        env: process.env,
        stdio: opts.json ? ["ignore", "ignore", "pipe"] : "inherit",
        maxBuffer: 4 * 1024 * 1024,
      });
      let exitCode = result.status ?? 1;
      let checkError: string | undefined;
      if (exitCode === 0 && step.check === "pgschema-plan") {
        try {
          assertPgschemaPlanClean(planPath);
        } catch (error) {
          checkError = (error as Error).message.startsWith("pgschema plan contains")
            ? (error as Error).message
            : `cannot verify pgschema plan: ${(error as Error).message}`;
          exitCode = 1;
        }
      }
      if (result.error) {
        checkError = result.error.message;
        exitCode = 1;
      } else if (result.signal) {
        checkError = `terminated by signal ${result.signal}`;
        exitCode = 1;
      }
      if (checkError && !opts.json) console.error(`ci: ${step.name}: ${checkError}`);
      results.push({
        name: step.name,
        ok: exitCode === 0,
        durationMs: Math.round(performance.now() - started),
        exitCode,
        ...(opts.json && exitCode !== 0 && (checkError || result.stderr)
          ? { stderr: [result.stderr?.trim(), checkError].filter(Boolean).join("\n") }
          : {}),
      });
      if (exitCode !== 0) break;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const ok = results.length > 0 && results.every((result) => result.ok);
  if (opts.json) console.log(JSON.stringify({ formatVersion: 1, ok, results }, null, 2));
  else if (ok) console.log(`ci: ok — ${results.length} check(s) passed`);
  if (!ok) process.exitCode = 1;
}
