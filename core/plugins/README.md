# The Runtime's six plugins

One folder per plugin. Each is an Agent Plugin package (schema 1.0.0) that ships with the Runtime:
`plugin.json`, `tools.json`, the `instructions/` the model reads, and a `skills/` folder where the
plugin brings one. These folders are not read at run time. `core/scripts/build-plugins.mjs` folds
them into `core/src/plugins/bundle.generated.ts`, and that bundle is what the compiler, the engine's
projection and the harness read.

## Folders

- `nylorun-memory/`: the agent's memory under `/memories`; the tool `memory`, two instruction
  sections and the `memory` skill.
- `nylorun-triggers/`: follow-ups and routines the agent books for itself; the tool `triggers`, one
  instruction section and the `triggers` skill.
- `nylorun-plan/`: the plan for a task, as steps with states; the tool `update_plan` and one
  instruction section.
- `nylorun-interactions/`: the two ways to reach the person; the tools `ask` and
  `request_connection`, and three instruction sections.
- `nylorun-artifacts/`: the files handed to the person; the tools `read_artifact` and
  `save_artifact`, and three instruction sections.
- `nylorun-sandbox/`: the Linux sandbox; the tools `bash`, `read`, `write`, `edit`, `grep` and
  `glob`, and one instruction section with `{workspace}`, `{tools}` and `{network}` filled in.

[Plugins](../../docs/reference/plugins.md) has a section per plugin, and follows how a declaration
in an agent folder becomes a tool the harness runs.

## Rules

- `plugin.json` names the server `nylorun` and lists the plugin's tools under `extensions.nylorun`
  (`core/plugins/nylorun-memory/plugin.json:9-17`); `tools.json` holds the same tools with each
  one's effect (`core/plugins/nylorun-memory/tools.json:2-8`). The build script reads `tools.json`,
  not the list in `plugin.json` (`core/scripts/build-plugins.mjs:45`).
- The six names and their order are fixed in `core/src/plugins/index.ts:19-26` and repeated in
  `core/scripts/build-plugins.mjs:16`; the contract's name union is the third copy
  (`core/src/contracts.ts:398-408`). A seventh plugin needs all three.
- `bundle.generated.ts` must match these folders, and `--check` fails when it does not
  (`core/scripts/build-plugins.mjs:68-76`).
- A plugin's SHA-256 is over every file of its folder, as `relative path\n`, bytes, `\n`
  (`core/scripts/build-plugins.mjs:42-43`): editing anything here changes the hash a manifest
  records for it (`core/src/folder/v3.ts:173-183`).
- `nylorun-sandbox` is the only plugin that requires a computer
  (`core/plugins/nylorun-sandbox/plugin.json:20-22`).
- No plugin here ships an agent, a flow or a task: what they add is tools, the text that goes with
  them, and a harness setting the compiler derives from the declaration
  (`core/src/folder/v3.ts:149-170`).

## Verification

- Run: `node core/scripts/build-plugins.mjs --check` (the bundle against these folders)
- Run: `npm run check --workspace @nylorun/core` (the package that reads the bundle)
