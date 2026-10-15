---
"nylorun": patch
"@nylorun/create-agent": patch
"@nylorun/admin": patch
"@nylorun/agents": patch
"@nylorun/runtime": patch
---

**READMEs and help text match protocol 14.**

- `nylorun --help` lists `environments fork`, `manifests` and `delete-version`. The package description no longer offers `nylo` as the Runtime client, and the README says nylorun depends on `@nylorun/agents` too.
- The READMEs name the current commands: `nylorun tenant keys`, `nylorun tenant mcp inspect`, `nylorun local logs` and `nylorun local reset`. `@nylorun/admin` says it speaks protocol 14.
- `@nylorun/agents`: a lost MCP or HTTP tool call is sent again with its key, then fails to the model as `tool.interrupted` (it is not left `uncertain`). Every manifest is v7. A2A takes `raw` files. A delegated agent cannot pause.
- `@nylorun/runtime`: the README describes protocol 14, `PUT /v1/sessions/{id}` says it answers an identical session (vaults are no longer attached), and the database-layout error names `nylorun local reset`.
- `@nylorun/create-agent`: `nylorun start` writes the project's keys (no key is derived any more).
