---
"@nylorun/runtime": patch
---

A model call whose stream was cut before its terminal chunk is tried again. Vercel AI Gateway ends a stream with `Upstream stream ended before terminal chunk` when the provider behind it fails after the stream began (a provider's 503, `finish_reason: stream_terminated`). pi-ai's retry list doesn't know that wording, so the call failed `invalid_request` on its first attempt and ended the turn: on beta, six Worker turns of 76 s to 13 minutes were lost this way to one provider's 503. The gate now retries it like any transient error, up to the Tenant's `modelAttempts` (3 by default) with `modelRetryDelayMs` between attempts. A call cut on every attempt fails `transient` (`retryable: true`), not `invalid_request`.

Retries are visible: the gates service logs a `model_retry` line for each one (session, effect, attempt, delay and the provider's error, cut to 300 characters), and its `model_call` line carries the call's `attempts`.
