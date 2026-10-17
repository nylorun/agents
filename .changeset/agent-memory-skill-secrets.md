---
"@nylorun/agents": minor
"@nylorun/core": patch
---

`agentManifests.save({ agent, runtime, memory })` turns on a built agent's memory (`harness.memory`, `{ access?, instructions? }`), and a skill folder's `SKILL.md` may list the secret slots its scripts read in its frontmatter (`secrets: [GH_TOKEN]`): `.skills()`, `.plugin()` and `composeManifest` make them the skill's `secrets` in the harness section, which the Runtime checks against `runtime.secrets` at save. A `secrets` that is not a list of environment variable names skips the skill with a warning.
