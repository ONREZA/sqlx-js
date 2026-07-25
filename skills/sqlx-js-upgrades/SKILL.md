---
name: sqlx-js-upgrades
description: Plan, execute, or document an sqlx-js dependency upgrade, public API migration, cache or generator revision change, and generated artifact regeneration. Use when upgrading versions, encountering incompatible cache guidance, changing a generated contract, writing an upgrade guide, or validating consumer rollout and rollback.
---

# sqlx-js upgrades

Treat source API, runtime behavior, and committed generated artifacts as one
versioned compatibility surface.

## Consumer upgrade workflow

1. Record current and target package versions and runtime baselines.
2. Read every applicable guide under `docs/upgrades/`.
3. Update package and option/API usage.
4. Run one live prepare when cache or catalog revisions changed.
5. Review regenerated declarations, caches, enum output, and function warnings.
6. Run offline checks, TypeScript, tests, build, and package smoke tests.
7. Roll out with explicit rollback and old/new artifact boundaries.

## Maintainer compatibility workflow

1. Identify whether a change affects public types, runtime values, cache
   artifacts, generator output, or CLI behavior.
2. Prefer backward-compatible reading or migration where sound.
3. When incompatible before 1.0, bump the relevant revision and fail with
   actionable regeneration guidance.
4. Add a versioned upgrade guide for required consumer action.
5. Cover stale artifact behavior and fresh regeneration in tests.

Read [the compatibility checklist](references/compatibility.md) before calling
an upgrade complete.

## Boundaries

- Do not edit committed generated artifacts by hand.
- Do not use `prepare --offline` when a live schema refresh is required.
- Do not describe local regeneration as a released package.
- Keep rollback instructions compatible with the old runtime and artifact
  format.
