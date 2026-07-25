# Benchmarks

The runtime benchmark is a regression and comparison tool. It is not a promise
that one driver will have the same ranking on every machine or workload.

## Run the benchmark

Install dependencies, ensure Docker is available, and run:

```bash
bun run benchmark:postgres
```

The package script builds the current worktree, starts an isolated
`pgvector/pgvector:pg18` container, verifies every operation before measuring
it, runs the scenarios, prints human-readable samples, emits a final JSON
summary, and removes the container.

Use an existing PostgreSQL instance instead:

```bash
SQLX_JS_BENCHMARK_DATABASE_URL=postgres://user:password@host/database \
  bun run benchmark:postgres
```

The supplied database is used as-is and is not removed.

## Compared clients

| Driver | Contract measured |
| --- | --- |
| `sqlx-js-managed` | Managed pool generations, runtime codec bootstrap, lifecycle, and query execution |
| `sqlx-js-raw` | Integrated raw pool and query execution |
| `postgres.js-serial` | Postgres.js with prepared statements disabled and `max_pipeline: 1` |
| `postgres.js-pipelined` | Postgres.js with prepared statements disabled and its default `max_pipeline: 100`; used only for the pipelined scenario |

Prepared statements are disabled in the Postgres.js comparison because
sqlx-js intentionally executes unnamed extended-protocol queries and does not
maintain a named prepared-statement cache. The pipelined scenario is shown
separately because automatic pipelining is also outside the sqlx-js runtime
contract.

## Scenarios

| Scenario | Pool / concurrency | Operation |
| --- | --- | --- |
| `simple-sequential` | 1 / 1 | One scalar parameter and one scalar row |
| `simple-concurrent` | 8 / 8 | The same query across concurrent connections |
| `simple-pipelined` | 8 / 32 | More concurrent operations than connections |
| `rows-100` | 8 / 16 | Decode 100 integer rows |
| `mixed-rows-100` | 8 / 16 | Decode 100 rows containing text, JSON, bytes, arrays, and bigint |
| `transaction-two-selects` | 8 / 16 | Begin, execute two parameterized queries, and commit |

Every measured window reports operations per second and p50, p95, and p99
operation latency. The final JSON contains every sample and the median for each
scenario and driver.

## Controls

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `SQLX_JS_BENCHMARK_DATABASE_URL` | isolated container | Use an existing PostgreSQL database |
| `SQLX_JS_PG_IMAGE` | `pgvector/pgvector:pg18` | Select the container image |
| `SQLX_JS_BENCHMARK_WARMUP_MS` | `1000` | Warm-up duration per sample |
| `SQLX_JS_BENCHMARK_DURATION_MS` | `3000` | Measurement duration per sample |
| `SQLX_JS_BENCHMARK_ROUNDS` | `3` | Number of alternating-order rounds |
| `SQLX_JS_BENCHMARK_SCENARIO` | all | Run one scenario by exact name |
| `SQLX_JS_BENCHMARK_DRIVER` | all | Run one driver by exact name |

For example, isolate mixed row decoding:

```bash
SQLX_JS_BENCHMARK_SCENARIO=mixed-rows-100 \
SQLX_JS_BENCHMARK_ROUNDS=5 \
SQLX_JS_BENCHMARK_DURATION_MS=10000 \
  bun run benchmark:postgres
```

## Interpreting results

Record the CPU, operating system, runtime versions, PostgreSQL image or server,
container setup, and all non-default controls with published results. Compare
commits on the same idle machine and keep the database path identical.

Short local runs are useful for detecting large regressions, not for small
percentage claims. Increase warm-up, duration, and round count for a release
comparison. Treat throughput and tail latency together; a higher operation
count does not compensate for unacceptable p99 behavior.

The harness measures a narrow client/runtime path. It does not model
application query complexity, production network latency, TLS, authentication,
lock contention, cache hit rates, data distribution, or failure recovery. Use
the runtime soak and chaos scripts for lifecycle and fault behavior:

```bash
bun run test:runtime-soak
bun run test:runtime-chaos
```

[Documentation index](./README.md)
