# Documentation

README is the project overview and fastest path to a first typed query. These
guides contain the complete contracts, operational details, and edge cases.

## Start here

| Goal | Guide |
| --- | --- |
| Install sqlx-js and prepare the first query | [Getting started](./getting-started.md) |
| Learn the typed query surface | [Query API](./query-api.md) |
| Choose the managed or raw runtime | [Runtime and clients](./runtime.md) |
| Bind queries to PostgreSQL roles or RLS context | [Connection profiles and RLS](./profiles-and-rls.md) |
| Configure scanning, generated catalogs, and custom types | [Configuration and custom types](./configuration.md) |
| Build CI and deployment gates | [CI and deployment checks](./ci.md) |

## Reference

- [CLI and workflows](./cli.md) covers prepare, provider-aware schema
  development, migrations, snapshots, diagnostics, and query inventory.
- [Type and nullability inference](./type-inference.md) explains where generated
  row and parameter types come from and when explicit assertions are needed.
- [Benchmarks](./benchmarks.md) documents the runtime benchmark methodology,
  controls, and interpretation boundaries.
- [Runtime performance tuning](./performance-tuning.md) records optimization
  priorities, acceptance gates, and directions that are intentionally avoided.
- [Agent skills](./agent-skills.md) lists installable workflows for coding
  agents and their validation contract.
- [Limitations and non-goals](./limitations.md) records intentional boundaries
  and known unsupported cases.
- [Upgrade guides](./upgrades/README.md) contain version-specific regeneration,
  API migration, rollout, and rollback instructions.
- [Roadmap](../ROADMAP.md) lists planned work and explicitly rejected or
  deferred directions.

## Architecture and compatibility

- [sqlx-js Extended JSON protocol](./extended-json-protocol.md) defines the
  branded, immutable, versioned `json`/`jsonb` value and transport contract.
- [Postgres.js compatibility matrix](./postgres-js-feature-matrix.md) defines
  the runtime replacement boundary and permanent non-goals.
- [Postgres.js upstream audit](./postgres-js-upstream-audit.md) records which
  upstream reliability and developer-experience findings were adopted.

## Project participation

- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)

[Back to README](../README.md)
