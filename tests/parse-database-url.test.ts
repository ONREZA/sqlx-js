import { describe, expect, test } from "bun:test";
import { parseDatabaseUrl } from "../src/pg/wire";

describe("parseDatabaseUrl", () => {
  test("rejects unknown protocol", () => {
    expect(() => parseDatabaseUrl("mysql://u@h/db")).toThrow(/unsupported scheme/);
  });

  test("defaults port to 5432 and database to user when path is empty", () => {
    const cfg = parseDatabaseUrl("postgres://alice@host/");
    expect(cfg.host).toBe("host");
    expect(cfg.port).toBe(5432);
    expect(cfg.user).toBe("alice");
    expect(cfg.database).toBe("alice");
  });

  test("URL-decodes user and password", () => {
    const cfg = parseDatabaseUrl("postgres://u%40org:p%40ss@h/db");
    expect(cfg.user).toBe("u@org");
    expect(cfg.password).toBe("p@ss");
  });

  test("accepts every valid sslmode", () => {
    for (const m of ["disable", "prefer", "require", "verify-ca", "verify-full"]) {
      const cfg = parseDatabaseUrl(`postgres://u@h/db?sslmode=${m}`);
      expect(cfg.sslmode).toBe(m as never);
    }
  });

  test("throws on unknown sslmode", () => {
    expect(() => parseDatabaseUrl("postgres://u@h/db?sslmode=bogus")).toThrow(/unsupported sslmode/);
  });

  test("propagates application_name", () => {
    const cfg = parseDatabaseUrl("postgres://u@h/db?application_name=migrator");
    expect(cfg.applicationName).toBe("migrator");
  });

  test("converts connect_timeout seconds → milliseconds", () => {
    const cfg = parseDatabaseUrl("postgres://u@h/db?connect_timeout=5");
    expect(cfg.connectTimeoutMs).toBe(5000);
  });

  test("ignores non-positive / non-numeric connect_timeout silently", () => {
    expect(parseDatabaseUrl("postgres://u@h/db?connect_timeout=0").connectTimeoutMs).toBeUndefined();
    expect(parseDatabaseUrl("postgres://u@h/db?connect_timeout=abc").connectTimeoutMs).toBeUndefined();
    expect(parseDatabaseUrl("postgres://u@h/db?connect_timeout=-3").connectTimeoutMs).toBeUndefined();
  });

  test("postgresql:// alias works", () => {
    const cfg = parseDatabaseUrl("postgresql://u@h/db");
    expect(cfg.host).toBe("h");
  });
});
