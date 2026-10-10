---
"@nylorun/core": patch
"@nylorun/runtime": patch
"@nylorun/agents": patch
"nylorun": patch
---

**Clearer wording when a definition runs your code.** The refusal for a code tool or a flow's tool stage, the `hooks were removed` error and `nylo endpoints` now say that the Runtime runs agents from their manifests alone, instead of that it runs no code of yours during a session. Only the message text changed; anything matching the old wording (for example `runs no code of yours during a session`) needs the new text.
