---
"@nylorun/runtime": patch
---

A failed A2A task gives the Runtime's own reason after the code, when there is one: "The agent failed (model.failed): Effect identity request drift." A caller can now tell a run that couldn't go on (effect drift, a lost lease, a stopping run) from a model that failed. A model's or a provider's message is still never passed on.

An effect that drifts on replay is logged ("effect drift on replay") with its session, turn, effect id and kind, and both request hashes. The request itself is never logged.
