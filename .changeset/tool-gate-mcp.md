---
"@nylorun/runtime": minor
---

**Remote MCP servers run behind the Tool Gate (F4.1).** With the gates service (the local stack's `gateway` container), the gateway holds each session's connection to a `streamable-http` or `sse` MCP server, authorizes it from the session's attached vaults (OAuth refresh included), and runs `tools/list` and `tools/call`. The runtime names the server and never sees its credential. Stdio MCP servers still run beside the loop.

- New internal routes on the gates service: `POST /nylorun/v1/mcp/connect`, `/mcp/list`, `/mcp/close` and `/tool-calls`.
- The loop now passes its abort signal to every MCP call, in and out of process.
