---
"@nylorun/runtime": minor
---

The outbox no longer stalls the Tenant sweep, holds up commands or loses a pod sandbox's signals, and Workers register versioned Restate deployments.

- A wake that keeps failing (Restate refuses it, or an older Runtime does not know its reason) is retried with backoff and, after ten failures, parked: logged once at error and kept in the outbox for an operator. It no longer fails the sweep, so Restate never pauses the Tenant's sweep object over it. Migration 0018 adds `attempts`, `retry_at` and `parked_at` to `nylorun.wakes`.
- The sweep drains the whole outbox and pages through every orphaned session in each pass, within a 2 s budget, instead of 100 rows per pass.
- A command's wake is sent after commit without the request waiting for it; a failed send is logged at warn and sent again by the sweep's next pass. The sweep's grace is compared on the database's clock and is now 30 s.
- A pod sandbox's reconcile and idle timer go through the outbox (migration 0019, `nylorun.sandbox_signals`), so a crash after commit no longer loses them, and a host revocation goes over the control bus (`host.revoked`), so it reaches every process with the Tenant open. `Tx.afterCommit` is removed.
- Sends to Restate's ingress use `@restatedev/restate-sdk-clients` 1.17.2, each with an idempotency key.
- A Worker registers `<NYLORUN_WORKER_URL>/nylorun/<version>`, the version being the new `NYLORUN_WORKER_VERSION` or the Runtime's own, without forcing in a container, so a rolling upgrade keeps the old deployment for the invocations it started. A build whose Worker code changed under the same Runtime version sets its own `NYLORUN_WORKER_VERSION`.
