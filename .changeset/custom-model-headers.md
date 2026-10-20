---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/studio": patch
---

Headers for a custom model endpoint (#493). A custom endpoint's `settings` (`PUT /v1/tenant/model`) take `headers`, sent on every call, and `callHeaders`, whose values the Runtime resolves per call from the calling Agent: one of its labels (`{ from: "agent.label", key: "org" }`), its id (`agent.id`) or the session's owner when it is a person (`session.owner`). A source with no value sends no header. A Runtime that serves several orgs' Agents can then send each call's org (`x-nylorun-org` from the `org` label), so a model gateway attributes and budgets it while the call is made, in process and through the gates service alike. They are settings, read back by `GET /v1/tenant/model`: neither map may set `authorization`, a hop-by-hop or transport header, or `Nylorun-*`, and a name appears once across both. Studio keeps them when it saves the model.
