---
"@nylorun/runtime": patch
---

**Tenant settings and vault routes on Hono.** `/v1/tenant/**` (status, reset, config seed, models, providers, model and model selection, sandbox configuration) and `/v1/vaults/**` (vaults and credentials) are declared as Hono routes (`api/http/routes/tenant.ts`, `api/http/routes/vaults.ts`), with who may call each for the Runtime's OpenAPI document. Answers are unchanged: an executor calling them is still refused and recorded, and a subject's vault is still checked as theirs before anything else.
