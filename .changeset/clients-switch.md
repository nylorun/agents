---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/admin": major
"@nylorun/studio": minor
"nylorun": minor
"@nylorun/cli": minor
---

**The clients use management keys (Runtime and Management APIs, step A3).** The protocol stays at 7; every client keeps working against a protocol 7 Runtime's routes.

- `nylorun`: `nylorun start` keeps an application key (`project`) and a management key (`project-management`) for a Project, in `<Host root>/project-credentials.json` and the Project's `.nylorun/credentials.json` (still format 1, with new `managementKey` and `managementPrincipalId` fields). A credentials file holding only an application key gains a management key at the next start. Commands outside a project keep `cli` and `cli-management`. Keys are issued through `nylorun-operate` in the runtime container instead of the Admin API, and `nylorun key put <id> --management` puts a management key. Seeding the Tenant and `nylorun mcp connect` use the management key (`/v1/tenant/vaults`). Studio reaches the Runtime's public listener.
- `@nylorun/cli`: `status`, `reset`, `configure`, `doctor` and `access signing-keys` use the Management API through `@nylorun/admin` with the Project's management key, or `NYLORUN_MANAGEMENT_KEY`.
- `@nylorun/studio`: local Studio needs no login. A request on the published loopback address (`localhost` or `127.0.0.1` at Studio's port) acts as signed in; hosts behind a sign-in proxy and embedding keep their login, and state-changing requests still need Studio's own `Origin`. Studio learns its Tenant from `GET /v1/tenant` with its key instead of the Admin API, and its Connections page manages vaults through `@nylorun/admin/client` at `/v1/tenant/vaults`.
- **Breaking (`@nylorun/admin`, `@nylorun/runtime`): Studio's key is derived from the admin key alone.** `deriveStudioToken(adminKey)` takes no Tenant id (HMAC-SHA256 over `nylorun/studio/v2`). The Host registers the new key's hash at its next start, replacing the old one; an app that embeds Studio and derives its key must update.
- `@nylorun/core`: `ProjectCredentialsFileSchema` gains optional `managementKey` and `managementPrincipalId`.
