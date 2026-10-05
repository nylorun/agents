---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

Add optional session reads and resumable model-ledger export on the protocol-7 baseline: pinned manifests, usage totals, model calls, and opt-in session/history/sandbox pages. Runtime reads use a separate bounded, read-only Drizzle pool. The additive migration preserves unknown legacy creation times and usage quality; ledger export uses safe transaction order without skipping committed rows. SDK page/export helpers discover `session-reads` and `calls-export`; legacy unpaged responses remain unchanged.
