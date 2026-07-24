import { spawnSync } from "node:child_process";

export type CiStep = {
  name: string;
  args: string[];
};

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
  json?: boolean;
  shadowUrl?: string;
  shadowAdminUrl?: string;
  migrationsDir?: string;
  dtsPath?: string;
};

export function buildCiSteps(
  opts: Pick<CiOptions, "root" | "shadowUrl" | "shadowAdminUrl" | "migrationsDir" | "dtsPath">,
): CiStep[] {
  const root = ["--root", opts.root];
  const shadow = opts.shadowUrl ? ["--shadow-url", opts.shadowUrl] : [];
  const shadowAdmin = opts.shadowAdminUrl ? ["--shadow-admin-url", opts.shadowAdminUrl] : [];
  const migrations = opts.migrationsDir ? ["--migrations", opts.migrationsDir] : [];
  const dts = opts.dtsPath ? ["--dts", opts.dtsPath] : [];
  return [
    {
      name: "verify",
      args: [
        "verify",
        "--strict-inference",
        ...shadow,
        ...shadowAdmin,
        ...migrations,
        ...dts,
        ...root,
      ],
    },
    {
      name: "prepare-offline",
      args: ["prepare", "--check", "--strict-inference", ...dts, ...root],
    },
  ];
}

export function runCi(opts: CiOptions): void {
  const results: CiStepResult[] = [];
  for (const step of buildCiSteps(opts)) {
    if (!opts.json) console.log(`ci: ${step.name}`);
    const started = performance.now();
    const result = spawnSync(opts.executable, [opts.cliPath, ...step.args], {
      encoding: "utf8",
      env: process.env,
      stdio: opts.json ? ["ignore", "ignore", "pipe"] : "inherit",
      maxBuffer: 4 * 1024 * 1024,
    });
    let exitCode = result.status ?? 1;
    let checkError: string | undefined;
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
  const ok = results.length > 0 && results.every((result) => result.ok);
  if (opts.json) console.log(JSON.stringify({ formatVersion: 1, ok, results }, null, 2));
  else if (ok) console.log(`ci: ok — ${results.length} check(s) passed`);
  if (!ok) process.exitCode = 1;
}
