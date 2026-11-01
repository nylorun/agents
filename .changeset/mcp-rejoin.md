---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

An MCP server that failed at a session's first discovery is tried again at each later turn's first
segment, and joins the session's snapshot once it answers: its tools are offered from that turn on,
its diagnostic is replaced, and `mcp.discovered` names it again with `rejoined: true`. `session.mcp`
takes a later snapshot of servers the session lacks and merges them within `mcpSnapshotBytes`.
