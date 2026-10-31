---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": patch
---

An agent manifest names the model its agent runs on (Host feature `agent-model`).

- **`harness.model`**: `<provider>/<model>`, such as `anthropic/claude-sonnet-4-5` (the provider's id, a `/`, then the model's id, which may hold a `/`; at most 200 characters). In an agent folder it is `model:` in `AGENT.md`'s frontmatter; the compiler refuses any other shape (`value_invalid`) and a `model` in an agent under `agents/`, which runs on the root agent's. `harness.manifest.json` takes it too, and the composer keeps it.
- **A new session starts on it.** A session opened on a version that names a model gets it as its own model (`GET /v1/sessions/{id}/model` answers `source: "session"`), as `PUT /v1/sessions/{id}/model` would choose it, when the provider is connected and its catalog lists the model. Otherwise the session has none and the Tenant's model applies; nothing fails. Sessions opened by the A2A server and by triggers get it too. An explicit choice still replaces it, and an open session keeps its model across versions.
- `agentModelChoice` and `AgentModelSchema` in `@nylorun/core/contracts`.
- The JSON Schema documents that gained the field are published at new ids: `agent-manifest/v8.1.json`, `harness-manifest/v1.1.json` and `agent-folder/v1/agent-md.1.json`; the old ids are retired. `manifestSchemaVersion` stays 8.
