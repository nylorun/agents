---
"@nylorun/runtime": minor
"@nylorun/admin": minor
---

**The Management API's routes and client (Runtime and Management APIs, step A2).** Additive; the protocol stays at 7.

- `@nylorun/runtime`: `GET /v1/tenant/keys`, `PUT /v1/tenant/keys/{keyId}` and `DELETE /v1/tenant/keys/{keyId}` manage the Tenant's application keys with a management key. A management key's name, `studio` and `bootstrap` are refused, so no API call creates, rotates or deletes a management key. Vaults (`/v1/tenant/vaults…`, including `…/oauth/start`) and signing keys (`/v1/tenant/signing-keys…`) are also served under `/v1/tenant`, for management keys only; the old `/v1/vaults…` and `/v1/access/signing-keys…` paths keep serving application keys until protocol 8. `GET /v1/oauth/callback` and `GET /v1/access/jwks` keep their paths.
- `@nylorun/admin`: `createManagementClient({ url, key })` is the Management API's client: `tenant` (status, seed, reset), `keys` (application keys), `models` (catalog, providers, get, put, select, usage, budgets), `vaults` (with credentials and `startOAuth`), `signingKeys` and `settings` (sandbox, artifacts). `@nylorun/admin/client` exports it with no Node module, for browser apps behind a proxy that adds the key.
