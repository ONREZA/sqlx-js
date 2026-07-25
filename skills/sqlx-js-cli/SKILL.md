---
name: sqlx-js-cli
description: Select, inspect, and run current sqlx-js CLI commands and flags. Use for command discovery, exact syntax, help output, diagnostics, snapshots, query inventory, embedded SQL, or machine-readable output. Route new-project adoption to sqlx-js-project-setup, CI pipelines to sqlx-js-ci, and schema ownership or deployment to sqlx-js-schema-workflows.
---

# sqlx-js CLI

Choose commands from live project evidence and preserve their write and database
boundaries.

## Source-of-truth order

1. Inspect the current checkout or installed package version.
2. Read `sqlx-js.config.*`, `package.json`, and generated scripts.
3. Run the matching command with `--help`.
4. Read `docs/cli.md` and the command implementation when source is available.
5. Use remote documentation only after local version-specific evidence.

Do not recall flags from another sqlx-js release.

## Workflow

1. Resolve the project root and configured schema provider.
2. Classify whether the command writes the worktree, reads a database, or
   changes the target database.
3. Prefer project scripts over a globally installed binary.
4. Inspect help before using an unfamiliar flag:

   ```bash
   bun bin/sqlx-js.ts <command> --help
   ```

5. Use JSON output when another tool must consume the result.
6. Run the narrow command and verify the artifact or database state it owns.

Read [the command map](references/command-map.md) before selecting among
`prepare`, `dev`, `verify`, `ci`, `doctor`, `queries`, and `snapshot`.

## Boundaries

- Use `sqlx-js-schema-workflows` for migrations, pgschema, shadow databases,
  schema ownership, and deployment.
- Use `sqlx-js-project-setup` for installation and first-project setup.
- Use `sqlx-js-ci` for CI pipeline design and artifact gates.
- Use `sqlx-js-query-api` for application query syntax.
- Use `sqlx-js-upgrades` for cache or generator incompatibility.
- Never treat `prepare --check` as live database parity.
- Never treat `verify` as target database deployment.
- Do not add or guess a command that is absent from current `--help`.
