import {
  createPostgresSession,
  type PostgresOptions,
  type PostgresSession,
  type PostgresSessionOptions,
} from "./postgres-runtime";
import {
  advisoryLockControl,
  CHECK_ADVISORY_LOCK_SQL,
  formatAdvisoryLockKey,
  type PostgresAdvisoryLockControl,
  type PostgresAdvisoryLockInt4Key,
  type PostgresAdvisoryLockKey,
} from "./postgres-advisory-lock-key";

export type { PostgresAdvisoryLockInt4Key, PostgresAdvisoryLockKey } from "./postgres-advisory-lock-key";

const MAX_TIMEOUT_MS = 2_147_483_647;

export type PostgresAdvisoryLockOptions = Omit<PostgresSessionOptions, "types"> & {
  readonly operationTimeoutMs?: number;
};

export class PostgresAdvisoryLockLostError extends Error {
  readonly key: PostgresAdvisoryLockKey;

  constructor(key: PostgresAdvisoryLockKey, options?: ErrorOptions) {
    super(
      `sqlx-js: PostgreSQL advisory lock ${formatAdvisoryLockKey(key)} was lost`,
      options,
    );
    this.name = "PostgresAdvisoryLockLostError";
    this.key = key;
  }
}

export interface PostgresAdvisoryLockSession<
  Key extends PostgresAdvisoryLockKey = PostgresAdvisoryLockKey,
> extends AsyncDisposable {
  readonly key: Key;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

type AcquireRow = {
  backend_pid: number;
  acquired: boolean;
};

type CheckRow = {
  backend_pid: number;
  held: boolean;
};

type ReleaseRow = {
  backend_pid: number;
  released: boolean;
};

type ValidatedLockOptions = {
  readonly operationTimeoutMs?: number;
  readonly sessionOptions: PostgresSessionOptions;
};

function validateLockOptions(options: PostgresAdvisoryLockOptions): ValidatedLockOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("sqlx-js: advisory lock options must be an object");
  }
  const snapshot = { ...options };
  const poolOptions = snapshot as PostgresOptions;
  for (const name of ["max", "idleTimeoutMs", "maxLifetimeMs"] as const) {
    if (poolOptions[name] !== undefined) {
      throw new TypeError(`sqlx-js: advisory lock sessions own ${name}; do not configure it`);
    }
  }
  if (poolOptions.types !== undefined) {
    throw new TypeError("sqlx-js: advisory lock sessions use fixed control-query codecs");
  }
  const { operationTimeoutMs, ...sessionOptions } = snapshot;
  if (
    operationTimeoutMs !== undefined
    && (
      !Number.isSafeInteger(operationTimeoutMs)
      || operationTimeoutMs < 1
      || operationTimeoutMs > MAX_TIMEOUT_MS
    )
  ) {
    throw new TypeError(
      `sqlx-js: advisory lock operationTimeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}, `
        + `got ${String(operationTimeoutMs)}`,
    );
  }
  return { operationTimeoutMs, sessionOptions };
}

async function runControlQuery<Row extends Record<string, unknown>>(
  client: PostgresSession,
  sql: string,
  params: unknown[],
  operation: string,
  timeoutMs: number | undefined,
): Promise<Row[]> {
  const query = client.unsafe<Row>(sql, params);
  if (timeoutMs === undefined) return await query;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void client.end().catch(() => {});
          reject(new Error(
            `sqlx-js: PostgreSQL advisory lock ${operation} timed out after ${timeoutMs}ms`,
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class HeldPostgresAdvisoryLock implements PostgresAdvisoryLockSession {
  readonly #client: PostgresSession;
  readonly #control: PostgresAdvisoryLockControl;
  readonly #backendPid: number;
  readonly #operationTimeoutMs: number | undefined;
  #state: "held" | "releasing" | "released" | "lost" = "held";
  #closePromise?: Promise<void>;
  #releasePromise?: Promise<void>;

  constructor(
    client: PostgresSession,
    control: PostgresAdvisoryLockControl,
    backendPid: number,
    operationTimeoutMs: number | undefined,
  ) {
    this.#client = client;
    this.#control = control;
    this.#backendPid = backendPid;
    this.#operationTimeoutMs = operationTimeoutMs;
  }

  get key(): PostgresAdvisoryLockKey {
    return this.#control.key;
  }

  #assertHeldState(): void {
    if (this.#state === "lost") throw new PostgresAdvisoryLockLostError(this.key);
    if (this.#state !== "held") {
      throw new Error(
        `sqlx-js: PostgreSQL advisory lock ${formatAdvisoryLockKey(this.key)} was released`,
      );
    }
  }

  async assertHeld(): Promise<void> {
    this.#assertHeldState();
    try {
      const [row] = await runControlQuery<CheckRow>(
        this.#client,
        CHECK_ADVISORY_LOCK_SQL,
        this.#control.identity,
        "health check",
        this.#operationTimeoutMs,
      );
      if (!row || row.backend_pid !== this.#backendPid || !row.held) {
        throw new PostgresAdvisoryLockLostError(this.key);
      }
    } catch (error) {
      await this.#lose();
      if (error instanceof PostgresAdvisoryLockLostError) throw error;
      throw new PostgresAdvisoryLockLostError(this.key, { cause: error });
    }
    this.#assertHeldState();
  }

  release(): Promise<void> {
    if (this.#releasePromise) return this.#releasePromise;
    if (this.#state === "released") return Promise.resolve();
    if (this.#state === "lost") return this.#close();
    this.#state = "releasing";
    return this.#releasePromise = this.#release();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }

  async #release(): Promise<void> {
    let released = false;
    try {
      const [row] = await runControlQuery<ReleaseRow>(
        this.#client,
        this.#control.releaseSql,
        this.#control.params,
        "release",
        this.#operationTimeoutMs,
      );
      if (
        !row ||
        row.backend_pid !== this.#backendPid ||
        this.#state === "lost" ||
        !row.released
      ) {
        throw new PostgresAdvisoryLockLostError(this.key);
      }
      released = true;
    } catch (error) {
      this.#state = "lost";
      if (error instanceof PostgresAdvisoryLockLostError) throw error;
      throw new PostgresAdvisoryLockLostError(this.key, { cause: error });
    } finally {
      if (released) this.#state = "released";
      await this.#close();
    }
  }

  async #lose(): Promise<void> {
    if (this.#state === "released" || this.#state === "lost") return;
    this.#state = "lost";
    await this.#close().catch(() => {});
  }

  #close(): Promise<void> {
    return this.#closePromise ??= this.#client.end();
  }
}

export function tryAcquirePostgresAdvisoryLock(
  databaseUrl: string | undefined,
  key: PostgresAdvisoryLockInt4Key,
  options?: PostgresAdvisoryLockOptions,
): Promise<PostgresAdvisoryLockSession<PostgresAdvisoryLockInt4Key> | null>;
export function tryAcquirePostgresAdvisoryLock(
  databaseUrl: string | undefined,
  key: bigint,
  options?: PostgresAdvisoryLockOptions,
): Promise<PostgresAdvisoryLockSession<bigint> | null>;
export function tryAcquirePostgresAdvisoryLock(
  databaseUrl: string | undefined,
  key: PostgresAdvisoryLockKey,
  options?: PostgresAdvisoryLockOptions,
): Promise<PostgresAdvisoryLockSession | null>;
export async function tryAcquirePostgresAdvisoryLock(
  databaseUrl: string | undefined,
  keyInput: PostgresAdvisoryLockKey,
  options: PostgresAdvisoryLockOptions = {},
): Promise<PostgresAdvisoryLockSession | null> {
  const control = advisoryLockControl(keyInput);
  const { operationTimeoutMs, sessionOptions } = validateLockOptions(options);
  const client = await createPostgresSession(databaseUrl, sessionOptions);
  try {
    const [row] = await runControlQuery<AcquireRow>(
      client,
      control.acquireSql,
      control.params,
      "acquisition",
      operationTimeoutMs,
    );
    if (!row) throw new Error("sqlx-js: PostgreSQL advisory lock query returned no row");
    if (!row.acquired) {
      await client.end();
      return null;
    }
    return new HeldPostgresAdvisoryLock(client, control, row.backend_pid, operationTimeoutMs);
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}
