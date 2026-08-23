import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  errorCatalogCacheExists,
  errorCatalogOutputPath,
  extractErrorCatalog,
  introspectErrorCatalog,
  readErrorCatalogCache,
  removeErrorCatalogCache,
  renderErrorCatalog,
  writeErrorCatalogCache,
  writeErrorCatalogModule,
  type RoutineErrorSource,
} from "../src/error-catalog";
import type { PgClient } from "../src/pg/wire";
import { assertDistinctPrepareGeneratedOutputs } from "../src/prepare-artifacts";
import { assertFocusedPrepareCatalogs } from "../src/commands/prepare-focus";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function routine(source: string, name = "charge"): RoutineErrorSource {
  return {
    signature: `billing.${name}(payment_id uuid)`,
    source,
  };
}

test("extracts stable PL/pgSQL exception identities from supported RAISE forms", () => {
  const catalog = extractErrorCatalog([
    routine(`
      BEGIN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'PAYMENT_ATTEMPT_CANCEL_RETRYABILITY_REQUIRED';
        RAISE SQLSTATE '23503' USING MESSAGE = 'PAYMENT_ACCOUNT_NOT_FOUND';
        RAISE EXCEPTION SQLSTATE '22000' USING MESSAGE = 'PAYMENT_DATA_EXCEPTION';
        RAISE USING MESSAGE = 'PAYMENT_PROVIDER_FAILED';
        RAISE EXCEPTION 'PAYMENT_ATTEMPT_BUSY' USING ERRCODE = '55P03';
        RAISE EXCEPTION 'PAYMENT_DEFAULT_CODE';
      END
    `),
    routine("BEGIN NULL; END", "without_errors"),
  ]);

  expect(catalog.coverage).toEqual({
    routinesWithRaises: 1,
    raiseExceptions: 6,
    extractedOccurrences: 6,
    skipped: 0,
  });
  expect(catalog.errors).toEqual([
    {
      code: "23503",
      message: "PAYMENT_ACCOUNT_NOT_FOUND",
      routines: ["billing.charge(payment_id uuid)"],
    },
    {
      code: "55P03",
      message: "PAYMENT_ATTEMPT_BUSY",
      routines: ["billing.charge(payment_id uuid)"],
    },
    {
      code: "22023",
      message: "PAYMENT_ATTEMPT_CANCEL_RETRYABILITY_REQUIRED",
      routines: ["billing.charge(payment_id uuid)"],
    },
    {
      code: "22000",
      message: "PAYMENT_DATA_EXCEPTION",
      routines: ["billing.charge(payment_id uuid)"],
    },
    {
      code: "P0001",
      message: "PAYMENT_DEFAULT_CODE",
      routines: ["billing.charge(payment_id uuid)"],
    },
    {
      code: "P0001",
      message: "PAYMENT_PROVIDER_FAILED",
      routines: ["billing.charge(payment_id uuid)"],
    },
  ]);
});

test("ignores comments, strings, non-exception levels, and dynamic or human messages", () => {
  const catalog = extractErrorCatalog([
    routine(`
      BEGIN
        -- RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'COMMENTED_ERROR';
        value := 'RAISE EXCEPTION USING MESSAGE = ''STRING_ERROR''';
        escaped := E'prefix\\' RAISE EXCEPTION USING MESSAGE = \\'ESCAPED_STRING_ERROR\\'';
        nested := $payload$ RAISE EXCEPTION USING MESSAGE = 'DOLLAR_QUOTED_ERROR' $payload$;
        unicode_tag := $тег$ RAISE EXCEPTION USING MESSAGE = 'UNICODE_DOLLAR_QUOTED_ERROR' $тег$;
        high_tag := $💥$ RAISE EXCEPTION USING MESSAGE = 'HIGH_DOLLAR_QUOTED_ERROR' $💥$;
        /* outer /* RAISE EXCEPTION USING MESSAGE = 'BLOCK_COMMENT_ERROR'; */ comment */
        RAISEЖ USING ERRCODE = '22023', MESSAGE = 'UNICODE_IDENTIFIER_ERROR';
        SELECT RAISE, USING, ERRCODE = '22023', MESSAGE = 'SQL_IDENTIFIER_ERROR';
        RAISE WARNING USING MESSAGE = 'WARNING_ONLY';
        RAISE EXCEPTION USING ERRCODE = code_variable, MESSAGE = 'DYNAMIC_CODE';
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = message_variable;
        RAISE EXCEPTION 'Human-facing value: %', value USING ERRCODE = '22023';
        RAISE EXCEPTION 'STATIC_BUT_HAS_ARGUMENTS', value USING ERRCODE = '22023';
        RAISE EXCEPTION condition_name USING MESSAGE = 'NAMED_CONDITION';
        RAISE;
      END
    `),
  ]);

  expect(catalog.errors).toEqual([]);
  expect(catalog.coverage).toEqual({
    routinesWithRaises: 1,
    raiseExceptions: 5,
    extractedOccurrences: 0,
    skipped: 5,
  });
});

test("rejects escaped E literals and contradictory or duplicate RAISE options", () => {
  const catalog = extractErrorCatalog([
    routine(String.raw`
      BEGIN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = E'PAYMENT\137INVALID';
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'FIRST_MESSAGE', MESSAGE = 'SECOND_MESSAGE';
        RAISE EXCEPTION 'FORMAT_MESSAGE' USING ERRCODE = '22023', MESSAGE = 'OPTION_MESSAGE';
        RAISE SQLSTATE '22023' USING ERRCODE = '23514', MESSAGE = 'CONFLICTING_CODE';
        RAISE EXCEPTION USING ERRCODE = E'22023', MESSAGE = E'PAYMENT_SAFE_E_LITERAL';
        RAISE EXCEPTION USING MESSAGE = 'UNBALANCED_OPTIONS', DETAIL = (value;
      END
    `),
  ]);

  expect(catalog.errors).toEqual([{
    code: "22023",
    message: "PAYMENT_SAFE_E_LITERAL",
    routines: ["billing.charge(payment_id uuid)"],
  }]);
  expect(catalog.coverage).toEqual({
    routinesWithRaises: 1,
    raiseExceptions: 6,
    extractedOccurrences: 1,
    skipped: 5,
  });
});

test("quotes configured schema names without depending on standard_conforming_strings", async () => {
  let query = "";
  const client = {
    simpleQueryAll: async (sql: string) => {
      query = sql;
      return { rows: [] };
    },
  } as unknown as PgClient;

  await introspectErrorCatalog(client, ["billing\\archive'2026"]);

  expect(query).toContain("E'billing\\\\archive''2026'");
});

test("deduplicates identical errors and preserves routine provenance", () => {
  const catalog = extractErrorCatalog([
    routine("BEGIN RAISE EXCEPTION USING MESSAGE = 'PAYMENT_NOT_FOUND', ERRCODE = 'P0002'; END", "first"),
    routine("BEGIN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'PAYMENT_NOT_FOUND'; END", "second"),
  ]);

  expect(catalog.errors).toEqual([{
    code: "P0002",
    message: "PAYMENT_NOT_FOUND",
    routines: ["billing.first(payment_id uuid)", "billing.second(payment_id uuid)"],
  }]);
  expect(catalog.coverage.extractedOccurrences).toBe(2);
});

test("rejects one symbolic message mapped to different SQLSTATE codes", () => {
  expect(() => extractErrorCatalog([
    routine("BEGIN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PAYMENT_INVALID'; END", "first"),
    routine("BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAYMENT_INVALID'; END", "second"),
  ])).toThrow(/PAYMENT_INVALID.*22023.*23514/);
});

test("renders a stable runtime error catalog", () => {
  expect(renderErrorCatalog({
    coverage: { routinesWithRaises: 1, raiseExceptions: 1, extractedOccurrences: 1, skipped: 0 },
    errors: [{
      code: "22023",
      message: "PAYMENT_INVALID",
      routines: ["billing.charge(payment_id uuid)"],
    }],
  })).toBe(`// AUTO-GENERATED by sqlx-js. Do not edit.
// Run \`sqlx-js prepare\` to regenerate.

export const DbErrors = {
  PAYMENT_INVALID: { code: "22023", message: "PAYMENT_INVALID" },
} as const;

export type DbErrorName = keyof typeof DbErrors;

export type DbError = (typeof DbErrors)[DbErrorName];
`);
});

test("round-trips the versioned cache and generated module", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-errors-"));
  dirs.push(root);
  const cacheDir = join(root, ".sqlx-js");
  const output = errorCatalogOutputPath(root, {
    errorCatalog: { output: "src/db-errors.ts", schemas: ["billing"] },
  })!;
  const catalog = {
    coverage: { routinesWithRaises: 1, raiseExceptions: 1, extractedOccurrences: 1, skipped: 0 },
    errors: [{
      code: "22023",
      message: "PAYMENT_INVALID",
      routines: ["billing.charge(payment_id uuid)"],
    }],
  };

  writeErrorCatalogCache(cacheDir, catalog);
  writeErrorCatalogModule(output, renderErrorCatalog(catalog));

  expect(errorCatalogCacheExists(cacheDir)).toBe(true);
  expect(readErrorCatalogCache(cacheDir)).toEqual(catalog);
  expect(readFileSync(output, "utf8")).toContain("PAYMENT_INVALID");
  removeErrorCatalogCache(cacheDir);
  expect(errorCatalogCacheExists(cacheDir)).toBe(false);
});

test("generated error output cannot collide with another generated artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-error-output-"));
  dirs.push(root);
  expect(() => assertDistinctPrepareGeneratedOutputs({
    root,
    config: {
      enumCatalog: { output: "src/generated.ts", schemas: ["public"] },
      errorCatalog: { output: "src/generated.ts", schemas: ["public"] },
    },
    dtsPath: join(root, "sqlx-js-env.d.ts"),
  })).toThrow(/must be distinct/);
});

test("focused prepare requires the configured error catalog cache", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-error-focused-"));
  dirs.push(root);
  const cacheDir = join(root, ".sqlx-js");
  const config = {
    functionCatalog: false as const,
    errorCatalog: { output: "src/db-errors.ts", schemas: ["billing"] },
  };

  expect(() => assertFocusedPrepareCatalogs(config, cacheDir)).toThrow(/error catalog cache is missing/);
  writeErrorCatalogCache(cacheDir, {
    errors: [],
    coverage: { routinesWithRaises: 0, raiseExceptions: 0, extractedOccurrences: 0, skipped: 0 },
  });
  expect(() => assertFocusedPrepareCatalogs(config, cacheDir)).not.toThrow();
});

test("rejects a stale error catalog cache with regeneration guidance", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-error-cache-"));
  dirs.push(root);
  const cacheDir = join(root, ".sqlx-js");
  mkdirSync(join(cacheDir, "errors"), { recursive: true });
  writeFileSync(join(cacheDir, "errors/errors.json"), JSON.stringify({
    version: 2,
    errors: [],
    coverage: { routinesWithRaises: 0, raiseExceptions: 0, extractedOccurrences: 0, skipped: 0 },
  }));

  expect(() => readErrorCatalogCache(cacheDir)).toThrow(/stale.*Run `sqlx-js prepare`/);
});

test("rejects duplicate identities and impossible cache coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-error-cache-invalid-"));
  dirs.push(root);
  const cacheDir = join(root, ".sqlx-js");
  mkdirSync(join(cacheDir, "errors"), { recursive: true });
  const path = join(cacheDir, "errors/errors.json");
  const entry = {
    code: "22023",
    message: "PAYMENT_INVALID",
    routines: ["billing.charge()"],
  };

  writeFileSync(path, JSON.stringify({
    version: 1,
    errors: [entry, entry],
    coverage: { routinesWithRaises: 1, raiseExceptions: 2, extractedOccurrences: 2, skipped: 0 },
  }));
  expect(() => readErrorCatalogCache(cacheDir)).toThrow(/duplicate message/);

  writeFileSync(path, JSON.stringify({
    version: 1,
    errors: [entry],
    coverage: { routinesWithRaises: 1, raiseExceptions: 0, extractedOccurrences: 0, skipped: 0 },
  }));
  expect(() => readErrorCatalogCache(cacheDir)).toThrow(/malformed/);
});

test("does not read an error catalog through a cache-file symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-error-cache-symlink-"));
  dirs.push(root);
  const cacheDir = join(root, ".sqlx-js");
  const outside = join(root, "outside.json");
  mkdirSync(join(cacheDir, "errors"), { recursive: true });
  writeFileSync(outside, JSON.stringify({
    version: 1,
    errors: [],
    coverage: { routinesWithRaises: 0, raiseExceptions: 0, extractedOccurrences: 0, skipped: 0 },
  }));
  symlinkSync(outside, join(cacheDir, "errors/errors.json"));

  expect(() => readErrorCatalogCache(cacheDir)).toThrow(/must not be a symbolic link/);
});

test("does not read an error catalog through a managed-directory symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-error-cache-dir-symlink-"));
  dirs.push(root);
  const cacheDir = join(root, ".sqlx-js");
  const outside = join(root, "outside");
  mkdirSync(cacheDir);
  mkdirSync(outside);
  writeFileSync(join(outside, "errors.json"), JSON.stringify({
    version: 1,
    errors: [],
    coverage: { routinesWithRaises: 0, raiseExceptions: 0, extractedOccurrences: 0, skipped: 0 },
  }));
  symlinkSync(outside, join(cacheDir, "errors"), "dir");

  expect(() => readErrorCatalogCache(cacheDir)).toThrow(/must not be a symbolic link/);
});
