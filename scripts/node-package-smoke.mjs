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
  writeFileSync(join(temp, "types.ts"), `
    import {
      defineQuery,
      type JsonParameter,
      type JsonValue,
      type QueryParams,
      type QueryRegistry,
      type QueryWireParams,
      type SqlExecutor,
    } from "@onreza/sqlx-js";

    const statement = "SELECT $payload::jsonb AS payload";
    declare module "@onreza/sqlx-js" {
      interface KnownQueries {
        "SELECT $payload::jsonb AS payload": {
          params: { payload: JsonParameter<unknown> };
          row: { payload: JsonValue };
        };
      }
    }

    interface Payload { id: string; nested: { count: number } }
    const query = defineQuery.one("smoke.typedEcho", statement).mapParams(
      (payload: Payload, { json }) => ({ payload: json(payload) }),
    );
    type Input = QueryParams<typeof query>;
    type Wire = QueryWireParams<typeof query>;
    type Entry = { params: Wire; row: { payload: JsonValue } };
    type Registry = QueryRegistry & { queries: Record<typeof statement, Entry> };
    declare const executor: SqlExecutor<Registry>;
    declare const input: Input;
    const result: Promise<{ payload: JsonValue }> = query.run(executor, input);
    void result;
  `);
  writeFileSync(join(temp, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2023",
      types: ["node"],
      typeRoots: [join(root, "node_modules/@types")],
    },
    files: ["types.ts"],
  }));
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(temp, "tsconfig.json")], temp);
  writeFileSync(join(temp, "app.mjs"), `
    import assert from "node:assert/strict";
    import { createSqlClient, defineQuery, queryId, TransactionTimeoutError } from "@onreza/sqlx-js";

    let db;
    try {
      const events = [];
      const runtimeUrl = new URL(process.env.DATABASE_URL);
      runtimeUrl.searchParams.set("schema", "public");
      db = createSqlClient(runtimeUrl.toString(), {
        max: 1,
        onQuery: (event) => events.push(event),
        sqlFiles: { "queries/embedded.sql": "SELECT 9::int4 AS value" },
      });
      const { sql } = db;
      await db.ready({ timeoutMs: 5000 });
      await db.ping({ timeoutMs: 5000 });
      assert.equal(db.snapshot().state, "healthy");
      const row = await sql.one(
        "SELECT 42::int4 AS value, $1::jsonb AS payload, $2::int4[] AS numbers",
        sql.json({ ok: true }),
        sql.array([1, 2, 3]),
      );
      assert.deepEqual(row, { value: 42, payload: { ok: true }, numbers: [1, 2, 3] });

      const transactionValue = await sql.transaction({ timeoutMs: 5000 }, async (tx) => {
        await tx.execute("CREATE TEMP TABLE node_package_smoke (value int NOT NULL)");
        await tx.execute("INSERT INTO node_package_smoke (value) VALUES ($1)", 7);
        return await tx.one("SELECT value FROM node_package_smoke");
      });
      assert.deepEqual(transactionValue, { value: 7 });

      await assert.rejects(
        sql.transaction({ timeoutMs: 50 }, tx => tx("SELECT pg_sleep(1)")),
        error => error instanceof TransactionTimeoutError && error.timeoutMs === 50,
      );
      assert.deepEqual(await sql.one("SELECT 1::int AS value"), { value: 1 });

      const answerQuery = defineQuery.one("smoke.answer", "SELECT 43::int4 AS value");
      assert.deepEqual(await answerQuery.run(sql), { value: 43 });
      const echoQuery = defineQuery.one("smoke.echo", "SELECT $payload::jsonb AS payload").mapParams(
        (payload, { json }) => ({ payload: json(payload) }),
      );
      assert.deepEqual(await echoQuery.run(sql, { ok: true }), { payload: { ok: true } });
      assert.deepEqual(await sql.file.one("queries/embedded.sql"), { value: 9 });
      assert.equal(answerQuery.queryId, queryId(answerQuery.query));
      assert.ok(events.some((event) => event.queryId === answerQuery.queryId && event.queryName === "smoke.answer"));
      assert.ok(events.some((event) => event.queryId === echoQuery.queryId && event.queryName === "smoke.echo"));
    } finally {
      await db?.close();
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
  if (!existsSync(join(packageRoot, "docs/upgrades/0.15.0.md"))) {
    throw new Error("packed package is missing the current upgrade guide");
  }
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
