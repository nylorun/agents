---
"@nylorun/runtime": patch
---

**The A2A endpoint on Hono.** `POST /v1/a2a/agents/:agent` (A2A JSON-RPC, for a subject) and `GET /v1/a2a/agents/:agent/card` are declared as Hono routes (`api/a2a/endpoint.ts`). The Runtime's OpenAPI document describes the JSON-RPC envelope and links the A2A specification. Answers are unchanged: the legacy dispatcher and the routes share one implementation.
