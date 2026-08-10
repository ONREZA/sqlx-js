---
name: sqlx-js-project-setup
description: Install and configure sqlx-js in a new or existing TypeScript PostgreSQL project, choose built-in migrations or pgschema, configure DATABASE_URL and TLS, scaffold files, create the first typed query, and establish generated artifact ownership. Use for adoption, initialization, onboarding, or first-query setup.
---

# sqlx-js project setup

Establish one schema authority and one reproducible query-generation loop.

## Workflow

1. Verify PostgreSQL, runtime, TypeScript, and ESM compatibility.
2. Inspect the existing schema owner before scaffolding.
3. Install `@onreza/sqlx-js`, the supported TypeScript peer, and the fallback
   Temporal provider unless every target runtime exposes native Temporal.
4. Run `init` with the selected schema and Temporal providers.
5. Configure a development `DATABASE_URL` without committing credentials.
6. Build the proposed schema in a disposable shadow database.
7. Write one literal typed query and run strict prepare.
8. Include generated declarations in TypeScript and commit reproducible
   artifacts.
9. Add the provider-aware CI gate through `sqlx-js-ci`.

Read [the setup checklist](references/setup-checklist.md) before modifying an
existing project.

## Boundaries

- PostgreSQL 16+, ESM, and the supported Node/Bun/Deno baselines are required.
- Do not introduce a second schema authority.
- Do not point automatic shadow workflows at retained data.
- Keep TypeScript as a development dependency when production does not scan
  source.
- Keep the default adaptive scaffold paired with its `temporal-polyfill`
  dependency. Omit it only with `--temporal-provider native`.
- Keep `.env` out of version control; commit `.env.example` without secrets.
- Commit `sqlx-js-env.d.ts`, `.sqlx-js/`, and configured generated enum output.
- Keep the generated-file markers added by `init`; for an existing project,
  apply missing markers locally with `sqlx-js doctor --fix` before committing.
- Use `sqlx-js-query-api` after setup and `sqlx-js-schema-workflows` for
  ongoing DDL changes.
