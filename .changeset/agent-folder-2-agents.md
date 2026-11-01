---
"@nylorun/agents": minor
---

`previewTurn(manifest, { sandbox?, memory?, mcpFacts?, model?, selfWake?, loop? })` (ADR-100):
what the model of a turn reads and may call, offline, built from the code the harness runs:
`{ system, tools, blocks, features, pinned, diagnostics, agents }`, the root agent's and each
subagent's. It takes a compiled agent manifest v8 (`checkFolder`'s) or a loop manifest; the facts
it is not given come from the manifest.
