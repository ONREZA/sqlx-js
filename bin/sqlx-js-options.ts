import type { ParseArgsOptionsConfig } from "node:util";

const ROOT_OPTIONS: ParseArgsOptionsConfig = {
  root: { type: "string" },
  help: { type: "boolean", short: "h" },
};

export function optionsFor(command: string, subcommand?: string): ParseArgsOptionsConfig {
  if (command === "init") return { ...ROOT_OPTIONS, "schema-provider": { type: "string" } };
  if (command === "dev" || command === "verify") {
    return {
      ...ROOT_OPTIONS,
      dts: { type: "string" },
      migrations: { type: "string" },
      "shadow-admin-url": { type: "string" },
      "shadow-url": { type: "string" },
      "lock-timeout": { type: "string" },
      "strict-inference": { type: "boolean" },
      ...(command === "dev" ? { "no-prune": { type: "boolean" } } : {}),
    };
  }
  if (command === "doctor") {
    return {
      ...ROOT_OPTIONS,
      dts: { type: "string" },
      json: { type: "boolean" },
      fix: { type: "boolean" },
    };
  }
  if (command === "ci") return {
    ...ROOT_OPTIONS,
    json: { type: "boolean" },
    dts: { type: "string" },
    migrations: { type: "string" },
    "shadow-url": { type: "string" },
    "shadow-admin-url": { type: "string" },
  };
  if (command === "json") return { ...ROOT_OPTIONS, json: { type: "boolean" } };
  if (command === "pgschema") return ROOT_OPTIONS;
  if (command === "prepare") {
    return {
      ...ROOT_OPTIONS,
      dts: { type: "string" },
      check: { type: "boolean" },
      offline: { type: "boolean" },
      verify: { type: "boolean" },
      watch: { type: "boolean" },
      json: { type: "boolean" },
      jsonl: { type: "boolean" },
      warnings: { type: "boolean" },
      verbose: { type: "boolean" },
      "no-prune": { type: "boolean" },
      "strict-inference": { type: "boolean" },
      include: { type: "string", multiple: true },
      query: { type: "string", multiple: true },
    };
  }
  if (command === "queries") {
    return {
      ...ROOT_OPTIONS,
      json: { type: "boolean" },
      functions: { type: "string" },
      "min-nodes": { type: "string" },
      limit: { type: "string" },
    };
  }
  if (command === "snapshot") {
    const common = {
      ...ROOT_OPTIONS,
      schema: { type: "string" },
      "shadow-url": { type: "string" },
    } satisfies ParseArgsOptionsConfig;
    return subcommand === "dump"
      ? { ...common, manifest: { type: "string" }, "no-manifest": { type: "boolean" } }
      : common;
  }
  const common = { ...ROOT_OPTIONS, migrations: { type: "string" } } satisfies ParseArgsOptionsConfig;
  if (subcommand === "run") {
    return { ...common, "dry-run": { type: "boolean" }, json: { type: "boolean" }, "lock-timeout": { type: "string" } };
  }
  if (subcommand === "info" || subcommand === "check") return { ...common, json: { type: "boolean" } };
  if (subcommand === "revert") {
    return {
      ...common,
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      "shadow-admin-url": { type: "string" },
      "shadow-url": { type: "string" },
      "lock-timeout": { type: "string" },
    };
  }
  if (subcommand === "squash") {
    return {
      ...common,
      "shadow-admin-url": { type: "string" },
      "shadow-url": { type: "string" },
      "lock-timeout": { type: "string" },
      replace: { type: "boolean" },
      "pg-dump": { type: "string" },
    };
  }
  if (subcommand === "archive") return { ...common, force: { type: "boolean" } };
  return common;
}
