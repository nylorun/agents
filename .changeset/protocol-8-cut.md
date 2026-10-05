---
"@nylorun/core": major
"@nylorun/runtime": major
"@nylorun/agents": major
---

**Protocol 8: the Runtime API and the Management API take separate keys (Runtime and Management APIs, step A4).** Upgrade every package together; `nylorun`, `@nylorun/cli` and Studio already use management keys (A3).

- **Breaking (`@nylorun/runtime`): `/v1/tenant/*` takes only a management key.** An application key there, alone or acting for a subject, is `403 key_role_mismatch`; a management key acting for a subject is `403 subject_invalid`. This covers the Tenant's status, seed and reset, models, providers, usage and budgets, sandbox and artifact settings, application keys, vaults and signing keys. A management key on any other route but `/v1/me` and the public `/v1/access/jwks` is `403 key_role_mismatch`.
- **Breaking (`@nylorun/runtime`): vaults and signing keys moved.** They are at `/v1/tenant/vaults…` (including `…/oauth/start`) and `/v1/tenant/signing-keys…`; `/v1/vaults…` and `/v1/access/signing-keys…` are gone, with no alias. Opening a session with `vaultIds` is unchanged, as are `GET /v1/oauth/callback` and `GET /v1/access/jwks`.
- **Breaking (`@nylorun/core`, `@nylorun/runtime`): `tenant:settings` is retired.** It leaves `SUBJECT_SCOPES`; `Nylorun-Scopes` may still name it and it grants nothing. `/v1/tenant/models` and `/v1/tenant/providers` no longer admit `agents:write` subjects: apps don't read the model catalog.
- **Breaking (`@nylorun/agents`):** the vault methods (`createVault`, `listVaults`, `getVault`, `deleteVault`, `createCredential`, `listCredentials`, `getCredential`, `rotateCredential`, `deleteCredential`) and `client.access.signingKeys` / `SigningKeysClient` are removed; use `admin.vaults` and `admin.signingKeys` from `@nylorun/admin`'s `createManagementClient`. `client.access.jwks()` stays.
- `@nylorun/core`: `PROTOCOL_VERSION` is 8 and `HOST_PROTOCOL` 4–8, with the required feature `management-api`. Runtime API routes keep their request and response shapes.
- `@nylorun/runtime`: `startEphemeralRuntime` registers a management key (`managementKey`, the key `bootstrap`).
