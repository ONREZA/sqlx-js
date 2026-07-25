# Runtime performance tuning

sqlx-js intentionally spends more work during development so prepared
application queries can remain small and predictable at runtime. Runtime
optimization must preserve the reliability boundary: serial connections,
explicit cancellation, unknown outcomes after a dispatched connection loss,
bounded shutdown, and managed pool generation recovery.

The target is not to win every synthetic benchmark. It is to remove work that
prepare has already completed and leave only PostgreSQL I/O, value
encoding/decoding, pool dispatch, and required lifecycle handling in the hot
path.

## Current boundary

The raw client owns wire encoding, connection serialization, pool dispatch,
authentication, cancellation, and reconnecting idle work onto a fresh
connection. The managed client additionally owns codec bootstrap, operation
deadlines, active-operation tracking, pool generation replacement, lifecycle
events, and bounded shutdown.

Query IDs and named-parameter rewriting are cached after the first occurrence
of a SQL string. They are not expected to dominate steady-state execution.
Parameterized queries still discover their PostgreSQL parameter OIDs before
binding values because database-local enums, domains, composites, arrays, and
custom serializers cannot safely use portable numeric OIDs.

## Priorities

Complexity and expected ROI use a relative 1-10 scale. ROI is a hypothesis
until an alternating A/B benchmark passes the acceptance gate.

| Work | Complexity | Expected ROI | Decision |
| --- | ---: | ---: | --- |
| Capture CPU and allocation profiles for one benchmark path | 2 | 9 | Do first |
| Benchmark `TextEncoder.encodeInto()` for Bind frames | 2-3 | 4 | Rejected by A/B |
| Share generation interruption state for operations without timeout or signal | 4 | 7 | Rejected by A/B |
| Emit a prepared runtime manifest and execute known queries in one wire round trip | 7-8 | 10 | Main architectural target |
| Merge managed operation state with driver dispatch state | 8 | 6-8 | Reconsider only after the earlier work |
| Precompile result row materializers | 5-6 | 3 | Defer while row-heavy paths are already competitive |
| Further optimize query IDs or named-parameter rewriting | 3 | 1 | Do not prioritize |

## Work sequence

### 1. Measure without production instrumentation

CPU and allocation sampling belongs in the benchmark harness. Production
runtime code must not gain tracing branches, counters, timers, or environment
lookups solely for performance investigation.

Profile a single driver and scenario after warm-up. Keep raw profile artifacts
so dispatch, parameter encoding, Bind-frame construction, row decoding, and
managed lifecycle functions can be compared between commits.

### 2. Test direct UTF-8 encoding

The Bind frame currently avoids fragmented frame concatenation but still
creates one encoded byte array per non-null text parameter. A bounded
experiment may use `TextEncoder.encodeInto()` to write into one over-allocated
frame and return its populated view.

Retain it only when reduced allocations translate into stable end-to-end
throughput or latency improvements. A smaller microbenchmark allocation count
alone is not sufficient.

### 3. Shorten the managed hot path

The managed runtime should select the shortest internal path that preserves
the configured contract:

- share generation interruption state when an operation has no individual
  timeout or `AbortSignal`;
- avoid lifecycle event construction when the corresponding hook is absent;
- keep only the active state required by generation poisoning and close drain;
- create individual timer and abort state only when configured.

This is not a user-facing unsafe mode. The managed client must retain generation
replacement, unknown-outcome reporting, and bounded shutdown.

### 4. Compile prepare output for runtime execution

The long-term prepared path should emit a portable runtime descriptor for every
known query:

- the rewritten positional SQL and stable query ID;
- parameter codec identities expressed by PostgreSQL type identity rather than
  database-local numeric OID;
- result column layout, cardinality, and output-name mapping;
- the connection profile that owns the query contract.

At pool generation bootstrap, the runtime resolves descriptor type identities
to that database's OIDs and compiles parameter encoders. A known query can then
send `Parse`, `Bind`, `Describe Portal`, `Execute`, and `Sync` in one write
without waiting for a separate `ParameterDescription`.

The first implementation should retain the server's actual
`RowDescription`. Omitting it saves little after the synchronization point is
removed and weakens schema-drift detection.

Dynamic `unsafe(...)` SQL remains on the adaptive describe path.

#### Descriptor delivery decision

The runtime cannot recover application-specific prepare artifacts from
TypeScript declarations after type erasure. The descriptor therefore needs an
explicit delivery contract:

1. Generate a portable TypeScript module and pass its exported descriptor map
   once to `createSqlClient(...)`. This is the recommended direction because it
   works with Node, Bun, Deno, bundlers, serverless packaging, and monorepos
   without runtime filesystem discovery.
2. Load `.sqlx-js/` implicitly from the current working directory. This keeps
   the call site shorter but makes packaged applications, multiple registries,
   `fileRoot`, and startup failures ambiguous. Do not choose this by default.
3. Rewrite query call sites through a compiler or bundler plugin. This can
   provide the smallest call site but adds a second transformation toolchain
   and is outside the current library boundary.

The generated module should use stable PostgreSQL type identities for
database-local types and may retain built-in OIDs. The runtime resolves those
identities once per pool generation, encodes all parameters before dispatch,
and includes the resolved parameter OIDs in `Parse`. PostgreSQL can then fail
closed if the prepared contract no longer matches the live schema while the
client still sends the complete unnamed extended-protocol operation in one
write.

### 5. Re-evaluate lifecycle ownership

Only if managed execution still has a material gap should driver dispatch
accept the operation deadline, abort signal, generation token, and lifecycle
state directly. This could remove duplicate promises and state transitions,
but it changes the central recovery boundary and therefore requires stronger
evidence than a micro-optimization.

## Acceptance gates

Use the same idle machine, PostgreSQL instance, workload, runtime version, pool
size, and concurrency for both revisions. Alternate baseline and candidate
order. Report throughput together with p50, p95, and p99 latency.

Keep a tactical hot-path optimization only when all of these hold:

- at least five alternating samples show a median improvement of 2% or more in
  its target scenario;
- no core scenario regresses by more than 2% median without an explained
  tradeoff;
- p95 and p99 do not show a material regression;
- the full runtime, authentication/TLS, package smoke, soak, and chaos gates
  remain clean.

For a managed lifecycle change, require at least a 5% managed improvement in
the target concurrent scenario or a reduction of at least one quarter of the
measured managed-to-raw gap.

For a prepared runtime descriptor, require protocol evidence that the separate
statement-describe synchronization point is gone. Throughput alone is not
enough to justify a new generated artifact and cache revision.

## Directions to avoid

Do not add any of the following without new evidence that changes their
risk/return balance:

- a SQL-string metadata cache without complete invalidation for reconnect,
  role, `search_path`, transaction settings, and DDL;
- skipping `ParameterDescription` without a prepared portable codec contract;
- named prepared-statement caches or automatic connection pipelining;
- broad PostgreSQL binary-protocol support;
- omitting `RowDescription` before the one-round-trip prepared path is proven;
- object or promise pooling, a custom timer wheel, or generated functions via
  `new Function`;
- separate Node, Bun, and Deno driver implementations;
- a managed `fast` option that disables timeout, cancellation, poisoning, or
  shutdown guarantees;
- automatic replay after a dispatched connection loss.

The lower-level `createClient(...)` remains the explicit boundary for callers
that choose to own lifecycle and recovery themselves.

## Experiment log

### 2026-07-25: benchmark profiler

The benchmark wrapper successfully captured Node CPU and allocation sampling
profiles without changing published runtime code. The first managed
`simple-concurrent` sample identified wire draining, result metadata,
null-terminated string construction, Bind-frame construction, pool dispatch,
and managed operation startup among the visible application frames.

This profile supports the prepared-descriptor direction: SQL and protocol
message construction remain visible alongside managed lifecycle work.

### 2026-07-25: direct `TextEncoder.encodeInto()`

The candidate wrote every non-null parameter into one over-allocated Bind
buffer and returned the populated view. UTF-8, null parameters, metadata, and
pre-dispatch cancellation tests passed.

Five alternating long samples against one isolated PostgreSQL instance showed
a 1.50% raw throughput improvement with better p95 and p99 latency. The
throughput result did not reach the 2% tactical acceptance gate, so the
candidate was removed.

### 2026-07-25: shared generation interruption

The candidate replaced per-operation deferred promises with one generation
interruption promise for managed operations that had no individual timeout or
`AbortSignal`. Transactions and individually interruptible operations retained
their original state. Existing timeout, abort, recycle, close, and transaction
tests passed.

Five alternating managed `simple-concurrent` samples showed a 2.01% throughput
regression. Small p95 and p99 improvements did not compensate for lower
throughput, so the candidate was removed. Further managed work should change
dispatch ownership rather than reshuffle equivalent promise machinery.

### 2026-07-25: prepared descriptor MVP

The MVP hard-coded the portable built-in `int4` OID for
`SELECT $1::int4 AS value`, serialized the value before dispatch, and retained
the live portal `RowDescription`. The benchmark substituted this path beneath
the existing raw and managed clients without changing their public APIs.

Captured frontend writes confirmed the protocol change:

- adaptive: `Parse + Describe Statement + Flush`, then
  `Bind + Execute + Sync`;
- descriptor: `Parse + Bind + Describe Portal + Execute + Sync`.

Five alternating 3-second samples on Node 24.12.0, PostgreSQL 18 in
`pgvector/pgvector:pg18`, and an AMD Ryzen 9 5900X produced these medians:

| Scenario | Client | Adaptive ops/s | Descriptor ops/s | Change |
| --- | --- | ---: | ---: | ---: |
| Local sequential | Managed | 7,384 | 11,649 | +57.75% |
| Local sequential | Raw | 7,579 | 12,241 | +61.50% |
| Local concurrent | Managed | 25,513 | 37,587 | +47.33% |
| Local concurrent | Raw | 28,260 | 42,719 | +51.17% |
| 2 ms RTT sequential | Managed | 220 | 436 | +97.91% |
| 2 ms RTT sequential | Raw | 221 | 437 | +98.10% |
| 2 ms RTT concurrent | Managed | 1,605 | 3,132 | +95.10% |
| 2 ms RTT concurrent | Raw | 1,621 | 3,188 | +96.60% |

At 2 ms simulated RTT, concurrent median p50 fell from 4.99 ms to
2.55 ms managed and from 4.95 ms to 2.51 ms raw. The removed synchronization
point therefore saves one complete network round rather than only local
JavaScript work.

The experiment passes the prepared-descriptor gate and justifies implementing
portable descriptor generation and per-generation type resolution. It does
not validate database-local type identities, artifact delivery, schema drift,
profile binding, or stale-contract diagnostics; those remain required before
the path can serve application queries.

[Benchmark methodology](./benchmarks.md) · [Runtime contract](./runtime.md) ·
[Documentation index](./README.md)
