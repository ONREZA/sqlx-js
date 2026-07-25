import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scenario = process.env.SQLX_JS_BENCHMARK_SCENARIO ?? "simple-concurrent";
const driver = process.env.SQLX_JS_BENCHMARK_DRIVER ?? "sqlx-js-managed";
const timestamp = new Date().toISOString().replaceAll(":", "-");
const profileDir = resolve(
  process.env.SQLX_JS_BENCHMARK_PROFILE_DIR
    ?? `.profiles/postgres-runtime/${timestamp}-${scenario}-${driver}`,
);
const benchmark = fileURLToPath(
  new URL("./postgres-runtime-benchmark.mjs", import.meta.url),
);

mkdirSync(profileDir, { recursive: true });

const env = {
  ...process.env,
  SQLX_JS_BENCHMARK_SCENARIO: scenario,
  SQLX_JS_BENCHMARK_DRIVER: driver,
  SQLX_JS_BENCHMARK_WARMUP_MS:
    process.env.SQLX_JS_BENCHMARK_WARMUP_MS ?? "2000",
  SQLX_JS_BENCHMARK_DURATION_MS:
    process.env.SQLX_JS_BENCHMARK_DURATION_MS ?? "10000",
  SQLX_JS_BENCHMARK_ROUNDS:
    process.env.SQLX_JS_BENCHMARK_ROUNDS ?? "1",
};

writeFileSync(
  resolve(profileDir, "metadata.json"),
  `${JSON.stringify({
    scenario,
    driver,
    warmupMs: Number(env.SQLX_JS_BENCHMARK_WARMUP_MS),
    durationMs: Number(env.SQLX_JS_BENCHMARK_DURATION_MS),
    rounds: Number(env.SQLX_JS_BENCHMARK_ROUNDS),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  }, null, 2)}\n`,
);

const child = spawn(process.execPath, [
  "--cpu-prof",
  `--cpu-prof-dir=${profileDir}`,
  "--cpu-prof-name=runtime.cpuprofile",
  "--cpu-prof-interval=1000",
  "--heap-prof",
  `--heap-prof-dir=${profileDir}`,
  "--heap-prof-name=runtime.heapprofile",
  "--heap-prof-interval=32768",
  benchmark,
], {
  env,
  stdio: "inherit",
});

const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`runtime profile terminated by ${signal}`));
      return;
    }
    resolveExit(code ?? 1);
  });
});

if (exitCode !== 0) process.exitCode = exitCode;
else process.stdout.write(`Runtime profiles written to ${profileDir}\n`);
