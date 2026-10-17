---
"@nylorun/core": minor
"@nylorun/agents": minor
"@nylorun/runtime": minor
"@nylorun/studio": minor
"nylorun": minor
---

Session usage as one ledger (protocol 18). The usage ledger keeps each model call's cost by token kind (uncached input, cache read, cache write, output) at the prices the adapter applied (migration 0037). For a protocol 18 client, `GET /v1/sessions/{id}/calls/model` returns each call's `startedAt`, `endedAt` and `usage.costSplit` (null for a call recorded before), and `GET /v1/sessions/{id}/usage` adds `costSplit` with `splitCalls`, and the calls' durations added up as `modelTimeMs` with `timedCalls`. A protocol 16 or 17 client reads usage as before. Studio's Usage tab is rebuilt on them: a Session card with one tokens bar and a ledger of tokens and cost by kind adding up to a total row, then the model calls grouped by turn with the same columns (cached, uncached, output, total, time, cost), and a row menu whose View event opens the call's event in the Events tab.
