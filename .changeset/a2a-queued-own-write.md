---
"@nylorun/runtime": patch
---

An A2A `SendMessage` with `returnImmediately` to a busy context answers `TASK_STATE_SUBMITTED` (#586), and `CancelTask` on a queued task answers `TASK_STATE_CANCELED` (#585), instead of `TaskNotFoundError` while the session's stream still lags behind the record. Both replies now wait, up to 5 s, for the stream to hold the request's own write, and a queued task's `GetTask` answers `SUBMITTED` from its queue row until then.
