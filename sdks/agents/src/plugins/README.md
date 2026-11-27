# Reading Agent Plugins in the SDK

An Agent Plugins 1.0.0 package is a folder with a `plugin.json`, optionally `mcp.json`,
`skills/<name>/SKILL.md` and any other files its author ships. `load.ts` reads one into a
`LoadedPlugin` without throwing for a part it cannot use, and `plugin.ts` turns that into a part for
`.plugin()`, so a plugin's skills, MCP servers and files join the agent being built.

## Interface

- `loadPlugin` (`load.ts`): reads a package into a `LoadedPlugin`; a broken manifest or a stdio
  server throws a `PluginError`.
- `loadMcpServers` (`load.ts`): reads a package's `mcp.json` into MCP servers, skipping the ones it
  cannot run.
- `PluginError` (`load.ts`): the error a package that cannot be read at all throws, with its
  diagnostics.
- `LoadedPlugin`, `PluginDiagnostic` (`load.ts`): a read package, and one thing skipped on the way.
- `PLUGIN_SCHEMA`, `MCP_SCHEMA` (`load.ts`): the two 1.0.0 schema URLs the reader accepts.
- `plugin(directory)` (`plugin.ts`): reads a package and returns its part, warning on each skipped
  part.
- `partFromPlugin(loaded)` (`plugin.ts`): the part a read package adds.
- `PluginPart` (`plugin.ts`): that part: `skills`, `mcpServers`, `plugins` and `skillFiles`.
- `loadPlugin`, `loadMcpServers`, `PluginError` and the two types are re-exported from the SDK's
  entry (`sdks/agents/src/index.ts:239-240`).

## Rules

- `plugin.json` must be a file inside the package root and valid JSON
  (`sdks/agents/src/plugins/load.ts:90-102`).
- `$schema`, when present, must be the Agent Plugins 1.0.0 plugin schema
  (`sdks/agents/src/plugins/load.ts:117-122`).
- `name` must be 1-64 characters of lowercase letters, digits, hyphens and periods
  (`sdks/agents/src/plugins/load.ts:123-128`).
- A field the reader does not know is a warning, not an error, and a manifest `extensions` namespace
  is ignored with an info diagnostic (`sdks/agents/src/plugins/load.ts:107-115`, `:133-145`).
- A `stdio` MCP server throws; another server it cannot validate is skipped with a warning
  (`sdks/agents/src/plugins/load.ts:291-303`).
- A package with files beyond its skills, servers and subagents is mounted whole; one whose files are
  all carried by those parts is not (`sdks/agents/src/plugins/plugin.ts:41-64`).
- `.env`, `.env.*`, `*.pem` and `*.key` files are never mounted
  (`sdks/agents/src/plugins/load.ts:73`).
- A skipped part becomes a `NylorunPluginWarning` on the process, not a thrown error
  (`sdks/agents/src/plugins/plugin.ts:25-34`).

## Side effects

- Reads the package's files from disk, following a symlink only when it resolves inside the package
  root (`sdks/agents/src/plugins/load.ts:373-387`).
- Emits process warnings for each skipped part (`sdks/agents/src/plugins/plugin.ts:25-34`).

## Verification

- Run: `npm test --workspace @nylorun/agents`
