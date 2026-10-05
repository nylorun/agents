---
"@nylorun/core": minor
"@nylorun/harness": major
"@nylorun/agents": minor
"@nylorun/runtime": minor
"@nylorun/studio": minor
---

**HTTP tools and static approval (manifest-only agents, M3).** A tool can be one HTTP request the Runtime makes through its Tool Gate, with no Action endpoint; code tools keep working.

- `@nylorun/core`: `ToolManifest` gains `http` (`url`, `method` `POST`/`PUT`/`PATCH`, `credential`, `timeoutMs` up to 300000) and `approval` (`never`/`always`, HTTP tools only); a tool is never both an agent and an HTTP request, and `fn` and `command` are refused ("Functions are not available yet"). Remote MCP servers take `approval`. `http()` builds an HTTP tool, `httpToolOf()` reads one; `SESSION_ID_HEADER`, `TURN_ID_HEADER` and `AGENT_ID_HEADER` name the headers it sends. `Agent.from` rebuilds HTTP tools without an implementation; an HTTP tool is refused as a flow stage.
- `@nylorun/harness`: hosted HTTP tools keep their target, and `approval: "always"` (an HTTP tool's, or `DurableSessionTool.approval` for a remote MCP server's tools) pauses each call for approval. **Breaking:** `HarnessExecutors.recovers.remoteMcp` is renamed `recovers.tool`.
- `@nylorun/agents`: exports `http` and the identity header constants.
- `@nylorun/runtime`: the Tool Gate runs HTTP tool calls (`POST /nylorun/v1/http-calls` at the gates service, or in process): the input as JSON under the Host's address policy, the session's vault credential bound to the URL, `Nylorun-Session-Id`/`-Turn-Id`/`-Agent-Id` and the effect id as `Idempotency-Key`. A keyed call runs once (`tool_crossings`), so a re-send after a takeover joins it and one lost with the gateway is `uncertain`. Non-2xx answers, timeouts, refused addresses, missing credentials and output mismatches are tool errors the model sees. The credential resolver is asked with `target.kind: "http"` and the tool's `credential` name.
- `@nylorun/studio`: the Agent Manifest tab lists HTTP tools with their method and URL, and marks tools and MCP servers that wait for approval.
