---
"@nylorun/runtime": patch
---

Cancels and sessions resets reach the other Runtime processes over a control bus on Postgres, not S2's `tenant/control` stream, which is gone: nothing inside the Runtime depends on S2 any more. A cancel writes a `session.cancel` signal in its own transaction and Postgres notifies every process at commit (`LISTEN`/`NOTIFY` on `nylorun_control`), so a cancel aborts the Worker's model or tool call even while S2 is down. Each process holds one `LISTEN` connection of its own and reads recent signals back every 5 s and after a reconnect; connect the Runtime to Postgres directly or through a pooler in session mode. Migration `0015_control_signals` adds `nylorun.control_signals`; the Tenant sweep deletes signals older than an hour. While processes of the previous beta still run beside new ones, a cancel between them is stopped by the Session Store check before the next effect, as when a signal was lost.
