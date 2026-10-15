---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/studio": patch
---

**The harness writes the model's instructions and defines the sandbox and skill tools; no `runtime` block (protocol 15).** The third step of the harness boundary, still protocol 15 and Harness API 4. See MIGRATION.md.

- **No `runtime` block.** The Runtime no longer pins model-facing text or tools on a session's manifest: a session pins its definition as registered (`manifestHash` equals `definitionHash`) and keeps its sandbox spec on the session. The manifest schema refuses `runtime` with what replaces it (`REMOVED_MANIFEST_FIELDS`). `runtimeManifestFor`, `runtimeToolOf`, `RuntimeManifest`, `RUNTIME_TOOL_NAMES`, `isRuntimeToolName`, `createSandboxTools`, `SANDBOX_INSTRUCTIONS`, the skill tool names, `isSkillTool`, `SKILLS_USAGE`, `formatSkillCatalog` and `skillOfToolCall` leave `@nylorun/core/define`; `RUNTIME_PART_ID` is `SESSION_PART_ID` (`"session"`), and `agentFrom` takes `sessionInstructions`. `@nylorun/agents` no longer re-exports the skill catalog helpers. Migration 0030 closes the agent sessions that still pinned a `runtime` block (`closedReason: "protocol_15"`).
- **`turn.start` states facts.** `environment` (`TurnEnvironmentSchema`: `{id, kind, sandbox?: {workspace}}`) and `routing.sandbox.spec` (the pinned spec) join the agent's `skills`.
- **Our engine words them.** `@nylorun/harness` writes the skill catalog, the sandbox note and the skills' folder note, and defines the six sandbox tools, `load_skill` and `read_skill_resource`, in the order and bytes the `runtime` block had, so the prompt's prefix is unchanged (`engineToolsFor`, `sandboxTools`, `sandboxInstructions`, `skillCatalogText`, `skillFolderNote`, `skillTools`, all exported for a harness of your own). The skill tools run in the harness over `definition.file` (`runSkillTool`), and core no longer runs them (`tenant/skill-tool.ts` is gone). The sandbox tools' limits are harness configuration (`createHarness({ sandboxTools })`, `harnessExecutors({ sandboxTools })`, `DEFAULT_SANDBOX_TOOL_LIMITS`), as is the most a skill read takes into the context (`createHarness({ skillReadBytes })`, 10 MiB by default), held to the run's `limits.recordEntryBytes`.
- **Effects name their target.** A tool effect carries `target: {kind: "mcp" | "http" | "sandbox" | "harness" | "platform"}` (`EffectTargetSchema`) and may carry `skill`; the record routes by the kind, never by the tool's name, and a call without a target or one the session lacks is `tool.unavailable`. `hello.features.tools` and `NativeToolSchema` are removed, no tool name is reserved, and the record keeps the skill the intent names when the agent has it. A skill tool's `tool.completed` is `kind: "harness"` (it was `platform`).
- **Studio** drops the manifest panel's Runtime section: it shows the sandbox tools when the session's Environment has a sandbox.
