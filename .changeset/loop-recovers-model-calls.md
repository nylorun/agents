---
"@nylorun/runtime": minor
---

**A runtime that dies or restarts mid-call no longer strands the session.** With the gates service, a model call keeps running at the gateway when the runtime that sent it is killed or shut down. The runtime that takes the session over re-sends the journaled call and joins it, or collects its outcome, so the turn completes with one provider call instead of becoming `uncertain`.

- Takeover leaves a model effect `invoking` when the gate recovers calls, and a shutdown no longer marks the call `uncertain`. Other effects, and a Runtime that calls models in its own process (embedding, tests), keep the previous behaviour.
- A cancel still stops the provider request, and still marks the turn's model call `uncertain`.
