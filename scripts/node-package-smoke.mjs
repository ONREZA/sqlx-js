import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = join(root, ".env");
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) throw new Error("node package smoke requires DATABASE_URL");
const temp = mkdtempSync(join(tmpdir(), "sqlx-js-node-package-"));

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.error) throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
  return result.stdout;
}

try {
  const pack = JSON.parse(run("npm", ["pack", root, "--json", "--pack-destination", temp]));
  const filename = pack[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return a package filename");
  writeFileSync(join(temp, "package.json"), JSON.stringify({ type: "module", private: true }));
  run("npm", ["install", join(temp, filename), "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund"], temp);
  if (existsSync(join(temp, "node_modules/typescript"))) {
    throw new Error("packed runtime unexpectedly installed the omitted TypeScript peer");
  }
  writeFileSync(join(temp, "app.mjs"), `
    import assert from "node:assert/strict";
    import { close, createClient, setClient, sql } from "@onreza/sqlx-js";

    try {
      setClient(createClient(process.env.DATABASE_URL, { max: 1 }));
      const row = await sql.one(
        "SELECT 42::int4 AS value, $1::jsonb AS payload, $2::int4[] AS numbers",
        sql.json({ ok: true }),
        sql.array([1, 2, 3]),
      );
      assert.deepEqual(row, { value: 42, payload: { ok: true }, numbers: [1, 2, 3] });

      const transactionValue = await sql.transaction(async (tx) => {
        await tx.execute("CREATE TEMP TABLE node_package_smoke (value int NOT NULL)");
        await tx.execute("INSERT INTO node_package_smoke (value) VALUES ($1)", 7);
        return await tx.one("SELECT value FROM node_package_smoke");
      });
      assert.deepEqual(transactionValue, { value: 7 });
    } finally {
      await close();
    }
    console.log("node packed runtime ok");
  `);
  process.stdout.write(run("node", ["app.mjs"], temp));
  const packageJson = JSON.parse(readFileSync(join(temp, "node_modules/@onreza/sqlx-js/package.json"), "utf8"));
  if (packageJson.version === undefined) throw new Error("packed package metadata is missing version");
  if (packageJson.bin?.["sqlx-js"] !== "dist/bin/sqlx-js.js") throw new Error("packed package metadata is missing the sqlx-js bin");
  if (packageJson.bin?.["sqlx-js-diagnostics"] !== "dist/bin/sqlx-js-diagnostics.js") {
    throw new Error("packed package metadata is missing the sqlx-js-diagnostics bin");
  }
  const packageRoot = join(temp, "node_modules/@onreza/sqlx-js");
  const cliPath = join(packageRoot, packageJson.bin["sqlx-js"]);
  const cliVersion = run("node", [cliPath, "--version"], temp).trim();
  if (cliVersion !== packageJson.version) throw new Error(`packed CLI version ${cliVersion} does not match ${packageJson.version}`);
  const missingTypeScript = spawnSync("node", [cliPath, "prepare", "--check", "--root", temp], {
    cwd: temp,
    encoding: "utf8",
    env: process.env,
  });
  if (missingTypeScript.status !== 2 || !missingTypeScript.stderr.includes("TypeScript is required for source scanning")) {
    throw new Error("packed prepare does not report the missing optional TypeScript peer");
  }
  const migrationCheck = JSON.parse(run("node", [cliPath, "migrate", "check", "--root", temp, "--json"], temp));
  if (migrationCheck.ok !== true) throw new Error("packed offline migration check failed without the TypeScript peer");
  const diagnosticsHelp = run("node", [join(packageRoot, packageJson.bin["sqlx-js-diagnostics"]), "--help"], temp);
  if (!diagnosticsHelp.includes("usage: sqlx-js-diagnostics")) throw new Error("packed diagnostics CLI help is unavailable");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
