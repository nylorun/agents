---
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/core": minor
"@nylorun/agents": minor
---

A message's context (ADR-157, Host feature `message-context`): a message takes `context`, up to 16 items `{ type?, value }` and 16 KiB in all, facts for its own turn only. The Runtime keeps them on `command.message` and passes them to the turn as its input's `metadata.context`; our harness renders the turn's latest ones in the `<runtime-context>` block after the history on every model call of that turn, and later turns leave them out. A workflow session refuses them. `session.input(value, { context })` and `session.inputParts(parts, { context })` send them, and refuse before sending when the Runtime lacks the feature.
