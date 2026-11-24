---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

Skills only a person starts. A `SKILL.md` may set `disable-model-invocation: true`, as Claude Code's skills do; the compiler and the SDK carry it as the skill's `disableModelInvocation: true`. Such a skill is left out of the model's catalog and `load_skill` unless the turn's message names it: a message command's new `skill` (the SDK's `MessageOptions.skill`, an A2A message's `metadata.skill`). The named skill is offered for that turn only, and the model is told the person started it; an agent used as a tool never gets it. A name the session's agent doesn't hold is `400 unknown_skill`, and a message naming a skill waits for its own turn rather than steering one. Host feature `person-started-skills`; agent manifest `v8.7` and harness file `v1.7` take the field. Also fixes the SDK sending a message's `context` twice with parts.
