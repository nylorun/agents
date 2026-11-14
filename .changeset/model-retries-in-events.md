---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

A model call's retries are in its event. `message.assistant` and `model.failed` carry `attempts`, the provider calls the gate made for the call (the first included), and `retries`, one `{ attempt, delayMs, error }` for each retry (the error as the provider worded it, cut to 300 characters, with the provider's credential scrubbed). Before, a call that answered after a retry was one `message.assistant` that showed no sign of it, and a call that failed after its attempts showed only its last error; the retries were only in the gates service's `model_retry` log lines.

- `@nylorun/core`: `ModelRetrySchema`, and the optional `attempts` and `retries` on the facts `message.assistant`, `model.failed` and `context.compacted` share. `ModelFailureOutcome` takes optional `attempts` and `retries`.
- `@nylorun/runtime`: the gate's answer reports them in `evidence.extras`, the usage ledger keeps them (`model_usage.attempts` and `retries`, store migration 0047, nullable, run at start), and the call's event takes them from its row; a failed call's from its failure outcome. A trace's chat span has `nylorun.model.attempts`. A retried call is still metered once, as one call. `/calls/model` is unchanged.
