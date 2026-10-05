---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

**Key roles and management keys (Runtime and Management APIs, step A1).** Additive; the protocol stays at 7. Application keys keep reaching every route they reach today.

- `@nylorun/runtime`: a key now has a role. `application` keys are unchanged. A new **management key** (role `management`) reaches the Management API (`/v1/tenant/*`) and `/v1/me` only, as itself: `Nylorun-Subject` or `Nylorun-Scopes` with it is `403 subject_invalid`, an `Origin` is `403 origin_rejected`, and any other route is `403 key_role_mismatch`. `/v1/me` reports it as `via: management:<id>` with no scopes and no agents. Studio's derived key has role `studio`, which reaches both. Migration `0011_key_roles` gives the existing `studio` principal its role.
- `@nylorun/runtime`: management keys are issued only on the Tenant's machine, with the new `nylorun-operate` command in the runtime image (`nylorun-operate keys list | put <id> [--role application|management] | rm <id>`), or from `NYLORUN_MANAGEMENT_KEY_FILE` (64 hex characters), which the Host registers as the key `bootstrap` at every start and replaces when the file changes. `bootstrap` is reserved like `studio`. Rotating a key keeps its role; putting an id that holds the other role is refused.
- `@nylorun/core`: `KEY_ROLES`, `KeyRole`, `BOOTSTRAP_KEY_ID` and the error code `key_role_mismatch`.
