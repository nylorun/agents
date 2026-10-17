---
"@nylorun/agents": patch
---

`composeManifest(dir)`, and so `nylorun apply`, keep a `harness.manifest.json`'s `memory`: the composed harness section turned the Agent's memory on only when the manifest was saved as one document.
