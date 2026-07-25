---
name: sqlx-js-runtime-evidence
description: Run and interpret sqlx-js runtime benchmarks, soak tests, chaos tests, authentication and TLS smoke tests, package runtime boundaries, and backend cleanup checks. Use for performance claims, regression baselines, fault injection, reliability evidence, canary planning, or requests mentioning benchmark, soak, chaos, latency, throughput, or unexpected backends.
---

# sqlx-js runtime evidence

Produce comparable evidence and keep performance, reliability, and release
claims separate.

## Select the gate

- Performance comparison: `bun run benchmark:postgres`.
- Sustained normal load: `bun run test:runtime-soak`.
- Expected connection and backend faults: `bun run test:runtime-chaos`.
- Authentication and TLS matrix: `bun run test:postgres-auth-tls`.
- Published runtime import boundary: `bun run test:runtime-boundary`.
- Packed Node/Bun or Deno behavior: package smoke scripts.

Read [the evidence protocol](references/evidence-protocol.md) before publishing
or comparing results.

## Workflow

1. Record commit, runtime, OS, CPU, PostgreSQL image/version, and environment
   controls.
2. Use the same database path and workload for compared commits/drivers.
3. Include warm-up and multiple alternating-order rounds.
4. Verify the operation result before measuring.
5. Capture throughput and tail latency, not one aggregate number.
6. Separate expected injected faults from unexpected errors.
7. Check backend cleanup after fault runs.
8. Report local evidence separately from CI, staging soak, canary, and release.

## Guardrails

- Do not publish short workstation results as universal rankings.
- Do not compare drivers with different prepared statement or pipelining
  contracts without naming the difference.
- Do not optimize away reliability instrumentation based on one microbenchmark.
- Do not call a runtime released because local chaos and package gates pass.
