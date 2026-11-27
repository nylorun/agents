# The Runtime's plugins as data

The six plugins that ship with the Runtime, as one generated value and the constants around it.
`index.ts` holds the server name, the tool prefix, the six names in their order, and the helpers
that map a tool to its plugin and its model name. `bundle.generated.ts` holds each plugin's
description, tools, instruction sections, skills and file hash, copied from `core/plugins/` by
`core/scripts/build-plugins.mjs`.

## Interface

- `RUNTIME_SERVER` (`index.ts`): `"nylorun"`, the one MCP server name the plugins' tools appear
  under.
- `RUNTIME_TOOL_PREFIX` (`index.ts`): `` `${RUNTIME_SERVER}__` ``, which a plugin's tool is named
  with in front of the model.
- `PLUGIN_NAMES` (`index.ts`): the six names, in the order their instructions and skills are
  written.
- `PluginName`, `PluginToolEffect`, `RuntimePlugin` (`index.ts`): the name union, an effect
  (`"runtime"`, `"harness"` or `"sandbox"`), and one plugin's entry as the bundle holds it.
- `isPluginName` (`index.ts`): whether a value is one of the six.
- `pluginOf`, `pluginTools` (`index.ts`): one plugin's bundle entry, and the tools it brings.
- `pluginOfTool` (`index.ts`): the plugin a bare tool name belongs to.
- `runtimeToolName`, `runtimeToolOf` (`index.ts`): `memory` to `nylorun__memory`, and back for a
  declared tool.
- `pluginSkills`, `pluginSkill` (`index.ts`): the declared plugins' skills, and one by name.
- `DeclaredPlugin`, `declaredTools` (`index.ts`): what a manifest records for a plugin, and the
  tools left on across a list of them.
- `PLUGIN_BUNDLE` (`bundle.generated.ts`): every plugin's data, keyed by name.

## Rules

- `PLUGIN_NAMES` order is the order the model reads: the plugins' skills are added in it
  (`core/src/engine/projection.ts:242`), and their instruction sections are written in the same
  order (`core/src/engine/projection.ts:272-291`).
- `bundle.generated.ts` is generated and says so at its head: never edit it by hand, run
  `node core/scripts/build-plugins.mjs` (`core/src/plugins/bundle.generated.ts:1`).
- Every name in the bundle is a name in `PLUGIN_NAMES`, and the build script's own `ORDER` is the
  same list (`core/scripts/build-plugins.mjs:16`).
- `runtimeToolOf` returns a tool only when some declared plugin holds it
  (`core/src/plugins/index.ts:70-74`), so a model name that is not a plugin's tool is not mapped.
- A plugin's hash is the SHA-256 of its folder, every file as path and bytes
  (`core/scripts/build-plugins.mjs:42-43`), and the contract checks its shape
  (`core/src/contracts.ts:398-408`).
- `nylorun` is reserved as a server name: a folder's own `mcpServers` in an `agent-folder/3` folder
  may not use it (`core/src/folder/compile.ts:1169-1170`).

## Side effects

None found. The folder reads the generated bundle it imports and does no I/O.

## Verification

- Run: `npm test --workspace @nylorun/core` (`core/test/runtime-plugins.test.ts` covers this
  folder)
