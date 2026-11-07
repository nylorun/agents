---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/studio": patch
---

Queued messages no longer wait for good (Host feature `queue-recovery`). When a turn ends and its
Agent refuses to start the next one for the session's queued messages (its disk being copied, its
pod lost, the Agent deleted), the messages wait with the session's `queueStalled`, and the Tenant
sweep tries the start again (Host tuning `sweep.queueRetryMs`, 30 seconds), as does the end of the
Agent's disk copy. A message that has waited longer than the new Runtime limit `queuedStartMs`
(15 minutes) is removed with the new event `queue.failed` (`queue.start_expired`, with the
refusal's code as `reason`); a refusal no retry changes (a turn request the version no longer
resolves, another harness) fails the messages at once (`queue.start_refused`), and the messages
behind them are tried next. Before, nothing started such a queue until another message arrived.

On the A2A endpoint (profile v2), a queued task that fails is `TASK_STATE_FAILED` with a status
message saying why, in `GetTask`, its pushes and a blocking `SendMessage`. `CancelTask` on a queued
task now takes it out of the queue, whether a task runs in its context or not, and answers
`TASK_STATE_CANCELED` (the new event `queue.cancelled`), pushed; before, it was
`TaskNotCancelableError`.
