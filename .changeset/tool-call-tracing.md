---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/studio": minor
---

**A tool call is traced from the log alone to its skill or MCP server and the plugin that brought it.** No protocol change beyond 13. See MIGRATION.md.

- **`tool.completed`** gains `skill` and `plugin` (`{ name, version? }`), and tool call rows (`GET /v1/sessions/{id}/calls/tool`, `session.toolCalls()`) gain `skill` and `plugin`, `null` when there is none. An MCP call gets its server's plugin. `load_skill` and `read_skill_resource` get the skill they name, and a sandbox tool whose input names `/skills/<name>/` gets that skill; both get the skill's plugin.
- **`kind: "harness"`** (`TOOL_CALL_KINDS`): a tool the turn's harness declared in `hello.features.tools`. Such a call said `platform` before.
- **`mcp.discovered`** names each server's `plugin`.
- `@nylorun/core`: `skillOfToolCall`, `pluginOf` and `ToolCallTrace` in `/define`.
- **Studio** shows each tool call's kind, server or skill, and a plugin badge, in the chat and the event details and summaries, and the plugin of each server `mcp.discovered` lists.
