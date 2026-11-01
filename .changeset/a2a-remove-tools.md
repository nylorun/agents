---
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

A2A `SendMessage` takes `message.metadata.removeTools` (Host feature `remove-tools`): the tools a new message's turn may not use, by name, as a session message's `removeTools`. `createA2aClient`'s `send` takes `removeTools`.
