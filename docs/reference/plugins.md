# Plugins

The Runtime has two plugin mechanisms, and a compiled manifest records them in different places.
This page follows both from the code: the Runtime's own six plugins in `core/plugins/`, which a
folder declares by name and which reach the harness as the tool server `nylorun`; and Agent Plugins
by other authors (`plugin.json`, schema 1.0.0), which a folder vendors under `plugins/<name>/` or
the Agents SDK reads with `.plugin()`.

| | The Runtime's plugins | Agent Plugins |
| --- | --- | --- |
| Declared | `plugins:` in `AGENT.md`, in `agent-folder/3` only | the folder's `plugins/<name>/plugin.json`, or `.plugin(directory)` in the SDK |
| Read by | `core/scripts/build-plugins.mjs` when the bundle is built; the bundle at run time | `core/src/folder/plugins.ts` for a folder, `sdks/agents/src/plugins/load.ts` for the SDK |
| Adds | engine features (`harness.memory`, `harness.loop`, `harness.engine.sandbox`, `harness.engine.artifacts`, `harness.engine.triggers`), instructions, tools named `nylorun__<tool>` | skills, MCP servers, subagents, files mounted read-only |
| Recorded in | `harness.engine.plugins` | `harness.skills` and `harness.mcpServers` (labelled with the plugin), `harness.plugins` |

The two never meet: nothing in `core/src/plugins/` reads a `plugin.json` at run time, and nothing in
the folder or SDK loaders knows the six names in `PLUGIN_NAMES`
(`core/src/plugins/index.ts:19-26`).

## The Runtime's plugins

### Declared in the agent folder

A folder names the plugins it wants in the `plugins` key of `AGENT.md`, which is an
`agent-folder/3` key: `AGENT_KEYS` lists it (`core/src/folder/compile.ts:186`), and a folder that
sets `plugins` without `format: agent-folder/3` is refused with `v3_key`
(`core/src/folder/compile.ts:770-771`).

`v3Declarations` checks the list before anything is compiled (`core/src/folder/v3.ts:102-119`):

- each name is one of the six (`plugin_unknown`, with a suggestion), and none twice;
- a plugin whose `requires` holds `computer` is refused when the runtime has none
  (`plugin_needs_computer`, `core/src/folder/v3.ts:110-111`);
- a subagent's plugins are a subset of its parent's (`plugin_subset`,
  `core/src/folder/v3.ts:112-113`);
- `mcpServers.nylorun` turns the declared plugins' tools off one by one, or all with `"*"`
  (`core/src/folder/v3.ts:117-143`).

The same function turns the declared names into the harness's own settings
(`core/src/folder/v3.ts:149-170`): `nylorun-plan` into `loop.plan`, `nylorun-interactions` into
`loop.ask` and `loop.connections` (root only), `nylorun-memory` into `memory.access: "read_write"`
(root only), `nylorun-sandbox` into `engine.sandbox`, `nylorun-artifacts` into `engine.artifacts`,
`nylorun-triggers` into `engine.triggers`. Those settings are what the engine then projects; the
plugin names themselves go no further than the manifest entry below.

### Built into a bundle

`core/scripts/build-plugins.mjs` walks each folder in its own `ORDER` (`:16`, the same order as
`PLUGIN_NAMES`) and writes `core/src/plugins/bundle.generated.ts` (`:64-77`). For each plugin it
reads:

- `plugin.json`, for the description (`:44`);
- `tools.json`, for the tools (`:45`);
- `extensions.nylorun.requires` (`:57`);
- every file under `instructions/`, keyed by path without `.md` (`:47-48`);
- every `skills/<name>/SKILL.md`, as name, description and text (`:50-55`);
- a SHA-256 over every file of the folder, as `relative path\n`, bytes, `\n` (`:42-43`).

With `--check` it fails instead of writing when the bundle is stale (`:68-76`). `plugin.json`'s
`$schema`, `name`, `author` and `license`, and `tools.json`'s `server`, are not read by anything:
the folder is an Agent Plugin package for other hosts to read, and the constants that matter to the
Runtime live in `core/src/plugins/index.ts` — the server `nylorun` (`:14`), the tool prefix
`nylorun__` (`:16`) and the six names in order (`:19-26`).

### Written into the manifest

`enginePlugins` records each declared plugin as `{ name, tools, sha256 }`, plus `hosts` for
`nylorun-sandbox` (`core/src/folder/v3.ts:173-183`), and the compiler puts the result in
`harness.engine.plugins` (`core/src/folder/compile.ts:945`). The shape is fixed in the contract
(`core/src/contracts.ts:398-408`) and the type (`core/src/types/manifest.ts:225-238`), where the
name is the six-name union and `sha256` must match `sha256:[0-9a-f]{64}`. The hash is how a manifest
says which version of a plugin's files it was compiled against.

The plugins' skills are reserved names in the folder: a `skills/` folder may not take them
(`core/src/folder/compile.ts:1282`), and the harness offers them whether or not the agent has a
`skills/` folder (`core/src/engine/projection.ts:242`).

### Projected as the `nylorun` server

`engineProjection` takes the plugin path when `agent.engine.plugins` is present
(`core/src/engine/projection.ts:121-122`) and hands it to `pluginProjection`
(`core/src/engine/projection.ts:227`). That function:

- builds the skills catalog from the plugins' skills and the folder's, folder first
  (`core/src/engine/projection.ts:242`);
- offers a plugin's tool only when the feature it belongs to is on and the tool itself is on
  (`core/src/engine/projection.ts:246-256`);
- writes the plugins' instruction sections under the heading `## Plugins`
  (`core/src/engine/projection.ts:210-212`, `:272-291`);
- renames each tool to `nylorun__<tool>` and keeps its own name as `effectName`
  (`core/src/engine/projection.ts:293`), which is how `nylorun__memory` is `memory` to the record,
  the tool policy and the harness (`core/src/engine/tools.ts:39-46`).

The rename is why the model sees one MCP-like server, `nylorun`, instead of six: the names come
from `runtimeToolName` and go back with `runtimeToolOf`
(`core/src/plugins/index.ts:66`, `:71-74`), and the compiler's explanation of a feature names the
plugin that brought it (`core/src/engine/explain.ts:80-89`, `:112`).

### Run by the harness

The harness builds each agent's engine tools from the manifest the turn started with
(`runtime/harness/src/api/run.ts:117-133`): `engineToolsFor(agent, start.agent, ctx.engine, memory,
plan, connections, triggers, ask)`, with memory's access and whether the agent is the root, and
plan, connections, triggers and ask for the root only. `engineToolsFor` is a thin wrapper over
`engineProjection` (`runtime/harness/src/tools/engine-tools.ts:72-83`), so the engine's text and
tools are the same in the compiler's preview and in the run.

The tools are offered after the agent's own and before the session's MCP tools
(`runtime/harness/src/run/durable.ts:155-161`). A call is recorded with `toolName: tool.effectName
?? tool.name` (`runtime/harness/src/run/durable.ts:519-533`), so a plugin's tool leaves the same
effect record as it would without plugins; what runs it is the tool's `target`:

- `{ kind: "runtime", operation: "memory" | "triggers" | "schedule_wake" }` for `nylorun-memory`'s
  `memory` and `nylorun-triggers`' `triggers` (`core/src/engine/tools.ts:360`, `:412`, `:447`,
  `:489`), served by the Runtime (`runtime/server/src/harness-api/record.ts:317`);
- `{ kind: "harness" }` for the plan, ask, connection and artifact tools
  (`core/src/engine/tools.ts:303`, `:310`, `:533`, `:571`, `:672`);
- `{ kind: "sandbox" }` for the sandbox tools (`core/src/engine/tools.ts:217`).

A plugin's skills are read from the bundle rather than from a folder: `pluginSkill` looks a name up
in the declared plugins before the folder's skills (`runtime/harness/src/tools/skills.ts:151-172`).
The sandbox mounts each declared plugin's files read-only at `/plugins/<name>@<hash>/`
(`runtime/harness/src/tools/skills.ts:286-299`, `core/src/utils/definition-files.ts:41-52`), so an
agent can read the plugin's own text where it runs.

### What the six contain

Six plugins, thirteen tools, two skills, eleven instruction sections. No plugin in `core/plugins/`
ships an agent, a flow or a task of its own: everything they add is a tool, the text that goes with
it, and the harness setting the compiler derives from it. Counts are from
`core/src/plugins/bundle.generated.ts`.

| Plugin | Tools (effect) | Skill | Instructions | Requires |
| --- | --- | --- | --- | --- |
| `nylorun-memory` | `memory` (runtime) | `memory` | `memory`, `memory.view` | none |
| `nylorun-triggers` | `triggers` (runtime) | `triggers` | `triggers` | none |
| `nylorun-plan` | `update_plan` (harness) | none | `update_plan` | none |
| `nylorun-interactions` | `ask`, `request_connection` (harness) | none | `_`, `ask`, `request_connection` | none |
| `nylorun-artifacts` | `read_artifact`, `save_artifact` (harness) | none | `_`, `read_artifact`, `save_artifact` | none |
| `nylorun-sandbox` | `bash`, `read`, `write`, `edit`, `grep`, `glob` (sandbox) | none | `_` | `computer` |

#### `nylorun-memory`

The agent's memory: Markdown files under `/memories` that outlive the session
(`core/plugins/nylorun-memory/plugin.json:4`). One tool, `memory`, effect `runtime`
(`core/plugins/nylorun-memory/tools.json:3-8`), which is the tool the harness's own definition
mirrors (`core/src/engine/tools.ts:364-412`). Two instruction sections: `memory` for an agent that
may write (`core/plugins/nylorun-memory/instructions/memory.md`) and `memory.view` for one that may
only read (`core/plugins/nylorun-memory/instructions/memory.view.md`). The `memory` skill says what
to keep and how to write it (`core/plugins/nylorun-memory/skills/memory/SKILL.md:1-3`). Declaring it
gives the root agent `memory.access: "read_write"` (`core/src/folder/v3.ts:166`). Only the root gets
it: an agent the manifest gives `harness.memory` without being the root gets the `memory.view`
section instead (`core/src/engine/projection.ts:252`).

#### `nylorun-triggers`

Triggers the agent sets up itself: a follow-up in this conversation or a routine in a session of its
own (`core/plugins/nylorun-triggers/plugin.json:4`). One tool, `triggers`, effect `runtime`
(`core/plugins/nylorun-triggers/tools.json`), which `list`s, `create`s and `delete`s a trigger
(`core/src/engine/tools.ts:454-489`) and is served as the Runtime operation `triggers`. One
instruction section (`core/plugins/nylorun-triggers/instructions/triggers.md`) and the `triggers`
skill, which is about writing the prompt and the schedule for a turn nobody watches
(`core/plugins/nylorun-triggers/skills/triggers/SKILL.md:1-3`). Declaring it sets
`engine.triggers`, for the root only (`core/src/folder/v3.ts:162`).

#### `nylorun-plan`

The agent's plan for a task, kept as a list of steps with states
(`core/plugins/nylorun-plan/plugin.json:4`). One tool, `update_plan`, effect `harness`
(`core/plugins/nylorun-plan/tools.json`), with at most `PLAN_LIMITS.steps` steps and the label and
note lengths the limits set (`core/src/engine/tools.ts:499-507`). One instruction section. Declaring
it sets `loop.plan` (`core/src/folder/v3.ts:154-155`), and the plan is offered to the root only
(`runtime/harness/src/api/run.ts:129`).

#### `nylorun-interactions`

The two ways an agent reaches the person: a question it cannot answer itself and an app it needs
connected (`core/plugins/nylorun-interactions/plugin.json:4`). Two tools, `ask` and
`request_connection`, effect `harness` (`core/plugins/nylorun-interactions/tools.json`), defined at
`core/src/engine/tools.ts:545-571` and `:650-672`. Three instruction sections: `_` (the heading
`## Asking`, `core/plugins/nylorun-interactions/instructions/_.md:1`), `ask` and
`request_connection`. Declaring it sets `loop.ask` and `loop.connections`, for the root only
(`core/src/folder/v3.ts:154-155`).

#### `nylorun-artifacts`

The files an agent hands the person, saved to Files and read back by name
(`core/plugins/nylorun-artifacts/plugin.json:4`). Two tools, `read_artifact` and `save_artifact`,
effect `harness` (`core/plugins/nylorun-artifacts/tools.json`), defined at
`core/src/engine/tools.ts:298-351`. Three instruction sections: `_`, `read_artifact`,
`save_artifact`. Declaring it sets `engine.artifacts.read`, and `engine.artifacts.save` only with a
computer (`core/src/folder/v3.ts:162`).

#### `nylorun-sandbox`

An isolated Linux sandbox with a persistent working directory (`core/plugins/nylorun-sandbox/
instructions/_.md:1-2`). Six tools, effect `sandbox`: `bash`, `read`, `write`, `edit`, `grep`,
`glob` (`core/plugins/nylorun-sandbox/plugin.json:12-19`), offered in the order
`SANDBOX_TOOL_NAMES` gives (`core/src/engine/tools.ts:217`). One instruction section, `_`, with
`{workspace}`, `{tools}` and `{network}` filled from the sandbox's configuration. It is the only
plugin that requires a computer (`core/plugins/nylorun-sandbox/plugin.json:20-22`), and the only one
whose manifest entry carries `hosts` (`core/src/folder/v3.ts:173-183`). Declaring it sets
`engine.sandbox` to the tool names it turns on (`core/src/folder/v3.ts:159`).

## Agent Plugins from other authors

An Agent Plugin is a folder with a `plugin.json` (`$schema` 1.0.0), optionally `mcp.json`,
`skills/<name>/SKILL.md`, `agents/*.md` and any other files. Two loaders read one, with different
strictness.

In a folder, `foldPlugins` walks `plugins/` and folds each package into the compiled manifest
(`core/src/folder/plugins.ts:88-92`): its `skills/<name>/SKILL.md` files become the agent's skills,
its `mcp.json` servers become MCP servers, and under `agent-folder/4`, `agents/*.md` becomes the
plugin's subagents
(`core/src/folder/plugins.ts:94-228`). Parts the Runtime cannot run are noted rather than folded
(`core/src/folder/plugins.ts:26-35`), every file is checked before it is read
(`core/src/folder/plugins.ts:59-79`), and a malformed package is a `PluginError` — the folder does not
compile (`core/src/folder/plugins.ts:5-8`).

In the SDK, `loadPlugin` reads a directory into a `LoadedPlugin`
(`sdks/agents/src/plugins/load.ts:88-160`), and `plugin(directory)` turns it into a part for
`.plugin()` (`sdks/agents/src/plugins/plugin.ts:19-23`, `sdks/agents/src/builder.ts:28-30`). It is
the lenient reader: a part it cannot use is dropped with a `PluginDiagnostic` instead of an error
(`sdks/agents/src/plugins/plugin.ts:25-34`). `compose` folds a folder's plugins the same way a
`.plugin()` call does, so both paths produce the same parts (`sdks/agents/src/compose.ts:192-209`).

Whichever path reads it, a plugin's skills are labelled with the plugin's name and version
(`sdks/agents/src/compose.ts:202`), and a plugin holding files beyond skills, servers and subagents
is mounted whole, read-only at `/plugins/<name>@<hash>/`
(`core/src/utils/definition-files.ts:44-52`). The test fixture
`core/test/support/egm-plugin` is one such package, copied from `google/elephant-goldfish-model`
0.1.1 and used to compile its personas as a plugin's subagents
(`core/test/support/egm-plugin/README.md:1-8`).

## What the code does not show

- **`/mcp/nylorun` is not served here.** Every `mcp.json` in `core/plugins/` points at
  `https://runtime.nylorun/mcp/nylorun` (`core/plugins/nylorun-memory/mcp.json:5-6`), and no route in
  this repository answers it: a search for `mcp/nylorun` finds only those six files. The URL is the
  Agent Plugin package's declaration of the server for other hosts to read; the Runtime's own path
  never calls it, because the tools are built in code (`core/src/engine/tools.ts`) rather than
  fetched over MCP.
- **Nothing reads `tools.json` or `extensions.nylorun` at run time.** `tools.json` is read only by
  `core/scripts/build-plugins.mjs:45`, and the `extensions` block only for `requires` (`:57`). The
  tools a manifest records come from that file at build time, not from the plugin's own copy of it.
- **No check compares a manifest's plugin `sha256` with the bundle at run time.** The schema requires
  the format (`core/src/contracts.ts:398-408`) and the harness materializes the plugin folder under
  the hash it computes from the files it holds (`core/src/utils/definition-files.ts:51-52`); a
  manifest compiled against an older plugin still runs, and nothing fails it.
- **The subagent plugins in `core/plugins/` are none.** Nothing in the six ships an `agents/`
  folder, so the `agent-folder/4` subagent path applies only to Agent Plugins from elsewhere.
- **This page was written from the code at commit `3491b94` and not run.** No build or test was
  executed for it.
