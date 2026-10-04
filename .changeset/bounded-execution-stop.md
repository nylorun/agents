---
"@nylorun/runtime": patch
---

**Closing a Tenant no longer hangs on work that ignores its abort.** `MemoryExecution.stop()` and `RestateExecution.stop()` now abort running handlers and wait for them only up to a stop grace (`stopGraceMs`, default `DEFAULT_STOP_GRACE_MS`, 30 s), then abandon the ones still running. Before, `stop()` waited without a limit, so `TenantRuntime.close()` hung in its first step (`detach`) before its bounded `idle` step could run. Shutdown semantics are unchanged: work is aborted as a `shutdown`, and an abandoned advance's lease lapses so the next advance takes the session over. A Tenant that owns its execution uses its advance grace period as the stop grace; the Restate Worker logs a warning when it abandons handlers and drops their connections, so Restate retries them.
