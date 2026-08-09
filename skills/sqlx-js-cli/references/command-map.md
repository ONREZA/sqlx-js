# Command map

Use current `--help` for exact flags. This file selects the command family and
records its ownership boundary.

| Command | Primary responsibility | Worktree writes | Target DB changes |
| --- | --- | --- | --- |
| `init` | Scaffold config, declarations, schema source, and scripts | Yes | No |
| `prepare` | Generate, watch, restore, or check query artifacts | Mode-dependent | Reads only |
| `dev` | Build configured schema in shadow and regenerate artifacts | Yes | No |
| `verify` | Build configured schema in shadow and compare artifacts | No | No |
| `ci` | Strict provider-aware verification | No | No |
| `doctor` | Audit runtime, config, DB, cache, RLS, and tooling | No | Reads only |
| `queries` | Read-only query inventory and audits | No | No |
| `snapshot` | Schema snapshot and manifest dump/check | `dump` | Reads only |
| `migrate` | Built-in migration source and target history | Subcommand-dependent | Subcommand-dependent |
| `pgschema` | Managed pgschema install, plan, and apply | Install cache only | `apply` |

## Prepare modes

- `prepare`: live generation against `DATABASE_URL`.
- `prepare --watch`: live incremental generation with a warm session.
- `prepare --check`: database-free committed artifact verification.
- `prepare --offline`: regenerate supported outputs from committed cache.
- `prepare --verify`: live comparison without worktree writes.

## Machine-readable output

- Prefer `--json` for one structured command result.
- Use watch JSONL only where the command explicitly supports it.
- Use `sqlx-js-diagnostics` to convert prepare JSON into GitHub or editor
  diagnostics.
- Keep stdout machine-readable; send explanatory logging through the command's
  supported diagnostic channel.
