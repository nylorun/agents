---
"@nylorun/core": minor
"@nylorun/harness": patch
"@nylorun/runtime": patch
"@nylorun/studio": patch
---

A subagent used as a tool receives `{ task }` as a string, so one that declares an `inputSchema` that can't take a string is now refused when it is built or saved (ADR-162): `delegation.input` in the builder and the manifest contract, `delegation_input` in a manifest's files. Before, the manifest saved and the flow's first stage got a string it didn't declare. Messages and Studio now use ADR-162's words: an agent manifest is driven by a model loop or by a flow, and a flow's stages can be subagents; "flow agent" is no longer a kind. Studio's Agent manifests list filters by **Driven by** (Model loop or Flow), a flow's section is **Stages**, and a subagent used as a tool shows as "Subagent". No code, diagnostic code or wire format changes.
