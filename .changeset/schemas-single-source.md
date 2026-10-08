---
"@nylorun/core": minor
"@nylorun/harness": patch
"@nylorun/agents": patch
"@nylorun/runtime": patch
---

**One source of truth for the manifest and Harness API schemas.**

- `@nylorun/core`: `Agent.from` (`agentFrom`) checks a manifest with `AgentManifestSchema`, the Runtime's own check, instead of a validator of its own, and refuses with `agent.build-failed` and the schema's messages (each prefixed with its path, such as `capabilities.0.tools.0.name: …`). It now refuses what the Runtime refuses at registration and it let through, such as unknown fields (it dropped them) or a tool or MCP server name that not every model provider accepts. The schema names a top-level `model` or `schemaVersion` and a capability's `model` as before, and the skill whose `files` are wrong (`Skill 'triage' files must include SKILL.md`). The rebuilt manifest is a frozen copy; the object passed in is no longer frozen. `AgentManifestSchema` and `WorkflowManifestSchema` are no longer force-cast to their types: the build checks that each accepts exactly `AgentManifest` and `WorkflowManifest`. `@nylorun/core/contracts` exports `McpServerManifestSchema`, `HEADER_NAME_PATTERN` and `LOOPBACK_HOSTS`. The Harness API's types (`@nylorun/core/harness-api`) are inferred from the schemas that validate its frames, so they match them: `TurnStart.manifest`, `TurnStart.checkpoint` and `RunRouting.rootManifest` are `object`, `WorkspaceCall.tool` is a sandbox tool name, `ABORT_REASONS` is a tuple, and properties are no longer `readonly` (arrays that were stay so).
- `@nylorun/harness`: `runDurable` checks the manifest once, when it rebuilds the agent, instead of twice. The unpublished, stale `schemas/manifest.schema.json` (manifest `schemaVersion` 2) is gone; `z.toJSONSchema(AgentManifestSchema)` is the manifest's JSON Schema.
- `@nylorun/agents`: a plugin's MCP servers are checked with core's `McpServerManifestSchema`, header-name pattern and loopback hosts. A server whose key is not a name every model provider accepts is skipped with a `plugin.mcp-server-skipped` warning, since the Runtime would refuse the manifest declaring it.
- `@nylorun/runtime`: the stack configuration reads its four listeners (`NYLORUN_LISTEN_*`, `NYLORUN_GATES_LISTEN_*`, `NYLORUN_HARNESS_LISTEN_*`, `NYLORUN_EGRESS_LISTEN_*`) with one parser; the variables and their errors are unchanged.
