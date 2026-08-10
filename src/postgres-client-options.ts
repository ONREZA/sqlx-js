import { validateTransactionSettings, type DatabaseProfile } from "./config";
import type {
  OnQueryHook,
  OnQueryHookError,
} from "./runtime";
import type { PostgresOptions } from "./pg/driver";
import type { RuntimeTypeCodecs } from "./postgres-codecs";
import type { RuntimeQueryDescriptors } from "./runtime-descriptors";
import { parseDatabaseUrl, type ConnConfig } from "./pg/connection-resolver";

export type CreateClientOptions = PostgresOptions;

export type ClientState = "healthy" | "poisoned" | "recycling" | "failed" | "closing" | "closed";

type QueryLifecycleContext = {
  queryId: string;
  queryName?: string;
  profile?: string;
  role?: string;
  generation: number;
};

export type QueryStartEvent = QueryLifecycleContext & {
  kind: "query-start";
};

export type QueryTimeoutEvent = QueryLifecycleContext & {
  kind: "query-timeout";
  durationMs: number;
  timeoutMs: number;
  phase: "bootstrap" | "execution";
  outcome: "not_sent" | "unknown";
};

export type QueryErrorEvent = QueryLifecycleContext & {
  kind: "query-error";
  durationMs: number;
  phase: "bootstrap" | "execution";
  outcome: "not_sent" | "unknown";
  errorName: string;
  errorCode?: string;
  databaseError?: {
    sqlstate: string;
    severity?: string;
  };
};

export type ClientStateChangeEvent = {
  kind: "state-change";
  profile?: string;
  role?: string;
  from: ClientState;
  to: ClientState;
  generation: number;
  reason?: unknown;
};

export type ClientLifecycleEvent =
  | QueryStartEvent
  | QueryTimeoutEvent
  | QueryErrorEvent
  | ClientStateChangeEvent;

export type ClientSnapshot = {
  generation: number;
  state: ClientState;
  activeOperations: number;
  lastSuccessAt: number | null;
  lastTimeoutAt: number | null;
  recycleCount: number;
};

export type CloseOptions = {
  graceMs?: number;
  forceAfterMs?: number;
};

export type DeadlineOptions = {
  timeoutMs?: number;
};

type ManagedClientOptions = {
  profile?: DatabaseProfile;
  onQuery?: OnQueryHook;
  onQueryHookError?: OnQueryHookError;
  onLifecycle?: (event: ClientLifecycleEvent) => void | Promise<void>;
  onLifecycleHookError?: (error: unknown, event: ClientLifecycleEvent) => void | Promise<void>;
  operationTimeoutMs?: number;
  cancelGraceMs?: number;
  fileRoot?: string;
  reloadSqlFiles?: boolean;
  sqlFiles?: Readonly<Record<string, string>>;
  typeCodecs?: RuntimeTypeCodecs;
};

type ClientExecutionOptions =
  | {
    queryDescriptors: RuntimeQueryDescriptors;
    execution?: never;
  }
  | {
    queryDescriptors?: never;
    execution?: "adaptive";
  };

export type CreateSqlClientOptions =
  CreateClientOptions & ManagedClientOptions & ClientExecutionOptions;

export function normalizeRuntimeDatabaseUrl(url: string): string {
  if (!/^postgres(?:ql)?:\/\//i.test(url)) return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has("schema")) return url;
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

function postgresClientOptions(options: CreateSqlClientOptions): CreateClientOptions {
  const {
    execution: _execution,
    profile: _profile,
    onQuery: _onQuery,
    onQueryHookError: _onQueryHookError,
    onLifecycle: _onLifecycle,
    onLifecycleHookError: _onLifecycleHookError,
    operationTimeoutMs: _operationTimeoutMs,
    cancelGraceMs: _cancelGraceMs,
    fileRoot: _fileRoot,
    reloadSqlFiles: _reloadSqlFiles,
    sqlFiles: _sqlFiles,
    typeCodecs: _typeCodecs,
    queryDescriptors: _queryDescriptors,
    ...clientOptions
  } = options;
  return clientOptions;
}

function postgresOptionTokens(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (/\s/.test(character)) {
      if (token !== "") tokens.push(token);
      token = "";
    } else {
      token += character;
    }
  }
  if (escaped) token += "\\";
  if (token !== "") tokens.push(token);
  return tokens;
}

function roleSetting(value: string | undefined): boolean {
  return value !== undefined && /^(?:"|')?role(?:=|$)/i.test(value.trimStart());
}

function hasRoleStartupOption(value: string): boolean {
  const tokens = postgresOptionTokens(value);
  return tokens.some((token, index) => {
    const lower = token.toLowerCase();
    return lower === "--role"
      || lower.startsWith("--role=")
      || (lower === "-c" && roleSetting(tokens[index + 1]))
      || (lower.startsWith("-c") && roleSetting(token.slice(2)));
  });
}

export function assertProfileConnection(
  profile: Pick<DatabaseProfile, "name" | "role">,
  connection: ConnConfig,
): void {
  const resolvedRole = connection.startupParameters?.role;
  if (resolvedRole !== undefined && resolvedRole !== profile.role) {
    throw new Error(
      `sqlx-js: profile ${profile.name} requires role ${profile.role}, but DATABASE_URL uses role ${resolvedRole}`,
    );
  }
  if (connection.startupOptions && hasRoleStartupOption(connection.startupOptions)) {
    throw new Error(
      `sqlx-js: profile ${profile.name} cannot be combined with a role in resolved PostgreSQL options`,
    );
  }
}

export function validateRuntimeProfile(profile: NonNullable<CreateSqlClientOptions["profile"]>): void {
  if (!profile || typeof profile !== "object") {
    throw new Error("sqlx-js: profile must be a database profile");
  }
  if (typeof profile.name !== "string" || !profile.name.trim()) {
    throw new Error("sqlx-js: profile.name must be a non-empty string");
  }
  if (typeof profile.role !== "string" || !profile.role.trim()) {
    throw new Error(`sqlx-js: profile ${profile.name} must declare a non-empty PostgreSQL role`);
  }
  if (profile.transactionSettings !== undefined) {
    validateTransactionSettings(
      profile.transactionSettings,
      `profile ${profile.name} transactionSettings`,
    );
  }
}

export function profileClientOptions(
  url: string,
  options: CreateSqlClientOptions,
  connection?: ConnConfig,
): CreateClientOptions {
  const clientOptions = postgresClientOptions(options);
  const profile = options.profile;
  if (profile === undefined) return clientOptions;
  validateRuntimeProfile(profile);
  const configuredRole = clientOptions.role;
  if (configuredRole !== undefined && configuredRole !== profile.role) {
    throw new Error(
      `sqlx-js: profile ${profile.name} requires role ${profile.role}, but role is ${String(configuredRole)}`,
    );
  }
  if (typeof clientOptions.startupOptions === "string" && hasRoleStartupOption(clientOptions.startupOptions)) {
    throw new Error(`sqlx-js: profile ${profile.name} cannot be combined with a role in startupOptions`);
  }
  const resolvedConnection = connection ?? parseDatabaseUrl(url);
  assertProfileConnection(profile, resolvedConnection);
  return {
    ...clientOptions,
    role: profile.role,
  };
}
