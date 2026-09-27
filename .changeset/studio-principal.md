---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/admin": minor
"@nylorun/agents": minor
"@nylorun/cli": minor
"@nylorun/studio": minor
---

**Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.
