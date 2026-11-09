---
"@nylorun/core": minor
"@nylorun/runtime": patch
"nylorun": patch
"@nylorun/studio": patch
---

`GET /v1/tenant/sandbox`'s `cluster` names its `backend` (`agent-sandbox` or `substrate`) and, on Agent Substrate, its `atespace`. `nylorun doctor sandbox` prints the Tenant's pods line (backend, context, namespace, ready), and Studio's Sandbox section says Agent Substrate with the atespace.
