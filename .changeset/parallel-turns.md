---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"nylorun": minor
---

**Sessions on one Environment run their turns at the same time, and egress is recorded on the Environment (protocol 14, D66, D67).** A second session's turn on an Environment was refused with `409 environment_busy` until the first ended. Now any session on it may start a turn while others run; one turn per session stays. Which sessions work on one disk, and when, is the app's call. See MIGRATION.md, "Parallel turns, and egress on the Environment".

- **Turns.** `checkEnvironmentTurn` no longer refuses a turn because another session's turn runs, and the flow-tree exception is gone. `environment_busy` still answers stop, reset, snapshot and restore while any turn runs, and a turn while a disk copy runs.
- **Egress.** Every connection through egress-gate, allowed or refused, is `environment.egress` on the Environment's stream, with `runningTurns: [{ sessionId, turnId }]`, the turns running when it opened (at most 16). `egress.connection` leaves the session event catalog, and turn traces carry no `CONNECT` span.
- **Reading it.** `GET /v1/environments/{id}/events` takes `types` (comma-separated), `since` and `until` (ISO times); `client.environments.events(id, { types, since, until })` in `@nylorun/agents`, and `nylorun environments events <id> --types --since --until`.
- `@nylorun/core`: `EgressRunningTurnSchema`, `EgressRunningTurn`; `EgressConnectionPayloadSchema` gains `runningTurns`.
