---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/studio": minor
---

A session can have its own model (optional Host feature `session-model`). `PUT /v1/sessions/{id}/model` chooses one of a connected provider's models for that session's turns, `DELETE` clears it, and `GET` answers the model the next turn uses (`source: "session"` or `"tenant"`). The Tenant's model and every other session's stay as they are. The Model Gate calls the session's model on its provider's credential (a refreshed OAuth credential is written back to that provider), `turn.start.model` describes it, and the usage ledger records it. A choice names a connected provider and a model its catalog lists, is set by the application only (a trusted issuer's token can read it, not change it), and is refused while a turn runs or waits (`409 session_busy`); while its provider is disconnected the session uses the Tenant's model. The SDK adds `session.model()`, `setModel({ provider, model })` and `clearModel()`.

Studio's model picker under the message box now sets the model of that session only, instead of the Tenant's: "Tenant model" clears the session's choice, the picker is locked while a turn runs, it groups models by provider, and its search keeps what is typed. A Runtime without `session-model` shows no picker.
