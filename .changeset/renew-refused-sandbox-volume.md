---
"@nylorun/runtime": patch
---

A pod whose sandbox can't take the Runtime's new template (Agent Substrate: its volumes would
change) gets a new volume automatically, from its latest disk version when it has one, instead of
failing every start until a reset. The sandboxes service reports `RepointRefused` for a running
request even when the actor has crashed, and the Runtime records `agent.reset` with reason
`template`. A new volume refused again fails with the reason, once.
