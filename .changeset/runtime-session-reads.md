---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/admin": minor
---

Add optional session reads and a resumable model-ledger export: pinned manifests, usage totals, model calls, and opt-in session/history/sandbox pages (Host feature `session-reads`), and `GET /v1/tenant/calls/model` on the Management API (Host feature `calls-export`). Usage and model calls take an application key acting as itself; the export takes a management key. Runtime reads use a separate bounded, read-only Drizzle pool. The additive migration `0012_session_reads` preserves unknown legacy creation times and usage quality; the export uses safe transaction order without skipping committed rows. `@nylorun/agents` adds `client.sessions.page()`, `session.manifest()`, `session.usage()`, `session.modelCalls()`, `session.history({ limit })` and `client.sandboxes.page()`; `@nylorun/admin` adds `models.exportCalls()`. Legacy unpaged responses are unchanged.
