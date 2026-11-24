---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/admin": minor
---

A computer's awake time is recorded, and an idle computer waits for a command that outlives its turn.

- **`agent.resumed`.** Each time a pod becomes ready (its first start, a resume, a restart, or a move off a draining worker, cause `drain`, written with the drain's `agent.suspended`), its Agent's stream gets `agent.resumed`. Its awake time ends at the same Agent's next `agent.suspended`, `.failed`, `.lost`, `.reset`, `.deleted`, `.start_failed` or `.resumed`; an event's `time` is its commit time.
- **`GET /v1/tenant/agent-events`** (management key; `client.tenant.exportAgentEvents()` in `@nylorun/admin`) exports every Agent's events in safe transaction order, filtered by `types`, resumable from `next`, so an operator's meter can pair them into intervals. Migration 0051 adds `agent_events.txid` and its index. The Runtime meters nothing itself.
- **`GET /v1/activity`** on a computer (the computer agent and the engine's `--service computer`) answers `{ running, lastActivityAt }`. Before an idle suspend the Runtime asks it, and a computer with a command running, or one that started or ended within the idle period, stays awake until none has. A computer that can't answer (an older computer agent) is suspended as before.
- The disk measure before an idle suspend runs at most once an hour per computer, so a short `limits.idle` doesn't wait for `du` every time.
- Fixed: the idle timer could suspend a pod that had just become ready, before the Runtime saw it running.
