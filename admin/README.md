# @nylorun/admin

Admin API client for a Runtime installation: its status, with the one Tenant it
serves, its operator keys, and the Studio key the admin key derives. Depends only on
`@nylorun/core`.
Requires Node 24+. Vocabulary: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

```ts
import { createAdmin } from "@nylorun/admin";

// Resolution: explicit options → NYLORUN_ADMIN_URL + NYLORUN_ADMIN_KEY → local Host
const admin = createAdmin();
// or: createAdmin({ url, key }) / createAdmin({ tenant: "my-app" }) / createAdmin({ home })

const { tenant } = await admin.status();
// tenant: { id, name, state: "open" | "unavailable", envelope, cause? }
```

An installation serves one Tenant, which its Host creates on first start. There
are no Tenant routes: `createTenant`, `listTenants`, `getTenant` and
`deleteTenant` are gone, and a Host answers `/v1/admin/tenants*` with `404`.
When the Tenant cannot be opened, `status.tenant.state` is `unavailable` and
`cause` names why (`schema-too-new`, `kek-missing`, `database-layout-old`, …).

Operator keys (Host feature `operator-keys`) are the Tenant's revocable
application keys, managed by name. `put` creates a key or rotates it and returns
it once; a rotated or deleted key stops authenticating on its next request.
Ids match `^[a-z][a-z0-9-]{0,31}$`; `studio` is refused:

```ts
const { key } = await admin.keys.put("backend"); // { id, role, createdAt, key, rotated }
await admin.keys.list(); // [{ id, role, createdAt }], never the keys
await admin.keys.delete("backend"); // true when it existed
```

`nylorun start` links a Project with the operator key `project`, and
`nylorun key put|list|rm` does the same from a terminal.

The one key the admin key derives is Studio's (`deriveStudioToken(adminKey,
tenantId)`): the Host registers `studio` by hash when it creates its Tenant, so
Studio, and an app embedding it, stores no key, and rotating the admin key
rotates it. Every other client holds an operator key. Since protocol 7 no other
key is derived; a key an earlier Host derived stays valid as an ordinary key
until you replace it with `admin.keys.put(<its id>)`.

Local Host resolution reads `host.json` and `host-credentials.json` from the
Host root: `options.home`, else `NYLORUN_HOME`, else the Tenant's Host root
`~/.nylorun/tenants/<tenant>/` for the local Tenant named by `options.tenant`,
`NYLORUN_TENANT` or the Project link (`tenant` in `.nylorun/link.json`, format
3, found from `options.cwd` upwards; a link from an older nylorun throws
`connection_missing`). On POSIX the credentials file must be owned by the
user and not group- or world-readable. First use checks `/health`
compatibility and throws `incompatible_host` on mismatch.

`mintStudioLoginToken({ studioUrl, adminKey })` mints a single-use Studio login
token for an app that embeds Studio; its optional `tenant` must name the Host's
Tenant.

Errors are `AdminError` with a registry `code` from `@nylorun/core`
(`ERROR_CODES`). Re-exports: `PROTOCOL_FEATURES`, `ERROR_CODES`,
`compareVersions`, `deriveStudioToken`, `tenantHostRoot`, `OPERATOR_KEYS_FEATURE`.

Developer applications do **not** depend on this package — only managing
clients (CLI, desktop Runtime panel, CI) do.
