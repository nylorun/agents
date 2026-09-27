# Changelog

## 0.3.0-beta

### Minor Changes

- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [bf1c2da]
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
  - @nylorun/core@0.6.0-beta

## 0.2.0-beta

### Minor Changes

- c49efed: **New package:** Admin API client for managing clients (CLI, desktop Runtime panel, CI). Exports `createAdmin` with `createTenant`, `listTenants`, `getTenant`, `deleteTenant`, and `status`. Depends only on `@nylorun/core`. Resolves connection from options, then `NYLORUN_ADMIN_URL`/`NYLORUN_ADMIN_KEY`, then local Host settings (`host.json` + `host-credentials.json`). Developer applications do not depend on this package.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
  - @nylorun/core@0.5.0-beta

## 0.1.0-beta

- Package skeleton (Wave 0).
