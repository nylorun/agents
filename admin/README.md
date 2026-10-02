# @nylorun/admin

Admin API client for a Runtime installation: its status, with the one Tenant it
serves, and the keys the admin key derives. Depends only on `@nylorun/core`.
Requires Node 24+. Vocabulary: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

```ts
import { createAdmin } from "@nylorun/admin";

// Resolution: explicit options → NYLORUN_ADMIN_URL + NYLORUN_ADMIN_KEY → local Host
const admin = createAdmin();
// or: createAdmin({ url, key }) / createAdmin({ stack: "my-app" }) / createAdmin({ home })

const { tenant } = await admin.status();
// tenant: { id, name, state: "open" | "unavailable", envelope, cause? }
```

An installation serves one Tenant, which its Host creates on first start. There
are no Tenant routes: `createTenant`, `listTenants`, `getTenant` and
`deleteTenant` are gone, and a Host answers `/v1/admin/tenants*` with `404`.
When the Tenant cannot be opened, `status.tenant.state` is `unavailable` and
`cause` names why (`schema-too-new`, `kek-missing`, `database-layout-old`, …).

Whoever holds the admin key can derive the keys of the Tenant's derived
principals and of its Studio principal, so those clients store no key:

```ts
const key = admin.deriveTenantKey(tenant.id!, "project");
// deriveTenantKey(adminKey, tenantId, principalId) and
// deriveStudioToken(adminKey, tenantId) are exported too.
```

The Host registers the derived principals it is configured with
(`NYLORUN_DERIVED_PRINCIPALS`, default `project`; Babai uses `project,babai`)
when it creates its Tenant, and `studio` always. Ids match
`^[a-z][a-z0-9-]{0,31}$`; `studio` is reserved. Only each key's hash is stored,
so rotating the admin key rotates every derived key. `nylorun start` writes the
`project` key into a Project's `.nylorun/credentials.json`.

Local Host resolution reads `host.json` and `host-credentials.json` from the
Host root: `options.home`, else `NYLORUN_HOME`, else the stack's Host root
`~/.nylorun/stacks/<stack>/` for the stack named by `options.stack`,
`NYLORUN_STACK` or the Project link (`stack` in `.nylorun/link.json`, found
from `options.cwd` upwards). On POSIX the credentials file must be owned by the
user and not group- or world-readable. First use checks `/health`
compatibility and throws `incompatible_host` on mismatch.

`mintStudioLoginToken({ studioUrl, adminKey })` mints a single-use Studio login
token for an app that embeds Studio; its optional `tenant` must name the Host's
Tenant.

Errors are `AdminError` with a registry `code` from `@nylorun/core`
(`ERROR_CODES`). Re-exports: `PROTOCOL_FEATURES`, `ERROR_CODES`,
`compareVersions`, `deriveStudioToken`, `deriveTenantKey`, `stackHostRoot`,
`PROJECT_PRINCIPAL_ID`.

Developer applications do **not** depend on this package — only managing
clients (CLI, desktop Runtime panel, CI) do.
