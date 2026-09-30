---
"@nylorun/runtime": minor
---

**The Tenant's public keys are public.** `GET /v1/access/jwks` answers with `Nylorun-Tenant` alone, with no credential, so an Action endpoint can verify delivery tokens (and anyone can verify subject tokens) without holding a key.

- A credential that is sent is still checked: a wrong one is still the opaque `404`. A browser still needs a publishable key.
- Routes declare this with `anonymous: true`, which only the JWKS route uses. In the OpenAPI document it appears as an empty security requirement (`{}`).
