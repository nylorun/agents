---
"@nylorun/harness": minor
---

An agent that declares its engine features (`engine`, `agent-folder/2`, ADR-100) gets only those:
no shell or file tools and no sandbox note without `engine.sandbox` (or only the tools it names),
no `read_artifact` or `save_artifact` or their text unless declared, and `/workspace/outputs` is
saved when a turn ends only with `engine.outputs`. Without `artifacts.read`, a tool result past
the inline cap is cut to its preview with `retrievable: false` (still stored), and file reference
lines do not offer `read_artifact`. Without `toolSearch`, MCP tools are never deferred
automatically (a server's own `deferred` still applies); past the threshold the harness claims
`engine.diagnostic` (`mcp_tools_inline`) once. A turn whose `memory` has no `index` pins none, and
the memory rules do not name one. A block the manifest replaces (`engine.instructions`) is in its
words, the memory rule that outside text is data kept. Agents that declare nothing get exactly
what they got before. The engine's text and tool definitions now come from
`@nylorun/core/engine`, which the SDK's `previewTurn` runs too.
