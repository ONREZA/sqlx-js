import { validateTransactionSettings, type DatabaseProfile } from "./config";
import type {
  OnQueryHook,
  OnQueryHookError,
} from "./runtime";
import type { PostgresOptions } from "./pg/driver";
import type { RuntimeTypeCodecs } from "./postgres-codecs";
import type { RuntimeQueryDescriptors } from "./runtime-descriptors";

export type CreateClientOptions = PostgresOptions;

export type ClientState = "healthy" | "poisoned" | "recycling" | "failed" | "closing" | "closed";

export type QueryStartEvent = {
  queryId: string;
  queryName?: string;
  profile?: string;
  role?: string;
  generation: number;
};

export type QueryTimeoutEvent = QueryStartEvent & {
  durationMs: number;
  timeoutMs: number;
  phase: "bootstrap" | "execution";
  outcome: "not_sent" | "unknown";
};

export type QueryErrorEvent = QueryStartEvent & {
  durationMs: number;
  phase: "bootstrap" | "execution";
  outcome: "not_sent" | "unknown";
  errorName: string;
  errorCode?: string;
  databaseError?: {
    sqlstate: string;
    message: string;
    severity?: string;
  };
};

export type ClientStateChangeEvent = {
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
  onQueryStart?: (event: QueryStartEvent) => void | Promise<void>;
  onQueryTimeout?: (event: QueryTimeoutEvent) => void | Promise<void>;
  onQueryError?: (event: QueryErrorEvent) => void | Promise<void>;
  onClientStateChange?: (event: ClientStateChangeEvent) => void | Promise<void>;
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
    onQueryStart: _onQueryStart,
    onQueryTimeout: _onQueryTimeout,
    onQueryError: _onQueryError,
    onClientStateChange: _onClientStateChange,
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

function hasRoleStartupOption(value: string): boolean {
  return /(?:^|\s)-c\s*(?:"|')?role(?:\s*=|\s+)/i.test(value);
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
  if (/^postgres(?:ql)?:\/\//i.test(url)) {
    const parsed = new URL(url);
    const urlRole = parsed.searchParams.get("role");
    if (urlRole !== null && urlRole !== profile.role) {
      throw new Error(`sqlx-js: profile ${profile.name} requires role ${profile.role}, but DATABASE_URL uses role ${urlRole}`);
    }
    const urlOptions = parsed.searchParams.get("options");
    if (urlOptions && hasRoleStartupOption(urlOptions)) {
      throw new Error(`sqlx-js: profile ${profile.name} cannot be combined with a role in DATABASE_URL options`);
    }
  }
  return {
    ...clientOptions,
    role: profile.role,
  };
}
