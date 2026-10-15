---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/admin": patch
"@nylorun/studio": patch
---

**The harness builds the MCP tool list and shapes tool results; tools are identified by server and tool (protocol 15).** The fourth step of the harness boundary, still protocol 15 and Harness API 4. See MIGRATION.md.

- **Tools have an identity.** An MCP tool call's target is `{kind: "mcp", server, tool}` (the server's own name for the tool) and an HTTP tool call's `{kind: "http", tool}` (its declared name); `platform` is gone. `toolName` is the model's name, for display. The record checks an MCP call against the session's discovery (`tool.unknown`) and the turn's tool settings (`tool.disabled`), and `tool.completed`, tool-call rows (`tool`), approvals (`Approve server / tool?`, `interaction.tool`) and traces (`nylorun.tool.identity`) carry the identity. The Tool Gate matches a call to its journaled target.
- **Tool policy keys on identity.** A rule's `tool` is the tool's identity, never the model's name. A rule whose `tool` has `__` in it is refused at `PUT /v1/tenant/tool-policy`; a stored one makes the policy unreadable, so every call is denied (and `GET` answers `409`) until the policy names the tool by `server` and `tool`.
- **`turn.start.mcp` states facts.** The session pins what its servers listed, raw (`McpSnapshot` v2: servers, scrubbed instructions, tools as named); each turn gets `mcp` (`McpFactsSchema`: every tool with `enabled` and the manifest's `deferred` hint) in place of `sessionTools` and `routing.mcpSnapshot`, and `session.mcp` answers `{mcp}`. `mcp.discovered` has no `renamed` or `deferred`. Migration 0031 closes the sessions that pinned the former snapshot (`closedReason: "protocol_15"`).
- **Our engine names, defers and searches.** `@nylorun/harness` names MCP tools (`mcpToolName`, `mcpToolNames`, within the 64-character provider ceiling), defers them by the manifest's setting or the model's window and pins that layout in its state (`mcpToolSet`, `McpLayout`), and runs `tool_search` (BM25) itself; core's `tool_search`, `deferredToolsTools`, `TOOL_SEARCH_TOOL` and `TOOL_CALL_TOOL` leave `@nylorun/core/define`, and `runDurable` takes `mcp` instead of `sessionTools`.
- **Our engine shapes tool results.** Core no longer stores large or binary tool results: the record refuses an outcome past `limits.recordEntryBytes` (`limit_exceeded`). Our engine spills them with `artifact.write`, keyed by the call and its bytes (`spillKey`), with a preview, an image as a file for a model that reads images, and one budget per step (`shapeToolOutcome`, `StepBudget`, exported for a harness of your own). The Tool Gate still scrubs credentials and refuses answers past `limits.toolAnswerBytes`.
- **Harness configuration.** `createHarness({ mcpTools, toolResults })` sets the deferral share, characters per token, fallback window, the note's instruction length, `tool_search`'s limits, the inline cap, preview head and tail, step budget, stub, small size and entry envelope (`DEFAULT_MCP_TOOL_CONFIG`, `DEFAULT_TOOL_RESULT_CONFIG`).
- **The MCP preview** names tools as Nylorun's engine would (`modelName`, `renamed`) and shows a server's instructions uncut.
- **Studio** shows an MCP tool as `server / tool` in tool and approval cards, with the model's name, and links the artifacts a tool's result was stored in.
- **`examples/harness-minimal`** spills a large `bash` output with `artifact.write` and keeps a preview; its README shows how a harness of your own offers MCP tools.
