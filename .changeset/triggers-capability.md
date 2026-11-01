---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"nylorun": minor
---

The triggers capability (Host feature `agent-triggers`): an agent-folder/2 folder declares `engine: { triggers: true }` (the root agent's only; `engine.instructions.triggers` replaces its wording), which compiles to `harness.engine.triggers` and offers the root agent the `triggers` tool (`list`, `create`, `delete`) and the text block `triggers@1`. The Runtime serves each call as a `runtime` effect (operation `triggers`, `turn.start.agent.triggers`, Harness API v5.3): a trigger an agent makes is the Agent's (`origin: "agent"`, with its title and the session that made it), runs in the calling session (`session: "this"`) or one of its own (`"own"`, `<session>_t_<id>`), is checked against the limits in force (`runtime.limits.triggers` within the Tenant's), survives upgrades and waits paused while a version lacks the capability; a turn a trigger started can't create one. Tool rules take `kind: "runtime"`, so an `ask` rule can hold a `triggers` call (its interaction carries `metadata.input`); `DELETE /v1/agents/{id}/triggers/{triggerId}` deletes an agent's trigger (`409 trigger_from_manifest` for a manifest's); `GET /v1/runs/stream` serves the Tenant's runs as server-sent events from a cursor (`410 cursor_expired` across a reset). `client.agents.deleteTrigger`, `client.runs.stream` and `nylorun agents triggers rm` follow. The JSON Schemas are republished as `agent-manifest/v8.3`, `harness-manifest/v1.3`, `runtime-manifest/v1.2`, `agent-folder/v1/agent-md.3`, `agent-folder/v1/runtime.2` and `harness-api/v5.3`.
