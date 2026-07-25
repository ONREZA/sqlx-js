# Runtime evidence protocol

## Benchmark controls

The benchmark supports:

- `SQLX_JS_BENCHMARK_DATABASE_URL`
- `SQLX_JS_PG_IMAGE`
- `SQLX_JS_BENCHMARK_WARMUP_MS`
- `SQLX_JS_BENCHMARK_DURATION_MS`
- `SQLX_JS_BENCHMARK_ROUNDS`
- `SQLX_JS_BENCHMARK_SCENARIO`
- `SQLX_JS_BENCHMARK_DRIVER`

Keep these identical across comparisons. Use the median across multiple rounds
and retain the final JSON output.

## Comparison contract

The harness compares managed sqlx-js, raw sqlx-js, and a Postgres.js control.
Prepared statements are disabled for the control. Automatic pipelining is a
separate scenario because sqlx-js deliberately keeps serial physical
connections.

## Reliability result

Record:

- successful operations;
- expected injected faults by class;
- unexpected errors with first root cause;
- recovery and subsequent successful work;
- PostgreSQL backends remaining after cleanup.

An expected fault is not a passing result unless recovery and cleanup also
match the contract.

## Release boundary

Local unit, integration, benchmark, soak, and chaos gates are implementation
evidence. CI, live TLS/auth coverage, staging soak, canary, published package,
and rollback readiness remain separate release evidence.
