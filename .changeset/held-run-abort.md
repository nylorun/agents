---
"@nylorun/harness": patch
"@nylorun/runtime": patch
---

**A run core stops while it asks about a pending Action is no longer held.** When core cancelled a run, or stopped it for a shutdown, while the harness waited for core's answer to an Action's `effect.intent`, the harness then held the run for the whole `holdMs` (5 minutes by default): it listened for an abort that had already happened. The run kept its lease, and closing the Tenant waited for it. The harness now gives such a run back at once.
