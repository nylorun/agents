---
"@nylorun/core": patch
"@nylorun/runtime": minor
---

A tool policy rule whose `agent` names the session's root agent (its manifest's name) also matches
the MCP and HTTP calls of the agents it uses as tools; a rule naming the subagent's id still matches
them. `PolicyCall.root` carries the root for a subagent's call. The `agent` selector's contract
comments say so.
