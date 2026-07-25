# Contributing to sqlx-js

Thank you for helping improve sqlx-js. Issues, focused pull requests, test
cases, documentation fixes, and performance evidence are welcome.

## Before opening an issue

- Search existing issues and the [roadmap](./ROADMAP.md).
- Check [limitations and non-goals](./docs/limitations.md) for an intentional
  boundary.
- For upgrades, follow the relevant [upgrade guide](./docs/upgrades/README.md).
- Report security vulnerabilities privately according to
  [SECURITY.md](./SECURITY.md).

Use a minimal reproduction when reporting a bug. Include the sqlx-js,
PostgreSQL, runtime, and TypeScript versions; the relevant configuration and
SQL; the generated or runtime error; and the smallest schema needed to
reproduce it. Remove credentials and private data.

## Development setup

Requirements:

- Node.js 24 or newer
- Bun 1.3 or newer
- Deno 2.9 or newer for Deno package smoke tests
- Docker for the PostgreSQL integration suite
- PostgreSQL 16 or newer when using an external database

Install dependencies:

```bash
git clone https://github.com/ONREZA/sqlx-js.git
cd sqlx-js
bun install
```

`bun install` wires the repository's lefthook configuration. The optional
commit-message check uses Cocogitto:

```bash
cargo install cocogitto
# or: brew install cocogitto
```

## Make a focused change

Keep changes small and preserve the project's core boundaries:

- PostgreSQL-only, raw-SQL-first, and ESM-only.
- Prepare-time SQL and result validation; no runtime SQL parser or result-schema
  validator.
- Integrated prepare, migration, and runtime wire implementation.
- No automatic query replay after a dispatched connection failure.
- Generated artifacts are versioned compatibility contracts.

Source, tests, documentation, and commit messages are written in English. Add
comments only when they explain a non-obvious reason.

For a bug fix, first add a test that reproduces the supported behavior, then
implement the smallest fix. Do not add tests that only assert the absence of an
unrelated implementation technique.

## Verification

Run the narrowest relevant test while iterating, then the repository gates
appropriate to the change:

```bash
bunx tsc --noEmit
bun test tests --timeout 120000
bunx tsc -p example
bun run test:runtime-boundary
```

The integration suite starts PostgreSQL with Testcontainers and skips only when
Docker is unavailable. Runtime or packaging changes should also run:

```bash
bun run test:node-package
bun run test:deno-package
```

These package smoke tests require `DATABASE_URL`. Changes to inference should
run `bun run test:corpus`; changes to runtime failure behavior should run the
relevant soak or chaos script.

Documentation-only changes do not require the full database suite, but all
relative links and documented commands must remain valid.

## Commit and pull request

Use Conventional Commits with an imperative, lower-case subject no longer than
50 characters:

```text
fix(runtime): preserve transaction deadline
docs(readme): reorganize project guides
```

Explain what changed and why in the body when the subject is not sufficient.
Wrap body lines at 72 characters. Add issue references or `BREAKING CHANGE`
trailers in the footer.

Open a pull request with:

- the problem and intended contract;
- the chosen approach and important tradeoffs;
- verification commands and results;
- generated-artifact or upgrade impact;
- rollout and rollback notes when runtime behavior changes.

Releases are automated through release-please. Contributors should not edit the
package version or create release tags as part of an ordinary pull request.
