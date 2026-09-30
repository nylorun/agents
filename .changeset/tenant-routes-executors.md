---
"@nylorun/runtime": patch
"@nylorun/core": patch
---

**Tenant routes start moving to Hono.** The executor and Action routes and session commands (`/v1/executors/connect`, `/v1/actions/**`, `/v1/executors`, `/v1/executors/:agentId` and `POST /v1/sessions/:id/commands`) are declared as Hono routes (`api/http/routes/executors.ts`). Each says who may call it: its credentials, subject scopes and browser access. The Runtime's OpenAPI document shows this, and the executor routes are marked deprecated there, since Action endpoints replace them. Answers are unchanged. A path the new routes don't match exactly still goes to the router they replace, so its answer is unchanged too.

**Core:** the recursive contract schemas (JSON values, workflow nodes and manifests, and an agent used as a tool) carry a Zod `id`, so documents generated from them refer back to the named schema instead of recursing. Parsing is unchanged.
