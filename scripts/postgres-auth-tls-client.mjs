import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import { createClient } from "../dist/src/index.js";

const configPath = process.argv[2];
if (!configPath) throw new Error("PostgreSQL auth/TLS client requires a config path");

const cases = JSON.parse(readFileSync(configPath, "utf8"));
const runtime = globalThis.Deno
  ? `deno-${globalThis.Deno.version.deno}`
  : process.versions.bun
    ? `bun-${process.versions.bun}`
    : `node-${process.versions.node}`;

for (const testCase of cases) {
  process.stdout.write(`${runtime} ${testCase.name} start\n`);
  const client = createClient(testCase.url, {
    max: 1,
    applicationName: `sqlx-js-compat-${runtime}-${testCase.name}`,
  });
  try {
    const rows = await client.unsafe(`
      SELECT
        current_user AS current_user,
        ssl,
        client_dn
      FROM pg_catalog.pg_stat_ssl
      WHERE pid = pg_catalog.pg_backend_pid()
    `);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].current_user, testCase.user);
    assert.equal(rows[0].ssl, testCase.tls);
    if (testCase.clientCertificate) {
      assert.match(rows[0].client_dn, /CN=tls_user/);
    }
    process.stdout.write(`${runtime} ${testCase.name} ok\n`);
  } finally {
    await client.end();
  }
}
