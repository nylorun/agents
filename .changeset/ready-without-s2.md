---
"@nylorun/runtime": patch
"nylorun": patch
---

`/ready` no longer checks S2: its `checks` cover the listener, the Tenant, Postgres and Restate, and an unreachable S2 leaves it `200`. S2 only serves API listeners (history, SSE, AG-UI and A2A), so an outage degrades those reads and never makes the Runtime unready. S2's reachability stays in the Tenant's status (`GET /v1/tenant`, `streams.reachable`).
