---
"@nylorun/runtime": patch
---

A queue left waiting now starts. When a turn ended while its Agent couldn't take another (its disk being copied, its owner guard), the queued messages waited for the next message, which might never come: an A2A task stayed `SUBMITTED` for good. The Tenant sweep now starts the queue of an idle session holding messages older than `sweep.queueGraceMs` (30 s), and logs a start refused again once per session, with the refusal.
