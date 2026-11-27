# The engine's own tools

The tools, and the text the model reads with them, that the engine adds to an agent beside the agent's own: sandbox, skills, artifacts, memory, plan, connections, wakes, the session's MCP tools, tool search, media reads and the outputs folder. Each is named and described in `@nylorun/core/engine` and run here, most of them through the host's effect seam.

## Interface

- `engineToolsFor`, `EngineTools`, `EngineToolOptions` (`engine-tools.ts`): everything one agent gets, in one fixed order — the instruction blocks and the tools.
- `read_artifact` and `save_artifact`: `artifactToolsFor`, `artifactInstructions`, `isArtifactTool`, `runArtifactTool`, `ArtifactToolOptions`, `ArtifactToolContext` (`artifacts.ts`).
- `load_skill` and `read_skill_resource`: `skillCatalogText`, `formatSkillCatalog`, `skillFolderNote`, `skillTools`, `isSkillTool`, `runSkillTool`, `sandboxSkillsOf`, `sandboxPluginsOf`, `definitionFileChunks`, `mountSkills`, `SkillToolContext`, `SkillFiles` (`skills.ts`).
- `memory`: `memoryTool`, `memoryIndexBlock` (`memory.ts`).
- `update_plan`: `planTool`, `isPlanTool`, `planOf`, `runPlanTool`, `cut`, `PLAN_UPDATED`, `PlanToolContext` (`plan.ts`).
- `request_connection`: `connectionTool`, `isConnectionTool`, `connectedIn`, `runConnectionTool` (`connection.ts`).
- `ask`: `isAskTool`, `runAskTool` (`ask.ts`).
- `schedule_wake`: `wakeTool` (`wake.ts`).
- The session's MCP tools: `mcpToolSet`, `mcpToolName`, `mcpToolNames`, `mcpToolKey`, `mcpToolConfigOf`, `DEFAULT_MCP_TOOL_CONFIG`, `MODEL_TOOL_NAME_MAX`, `McpToolSet`, `McpLayout`, `McpRenamedTool`, `McpToolConfig` (`mcp.ts`, re-exported from `@nylorun/core/engine`).
- `tool_search` and `tool_call`: `runToolSearch`, `rank`, `tokens`, `isToolSearch`, `TOOL_SEARCH_TOOL`, `TOOL_CALL_TOOL`, `deferredToolsNote`, `deferredToolsTools`, `DeferredServerNote` (`tool-search.ts`).
- Result shaping: `shapeToolOutcome`, `StepBudget`, `spillKey`, `resultBytes`, `mayNeedShaping`, `previewOf`, `cutMessage`, `toolResultConfigOf`, `DEFAULT_TOOL_RESULT_CONFIG`, `ShapeContext`, `Stored`, `ToolResultConfig` (`results.ts`).
- Sandbox tools: `sandboxTools`, `sandboxToolLimitsOf`, `sandboxInstructions`, `DEFAULT_SANDBOX_TOOL_LIMITS`, `SandboxToolLimits` (`sandbox.ts`).
- A media `read`: `mediaReadOf`, `runMediaRead`, `MediaReadContext` (`read-media.ts`).
- The outputs folder: `saveOutputs`, `outputsConfigOf`, `DEFAULT_OUTPUTS_CONFIG`, `OutputsConfig`, `OutputsContext` (`outputs.ts`).
- `skillOfToolCall` (`trace.ts`): the skill a tool call ran.
- `startedSkillsOf`, `withPersonStartedSkills` (`person-started.ts`): skills only a person starts.
- `jsonBytes`, `utf8Boundary`, `textPage` (`text-page.ts`): a page of text whole in characters.

## Rules

- The tools and blocks come in one order, which keeps the prompt's prefix stable: instructions first, then the sandbox, skill, artifact, wake, memory, plan and connection tools (`engine-tools.ts`).
- The tools are offered after the agent's own and before the session's MCP tools, and are not part of the hashed manifest (`engine-tools.ts`).
- A tool past the artifact, skill, result and plan limits is cut or stored, never refused (`plan.ts` `cut`, `results.ts` `shapeToolOutcome`).
- `read_artifact` pages text at `artifactPageBytes`, escaped as JSON, and in whole characters (`artifacts.ts`, `text-page.ts`).
- A tool result never passes its cap: a result that cannot be stored keeps its preview and says why (`results.ts`).
- One step's results share a `StepBudget`, held under the run's `recordEntryBytes` less `entryEnvelopeBytes` (`results.ts`, `StepBudget`).
- `spillKey` is the call's effect id with the bytes' hash, so the same answer twice writes no new artifact (`results.ts`).
- A media `read` a model cannot read fails `sandbox.unreadable` before anything is stored, and a file whose first bytes are not its kind fails `sandbox.binary_file` (`read-media.ts`).
- A skill only a person starts is left out of the catalog, `load_skill`'s names and its answer unless the turn's input names it (`person-started.ts`).
- Skills' files are mounted at `/skills/<name>@<hash>/`, read-only, before each sandbox call (`skills.ts`, `mountSkills`).

## Side effects

- Artifacts are read and written over the Harness API's `artifact.read` and `artifact.write` (`artifacts.ts`, `results.ts`, `read-media.ts`, `outputs.ts`).
- Skill files come over the Harness API's `definition.file` seam, a range at a time (`skills.ts`, `definitionFileChunks`).
- Mounting skills writes into the session's sandbox through the host's files executor (`skills.ts`, `mountSkills`).
- `update_plan` claims a `plan.updated` event for the run's turn (`plan.ts`).
- A completed turn saves its outputs directory as the session's `outputs` folder artifact, before the turn ends, and a failure there is claimed and does not fail the turn (`outputs.ts`, `saveOutputs`).
- `ask`, `request_connection` and a sandbox call pause the turn or leave it to the host; each is one effect (`ask.ts`, `connection.ts`, `sandbox.ts`).

## Verification

- Run: `npm test` from `runtime/harness/`
