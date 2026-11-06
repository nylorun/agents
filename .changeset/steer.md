---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

A message can steer a running turn (D85). `delivery: "steer"` on a `message` command, behind the
optional Host feature `steer`: to a busy agent session it waits in the session queue marked
`steer`, and our engine takes it into the running turn before its next step, after the tool
results, through a new effect kind, `inputs`, which core answers in the transaction that journals
it (Harness API 5, `harness-api/v5.4.json`). Each taken message's `command.message` is written
under the running turn, then `queue.taken` with the `step`. The queued answer and
`message.queued` say which delivery applied; a workflow session queues. A steer the turn doesn't
take starts the next turn like any queued message, and D76's defaults never choose steer.
