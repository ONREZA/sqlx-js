# Upgrade guides

Version-specific breaking changes and migration instructions live here so the
main README can stay focused on the current API.

## Guides

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
