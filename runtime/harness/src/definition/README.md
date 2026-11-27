# Agent definitions

Turns an authored agent, or a manifest with its implementations, into the one object the rest of the engine runs: the manifest, its registry, its implementations and the hash that identifies it. It also checks a saved execution state against the definition it was made from. The engine keeps definitions and the run apart, so a hosted agent is its manifest alone.

## Interface

- `AgentDefinition` (`agent-definition.ts`): the manifest with its `parts`, `registry`, `output`, `manifest` and `hash`, and its `implementations`.
- `definitionFor(agent)` (`agent-definition.ts`): the definition of an authored agent, checked and hashed.
- `definitionFromBinding(binding)` (`agent-definition.ts`): the definition of a binding: its manifest, parts, registry, tools and implementations.
- `tryDefinitionFor(agent)` (`agent-definition.ts`): the definition, or `undefined` when the value is not an agent.
- `ToolRegistry` (`registry.ts`): the tools a definition offers by name.
- `checkCompatibility(manifest, state)`, `CompatibilityResult` (`compatibility.ts`): a saved state against a manifest's hash.

## Rules

- The definition keeps the binding's own `manifest`, and its `hash` is `hashManifest(manifest)` (`agent-definition.ts`).
- A tool name registered twice under one definition fails `tool.invalid` (`registry.ts`).
- `checkCompatibility` fails `execution.incompatible` when the state's `manifestHash` (when it has one), its `agentId`, or a `version` other than 1, differs (`compatibility.ts`).
- `tryDefinitionFor` answers `undefined` rather than throwing for a value that is not an agent (`agent-definition.ts`).

## Side effects

- None found.

## Verification

- Run: `npm test` from `runtime/harness/`
