---
"@nylorun/core": minor
---

`agent-folder/2` (ADR-100): a folder that declares every engine feature it uses. `format:
agent-folder/2` (or `2`) in `AGENT.md` turns it on; `agent-folder/1` and a folder with no format
compile exactly as before. Its `engine:` block declares `sandbox` (any of the six sandbox tools;
needs a computer), `artifacts: { read, save }` (`save` needs a computer), `outputs` (needs a
computer) and `toolSearch`, and `instructions.<block>` replaces a block's wording with a Markdown
file under `engine/`; `memory.index: false` pins no memory index. A computer with no sandbox tools
is a warning (`sandbox_undeclared`). A subagent declares its own `engine:` block, a subset of its
parent's (`engine_subset`).

The compiled manifest holds it as `harness.engine` (agent manifest v8, JSON Schema
`agent-manifest/v8.2.json`; the harness file `harness-manifest/v1.2.json`; the frontmatter
`agent-folder/v1/agent-md.2.json`), and the loop manifest the harness runs as `engine`
(`loopManifestOf`). `harness.engine.blocks` lists the engine text blocks the agent gets, each with
its version and the SHA-256 of its text, so an engine release that changes one changes the
version's hash.

New `@nylorun/core/engine`: our engine's text blocks by name and version (`skills`, `sandbox`,
`skill_folder`, `artifacts_save`, `outputs`, `artifacts_read`, `wake`, `memory`, `plan`,
`connection`, `tool_search`, each `@1`), the definitions of its own tools, the MCP tools' naming
and deferral (`mcpToolSet`, which no longer defers automatically for an agent that declares its
engine features without `toolSearch: true` and reports `mcp_tools_inline` instead), the projection
for one agent (`engineProjection`), `previewTurn` and `explainEngine`. Harness API v5 takes the
claim `engine.diagnostic` (a new event type) and a `turn.start.memory` without `index`
(`harness-api/v5.2.json`).
