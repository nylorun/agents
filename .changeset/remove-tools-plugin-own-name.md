---
"@nylorun/core": patch
"@nylorun/runtime": patch
"nylorun": patch
---

A message's `removeTools` turns a Runtime plugin's tool off by its own name too: `memory` now does what `nylorun__memory` does, so the name events and `check --explain` showed no longer leaves the tool on without a word (#589). `nylorun check --explain` lists a plugin's tools by the names the model reads (`nylorun__memory`, `nylorun__update_plan`), the ones `removeTools` and tool policy take, and its memory note says the index is pinned again at a turn after a write from elsewhere (#590, #591).
