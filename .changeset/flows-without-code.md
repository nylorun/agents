---
"@nylorun/core": major
"@nylorun/harness": major
"@nylorun/agents": major
"@nylorun/runtime": major
"@nylorun/studio": minor
---

**Flows run no code: workflow manifest v3 (manifest-only agents, step M2).** A flow agent is data: each stage gets the previous stage's output, a switch reads it, a map runs over it and a loop asks a verifier agent. See MIGRATION.md for what replaces each function.

- **Breaking (`@nylorun/core`, `@nylorun/agents`):** stage `input` functions, `switch` `on`, loop `verify` functions and `decide` are removed; a builder option that names one is refused with what replaces it. `.loop()` takes a verifier agent and a required `max`. New `.pipe(...children)` adds one stage per child; `.step()` is a deprecated alias (`NYLORUN_DEP_STEP`). `Chain`, `Switch`, `Parallel`, `Map`, `Loop`, `withInstructions`, `withoutTools`, `isSlot`, `functionKey` and the `StageArgs`, `LoopVerifyFn`, `LoopDecideArgs`, `LoopChoice` and v1 workflow types are removed. `Agent.from` for a flow takes tool nodes only.
- **Breaking (`@nylorun/core`):** workflow manifests are `workflowSchemaVersion: 3`; no node carries `input`, a switch has no `on`, a loop's `verify` is an agent and `max` is required. A v1 or v2 manifest is refused with a message naming the change. The `fn` and `verify` Actions and effect kinds, and the `loop.decided` event, are removed. `WorkflowManifestV2` / `WorkflowNodeV2` / `isWorkflowManifestV2` are now `WorkflowManifest` / `WorkflowNode` / `isWorkflowManifest`.
- **Breaking (`@nylorun/harness`):** the flow engine is `flow-3` and runs only v3 manifests; v1 and v2 engines, `agentTurnValue` and the `fn` / `verify` effect kinds are removed. A switch picks the case named by the previous output or its `route` field, a map runs over an array or an `items` array, and a loop retries with its verifier's feedback until `max`. An `agent` effect carries the flow's input as `flowInput` when the stage's input differs.
- **Breaking (`@nylorun/runtime`):** no `fn` or `verify` Actions are offered or delivered. An agent stage's message shows the flow's input as the original request before its own input, and each verifier verdict is recorded as `loop.verified`.
- `@nylorun/studio`: the workflow tree draws v3 manifests (a loop shows its verifier agent and `max`); the loop timeline drops decide outcomes, and `loop.verified` shows the feedback.
