---
"@nylorun/core": major
"@nylorun/harness": major
"@nylorun/agents": major
"@nylorun/runtime": major
"@nylorun/studio": minor
---

**Hooks are removed; manifests are v5 (manifest-only agents, step M1).** The Runtime no longer calls the developer's code before or after a turn or a model call. See MIGRATION.md for what replaces each use.

- **Breaking (`@nylorun/core`, `@nylorun/agents`):** `.beforeTurn()`, `.beforeModel()`, `.afterModel()`, `.afterTurn()`, the deprecated `.before()` / `.after()`, a capability's `before` / `after`, and the `Patch`, `Decision`, `TurnDecision`, `BeforeHook`, `AfterHook`, `HookScope` types and `runHookPoint` / `hooksFrom` helpers are removed. A capability that still passes `before` or `after` is refused with `hooks were removed: …`.
- **Breaking (`@nylorun/core`):** `manifestSchemaVersion` is 5. `capabilities[].hooks` is gone; a manifest that names it, or a v3/v4 manifest, is refused with a message naming the change. The `hook` Action and the `hook` effect kind of the Harness API are removed.
- **Breaking (`@nylorun/harness`):** the turn loop runs no hooks; the turn state a checkpoint carries is `{ turnId }`, and the engine version is `hosted-4`, so checkpoints of earlier engines are refused.
- `@nylorun/runtime`: no `hook` Actions are offered or delivered.
- `@nylorun/studio`: the Agent Manifest tab drops the Hooks count and the turn lifecycle.
