---
"@nylorun/runtime": patch
---

**Access routes on Hono.** `POST /v1/tokens`, the access policy, signing keys, publishable keys, subject revocations and the public keys (`GET /v1/access/jwks`, open to any caller that reached the Tenant) are declared as Hono routes (`api/http/routes/access.ts`), with who may call each for the Runtime's OpenAPI document. Answers are unchanged.
