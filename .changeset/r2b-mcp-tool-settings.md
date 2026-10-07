---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
---

**Per-tool MCP settings (manifest v6) and deferred tools** (R2b C9, C10). MIGRATION.md (protocol 10, "Per-tool settings and manifest v6" and "Deferred tools") has the details.

- `@nylorun/core`: an MCP server takes `tools` (`McpToolSettings` by the server's own tool name, `"*"` for the rest: `enabled`, `approval`, `deferred`) and `deferred`, in manifest v6. `mcp()` and `Agent.mcp()` accept them, and the builder writes v6 only for a manifest that uses them, so other manifests keep their hashes; `AgentManifestSchema` accepts v5 unchanged and refuses the fields in v5. `mcpToolSettings` resolves a tool's settings, `manifestVersionFor` says which version a definition needs. `isVariantOf` lets a turn variant disable an MCP tool or require its approval, and nothing else. `TOOLS_CAPABILITY_ID`, `TOOL_SEARCH_TOOL`, `TOOL_CALL_TOOL`, `deferredToolsTools` and `deferredToolsInstructions` describe `tool_search` and `tool_call`. A session tool may carry instructions, read with its capability's. `mcp.discovered` gains `deferred`, `disabled` and `unknownTools` per server.
- `@nylorun/harness`: a session tool marked `deferred` stays out of the model's tool list; `tool_call` runs it as its own call, after checking the arguments against its `inputSchema`, and asks for approval when it needs it.
- `@nylorun/runtime`: discovery leaves out the tools a server's settings disable and names keys that match no tool. A session of an agent with a remote MCP server pins an empty `nylorun.tools` capability; when the agent's MCP tools pass a tenth of the model's context window (or settings say so), they are deferred for the session's life, and the model gets `tool_search` (BM25 over the deferred tools' names and descriptions, served by core) and `tool_call`, with a note naming each server and its instructions. Approval resolves per tool, and a turn variant's tightening applies to its turn. The gate's `mcp/connect` answers the server's instructions.
