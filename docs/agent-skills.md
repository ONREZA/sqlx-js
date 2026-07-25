# Agent skills

sqlx-js ships project-specific [Agent Skills](https://agentskills.io/) for
coding agents that support the open `SKILL.md` format. They package operational
knowledge, decision boundaries, source maps, and verification gates without
loading the complete repository handbook into every prompt.

The structure is inspired by [prisma/skills](https://github.com/prisma/skills):
specific activation descriptions, short routing files, and detailed references
loaded only when needed. The sqlx-js skills additionally require current
checkout evidence, separate local and release truth, and preserve explicit
database/runtime ownership boundaries.

## Install

List the skills:

```bash
npx skills add ONREZA/sqlx-js --list
```

Install all skills:

```bash
npx skills add ONREZA/sqlx-js
```

Install one skill:

```bash
npx skills add ONREZA/sqlx-js --skill sqlx-js-runtime-reliability
```

Skills-compatible agents discover the installed metadata and load the full
instructions only when a request matches the description.

## Available skills

| Skill | Primary trigger |
| --- | --- |
| `sqlx-js-cli` | Command discovery, exact flags, help, diagnostics, queries, snapshots |
| `sqlx-js-project-setup` | Installation, provider choice, first query, generated artifacts |
| `sqlx-js-ci` | Shadow verification, offline consistency, deployment gates |
| `sqlx-js-troubleshooting` | Classifying ambiguous errors and routing diagnosis |
| `sqlx-js-schema-workflows` | Migrations, pgschema, shadow databases, schema deployment |
| `sqlx-js-query-api` | Writing typed queries, parameters, SQL files, transactions |
| `sqlx-js-inference` | Scanner, analyzer, narrowing, parameter mapping, codegen |
| `sqlx-js-runtime-reliability` | Driver, pooling, deadlines, cancellation, recovery |
| `sqlx-js-runtime-evidence` | Benchmarks, soak, chaos, TLS/auth, cleanup evidence |
| `sqlx-js-profiles-rls` | PostgreSQL roles, profile registries, RLS context |
| `sqlx-js-custom-types` | OIDs, JSON, arrays, enums, domains, composites, codecs |
| `sqlx-js-upgrades` | Package upgrades, generated artifacts, compatibility revisions |
| `sqlx-js-release` | Authorized release-please and npm publication workflow |

## Design boundaries

- `SKILL.md` contains the trigger-specific workflow and hard constraints.
- `references/` contains focused source maps and checklists.
- `agents/openai.yaml` contains UI metadata.
- Repository source, current CLI help, config, and generated artifacts remain
  the source of truth when they differ from remembered behavior.
- Skills do not grant authorization to deploy, publish, mutate a target
  database, or perform another external write.

## Validate changes

```bash
bun run test:skills
bun run test:docs
```

The skills validator checks frontmatter, directory/name alignment, context-size
limits, unresolved placeholders, UI metadata, and required structure. The
documentation checker verifies every relative reference target.

[Documentation index](./README.md)
