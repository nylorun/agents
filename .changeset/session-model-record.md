---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

A session records the model its turns call and why (`SessionModelRecord`): `model` on `GET
/v1/sessions/{id}` is `{provider, model, source: "manifest" | "session" | "tenant", reason?,
requested?}`, with the fallback's `reason` (`provider_not_connected`, `not_in_catalog`,
`invalid_model`) and the model `requested` by the manifest or the session. It is set when the
session opens, chooses or clears its model, and again at each segment's start, and each change
writes the new `session.model` event with the `previous` record. `SessionView.model` in
`@nylorun/agents`.
