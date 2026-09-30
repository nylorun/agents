---
"@nylorun/runtime": patch
---

**Action endpoints: Durable Session Execution can run deliveries (groundwork, unused yet).** The Worker endpoint registers a fourth Restate virtual object, `NylorunAction` (key `<tenantId>:<actionId>`), whose `deliver` handler runs one Action's delivery at a time and re-sends itself after a delay when the delivery asks to be retried. The in-process execution does the same. Nothing schedules deliveries yet. Operators will see the new service in Restate, and its paused invocations appear in the Tenant status with the others.
