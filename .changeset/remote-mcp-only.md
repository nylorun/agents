---
"@nylorun/core": major
"@nylorun/agents": major
"@nylorun/runtime": major
"nylorun": minor
---

**Remote MCP servers only (blueprint D47).** Nylorun accepts `streamable-http` and `sse` MCP servers, declared by URL and reached through the gates; stdio servers and plugin roots are gone. See MIGRATION.md.

- **Breaking (`@nylorun/core`):** `McpServerManifest` and the manifest schema keep only `streamable-http` and `sse`. A `stdio` server is refused by `.mcp({...})` (`McpError`, code `mcp.stdio`), by `Agent.from` and by the wire schema, all with one message (`stdioMcpRefusal`): "MCP server 'x' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL." `PutAgentRequest` loses `pluginRoots`, `CapabilityDeclaration` loses `pluginRoot`, and the Harness API's `RunRouting` loses `pluginRoots`.
- **Breaking (`@nylorun/agents`):** `.plugin()` and `plugin()` throw `PluginError` (code `plugin.mcp-stdio`) for a stdio server in a plugin's `mcp.json`; its remote servers and skills load as before. `saveAgent` no longer sends plugin roots. `prepareStdioLaunch`, `expandPluginPlaceholders` and `StdioLaunch` are removed.
- **Breaking (`@nylorun/runtime`):** no stdio MCP launcher: `PUT /v1/agents/:id` refuses a stdio server (`400`) and `pluginRoots`. `TenantConfig.childEnv`, `TenantPaths.pluginData` and `tmp`, `tenantChildEnvironment`, `startEphemeralRuntime({ baseline })` and `configForFactory`'s `baseline` and `hostConfig` are removed; the harness service no longer takes `childEnv` or `paths.pluginData`.
- `nylorun`: the local stack no longer mounts the Host root's `plugins/` into the runtime and harness containers, nor the Tenant's `plugin-data/`, `home/` and `tmp/` into the harness, which now mounts only `sandboxes/`.
