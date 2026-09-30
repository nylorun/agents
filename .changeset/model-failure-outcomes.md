---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/cli": patch
---

**Model calls don't strand sessions.** A model provider failure is now a known outcome, not a lost call. The Runtime retries what can be retried, and otherwise fails the turn with `model.<code>`, so the session accepts the next message instead of sitting `uncertain` until it is cancelled.

- **Runtime.**
  - **Upgrade.** The model adapter moves to pi-ai 0.99.1 and always streams.
  - **Per-call settings.**
    - Every call carries the session id, so OpenAI and other providers reuse the prompt cache and route to the same backend.
    - Provider auth no longer reads the process environment.
    - Rate limits, overloads, timeouts and transient errors are retried: 3 attempts with backoff, honouring `Retry-After`.
    - A stream that produces nothing for 300 s is aborted and retried. `TenantConfig.modelCall` sets attempts, backoff, the idle timeout and the request timeout.
  - **Failures.** Anything else fails the turn with one of these codes:
    - `model.context_overflow`, `model.rate_limited`, `model.overloaded`, `model.timeout`, `model.transient`
    - `model.content_policy`, `model.auth` (whose message says where to fix the credential)
    - `model.invalid_request`, `model.invalid_output`

    Only a call whose outcome was lost, such as a Worker dying mid-call, is still `uncertain`.
  - **Structured output.** A structured final answer is repaired (control characters, a Markdown code fence) before it is parsed.
  - **Model history.** Replayed history keeps the model that produced each message, so a model switch no longer sends one model's signatures or tool-call ids to another. Reasoning from OpenAI-compatible servers (`reasoning_content`, `reasoning`) is sent back only within the turn that produced it.
- **Events.**
  - `message.assistant` adds `model` (`provider`, `model`), `finishReason` and `usage`.
  - A new `model.failed` transcript event (`code`, `message`, `retryable`) is written instead of `message.assistant` when a call fails.
- **Core and harness.**
  - New types and helpers: `ModelFailureOutcome`, `ModelFailureCode`, `MODEL_FAILURE_CODES`, `isModelFailureOutcome`, `ModelProducer`.
  - `PromptItem` assistant messages may carry `producer`.
  - `ModelUsage` adds `cacheWriteTokens`.
  - A model adapter may return a failure outcome.
  - The durable engine version is `hosted-3`: a turn that is running when the Runtime is upgraded fails once with `execution.incompatible`, and the next message works.
- **CLI.**
  - `nylo configure` passes a stable installation id to OAuth logins that need one (OpenAI "Sign in with ChatGPT"), stored as `cli-installation-id` in the Host root.
  - A custom OpenAI-compatible provider now prompts for its API key instead of failing.
