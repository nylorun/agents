---
"@nylorun/runtime": minor
"@nylorun/core": minor
"@nylorun/agents": minor
---

Model roles (ADR-154, Host feature `model-roles`): `AGENT.md` may declare `roles`, a map from a role's name to a model (`<provider>/<model>`), compiled into `harness.roles` beside `model`. A session opened with `role` (`PUT /v1/sessions/{id}`, `client.createSession({ role })`, or an A2A message's `metadata.role` when it opens the context) runs on that role's model, through the same checks as `harness.model`; its model record says `source: "role"` and the role. A role the version does not declare is `400 unknown_role`. The JSON Schemas are republished as `agent-manifest/v8.5`, `harness-manifest/v1.5` and `agent-folder/v1/agent-md.5`.
