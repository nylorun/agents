---
"@nylorun/core": minor
"@nylorun/runtime": patch
"nylorun": minor
---

Subagents are files (ADR-164): a manifest's files in the new `format: agent-folder/4` write each subagent as one file, `agents/<id>.md`, as Claude Code and Cursor do. The root's `tools/`, `skills/`, `mcp.json`, `plugins/` and Runtime plugins are the manifest's library: a subagent file gets everything in it that a subagent can use, and narrows it with `tools`, `disallowedTools`, `skills` and `mcpServers`; the root can narrow its own tools with `tools` and `disallowedTools`; `flow: ./<id>.flow.json` drives a subagent with a flow; a manifest driven by a flow may hold the library its stages draw on. Claude Code's and Cursor's keys (`model`, `color`, `readonly`, …) and tool names (`Read`, `Grep`, …) are noted and read. A subagent folder in format 4 is `subagent_folder`, and a subagent file in an older format `subagent_file`. `nylorun migrate folder <dir> --to 4` turns each subagent folder into a file and writes only when the folder compiles to the same agent manifest. Formats 1 to 3, the agent manifest JSON, the API, the harness and delegation's one level are unchanged. The Runtime accepts format 4 uploads with this core.
