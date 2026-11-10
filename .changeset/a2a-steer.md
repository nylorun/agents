---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

A2A `SendMessage` takes `message.metadata.delivery: "steer"` (Host feature `a2a-steer`, ADR-140), a session message's steer (D85): to a busy context the message waits marked `steer`, and the running turn takes it before its next step, so its task becomes that turn's. To an idle context it starts a turn; to a workflow's, or a turn past its last step, it is an ordinary queued message. The task answered to a steer carries `metadata.delivery`: `steered`, or `queued` when the message started a turn or waits unmarked; callers that don't ask for steer get the same answer as before. `createA2aClient`'s `send` takes `delivery: "steer"`, and `readDelivery(task)` reads what applied.
