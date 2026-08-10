import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const SSL_MODES = ["disable", "prefer", "require", "verify-ca", "verify-full"] as const;
export type SslMode = (typeof SSL_MODES)[number];
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export type PgNotice = {
  message: string;
  severity?: string;
  code?: string;
  detail?: string;
  hint?: string;
};

export type ConnectionCredentialSource = "url" | "environment" | "option";

export type ConnConfig = {
  host: string;
  hostaddr?: string;
  port: number;
  user: string;
  password: string;
  passwordSource?: ConnectionCredentialSource;
  passfile?: string;
  database: string;
  sslmode?: SslMode;
  applicationName?: string;
  startupOptions?: string;
  connectTimeoutMs?: number;
  keepAliveMs?: number;
  statementTimeoutMs?: number;
  sslRootCert?: string;
  sslCert?: string;
  sslKey?: string;
  startupParameters?: Readonly<Record<string, string>>;
  onNotice?: (notice: PgNotice) => void | Promise<void>;
};

export type ConnectionEnvironment = Readonly<Record<string, string | undefined>>;

export type ResolveDatabaseUrlOptions = {
  env?: ConnectionEnvironment;
};

export function replaceDatabaseInUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  parsed.searchParams.delete("dbname");
  return parsed.toString();
}

function environmentValue(
  env: ConnectionEnvironment,
  name: string,
): string | undefined {
  try {
    return value(env[name]);
  } catch {
    return undefined;
  }
}

function value(raw: string | null | undefined): string | undefined {
  return raw === null || raw === undefined || raw === "" ? undefined : raw;
}

function decoded(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : decodeURIComponent(raw);
}

function normalizedHost(raw: string | undefined): string | undefined {
  const host = value(raw);
  return host?.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function singleHost(raw: string | undefined, name: string): string | undefined {
  const host = normalizedHost(raw);
  if (host?.includes(",")) {
    throw new Error(`sqlx-js: ${name} supports one PostgreSQL host, got ${host}`);
  }
  if (host?.startsWith("/")) {
    throw new Error(`sqlx-js: ${name} does not support PostgreSQL Unix-domain sockets`);
  }
  return host;
}

function port(raw: string | undefined): number {
  if (raw === undefined) return 5432;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`sqlx-js: PostgreSQL port must be an integer from 1 to 65535, got ${raw}`);
  }
  return parsed;
}

function sslMode(raw: string | undefined): SslMode | undefined {
  if (raw === undefined) return undefined;
  if (!(SSL_MODES as readonly string[]).includes(raw)) {
    throw new Error(`unsupported sslmode: ${raw}`);
  }
  return raw as SslMode;
}

function positiveSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  const milliseconds = parsed * 1000;
  return Number.isSafeInteger(parsed)
    && parsed > 0
    && milliseconds <= 2_147_483_647
    ? milliseconds
    : undefined;
}

function nonNegativeMilliseconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseDatabaseUrl(
  url: string,
  options: ResolveDatabaseUrlOptions = {},
): ConnConfig {
  const env = options.env ?? process.env;
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
    throw new Error(`unsupported scheme: ${parsedUrl.protocol}`);
  }
  for (const name of UNSUPPORTED_LIBPQ_CONNECTION_ENVIRONMENT) {
    if (environmentValue(env, name) !== undefined) {
      throw new Error(`sqlx-js: ${name} is not supported by the unified connection resolver`);
    }
  }

  const params = parsedUrl.searchParams;
  const sslAlias = params.get("ssl");
  if (sslAlias !== null && sslAlias !== "true") {
    throw new Error(`sqlx-js: PostgreSQL connection parameter ssl only supports ssl=true, got ${sslAlias}`);
  }
  const explicitSslMode = value(params.get("sslmode"));
  if (
    sslAlias === "true"
    && explicitSslMode !== undefined
    && explicitSslMode !== "require"
    && explicitSslMode !== "verify-ca"
    && explicitSslMode !== "verify-full"
  ) {
    throw new Error(`sqlx-js: ssl=true conflicts with sslmode=${explicitSslMode}`);
  }
  for (const name of UNSUPPORTED_LIBPQ_CONNECTION_PARAMETERS) {
    if (params.has(name)) {
      throw new Error(`sqlx-js: PostgreSQL connection parameter ${name} is not supported`);
    }
  }
  const authorityHost = singleHost(decoded(value(parsedUrl.hostname)), "DATABASE_URL");
  const configuredHost = singleHost(value(params.get("host")), "host")
    ?? authorityHost
    ?? singleHost(environmentValue(env, "PGHOST"), "PGHOST");
  const hostaddr = singleHost(
    value(params.get("hostaddr")) ?? environmentValue(env, "PGHOSTADDR"),
    "hostaddr",
  );
  if (hostaddr !== undefined && isIP(hostaddr) === 0) {
    throw new Error(`sqlx-js: hostaddr must be a numeric IPv4 or IPv6 address, got ${hostaddr}`);
  }
  const host = configuredHost ?? hostaddr ?? "localhost";
  const user = value(params.get("user"))
    ?? decoded(value(parsedUrl.username))
    ?? environmentValue(env, "PGUSER")
    ?? "postgres";
  const urlPassword = value(params.get("password")) ?? decoded(value(parsedUrl.password));
  const environmentPassword = environmentValue(env, "PGPASSWORD");
  const password = urlPassword ?? environmentPassword ?? "";
  const database = value(params.get("dbname"))
    ?? decoded(value(parsedUrl.pathname.replace(/^\//, "")))
    ?? environmentValue(env, "PGDATABASE")
    ?? user;
  const sslRootCert = value(params.get("sslrootcert"))
    ?? environmentValue(env, "PGSSLROOTCERT");
  let resolvedSslMode = sslMode(
    explicitSslMode
      ?? (sslAlias === "true" ? "require" : undefined)
      ?? environmentValue(env, "PGSSLMODE"),
  );
  if (sslRootCert === "system") {
    if (resolvedSslMode === undefined) resolvedSslMode = "verify-full";
    else if (resolvedSslMode !== "verify-full") {
      throw new Error("sqlx-js: sslrootcert=system requires sslmode=verify-full");
    }
  }
  const passfile = value(params.get("passfile")) ?? environmentValue(env, "PGPASSFILE");

  const cfg: ConnConfig = {
    host,
    ...(hostaddr === undefined ? {} : { hostaddr }),
    port: port(
      value(params.get("port")) ?? value(parsedUrl.port) ?? environmentValue(env, "PGPORT"),
    ),
    user,
    password,
    ...(urlPassword !== undefined
      ? { passwordSource: "url" as const }
      : environmentPassword !== undefined
        ? { passwordSource: "environment" as const }
        : {}),
    ...(passfile === undefined ? {} : { passfile }),
    database,
  };
  if (resolvedSslMode !== undefined) cfg.sslmode = resolvedSslMode;
  const applicationName = value(params.get("application_name"))
    ?? environmentValue(env, "PGAPPNAME");
  if (applicationName !== undefined) cfg.applicationName = applicationName;
  const startupOptions = value(params.get("options")) ?? environmentValue(env, "PGOPTIONS");
  if (startupOptions !== undefined) cfg.startupOptions = startupOptions;
  const role = value(params.get("role"));
  if (role !== undefined) cfg.startupParameters = { role };
  const connectTimeoutMs = positiveSeconds(
    value(params.get("connect_timeout")) ?? environmentValue(env, "PGCONNECT_TIMEOUT"),
  );
  if (connectTimeoutMs !== undefined) cfg.connectTimeoutMs = connectTimeoutMs;
  const statementTimeoutMs = nonNegativeMilliseconds(value(params.get("statement_timeout")));
  if (statementTimeoutMs !== undefined) cfg.statementTimeoutMs = statementTimeoutMs;
  if (sslRootCert !== undefined) cfg.sslRootCert = sslRootCert;
  const sslCert = value(params.get("sslcert")) ?? environmentValue(env, "PGSSLCERT");
  if (sslCert !== undefined) cfg.sslCert = sslCert;
  const sslKey = value(params.get("sslkey")) ?? environmentValue(env, "PGSSLKEY");
  if (sslKey !== undefined) cfg.sslKey = sslKey;
  return cfg;
}

function systemHomeDirectory(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

function defaultPassfile(
  env: ConnectionEnvironment,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "win32") {
    const appData = environmentValue(env, "APPDATA");
    return appData === undefined ? undefined : join(appData, "postgresql", "pgpass.conf");
  }
  const home = environmentValue(env, "HOME") ?? systemHomeDirectory();
  if (home === undefined) return undefined;
  return join(home, ".pgpass");
}

function pgpassFields(line: string): string[] | undefined {
  if (line === "" || line.startsWith("#")) return undefined;
  const fields: string[] = [];
  let field = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      field += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ":") {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (escaped) field += "\\";
  fields.push(field);
  return fields.length === 5 ? fields : undefined;
}

function matchesPgpass(pattern: string, actual: string): boolean {
  return pattern === "*" || pattern === actual;
}

function directPassword(config: ConnConfig): string | undefined {
  return config.passwordSource !== undefined || config.password !== ""
    ? config.password
    : undefined;
}

function passfilePath(
  config: ConnConfig,
  env: ConnectionEnvironment,
  platform: NodeJS.Platform,
): string | undefined {
  return config.passfile ?? defaultPassfile(env, platform);
}

function assertPassfilePermissions(path: string, mode: number, platform: NodeJS.Platform): void {
  if (platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error(
      `sqlx-js: PostgreSQL password file ${path} must not grant group or world access`,
    );
  }
}

function passwordFromPassfile(config: ConnConfig, contents: string): string {
  const expected = [config.host, String(config.port), config.database, config.user];
  for (const line of contents.split(/\r?\n/)) {
    const fields = pgpassFields(line);
    if (!fields) continue;
    if (fields.slice(0, 4).every((pattern, index) => matchesPgpass(pattern!, expected[index]!))) {
      return fields[4]!;
    }
  }
  return "";
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("sqlx-js: PostgreSQL connection aborted");
}

export function resolveConnectionPassword(
  config: ConnConfig,
  options: {
    env?: ConnectionEnvironment;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const configured = directPassword(config);
  if (configured !== undefined) return configured;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = passfilePath(config, env, platform);
  if (path === undefined) return "";
  let contents: string;
  try {
    assertPassfilePermissions(path, statSync(path).mode, platform);
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }

  return passwordFromPassfile(config, contents);
}

export async function resolveConnectionPasswordAsync(
  config: ConnConfig,
  options: {
    env?: ConnectionEnvironment;
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const configured = directPassword(config);
  if (configured !== undefined) return configured;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = passfilePath(config, env, platform);
  if (path === undefined) return "";
  if (options.signal?.aborted) throw abortReason(options.signal);
  try {
    const [info, contents] = await Promise.all([
      stat(path),
      readFile(path, {
        encoding: "utf8",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    ]);
    assertPassfilePermissions(path, info.mode, platform);
    return passwordFromPassfile(config, contents);
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function effectiveConnectTimeoutMs(config: ConnConfig): number {
  return config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
}

const UNSUPPORTED_LIBPQ_CONNECTION_ENVIRONMENT = [
  "PGSSLNEGOTIATION",
  "PGREQUIREAUTH",
  "PGCHANNELBINDING",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGREQUIRESSL",
  "PGSSLCOMPRESSION",
  "PGSSLCERTMODE",
  "PGSSLCRL",
  "PGSSLCRLDIR",
  "PGSSLSNI",
  "PGREQUIREPEER",
  "PGSSLMINPROTOCOLVERSION",
  "PGSSLMAXPROTOCOLVERSION",
  "PGGSSENCMODE",
  "PGKRBSRVNAME",
  "PGGSSLIB",
  "PGGSSDELEGATION",
  "PGCLIENTENCODING",
  "PGTARGETSESSIONATTRS",
  "PGLOADBALANCEHOSTS",
  "PGMINPROTOCOLVERSION",
  "PGMAXPROTOCOLVERSION",
] as const;

const UNSUPPORTED_LIBPQ_CONNECTION_PARAMETERS = [
  "sslnegotiation",
  "require_auth",
  "channel_binding",
  "service",
  "fallback_application_name",
  "keepalives",
  "keepalives_idle",
  "keepalives_interval",
  "keepalives_count",
  "tcp_user_timeout",
  "replication",
  "requiressl",
  "sslcompression",
  "sslcertmode",
  "sslkeylogfile",
  "sslpassword",
  "sslcrl",
  "sslcrldir",
  "sslsni",
  "requirepeer",
  "ssl_min_protocol_version",
  "ssl_max_protocol_version",
  "gssencmode",
  "krbsrvname",
  "gsslib",
  "gssdelegation",
  "client_encoding",
  "target_session_attrs",
  "load_balance_hosts",
  "min_protocol_version",
  "max_protocol_version",
  "oauth_issuer",
  "oauth_client_id",
  "oauth_client_secret",
  "oauth_scope",
] as const;

const LIBPQ_ENVIRONMENT_TO_CLEAR = [
  ...UNSUPPORTED_LIBPQ_CONNECTION_ENVIRONMENT,
  "PGDATESTYLE",
  "PGTZ",
  "PGGEQO",
] as const;

function pgOption(value: string): string {
  return value.replace(/[\\\s]/g, (character) => `\\${character}`);
}

function postgresStartupOptions(config: ConnConfig): string | undefined {
  const parameters = Object.entries(config.startupParameters ?? {})
    .map(([name, value]) => `-c ${pgOption(name)}=${pgOption(value)}`);
  const options = [config.startupOptions, ...parameters].filter((value) => value !== undefined);
  return options.length === 0 ? undefined : options.join(" ");
}

function setOrDelete(
  env: NodeJS.ProcessEnv,
  name: string,
  resolved: string | undefined,
): void {
  if (resolved === undefined || resolved === "") delete env[name];
  else env[name] = resolved;
}

export function postgresConnectionEnvironment(
  config: ConnConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.DATABASE_URL;
  for (const name of LIBPQ_ENVIRONMENT_TO_CLEAR) delete env[name];
  env.PGHOST = config.host;
  setOrDelete(env, "PGHOSTADDR", config.hostaddr);
  env.PGPORT = String(config.port);
  env.PGUSER = config.user;
  env.PGDATABASE = config.database;
  setOrDelete(env, "PGPASSWORD", config.password || undefined);
  setOrDelete(env, "PGPASSFILE", config.passfile);
  setOrDelete(env, "PGSSLMODE", config.sslmode);
  setOrDelete(env, "PGSSLROOTCERT", config.sslRootCert);
  setOrDelete(env, "PGSSLCERT", config.sslCert);
  setOrDelete(env, "PGSSLKEY", config.sslKey);
  setOrDelete(env, "PGAPPNAME", config.applicationName);
  setOrDelete(env, "PGOPTIONS", postgresStartupOptions(config));
  setOrDelete(
    env,
    "PGCONNECT_TIMEOUT",
    String(Math.ceil(effectiveConnectTimeoutMs(config) / 1000)),
  );
  return env;
}
