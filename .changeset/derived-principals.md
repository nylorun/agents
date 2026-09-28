---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/admin": minor
---

**Derived principals** (optional Host feature `derived-principals`): a client that holds the admin key no longer needs to store an application key.

- `admin.createTenant({ name, principals: ["babai"] })` registers each named principal by the hash of its derived key, and `admin.deriveTenantKey(tenantId, principalId)` (or `deriveTenantKey(adminKey, tenantId, principalId)`) recomputes the key when needed.
- `POST /v1/admin/tenants` accepts `derivedPrincipals: [{ id, credentialHash }]`. Ids match `^[a-z][a-z0-9-]{0,31}$` and `studio` is reserved; duplicate ids or credentials answer `400`. A retried create must name the same principals.
- `createTenant` with `principals` throws `incompatible_host` before sending anything to a Host without the feature.
