---
"@nylorun/runtime": patch
---

**The AG-UI endpoint on Hono.** Its four routes (run, thread messages, reattach, cancel under `/v1/ag-ui/agents/:agent`) are declared as Hono routes (`api/ag-ui/endpoint.ts`), documented with AG-UI's own schemas (`RunAgentInput`, the event union, `Message`). Answers and streams are unchanged: the legacy dispatcher and the routes share one implementation.
