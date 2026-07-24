import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "sqlx-js-postgres-compat-"));
const container = `sqlx-js-postgres-compat-${process.pid}-${Date.now()}`;
const image = process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg17";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
  return result.stdout.trim();
}

function openssl(args) {
  run("openssl", args, { cwd: temp });
}

function certificate(name, commonName, usage, extension) {
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${commonName}`,
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
  ]);
  writeFileSync(join(temp, `${name}.ext`), `${extension}\nextendedKeyUsage=${usage}\n`);
  openssl([
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-sha256",
    "-extfile",
    `${name}.ext`,
    "-out",
    `${name}.crt`,
  ]);
  chmodSync(join(temp, `${name}.key`), 0o600);
}

function connectionUrl(port, user, password, mode, certificates = false) {
  const url = new URL("postgresql://localhost/sqlx_js_compat");
  url.port = port;
  url.username = user;
  url.password = password;
  url.searchParams.set("sslmode", mode);
  if (mode === "verify-ca" || mode === "verify-full") {
    url.searchParams.set("sslrootcert", join(temp, "ca.crt"));
  }
  if (certificates) {
    url.searchParams.set("sslcert", join(temp, "client.crt"));
    url.searchParams.set("sslkey", join(temp, "client.key"));
  }
  return url.toString();
}

function waitUntilReady() {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8" });
    const initializationComplete = `${logs.stdout}${logs.stderr}`.includes(
      "PostgreSQL init process complete; ready for start up.",
    );
    const result = spawnSync(
      "docker",
      ["exec", container, "pg_isready", "-U", "postgres", "-d", "sqlx_js_compat"],
      { encoding: "utf8" },
    );
    last = `${result.stdout}${result.stderr}`.trim();
    if (initializationComplete && result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`PostgreSQL compatibility container did not become ready: ${last}`);
}

try {
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=sqlx-js-test-ca",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
  ]);
  certificate(
    "server",
    "localhost",
    "serverAuth",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  );
  certificate("client", "tls_user", "clientAuth", "subjectAltName=DNS:tls_user");

  writeFileSync(join(temp, "010-users.sql"), `
SET password_encryption = 'scram-sha-256';
CREATE ROLE scram_user LOGIN PASSWORD 'scram-secret';
CREATE ROLE clear_user LOGIN PASSWORD 'clear-secret';
SET password_encryption = 'md5';
CREATE ROLE md5_user LOGIN PASSWORD 'md5-secret';
CREATE ROLE tls_user LOGIN;
GRANT CONNECT ON DATABASE sqlx_js_compat TO scram_user, clear_user, md5_user, tls_user;
`);
  writeFileSync(join(temp, "020-pg-hba.sh"), `#!/usr/bin/env bash
set -euo pipefail
cat > "$PGDATA/pg_hba.conf" <<'EOF'
local all all trust
hostssl all tls_user all cert clientcert=verify-full
hostssl all clear_user all password
hostssl all scram_user all scram-sha-256
hostnossl all md5_user all md5
hostnossl all scram_user all scram-sha-256
host all all all reject
EOF
`);

  run("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--user",
    "root",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    "POSTGRES_PASSWORD=postgres",
    "--env",
    "POSTGRES_DB=sqlx_js_compat",
    "--publish",
    "127.0.0.1::5432",
    "--volume",
    `${temp}:/fixture:ro`,
    image,
    "bash",
    "-ceu",
    [
      "install -d -o postgres -g postgres /var/lib/postgresql/certs",
      "&&",
      "install -m 600 -o postgres -g postgres /fixture/server.key /var/lib/postgresql/certs/server.key",
      "&&",
      "install -m 644 -o postgres -g postgres /fixture/server.crt /var/lib/postgresql/certs/server.crt",
      "&&",
      "install -m 644 -o postgres -g postgres /fixture/ca.crt /var/lib/postgresql/certs/ca.crt",
      "&&",
      "install -m 644 /fixture/010-users.sql /docker-entrypoint-initdb.d/010-users.sql",
      "&&",
      "install -m 755 /fixture/020-pg-hba.sh /docker-entrypoint-initdb.d/020-pg-hba.sh",
      "&&",
      "exec docker-entrypoint.sh postgres",
      "-c ssl=on",
      "-c ssl_cert_file=/var/lib/postgresql/certs/server.crt",
      "-c ssl_key_file=/var/lib/postgresql/certs/server.key",
      "-c ssl_ca_file=/var/lib/postgresql/certs/ca.crt",
    ].join(" "),
  ]);
  waitUntilReady();
  const published = run("docker", ["port", container, "5432/tcp"]);
  const port = published.slice(published.lastIndexOf(":") + 1);

  const cases = [
    {
      name: "scram-no-tls",
      user: "scram_user",
      tls: false,
      url: connectionUrl(port, "scram_user", "scram-secret", "disable"),
    },
    {
      name: "scram-tls-require",
      user: "scram_user",
      tls: true,
      url: connectionUrl(port, "scram_user", "scram-secret", "require"),
    },
    {
      name: "md5-no-tls",
      user: "md5_user",
      tls: false,
      url: connectionUrl(port, "md5_user", "md5-secret", "disable"),
    },
    {
      name: "cleartext-tls-verify-full",
      user: "clear_user",
      tls: true,
      url: connectionUrl(port, "clear_user", "clear-secret", "verify-full"),
    },
    {
      name: "client-cert-verify-ca",
      user: "tls_user",
      tls: true,
      clientCertificate: true,
      url: connectionUrl(port, "tls_user", "", "verify-ca", true),
    },
    {
      name: "client-cert-verify-full",
      user: "tls_user",
      tls: true,
      clientCertificate: true,
      url: connectionUrl(port, "tls_user", "", "verify-full", true),
    },
  ];
  const configPath = join(temp, "cases.json");
  writeFileSync(configPath, JSON.stringify(cases));
  const clientScript = join(root, "scripts/postgres-auth-tls-client.mjs");

  process.stdout.write(run("node", [clientScript, configPath]) + "\n");
  process.stdout.write(run("bun", [clientScript, configPath]) + "\n");
  process.stdout.write(run("deno", [
    "run",
    "--allow-net",
    `--allow-read=${root},${temp}`,
    clientScript,
    configPath,
  ]) + "\n");
} catch (error) {
  const logs = spawnSync("docker", ["logs", container], { encoding: "utf8" });
  process.stderr.write(logs.stdout ?? "");
  process.stderr.write(logs.stderr ?? "");
  throw error;
} finally {
  spawnSync("docker", ["rm", "--force", container], { encoding: "utf8" });
  rmSync(temp, { recursive: true, force: true });
}
