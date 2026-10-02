---
"@nylorun/runtime": minor
---

**A runtime that dies or restarts mid-call no longer strands the session (P1.2).** The loop sends each model call with its effect id as the `Idempotency-Key`, and the gate runs a keyed call under its own control: if the caller disconnects, the call finishes and its outcome is kept for 30 minutes. The runtime that takes the session over re-sends the journaled call and joins it, or collects its outcome, so the turn completes with one provider call instead of becoming `uncertain`. A shutdown no longer marks the call `uncertain` either.

- A re-send with the same key and a different request answers `409 gate_conflict`.
- A user cancel sends `POST /nylorun/v1/model-calls/{key}/cancel`, which stops the provider request, and marks the turn's model call `uncertain`.
- Outcomes live in the gateway's memory: a gateway restart forgets them. A Runtime that calls models in its own process (embedding, tests) keeps the previous behaviour.
