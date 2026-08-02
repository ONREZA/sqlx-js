---
name: sqlx-js-ci
description: Design, implement, or debug sqlx-js continuous integration and deployment verification using provider-aware ci, shadow databases, prepare check and verify, strict inference, generated artifacts, diagnostics, snapshots, package smoke tests, and explicit target deployment gates. Use for GitHub Actions, CI failures, artifact drift, or release pipeline checks.
---

# sqlx-js CI

Validate the proposed schema and committed query contract without conflating
them with target deployment.

## Workflow

1. Inspect the configured schema provider and committed generated outputs.
2. Provision PostgreSQL and shadow creation credentials or an explicit
   disposable shadow.
3. Install pgschema only when configured.
4. Run provider-aware `sqlx-js ci`.
5. Run `doctor --json`, TypeScript, tests, example, and build as appropriate.
6. Keep target-specific migration or pgschema plans in explicit deployment
   steps.
7. Preserve structured diagnostics and exact failing gate.

Read [the CI gate map](references/gates.md) before changing a pipeline.

## Invariants

- `ci` validates a clean shadow and then offline artifact consistency.
- `prepare --check` is database-free and cannot prove live schema parity.
- `prepare --verify` compares against a specifically supplied live database and
  does not write the worktree.
- Commit generated declarations, cache, and configured enum output.
- Keep `doctor --json` read-only in CI; apply `doctor --fix` locally and commit
  the resulting `.gitattributes` change.
- Exclude generated artifacts from formatters while keeping TypeScript outputs
  in the type-check.
- Do not expose database credentials in logs or command arguments.
- Keep built-in migration and pgschema deployment gates provider-specific.
- A green CI run is not npm publication or production rollout evidence.
