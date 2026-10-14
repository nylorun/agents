---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/agents": minor
---

**An agent is its manifest: step middleware and capability bundles are removed from authoring.** The Runtime already refused middleware; now the local engine runs none either, and an agent is built only from the builder's own methods. No protocol change. See MIGRATION.md.

- **Removed:** `.use()`, `.capability()`, `capability()`, `CapabilityBuilder`, `middleware()`, `model()`, `StepMiddleware`, `StepRequest`, `StepResponse`, and `Implementations[id].middleware`. To reuse tools and instructions, write a function that adds them; a bundle you publish is an Agent Plugin.
- **`@nylorun/agents`:** the standalone `skills()`, `plugin()` and `mcp()` factories are removed; use `.skills(dir)`, `.plugin(dir)` and `.mcp(servers)`. `.skills()` takes no options: the part takes the folder's name.
- **`@nylorun/harness`:** each step offers the definition's tools and instructions in order. The `middleware.entered`, `middleware.completed` and `middleware.lease-violation` observe events are gone, and a model request carries no `model` directive or runtime context items.
