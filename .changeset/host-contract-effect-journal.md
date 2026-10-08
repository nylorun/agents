---
"@nylorun/harness": patch
---

**Docs: who journals effects.** `HOST_CONTRACT.md` no longer says Restate journals effect boundaries. The Runtime journals each effect in the Session Store under the advance's lease, and Durable Session Execution (Restate) only runs one advance per session at a time and delivers wakes and timers.
