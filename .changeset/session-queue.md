---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/harness": minor
"@nylorun/agents": minor
"nylorun": minor
---

Protocol 17, a queue per session (track T4, D76). A message sent while the session's turn runs or waits is queued (`{status: "queued", queuedMessageId, position}`, `message.queued`) and starts the next turn when this one ends, with every queued message, each its own user message (`queue.taken`); a cancel ends the turn, not the queue. `delivery: "reject"` keeps the refusal, now `409 session_busy`, and a protocol 16 client's messages default to it, so the Host serves protocol 16 and 17. The queue holds at most the Runtime limit `sessionQueuedMessages` (`429 queue_full`), and session reads count `queuedMessages`. Our engine takes `{kind: "messages", messages}` as a turn's input. The SDK's `input` and `inputParts` take `delivery`, and the CLI's `sessions send` takes `--reject-if-busy`. See MIGRATION.md.
