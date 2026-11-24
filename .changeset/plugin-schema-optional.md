---
"@nylorun/core": minor
"@nylorun/agents": minor
---

A vendored Agent Plugin loads as its author published it, with or without a `$schema`. A plugin's `plugin.json` and `mcp.json` without `$schema` read as Agent Plugins 1.0.0, in the folder compiler and in the SDK's `.plugin()` and `harness.manifest.json` plugins; a `$schema` that names another format is still refused (`plugin_invalid`, `plugin.schema-unsupported`). A `harness.manifest.json`'s own `mcpServers` file keeps its rule.
