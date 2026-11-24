---
"@nylorun/core": minor
"@nylorun/runtime": minor
"nylorun": minor
"@nylorun/studio": patch
---

An Agent Plugin's subagents work like the agent's own. In `format: agent-folder/4`, each `agents/*.md` of a plugin under `plugins/<name>/` is a subagent of the manifest that installs the plugin, read by the same rules as the root's own files: it inherits the manifest's library, narrows it with `tools`, `disallowedTools`, `skills`, `mcpServers`, `readonly` and `flow`, and is checked and reported at its own path in the plugin. Its tool in `harness.tools` carries `plugin: { name, version }`, as the plugin's skills and MCP servers do; no subagent inherits another. A subagent file is now named by its frontmatter `name`, whatever the file is called, as Claude Code and Cursor name theirs; the name must be a tool name (`name_invalid` otherwise). A name used twice is `plugin_duplicate` when a plugin's file is involved and `tool_twice` otherwise. `license` is noted and ignored in a subagent file. In formats 1 to 3 a plugin's `agents/` stays a note, which now names `nylorun migrate folder <dir> --to 4`.

The agent manifest's tool entry takes the optional `plugin` label, published as `agent-manifest/v8.6.json` and `harness-manifest/v1.6.json`; a Runtime announcing the Host feature `plugin-subagents` accepts it and keeps it through a run's rebuild, and the run is otherwise unchanged. `nylorun check` prints a line per plugin naming the subagents, skills and servers it brings, and Studio shows a subagent's plugin as it does a skill's.
