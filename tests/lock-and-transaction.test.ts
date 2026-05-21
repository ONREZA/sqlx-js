import { describe, expect, test } from "bun:test";
import { acquireMigrateLock } from "../src/commands/migrate";
import { _internal } from "../src/runtime";
import type { PgClient } from "../src/pg/wire";

const utf8 = (s: string) => new TextEncoder().encode(s);

class LockMock {
  attempts = 0;
  succeedAfter: number;
  unlimited: boolean;
  constructor(succeedAfter: number = 0, unlimited: boolean = false) {
    this.succeedAfter = succeedAfter;
    this.unlimited = unlimited;
  }
  async simpleQuery(sql: string): Promise<any> {
    if (/pg_advisory_lock/.test(sql) && !/try/.test(sql)) {
      this.attempts++;
      return { rows: [[utf8("")]], fields: [], tag: "SELECT" };
    }
    if (/pg_try_advisory_lock/.test(sql)) {
      this.attempts++;
      const got = this.unlimited ? false : this.attempts > this.succeedAfter;
      return { rows: [[utf8(got ? "t" : "f")]], fields: [], tag: "SELECT" };
    }
    return { rows: [], fields: [], tag: "OK" };
  }
}

const asClient = (m: unknown): PgClient => m as PgClient;

describe("acquireMigrateLock", () => {
  test("immediate acquire when no timeout", async () => {
    const m = new LockMock();
    await acquireMigrateLock(asClient(m), 1n);
    expect(m.attempts).toBe(1);
  });

  test("succeeds when pg_try_advisory_lock returns t on second attempt", async () => {
    const m = new LockMock(1);
    await acquireMigrateLock(asClient(m), 1n, 5000);
    expect(m.attempts).toBe(2);
  });

  test("throws after timeout elapses", async () => {
    const m = new LockMock(0, true);
    const start = Date.now();
    await expect(acquireMigrateLock(asClient(m), 1n, 120)).rejects.toThrow(/failed to acquire advisory lock/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  test("rejects non-finite timeout without polling", async () => {
    const m = new LockMock(0, true);
    await expect(acquireMigrateLock(asClient(m), 1n, Number.NaN)).rejects.toThrow(/finite number/);
    await expect(acquireMigrateLock(asClient(m), 1n, Number.POSITIVE_INFINITY)).rejects.toThrow(/finite number/);
    expect(m.attempts).toBe(0);
  });

  test("rejects non-safe-integer numeric lockKey", async () => {
    await expect(acquireMigrateLock(asClient(new LockMock()), 1.5)).rejects.toThrow(/safe integer/);
  });

  test("accepts bigint lockKey at the bigint boundary", async () => {
    const m = new LockMock();
    await acquireMigrateLock(asClient(m), 9999999999999999999n);
    expect(m.attempts).toBe(1);
  });
});

describe("buildSetTransaction", () => {
  const build = _internal.buildSetTransaction;

  test("empty opts → empty string (no SET TRANSACTION emitted)", () => {
    expect(build({})).toBe("");
  });

  test("isolation level uppercased", () => {
    expect(build({ isolation: "serializable" })).toBe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(build({ isolation: "read committed" })).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(build({ isolation: "repeatable read" })).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect(build({ isolation: "read uncommitted" })).toBe("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED");
  });

  test("readOnly true vs false", () => {
    expect(build({ readOnly: true })).toBe("SET TRANSACTION READ ONLY");
    expect(build({ readOnly: false })).toBe("SET TRANSACTION READ WRITE");
  });

  test("deferrable true vs false", () => {
    expect(build({ deferrable: true })).toBe("SET TRANSACTION DEFERRABLE");
    expect(build({ deferrable: false })).toBe("SET TRANSACTION NOT DEFERRABLE");
  });

  test("combined options keep canonical order", () => {
    expect(build({ isolation: "serializable", readOnly: true, deferrable: true }))
      .toBe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE");
  });
});
