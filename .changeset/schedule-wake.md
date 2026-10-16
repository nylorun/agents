---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/harness": minor
"@nylorun/admin": patch
---

`schedule_wake` (track T4, D77). An agent manifest's `runtime.selfWake: true` offers the agent `schedule_wake`: `{in | at, note}` books its session's next turn, replacing the booking before, and `{cancel: true}` removes it. The Runtime serves the call in its own transaction (a new effect target, `{kind: "runtime", operation: "schedule_wake"}`, additive on Harness API 5; `turn.start.agent.selfWake` tells a harness to offer it), so a replayed turn books once. The booking fires as a trigger run of kind `wake`, its note the turn's message with `cause.kind: "self"`. New session events `wake.booked` and `wake.cancelled`, tool call kind `runtime`, and Runtime limits `wakeMaxAheadMs` and `wakeNoteChars`.
