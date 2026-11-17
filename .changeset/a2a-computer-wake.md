---
"@nylorun/runtime": minor
---

An A2A task reports its computer waking (ADR-154 R3): a computer's `environment.state` `creating`, then `running`, reaches the caller as a `TASK_STATE_WORKING` update with `metadata["environment.state"]` (`{ state, backend: "computer" }`), so a client can show the wait for a task's first command.
