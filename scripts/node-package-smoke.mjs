import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = join(root, ".env");
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) throw new Error("node package smoke requires DATABASE_URL");
const temp = mkdtempSync(join(tmpdir(), "sqlx-js-node-package-"));
const descriptorVersions = JSON.parse(
  readFileSync(join(root, "example/.sqlx-js/runtime-descriptors.json"), "utf8"),
);

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
      createSqlClient,
      EXTENDED_JSON_PROTOCOL_VERSION,
      type JsonValue,
      type PgTimestamptz,
      type PgNotice,
      type PostgresType,
      type QueryParams,
      type QueryRegistry,
      type QueryWireParams,
      type SqlxJson,
      type SqlExecutor,
    } from "@onreza/sqlx-js";

    const statement = "SELECT $payload::jsonb AS payload";
    interface Payload { id: string; nested: { count: number } }
    const query = defineQuery.one("smoke.typedEcho", statement).mapParams(
      (payload: Payload, { json }) => ({ payload: json(payload) }),
    );
    type Entry = {
      params: { payload: SqlxJson<unknown> };
      row: { payload: SqlxJson<JsonValue> };
    };
    type Registry = QueryRegistry & {
      queries: Record<typeof statement, Entry>;
      fileQueries: {};
      jsonProtocol: typeof EXTENDED_JSON_PROTOCOL_VERSION;
    };
    type Input = QueryParams<typeof query, Registry>;
    type Wire = QueryWireParams<typeof query, Registry>;
    declare const executor: SqlExecutor<Registry>;
    declare const input: Input;
    declare const wire: Wire;
    const result: Promise<{ payload: SqlxJson<JsonValue> }> = query.run(executor, input);
    const boundedExecutor: SqlExecutor<Registry> = executor
      .with({ signal: new AbortController().signal })
      .with({ timeoutMs: 1_000 });
    const codec = {
      to: 20,
      from: 20,
      parse: BigInt,
      serialize: String,
    } satisfies PostgresType<bigint>;
    const notice: PgNotice = { message: "smoke", code: "00000" };
    const temporalStatement = "SELECT $1::timestamptz AS value";
    type NativeRegistry = QueryRegistry & {
      queries: Record<typeof temporalStatement, {
        params: [PgTimestamptz<typeof Temporal>];
        row: { value: PgTimestamptz<typeof Temporal> };
      }>;
      fileQueries: {};
      jsonProtocol: typeof EXTENDED_JSON_PROTOCOL_VERSION;
      temporalApi: typeof Temporal;
    };
    declare const nativeDescriptors: import("@onreza/sqlx-js").RuntimeQueryDescriptors;
    const nativeClient = createSqlClient<NativeRegistry>(undefined, {
      queryDescriptors: nativeDescriptors,
      temporalApi: Temporal,
    });
    const nativeResult: Promise<{ value: Temporal.Instant }[]> = nativeClient.sql(
      temporalStatement,
      Temporal.Instant.from("2026-01-01T00:00:00Z"),
    );
    void codec;
    void notice;
    void wire;
    void boundedExecutor;
    void result;
    void nativeResult;
  `);
  writeFileSync(join(temp, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2025",
      lib: ["ES2025", "ESNext.Temporal"],
      types: ["node"],
      typeRoots: [join(root, "node_modules/@types")],
    },
    files: ["types.ts"],
  }));
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(temp, "tsconfig.json")], temp);
  run("npm", [
    "install",
    "temporal-polyfill@1.0.3",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
  ], temp);
  writeFileSync(join(temp, "app.mjs"), `
    import assert from "node:assert/strict";
    import { Temporal } from "temporal-polyfill";
    import {
      createSqlClient,
      defineQuery,
      JsonNumber,
      queryId,
      SqlxJson,
      TransactionTimeoutError,
    } from "@onreza/sqlx-js";

    let db;
    try {
      const events = [];
      const runtimeUrl = new URL(process.env.DATABASE_URL);
      runtimeUrl.searchParams.set("schema", "public");
      const descriptorQuery = "SELECT $1::int4 AS descriptor_value";
      db = createSqlClient(runtimeUrl.toString(), {
        max: 1,
        keepAliveMs: 0,
        temporalApi: Temporal,
        onQuery: (event) => events.push(event),
        sqlFiles: { "queries/embedded.sql": "SELECT 9::int4 AS value" },
        queryDescriptors: {
          formatVersion: ${descriptorVersions.formatVersion},
          cacheFormat: ${descriptorVersions.cacheFormat},
          generatorRevision: ${descriptorVersions.generatorRevision},
          jsonProtocol: ${descriptorVersions.jsonProtocol},
          configHash: "node-package-smoke",
          temporal: ${JSON.stringify(descriptorVersions.temporal)},
          types: {},
          queries: {
            [queryId(descriptorQuery)]: { params: [23] },
          },
          profiles: {},
        },
      });
      const { sql } = db;
      await db.ready({ timeoutMs: 5000 });
      const requestSql = sql.with({ signal: new AbortController().signal });
      assert.deepEqual(
        await requestSql.with({ timeoutMs: 5000 }).one(descriptorQuery, 42),
        { descriptor_value: 42 },
      );
      await db.ping({ timeoutMs: 5000 });
      assert.equal(db.snapshot().state, "healthy");
      const bytes = new Uint8Array([0x00, 0x5c, 0x7f, 0xff]);
      const row = await sql.one(
        \`SELECT
           42::int4 AS value,
           $1::jsonb AS payload,
           $2::int4[] AS numbers,
           $3::bytea AS bytes,
           9007199254740993::int8 AS bigint,
           '[0:2]={-2,NULL,3}'::int2[] AS bounded,
           ARRAY[[-1,2],[3,-4]]::int4[][] AS matrix,
           ARRAY[0::oid, 4294967295::oid, NULL]::oid[] AS oids\`,
        sql.json({
          ok: true,
          id: 9_007_199_254_740_993n,
          exact: JsonNumber.from("12345678901234567890.125"),
          at: Temporal.Instant.from("2026-08-04T10:15:30.123456789Z"),
        }),
        sql.array([1, 2, 3]),
        bytes,
      );
      assert.ok(row.payload instanceof SqlxJson);
      assert.deepEqual(row.payload.value, {
        ok: true,
        id: 9_007_199_254_740_993n,
        exact: JsonNumber.from("12345678901234567890.125"),
        at: Temporal.Instant.from("2026-08-04T10:15:30.123456789Z"),
      });
      assert.deepEqual({ ...row, payload: undefined }, {
        value: 42,
        payload: undefined,
        numbers: [1, 2, 3],
        bytes,
        bigint: 9007199254740993n,
        bounded: [-2, null, 3],
        matrix: [[-1, 2], [3, -4]],
        oids: [0, 4294967295, null],
      });
      await sql.execute("SET bytea_output=escape");
      assert.deepEqual(
        await sql.one("SELECT decode('005c7fff', 'hex') AS bytes"),
        { bytes },
      );

      const transactionValue = await sql.transaction({ timeoutMs: 5000 }, async (tx) => {
        const requestTx = tx.with({ timeoutMs: 5000 });
        await requestTx.execute("CREATE TEMP TABLE node_package_smoke (value int NOT NULL)");
        await requestTx.execute("INSERT INTO node_package_smoke (value) VALUES ($1)", 7);
        return await requestTx.one("SELECT value FROM node_package_smoke");
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
      assert.deepEqual((await echoQuery.run(sql, { ok: true })).payload.value, { ok: true });
      assert.deepEqual(await sql.file.one("queries/embedded.sql"), { value: 9 });
      assert.equal(answerQuery.queryId, queryId(answerQuery.query));
      assert.ok(events.some((event) => event.queryId === answerQuery.queryId && event.queryName === "smoke.answer"));
      assert.ok(events.some((event) => event.queryId === echoQuery.queryId && event.queryName === "smoke.echo"));
    } finally {
      await db?.close();
    }
    console.log("packed runtime ok");
  `);
  process.stdout.write(`node ${run("node", ["app.mjs"], temp)}`);
  process.stdout.write(`bun ${run("bun", ["app.mjs"], temp)}`);
  writeFileSync(join(temp, "idle-exit.mjs"), `
    import { Temporal } from "temporal-polyfill";
    import { createClient } from "@onreza/sqlx-js";

    const client = createClient(process.env.DATABASE_URL, { max: 1, temporalApi: Temporal });
    await client.unsafe("SELECT 1");
    console.log("idle pool exit ok");
  `);
  const idleExit = spawnSync("node", ["idle-exit.mjs"], {
    cwd: temp,
    encoding: "utf8",
    env: process.env,
    timeout: 5_000,
  });
  if (idleExit.error || idleExit.status !== 0) {
    throw new Error(`idle Node process did not exit naturally: ${idleExit.error?.message ?? idleExit.stderr}`);
  }
  process.stdout.write(`node ${idleExit.stdout}`);
  const bunIdleExit = spawnSync("bun", ["idle-exit.mjs"], {
    cwd: temp,
    encoding: "utf8",
    env: process.env,
    timeout: 5_000,
  });
  if (bunIdleExit.error || bunIdleExit.status !== 0) {
    throw new Error(`idle Bun process did not exit naturally: ${bunIdleExit.error?.message ?? bunIdleExit.stderr}`);
  }
  process.stdout.write(`bun ${bunIdleExit.stdout}`);
  const packageJson = JSON.parse(readFileSync(join(temp, "node_modules/@onreza/sqlx-js/package.json"), "utf8"));
  if (packageJson.version === undefined) throw new Error("packed package metadata is missing version");
  if (packageJson.bin?.["sqlx-js"] !== "dist/bin/sqlx-js.js") throw new Error("packed package metadata is missing the sqlx-js bin");
  if (packageJson.bin?.["sqlx-js-diagnostics"] !== "dist/bin/sqlx-js-diagnostics.js") {
    throw new Error("packed package metadata is missing the sqlx-js-diagnostics bin");
  }
  const packageRoot = join(temp, "node_modules/@onreza/sqlx-js");
  if (!existsSync(join(packageRoot, "docs/upgrades/0.20.0.md"))) {
    throw new Error("packed package is missing the current upgrade guide");
  }
  const cliPath = join(packageRoot, packageJson.bin["sqlx-js"]);
  const cliVersion = run("node", [cliPath, "--version"], temp).trim();
  if (cliVersion !== packageJson.version) throw new Error(`packed CLI version ${cliVersion} does not match ${packageJson.version}`);
  const extensionlessConfigRoot = join(temp, "extensionless-config");
  mkdirSync(extensionlessConfigRoot);
  writeFileSync(join(extensionlessConfigRoot, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(extensionlessConfigRoot, "sqlx-js.config.ts"),
    'import { scan } from "./scan";\nexport default { scan };\n',
  );
  writeFileSync(
    join(extensionlessConfigRoot, "scan.ts"),
    'export const scan = { include: ["src/**/*.ts"] };\n',
  );
  const nodeConfigFailure = spawnSync(
    "node",
    [cliPath, "pgschema", "plan", "--root", extensionlessConfigRoot],
    { cwd: temp, encoding: "utf8", env: process.env },
  );
  if (
    nodeConfigFailure.status !== 2
    || !nodeConfigFailure.stderr.includes(
      'Import it with its file extension, for example "./scan.ts"',
    )
    || !nodeConfigFailure.stderr.includes("bun --bun sqlx-js")
  ) {
    throw new Error(
      "packed Node CLI does not explain extensionless TypeScript config imports: "
      + `status=${nodeConfigFailure.status} stdout=${JSON.stringify(nodeConfigFailure.stdout)} `
      + `stderr=${JSON.stringify(nodeConfigFailure.stderr)}`,
    );
  }
  const bunConfig = spawnSync(
    "bun",
    [cliPath, "pgschema", "plan", "--root", extensionlessConfigRoot],
    { cwd: temp, encoding: "utf8", env: process.env },
  );
  if (
    bunConfig.status !== 2
    || !bunConfig.stderr.includes('set schema.provider = "pgschema"')
  ) {
    throw new Error(
      "packed Bun CLI did not load the extensionless TypeScript config: "
      + `status=${bunConfig.status} stdout=${JSON.stringify(bunConfig.stdout)} `
      + `stderr=${JSON.stringify(bunConfig.stderr)}`,
    );
  }
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
