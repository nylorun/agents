---
"@nylorun/runtime": minor
---

A version that sets `harness.memory.index: false` (`agent-folder/2`, ADR-100) gets no memory index
rendered: `turn.start.memory` comes without `index`. The harness may claim `engine.diagnostic`,
which the OpenAPI document lists.
