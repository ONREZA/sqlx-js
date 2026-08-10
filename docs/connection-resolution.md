# Unified connection resolution

This document is the implementation and release tracker for the P0 connection
resolver. Completion means that every sqlx-js-owned database consumer resolves
the same target and credential contract. A working `prepare` command alone is
not completion.

## Resolution contract

The precedence order is:

1. Typed runtime password options, including a dynamic provider for each new
   pooled connection.
2. Non-empty values in the PostgreSQL URL.
3. Supported PostgreSQL environment variables for values omitted from the URL.
4. The first matching password-file entry when no password was supplied.
5. sqlx-js defaults.

Within a URI, keyword query parameters such as `host`, `port`, `user`,
`password`, and `dbname` override the corresponding authority components, as
they do in libpq. `connect_timeout` accepts positive integer seconds; the
internal client and libpq subprocess adapters share a 15-second default.

The URL and environment resolver supports `host`, `hostaddr`, `port`, `user`,
`password`, `dbname`, `passfile`, `sslmode`, `sslrootcert`, `sslcert`, `sslkey`,
`application_name`, `options`, and `connect_timeout`. The URL additionally
supports sqlx-js's `role` and millisecond `statement_timeout` settings. The
libpq/JDBC-compatible URI alias `ssl=true` maps to `sslmode=require` and cannot
be combined with a weaker mode. The
environment names are `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
`PGDATABASE`, `PGPASSFILE`, `PGSSLMODE`, `PGSSLROOTCERT`, `PGSSLCERT`,
`PGSSLKEY`, `PGAPPNAME`, `PGOPTIONS`, and `PGCONNECT_TIMEOUT`.
Known libpq policy variables and URL parameters outside this supported set fail
during resolution instead of affecting only a subprocess or being silently
ignored by the wire client. Unrelated application parameters such as Prisma's
`schema` remain outside connection resolution. Session-only `PGDATESTYLE`,
`PGTZ`, and `PGGEQO` values are removed from subprocess adapters because
sqlx-js owns those runtime invariants.

`sslrootcert=system` delegates trust roots to the active runtime and requires
`sslmode=verify-full`; when the mode is omitted, the resolver selects
`verify-full`. A file-backed root certificate with `sslmode=require` enables CA
verification, matching PostgreSQL's compatibility behavior.

`hostaddr` is the numeric IPv4 or IPv6 TCP endpoint. `host` remains the logical
identity used by TLS verification and password-file matching. When only
`hostaddr` is supplied, its IP is used for all three identities. Multiple hosts
and Unix-domain sockets are outside this P0 contract.

Password files use the PostgreSQL five-field
`host:port:database:user:password` format. Matching is first-entry-wins,
supports `*`, and honors backslash escaping for `:` and `\`. `PGPASSFILE` or
the URL `passfile` setting overrides the platform default (`~/.pgpass` on Unix,
`%APPDATA%\postgresql\pgpass.conf` on Windows). Unix password files with any
group or world permission bits are rejected before authentication. Passwords
are never included in target summaries or diagnostics.

## P0 implementation tracker

### Resolver and security invariants

- [x] One resolver owns URL parsing, supported environment fallbacks, defaults,
  subprocess environment rendering, and password-file lookup.
- [x] URL and typed values take precedence without allowing ambient environment
  settings to replace an explicit target or password.
- [x] TCP routing, TLS identity, and password-file identity are represented
  separately and covered by regression tests.
- [x] `verify-full` uses the logical host while TCP and cancellation use
  `hostaddr`.
- [x] Password-file first-match, wildcard, escaping, default-path, and Unix
  permission behavior are implemented without logging secrets.
- [x] Internal wire password and TLS file reads are asynchronous and remain
  inside the end-to-end connection deadline.
- [x] Dynamic runtime password providers still resolve once for every new
  connection and override URL, environment, and password-file sources.
- [x] Prepare sessions and managed runtime clients resolve their target once;
  validation workers and replacement pool generations cannot drift after a
  later process-environment change.
- [x] Single-host TCP is explicit; unsupported multi-host inputs fail during
  resolution instead of being partially interpreted.

### Consumer coverage

- [x] Prepare, prepare verify, prepare watch, and connection-profile workers.
- [x] Doctor, schema snapshot, and JSON audit.
- [x] Built-in migrate run/revert/repair paths and runtime startup migrations.
- [x] Automatic, admin, configured, and materializer shadow-database paths.
- [x] Raw and managed runtime pools, replacement generations, and cancellation.
- [x] `pg_dump` subprocesses receive the same `PGHOST`/`PGHOSTADDR`, identity,
  TLS, timeout, password-file, statement-timeout, UTF-8, UTC, and ISO settings
  without inheriting the raw `DATABASE_URL`.
- [x] `pgschema` receives the resolved endpoint and password. Its process cannot
  repeat password-file lookup after the shared resolver, and its upstream
  single-host DSN cannot express a separate TLS server name. Therefore,
  a distinct `hostaddr` and `host` fails before the provider runs for every TLS
  mode, with guidance to use a hostname-preserving path or the built-in
  workflow. `sslmode=disable` remains available only for a trusted path.
  Passthrough arguments cannot replace the resolved application target,
  credentials, schema, or desired file. The separate disposable plan database
  remains upstream pgschema-owned: `PGSCHEMA_PLAN_*` and `--plan-*` are passed
  through and do not participate in sqlx-js target resolution.
  Upstream pgschema owns its fixed `application_name=pgschema` and 30-second
  connection timeout. Explicit target `application_name`, `options`, `role`,
  and `statement_timeout` settings fail before execution because pgschema
  cannot scope them independently from its second plan-database connection.

### Target diagnostics

- [x] Live prepare and verify inspect `current_database`, `current_user`, server
  version, `search_path`, current schema, and non-system function/enum counts.
- [x] Human summary output includes the sanitized target on success, query
  failure, and fatal validation errors raised after target inspection.
- [x] Prepare JSON and watch JSONL expose the target as structured fields.
- [x] Target output contains neither the network host nor credentials.

### Verification gates

- [x] Resolver, password-file, TCP endpoint, TLS fail-closed, connection-loss,
  cross-runtime auth/TLS, and watch tests.
- [x] Full Bun unit and PostgreSQL integration suite.
- [x] Example TypeScript check and runtime-boundary test.
- [x] Packed Node/Bun and Deno database smoke tests.

## Explicitly outside P0

The resolver is not a promise to clone all of libpq. Multi-host failover,
`target_session_attrs`, service files, Unix-domain sockets, GSSAPI, channel
binding policy, arbitrary libpq keyword parameters, and a custom socket factory
remain unsupported until a concrete consumer establishes their ownership and
acceptance tests.

Native `hostaddr` plus a distinct TLS identity and SNI name in the pgschema
provider requires an upstream pgschema connection API that represents both
values. sqlx-js's P0 contract is to preserve security by refusing that
combination for TLS modes, not to downgrade verification or patch DNS globally.

[Documentation index](./README.md) · [Roadmap](../ROADMAP.md)
