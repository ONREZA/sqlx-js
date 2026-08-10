import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDatabaseUrl,
  postgresConnectionEnvironment,
  replaceDatabaseInUrl,
  resolveConnectionPassword,
  resolveConnectionPasswordAsync,
} from "../src/pg/connection-resolver";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "sqlx-js-connection-resolver-"));
  temporaryPaths.push(path);
  return path;
}

describe("connection resolver", () => {
  test("uses URL values before environment fallbacks", () => {
    const config = parseDatabaseUrl(
      "postgresql://url_user:url_password@db.internal:5440/url_db?application_name=url-app&sslmode=verify-full",
      {
        env: {
          PGHOST: "environment-host",
          PGPORT: "5555",
          PGUSER: "environment-user",
          PGPASSWORD: "environment-password",
          PGDATABASE: "environment-db",
          PGAPPNAME: "environment-app",
          PGSSLMODE: "disable",
        },
      },
    );

    expect(config).toMatchObject({
      host: "db.internal",
      port: 5440,
      user: "url_user",
      password: "url_password",
      passwordSource: "url",
      database: "url_db",
      applicationName: "url-app",
      sslmode: "verify-full",
    });
  });

  test("fills omitted URL values from PostgreSQL environment settings", () => {
    const config = parseDatabaseUrl("postgresql:///", {
      env: {
        PGHOST: "db.internal",
        PGHOSTADDR: "127.0.0.1",
        PGPORT: "5544",
        PGUSER: "app",
        PGDATABASE: "app_db",
        PGPASSFILE: "/run/secrets/pgpass",
        PGOPTIONS: "-c search_path=app,public",
        PGCONNECT_TIMEOUT: "7",
        PGSSLROOTCERT: "/run/secrets/root.crt",
      },
    });

    expect(config).toMatchObject({
      host: "db.internal",
      hostaddr: "127.0.0.1",
      port: 5544,
      user: "app",
      database: "app_db",
      passfile: "/run/secrets/pgpass",
      startupOptions: "-c search_path=app,public",
      connectTimeoutMs: 7000,
      sslRootCert: "/run/secrets/root.crt",
    });
  });

  test("uses URI query keywords after authority values like libpq", () => {
    const config = parseDatabaseUrl(
      "postgresql://authority_user:authority_password@authority.internal:5433/authority_db"
        + "?host=query.internal&port=5544&user=query_user&password=query_password&dbname=query_db",
      { env: {} },
    );

    expect(config).toMatchObject({
      host: "query.internal",
      port: 5544,
      user: "query_user",
      password: "query_password",
      passwordSource: "url",
      database: "query_db",
    });
  });

  test("replaces query-style database names for shadow connections", () => {
    const rewritten = replaceDatabaseInUrl(
      "postgresql://app@db.internal/?dbname=application&sslmode=require",
      "sqlx_js_shadow",
    );

    expect(parseDatabaseUrl(rewritten, { env: {} })).toMatchObject({
      database: "sqlx_js_shadow",
      sslmode: "require",
    });
    expect(new URL(rewritten).searchParams.has("dbname")).toBe(false);
  });

  test("keeps environment values literal instead of URL-decoding them", () => {
    const config = parseDatabaseUrl("postgresql:///", {
      env: {
        PGHOST: "db%zone.internal",
        PGUSER: "app%reader",
        PGDATABASE: "db%name",
      },
    });

    expect(config).toMatchObject({
      host: "db%zone.internal",
      user: "app%reader",
      database: "db%name",
    });
  });

  test("does not require access to unused environment variables", () => {
    const deniedEnvironment = new Proxy({}, {
      get() {
        throw new Error("environment access denied");
      },
    });

    expect(parseDatabaseUrl(
      "postgresql://app:secret@db.internal:5544/app?sslmode=require",
      { env: deniedEnvironment },
    )).toMatchObject({
      host: "db.internal",
      port: 5544,
      user: "app",
      password: "secret",
      database: "app",
      sslmode: "require",
    });
  });

  test("uses the platform default password-file path", () => {
    const root = temporaryDirectory();
    const passfile = join(root, ".pgpass");
    writeFileSync(passfile, "db.internal:5432:app:app:from-default\n", { mode: 0o600 });
    const config = parseDatabaseUrl("postgresql://app@db.internal/app", { env: {} });

    expect(resolveConnectionPassword(config, { env: { HOME: root }, platform: "linux" }))
      .toBe("from-default");
  });

  test("uses APPDATA for the Windows password-file path without guessing from HOME", () => {
    const root = temporaryDirectory();
    const appData = join(root, "appdata");
    const passfileDirectory = join(appData, "postgresql");
    mkdirSync(passfileDirectory, { recursive: true });
    writeFileSync(
      join(passfileDirectory, "pgpass.conf"),
      "db.internal:5432:app:app:from-windows-default\n",
    );
    writeFileSync(join(root, ".pgpass"), "*:*:*:*:wrong-home\n", { mode: 0o600 });
    const config = parseDatabaseUrl("postgresql://app@db.internal/app", { env: {} });

    expect(resolveConnectionPassword(config, {
      env: { APPDATA: appData, HOME: root },
      platform: "win32",
    })).toBe("from-windows-default");
    expect(resolveConnectionPassword(config, {
      env: { HOME: root },
      platform: "win32",
    })).toBe("");
  });

  test("uses hostaddr for network routing without changing TLS or pgpass identity", () => {
    const config = parseDatabaseUrl(
      "postgresql://app@db.internal/app?hostaddr=127.0.0.1&sslmode=verify-full",
      { env: {} },
    );
    expect(config.hostaddr).toBe("127.0.0.1");
    expect(config.host).toBe("db.internal");
  });

  test("treats the system CA store as verify-full only", () => {
    expect(parseDatabaseUrl(
      "postgresql://app@db.internal/app?sslrootcert=system",
      { env: {} },
    )).toMatchObject({ sslmode: "verify-full", sslRootCert: "system" });
    expect(() => parseDatabaseUrl(
      "postgresql://app@db.internal/app?sslmode=require&sslrootcert=system",
      { env: {} },
    )).toThrow("sslrootcert=system requires sslmode=verify-full");
  });

  test("maps the libpq ssl=true URI alias without allowing a weaker mode", () => {
    expect(parseDatabaseUrl(
      "postgresql://app@db.internal/app?ssl=true",
      { env: {} },
    ).sslmode).toBe("require");
    expect(parseDatabaseUrl(
      "postgresql://app@db.internal/app?ssl=true&sslmode=verify-full",
      { env: {} },
    ).sslmode).toBe("verify-full");
    expect(() => parseDatabaseUrl(
      "postgresql://app@db.internal/app?ssl=true&sslmode=prefer",
      { env: {} },
    )).toThrow("ssl=true conflicts with sslmode=prefer");
    expect(() => parseDatabaseUrl(
      "postgresql://app@db.internal/app?ssl=false",
      { env: {} },
    )).toThrow("only supports ssl=true");
  });

  test("rejects non-numeric hostaddr and multi-host inputs", () => {
    expect(() => parseDatabaseUrl("postgresql://app@db/app?hostaddr=tunnel", { env: {} }))
      .toThrow("hostaddr must be a numeric");
    expect(() => parseDatabaseUrl("postgresql:///app", { env: { PGHOST: "one,two" } }))
      .toThrow("supports one PostgreSQL host");
    expect(() => parseDatabaseUrl("postgresql:///app", { env: { PGHOST: "/run/postgresql" } }))
      .toThrow("does not support PostgreSQL Unix-domain sockets");
  });

  test("rejects known libpq environment policies it cannot preserve", () => {
    expect(() => parseDatabaseUrl(
      "postgresql://app@db.internal/app",
      { env: { PGCHANNELBINDING: "require" } },
    )).toThrow("PGCHANNELBINDING is not supported");
    expect(() => parseDatabaseUrl(
      "postgresql://app@db.internal/app",
      { env: { PGTARGETSESSIONATTRS: "read-write" } },
    )).toThrow("PGTARGETSESSIONATTRS is not supported");
    expect(() => parseDatabaseUrl(
      "postgresql://app@db.internal/app",
      { env: { PGSERVICE: "production" } },
    )).toThrow("PGSERVICE is not supported");
    expect(() => parseDatabaseUrl(
      "postgresql://app@db.internal/app?channel_binding=require",
      { env: {} },
    )).toThrow("connection parameter channel_binding is not supported");
  });

  test("uses the first matching pgpass entry with escaping and wildcards", () => {
    const root = temporaryDirectory();
    const passfile = join(root, "pgpass");
    writeFileSync(
      passfile,
      [
        "other:5432:app:app:wrong",
        "db.internal:5432:app:app:secret\\:with\\\\escapes",
        "*:*:*:*:fallback",
      ].join("\n"),
      { mode: 0o600 },
    );
    const config = parseDatabaseUrl(
      `postgresql://app@db.internal/app?hostaddr=127.0.0.1&passfile=${encodeURIComponent(passfile)}`,
      { env: {} },
    );

    expect(resolveConnectionPassword(config, { env: {} })).toBe("secret:with\\escapes");
  });

  test("resolves password files asynchronously and honors cancellation", async () => {
    const root = temporaryDirectory();
    const passfile = join(root, "pgpass");
    writeFileSync(passfile, "db.internal:5432:app:app:async-secret\n", { mode: 0o600 });
    const config = parseDatabaseUrl(
      `postgresql://app@db.internal/app?passfile=${encodeURIComponent(passfile)}`,
      { env: {} },
    );

    expect(await resolveConnectionPasswordAsync(config, { env: {} })).toBe("async-secret");
    const controller = new AbortController();
    const reason = new Error("deadline reached");
    controller.abort(reason);
    await expect(resolveConnectionPasswordAsync(config, {
      env: {},
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  test("keeps an explicit password ahead of pgpass", () => {
    const root = temporaryDirectory();
    const passfile = join(root, "pgpass");
    writeFileSync(passfile, "*:*:*:*:from-file\n", { mode: 0o600 });
    const config = parseDatabaseUrl(
      `postgresql://app:from-url@db.internal/app?passfile=${encodeURIComponent(passfile)}`,
      { env: {} },
    );

    expect(resolveConnectionPassword(config, { env: {} })).toBe("from-url");
  });

  test("lets an explicit empty runtime password suppress password-file lookup", () => {
    const root = temporaryDirectory();
    const passfile = join(root, "pgpass");
    writeFileSync(passfile, "*:*:*:*:from-file\n", { mode: 0o600 });
    const config = parseDatabaseUrl(
      `postgresql://app@db.internal/app?passfile=${encodeURIComponent(passfile)}`,
      { env: {} },
    );
    config.passwordSource = "option";

    expect(resolveConnectionPassword(config, { env: {} })).toBe("");
  });

  test("rejects a password file accessible by group or world", () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const passfile = join(root, "pgpass");
    writeFileSync(passfile, "*:*:*:*:secret\n", { mode: 0o600 });
    chmodSync(passfile, 0o644);
    const config = parseDatabaseUrl(
      `postgresql://app@db.internal/app?passfile=${encodeURIComponent(passfile)}`,
      { env: {} },
    );

    expect(() => resolveConnectionPassword(config, { env: {} }))
      .toThrow("must not grant group or world access");
  });

  test("renders the same resolved identity for libpq subprocesses", () => {
    const config = parseDatabaseUrl(
      "postgresql://app@db.internal:5544/app?hostaddr=127.0.0.1&passfile=%2Frun%2Fsecrets%2Fpgpass&sslmode=verify-full&role=app_reader",
      { env: {} },
    );
    const env = postgresConnectionEnvironment(config, {
      DATABASE_URL: "postgresql://app:secret@wrong.invalid/wrong",
      PGCHANNELBINDING: "require",
      PGSERVICE: "ambient-service",
      PGTARGETSESSIONATTRS: "read-write",
      PGSCHEMA_PLAN_HOST: "keep-for-provider",
    });

    expect(env).toMatchObject({
      PGHOST: "db.internal",
      PGHOSTADDR: "127.0.0.1",
      PGPORT: "5544",
      PGUSER: "app",
      PGDATABASE: "app",
      PGPASSFILE: "/run/secrets/pgpass",
      PGSSLMODE: "verify-full",
      PGOPTIONS: "-c role=app_reader",
      PGCONNECT_TIMEOUT: "15",
      PGSCHEMA_PLAN_HOST: "keep-for-provider",
    });
    expect(env).not.toHaveProperty("PGCHANNELBINDING");
    expect(env).not.toHaveProperty("PGSERVICE");
    expect(env).not.toHaveProperty("PGTARGETSESSIONATTRS");
    expect(env).not.toHaveProperty("DATABASE_URL");
  });
});
