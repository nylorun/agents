---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

The Runtime keeps a turn index and serves it as a change feed (Host feature `turns`, A2A-E1 to E3).

- **The turn index.** Every turn has a row: its session, Agent, status (`running`, `paused`, `completed`, `failed`, `cancelled`), start, end, last change, totals and, for an A2A context, its context and task id. It is written in the same transaction as the event that changes the turn, so it always agrees with the session's log. Migration `0040_turn_index_backfill` indexes the turns already recorded when the Runtime first starts on this version.
- **`GET /v1/turns`** pages the turns in the order they changed: pass the page's `cursor` as `changedAfter` to read on (a turn comes again each time it changes, and the cursor comes back even when nothing changed), `limit` up to 500 (default 100). `sessionId` reads one session's turns, oldest first. An application key reads the whole Tenant; acting for a person, only their sessions' turns. A client that missed pushes catches up with one call per interval.
- **A2A `ListTasks`** is served: the caller's tasks with the Agent, latest status change first, filtered by `contextId`, `status` and `statusTimestampAfter`, paged with `pageSize` (up to 100, default 50) and `pageToken`, with `totalSize`; `historyLength` and `includeArtifacts` add each task's history and output. `GetTask`, `CancelTask` and replies read one turn's events through the index instead of the session's whole history.
- **A2A contexts are listable.** The session of a context now carries `info.a2a` (`contextId` and the subject); a context opened by an earlier version gets it with its next message. Its session id is still the one-way hash of the subject, Agent and context.
- `@nylorun/core` adds `TurnSummarySchema`, `TurnChangesPageSchema` and `TURN_STATUSES`.
