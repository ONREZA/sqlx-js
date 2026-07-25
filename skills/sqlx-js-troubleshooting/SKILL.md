---
name: sqlx-js-troubleshooting
description: Classify and diagnose ambiguous sqlx-js failures across installation, configuration, scanning, prepare, PostgreSQL connectivity, generated artifacts, schema workflows, profiles and RLS, runtime execution, codecs, CI, upgrades, and releases. Use when the user reports a sqlx-js error or hang without a clear owning subsystem.
---

# sqlx-js troubleshooting

Find the first failing ownership boundary before editing code or configuration.

## Triage workflow

1. Capture the exact command or API call, version, runtime, PostgreSQL version,
   config, and first complete error.
2. Reproduce with the narrowest read-only or disposable environment.
3. Run `doctor --json` when project-level configuration and database state are
   involved.
4. Classify the phase using [the failure map](references/failure-map.md).
5. Read the matching specialized skill before proposing a fix.
6. Separate root cause, supported workaround, and required permanent change.
7. Verify the same boundary that failed.

## Evidence rules

- Prefer current checkout, generated artifacts, CLI help, server SQLSTATE, and
  logs over remembered behavior.
- Do not mutate schema or target data during diagnosis unless explicitly
  authorized.
- Do not call a conservative generated type a bug until PostgreSQL metadata and
  SQL provenance prove a stronger contract.
- Do not call reconnect a retry or assume dispatched SQL is safe to replay.
- Do not interpret RLS planning checks as proof of runtime policy expressions.
- When the issue belongs to a consumer's schema, proxy, credentials, or
  authorization model, keep ownership there rather than masking it in sqlx-js.
