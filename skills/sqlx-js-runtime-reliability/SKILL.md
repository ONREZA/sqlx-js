---
name: sqlx-js-runtime-reliability
description: Diagnose or modify the integrated PostgreSQL wire driver, raw pool, managed generations, cancellation, deadlines, reconnect behavior, transaction cleanup, lifecycle observers, and codec bootstrap. Use for runtime hangs, connection loss, timeouts, unknown outcomes, recovery, pg driver changes, or source under src/pg/driver.ts and src/postgres-runtime.ts.
---

# sqlx-js runtime reliability

Protect outcome certainty and connection ownership before optimizing throughput
or convenience.

## Workflow

1. Classify the phase: connect, authenticate, bootstrap, encode, dispatch,
   receive, transaction cleanup, or shutdown.
2. Determine whether application SQL was sent.
3. Preserve the outcome contract: `not_sent`, confirmed result/rollback, or
   `unknown`.
4. Reproduce with a focused lifecycle or fault test.
5. Change the narrowest owner: connection, raw pool, managed generation, or
   scoped transaction.
6. Verify normal operation, cancellation, collateral work, recovery, and
   backend cleanup.

Read [the reliability contract](references/reliability-contract.md) before
editing the runtime.

## Non-negotiable boundaries

- Never replay dispatched SQL after connection loss.
- Keep every physical connection strictly serial.
- Do not add automatic pipelining or named statement caches.
- A transaction owns one dedicated connection.
- Apply end-to-end deadlines before codec bootstrap and through cleanup.
- Retire a connection or generation when protocol synchronization or cleanup
  is unconfirmed.
- Keep raw and managed clients as distinct ownership boundaries.
- Resolve database-local codec OIDs once per managed generation and invalidate
  them with that generation.
- Do not trade cancellation correctness or database-local type behavior for a
  micro-optimization.

## Verification

Use targeted driver/runtime tests first. Then run the PostgreSQL integration
suite, runtime boundary, package smoke tests, and relevant soak/chaos gates.
Use `sqlx-js-runtime-evidence` to design or interpret performance and fault
evidence.
