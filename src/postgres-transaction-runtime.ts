import { queryId } from "./query-id";
import type { PostgresQueryClient } from "./pg/driver";
import type {
  RuntimeClient,
  RuntimeQueryRequest,
  RuntimeQueryResult,
} from "./runtime";

export type PendingQuery = PromiseLike<RuntimeQueryResult> & {
  cancel?: () => unknown;
  execute?: () => PendingQuery;
};

export type TransactionState = {
  expired?: Error;
  deadlineAt?: number;
  expire?: () => void;
  pending: Set<PendingQuery>;
  interrupt: {
    promise: Promise<never>;
    reject(error: unknown): void;
  };
  nextSavepoint: number;
};

export type TransactionRuntimeHost<Generation> = {
  readonly fileRoot: string;
  readonly reloadSqlFiles: boolean;
  readonly sqlFiles?: Readonly<Record<string, string>>;
  executeTransactionQuery(
    generation: Generation,
    client: PostgresQueryClient,
    state: TransactionState,
    request: RuntimeQueryRequest,
  ): Promise<RuntimeQueryResult>;
  executeTransactionControl(
    client: PostgresQueryClient,
    state: TransactionState,
    query: string,
  ): Promise<void>;
  checkTransactionState(state: TransactionState): void;
};

export type TransactionRuntimeClientHandle = RuntimeClient & {
  finish(): void;
  settle(): Promise<void>;
};

type SavepointOutcome<R> =
  | { ok: true; value: R }
  | { ok: false; error: unknown };

export function createTransactionRuntimeClient<Generation>(
  runtime: TransactionRuntimeHost<Generation>,
  generation: Generation,
  client: PostgresQueryClient,
  state: TransactionState,
): TransactionRuntimeClientHandle {
  return new TransactionRuntimeClient(runtime, generation, client, state);
}

async function executeSavepoint<R, Generation>(
  runtime: TransactionRuntimeHost<Generation>,
  generation: Generation,
  client: PostgresQueryClient,
  state: TransactionState,
  fn: (client: RuntimeClient) => Promise<R>,
): Promise<SavepointOutcome<R>> {
  runtime.checkTransactionState(state);
  const name = `sqlx_js_${state.nextSavepoint++}`;
  await runtime.executeTransactionControl(client, state, `SAVEPOINT ${name}`);
  const scoped = new SavepointRuntimeClient(runtime, generation, client, state);
  let value!: R;
  let callbackError: unknown;
  let callbackFailed = false;
  try {
    value = await fn(scoped);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  scoped.finish();
  await scoped.settle();
  runtime.checkTransactionState(state);
  if (callbackFailed || scoped.failed) {
    await runtime.executeTransactionControl(client, state, `ROLLBACK TO SAVEPOINT ${name}`);
    await runtime.executeTransactionControl(client, state, `RELEASE SAVEPOINT ${name}`);
    return callbackFailed ? { ok: false, error: callbackError } : { ok: true, value };
  }
  await runtime.executeTransactionControl(client, state, `RELEASE SAVEPOINT ${name}`);
  return { ok: true, value };
}

class TransactionRuntimeClient<Generation> implements RuntimeClient {
  readonly fileRoot: string;
  readonly reloadSqlFiles: boolean;
  readonly sqlFiles?: Readonly<Record<string, string>>;
  private active = true;
  private childSavepointActive = false;
  private readonly savepoints = new Set<Promise<unknown>>();

  constructor(
    private readonly runtime: TransactionRuntimeHost<Generation>,
    private readonly generation: Generation,
    private readonly client: PostgresQueryClient,
    private readonly state: TransactionState,
  ) {
    this.fileRoot = runtime.fileRoot;
    this.reloadSqlFiles = runtime.reloadSqlFiles;
    this.sqlFiles = runtime.sqlFiles;
  }

  async query(query: string, params: unknown[]): Promise<RuntimeQueryResult> {
    return await this.execute({
      query,
      params,
      observedQuery: query,
      observedParams: params,
      metadata: { queryId: queryId(query) },
    });
  }

  async execute(request: RuntimeQueryRequest): Promise<RuntimeQueryResult> {
    if (!this.active) {
      throw new Error("sqlx-js.transaction: scoped executor is no longer active");
    }
    if (this.childSavepointActive) {
      throw new Error(
        "sqlx-js.transaction: use the savepoint callback executor while a savepoint is active",
      );
    }
    return await this.runtime.executeTransactionQuery(this.generation, this.client, this.state, request);
  }

  async transaction<R>(): Promise<R> {
    throw new Error("sqlx-js.transaction: nested transactions are not supported");
  }

  async savepoint<R>(fn: (client: RuntimeClient) => Promise<R>): Promise<R> {
    if (!this.active) {
      throw new Error("sqlx-js.transaction: scoped executor is no longer active");
    }
    if (this.childSavepointActive) {
      throw new Error(
        "sqlx-js.transaction: use the savepoint callback executor while a savepoint is active",
      );
    }
    this.childSavepointActive = true;
    const pending = executeSavepoint(
      this.runtime,
      this.generation,
      this.client,
      this.state,
      fn,
    );
    this.savepoints.add(pending);
    try {
      const outcome = await pending;
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } finally {
      this.savepoints.delete(pending);
      this.childSavepointActive = false;
    }
  }

  async settle(): Promise<void> {
    while (this.savepoints.size > 0) {
      await Promise.allSettled([...this.savepoints]);
    }
  }

  finish(): void {
    this.active = false;
  }

  async close(): Promise<void> {}
}

class SavepointRuntimeClient<Generation> implements RuntimeClient {
  readonly fileRoot: string;
  readonly reloadSqlFiles: boolean;
  readonly sqlFiles?: Readonly<Record<string, string>>;
  private aborted = false;
  private active = true;
  private childSavepointActive = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  get failed(): boolean {
    return this.aborted;
  }

  constructor(
    private readonly runtime: TransactionRuntimeHost<Generation>,
    private readonly generation: Generation,
    private readonly client: PostgresQueryClient,
    private readonly state: TransactionState,
  ) {
    this.fileRoot = runtime.fileRoot;
    this.reloadSqlFiles = runtime.reloadSqlFiles;
    this.sqlFiles = runtime.sqlFiles;
  }

  async query(query: string, params: unknown[]): Promise<RuntimeQueryResult> {
    return await this.execute({
      query,
      params,
      observedQuery: query,
      observedParams: params,
      metadata: { queryId: queryId(query) },
    });
  }

  execute(request: RuntimeQueryRequest): Promise<RuntimeQueryResult> {
    if (!this.active) {
      return Promise.reject(new Error("sqlx-js.savepoint: the savepoint executor is no longer active"));
    }
    if (this.aborted) {
      return Promise.reject(
        new Error("sqlx-js.savepoint: the savepoint is aborted; return from its callback to roll it back"),
      );
    }
    if (this.childSavepointActive) {
      return Promise.reject(
        new Error("sqlx-js.savepoint: use the nested callback executor while a child savepoint is active"),
      );
    }
    const pending = this.runtime.executeTransactionQuery(
      this.generation,
      this.client,
      this.state,
      request,
    );
    this.inFlight.add(pending);
    void pending.then(
      () => {
        this.inFlight.delete(pending);
      },
      () => {
        this.inFlight.delete(pending);
        if (!this.state.expired) this.aborted = true;
      },
    );
    return pending;
  }

  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  finish(): void {
    this.active = false;
  }

  async transaction<R>(): Promise<R> {
    throw new Error("sqlx-js.transaction: nested transactions are not supported");
  }

  async savepoint<R>(fn: (client: RuntimeClient) => Promise<R>): Promise<R> {
    if (!this.active) {
      throw new Error("sqlx-js.savepoint: the savepoint executor is no longer active");
    }
    if (this.aborted) {
      throw new Error("sqlx-js.savepoint: the savepoint is aborted; return from its callback to roll it back");
    }
    if (this.childSavepointActive) {
      throw new Error("sqlx-js.savepoint: use the nested callback executor while a child savepoint is active");
    }
    this.childSavepointActive = true;
    const pending = executeSavepoint(
      this.runtime,
      this.generation,
      this.client,
      this.state,
      fn,
    );
    this.inFlight.add(pending);
    try {
      const outcome = await pending;
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } finally {
      this.inFlight.delete(pending);
      this.childSavepointActive = false;
    }
  }

  async close(): Promise<void> {}
}
