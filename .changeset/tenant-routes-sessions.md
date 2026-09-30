---
"@nylorun/runtime": patch
---

**Agent and session routes on Hono.** `GET /v1/agents`, `PUT /v1/agents/:id`, `GET /v1/sessions`, `PUT` and `GET /v1/sessions/:id`, `GET /v1/sessions/:id/items`, the session event stream (`GET /v1/sessions/:id/events`) and `POST /v1/sessions/:id/sandbox/:tool` are declared as Hono routes (`api/http/routes/sessions.ts`), with who may call each for the Runtime's OpenAPI document. Answers are unchanged.
