# Upgrade guides

Version-specific breaking changes and migration instructions live here so the
main README can stay focused on the current API.

## Guides

- [0.30.0](./0.30.0.md) — Temporal-only SQL I/O, query-local timestamp
  policy, Extended JSON protocol v1, reader-first audit, provider setup, and
  artifact regeneration.
- [0.29.0](./0.29.0.md) — exact-query array-element assertions and query
  cache regeneration.
- [0.27.0](./0.27.0.md) — source-owned nullable/parse-only contracts, CLI
  package identity, complete function settings, and artifact regeneration.
- [0.25.0](./0.25.0.md) — compact prepare output, explicit warning and verbose
  detail modes, and clarified doctor ownership and coverage counters.
- [0.24.0 / 0.24.1](./0.24.0.md) — generator-bound temporal infinity policy,
  runtime enforcement, artifact regeneration, and the 0.24.1 patch scope.
- [0.23.0](./0.23.0.md) — descriptor-first generated clients, inference
  explanations, execution-intent diagnostics, typed savepoints, and cache
  regeneration.
- [0.22.0](./0.22.0.md) — prepared runtime descriptors, cache regeneration,
  and optional one-write parameter dispatch.
- [0.20.0](./0.20.0.md) — integrated PostgreSQL runtime, ESM-only runtime
  baseline, pool option migration, and Postgres.js removal.
- [0.18.0](./0.18.0.md) — PostgreSQL function security/planner metadata,
  reviewable diagnostics, and generated-artifact regeneration.
- [0.17.0](./0.17.0.md) — provider-aware `dev` / `verify`, explicit
  `pgschema` / `snapshot` namespaces, and source-of-truth CI semantics.
- [0.15.0](./0.15.0.md) — managed pool generations, end-to-end deadlines,
  bounded lifecycle, transaction deadlines, and `AbortSignal`.
- [Pre-0.15 generated-artifact migrations](./pre-0.15.0.md) — archived cache,
  generator, parameter, observer, and SQL-file changes from earlier releases.

## Maintenance policy

Add one `<target-version>.md` file whenever an upgrade needs application code,
generated-artifact, configuration, or operational changes. Each guide should
state:

1. the source versions it applies to;
2. every breaking public contract;
3. before/after migration examples;
4. rollout and rollback constraints;
5. the verification commands required before deployment.

`CHANGELOG.md` remains the release summary. Detailed migration instructions
belong here, and the root README should link to the current guide instead of
accumulating historical upgrade notes.
