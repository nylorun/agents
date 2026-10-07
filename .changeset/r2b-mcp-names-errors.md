---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
---

**Model-safe MCP tool names, coded MCP tool errors and credential scrubbing** (R2b C6, C7, C8). MIGRATION.md (protocol 10, "Tool and MCP server names" and "Tool errors the model sees") has the details.

- `@nylorun/core`: a declared tool's name and an MCP server's name must match `^[A-Za-z0-9_-]{1,64}$` (`AgentManifestSchema`, so `PUT /v1/agents/{id}` refuses others). `mcp.discovered`'s server outcomes gain `renamed: [{ serverToolName, name }]`; `tool.completed` gains `redacted` and its `error` gains `retryable`. A failed `ToolOutcome` and `ToolResult` may carry `retryable`.
- `@nylorun/harness`: a failed tool result keeps the outcome's `retryable`, and the model sees it beside `code` and `message`.
- `@nylorun/runtime`: the model knows an MCP tool by `server__tool` with characters outside `[A-Za-z0-9_-]` replaced by `_`, shortened to 64 with an 8-hex SHA-256 suffix (also given to a renamed tool that collides); the server is still called by its own name. A failed MCP tool call is a failed tool result the model sees, with code `mcp.unreachable` (never sent; retryable), `credential_rejected` (`401`), `mcp.forbidden` (`403`), `mcp.error` (a JSON-RPC error) or `mcp.status` (another HTTP status); a call whose answer was lost after it was sent is `mcp.lost` for a `readOnlyHint` or `idempotentHint` tool and stays `uncertain` otherwise, as does a call lost with a gateway restart. A pooled connection whose server ended its session (`404` to its `Mcp-Session-Id`) or whose credential's `via` moved is dropped, opened again, and the call sent once more, since the tool never saw it. The credential values sent on a call (at least 8 characters, and a `Bearer` value's token) are replaced with `[redacted]` in MCP and HTTP tool results and errors before the gate records or returns them; no other field is touched.
