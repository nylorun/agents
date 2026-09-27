# @nylorun/admin

Admin API client for creating, listing, inspecting and deleting Tenants, and
reading Host service status. Depends only on `@nylorun/core`. Requires Node
24+. Vocabulary: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

```ts
import { createAdmin } from "@nylorun/admin";

// Resolution: explicit options → NYLORUN_ADMIN_URL + NYLORUN_ADMIN_KEY → local Host
const admin = createAdmin();
// or: createAdmin({ url, key }) / createAdmin({ home: "/path/to/host-root" })

const status = await admin.status();
const { tenant, applicationKey } = await admin.createTenant({ name: "my-app" });
await admin.listTenants();
await admin.getTenant(tenant.id);
await admin.deleteTenant(tenant.id, { activeWork: "refuse" });
```

`createTenant` generates the Tenant id, principal, application key and
idempotency key locally; only the key's hash is sent. On network error or
`5xx` it retries up to three times with identical values. Persist the returned
`applicationKey` — the Host never sees it in cleartext again.

`createTenant` also registers the Tenant's Studio principal (`studio`) by
sending the hash of `deriveStudioToken(adminKey, tenantId)`. Studio derives the
same key from the admin key to call that Tenant's API, so whoever holds the
admin key can reach every Tenant created this way.

Local Host resolution reads `host.json` and `host-credentials.json` under
`NYLORUN_HOME` / `~/.nylorun` (or `options.home`). On POSIX the credentials
file must be owned by the user and not group- or world-readable. First use
checks `/health` compatibility and throws `incompatible_host` on mismatch.

Errors are `AdminError` with a registry `code` from `@nylorun/core`
(`ERROR_CODES`). Re-exports: `PROTOCOL_FEATURES`, `ERROR_CODES`,
`compareVersions`.

Developer applications do **not** depend on this package — only managing
clients (CLI, desktop Runtime panel, CI) do.
