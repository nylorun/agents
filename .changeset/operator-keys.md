---
"@nylorun/runtime": minor
"@nylorun/core": minor
"@nylorun/admin": minor
"nylorun": minor
---

**Operator keys, and project links on them (F9 I1).** The Admin API manages the Tenant's application keys by name: `PUT /v1/admin/keys/{id}` creates a key or rotates it and returns it once, `GET /v1/admin/keys` lists every key's id, role and issue time (never the keys), and `DELETE /v1/admin/keys/{id}` removes one. A rotated or deleted key stops authenticating on its next request. Ids follow `^[a-z][a-z0-9-]{0,31}$`; `studio` (derived from the admin key) is refused. Keys keep today's format (64 hex) and only their SHA-256 is stored, in the existing principals table (no migration). Host feature `operator-keys` (additive, protocol unchanged); core adds the `OperatorKey`, `ListOperatorKeysResponse`, `PutOperatorKeyResponse` and `DeleteOperatorKeyResponse` schemas.

- `@nylorun/admin`: `admin.keys.put(id)`, `admin.keys.list()` and `admin.keys.delete(id)`; they refuse with `incompatible_host` when the Host lacks `operator-keys`.
- `nylorun key put|list|rm <id>` manages a running local Tenant's keys; `put` prints the key once on stdout.
- `nylorun start` no longer derives the project's key. It keeps `.nylorun/credentials.json` while its key still reaches the Tenant (one authenticated read); otherwise it gives the project the operator key `project`, which the Host root keeps in `project-credentials.json` (0600) so every checkout linked to the Tenant shares it. An existing derived project key keeps working and is adopted.
- `nylorun sandbox` uses the linked project's key, or the operator key `cli` it puts once and keeps in `<Host root>/cli-credentials.json` (0600).
- The ephemeral Runtime (`startEphemeralRuntime`) no longer registers the derived `project` principal; pass `derivedPrincipals: ["project"]` to keep it. Derived principals (`NYLORUN_DERIVED_PRINCIPALS`, `deriveTenantKey`) still work on a Host.
