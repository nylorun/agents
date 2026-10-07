# @nylorun/admin

The Management API client (protocol 8): the Tenant's status, seed and reset, its
models, vaults, MCP server previews, signing keys, settings and application keys, through
`/v1/tenant/*` with a **management key**. It also holds the two helpers over the
admin key that Studio needs. Depends only on `@nylorun/core`.
Requires Node 24+. Vocabulary: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

Developer applications do **not** depend on this package: they use the Runtime
API through `@nylorun/agents`. Operators' clients do: the CLI, Studio, CI and
your own tools.

```ts
import { createAdmin } from "@nylorun/admin";

const admin = createAdmin();
// or: createAdmin({ url, key }) / createAdmin({ tenant: "my-app" }) / createAdmin({ home })

const status = await admin.tenant.status(); // GET /v1/tenant
const model = await admin.models.get(); // the Tenant's model, never its secret
const { key } = await admin.keys.put("backend"); // a new application key, shown once
```

## Connecting

`createAdmin(options?)` resolves the URL and the management key once, in this
order, and `admin.source` says which one it used (`options`, `environment` or
`local-host`):

1. `options`: `url` and `key` (a management key), both or neither.
2. The environment: `NYLORUN_RUNTIME_URL` and `NYLORUN_MANAGEMENT_KEY`. Only the
   key selects this: `NYLORUN_RUNTIME_URL` alone is an app's, with
   `NYLORUN_SERVER_KEY`.
3. The local Host. The URL comes from `host.json` in the Host root:
   `options.home`, else `NYLORUN_HOME`, else `~/.nylorun/tenants/<tenant>/` for
   the local Tenant named by `options.tenant`, `NYLORUN_TENANT` or the Project
   link (`.nylorun/link.json`, format 3, found from `options.cwd` upwards). The
   key is the `managementKey` of the linked Project's `.nylorun/credentials.json`,
   else of the Host root's `project-credentials.json`, else of its
   `cli-credentials.json`. `nylorun start` writes them (the keys
   `project-management` and `cli-management`). On POSIX a credentials file must
   be the user's and not group- or world-readable.

When none resolves, or the Project link is from an older nylorun, it throws
`connection_missing` and lists what it tried. The first request checks the
Host's `/health` and throws `incompatible_host` unless the Host serves protocol
8 with the feature `management-api`.

Management keys are issued on the Tenant's machine only:
`npx nylorun key put <id> --management` on a local Tenant, or
`nylorun-operate keys put <id> --role management` inside the runtime container
([SELF_HOSTING.md](../SELF_HOSTING.md#keys)). No API call creates one.

## The groups

| Group | Methods | Routes |
| --- | --- | --- |
| `admin.tenant` | `status()`, `seed(request)`, `reset(request)` | `GET /v1/tenant`, `PUT /v1/tenant/config/seed`, `POST /v1/tenant/reset` |
| `admin.keys` | `list()`, `put(id)`, `delete(id)` | `/v1/tenant/keys…` |
| `admin.models` | `catalog()`, `providers()`, `get()`, `put(request)`, `select(request)`, `usage(query)`, `budgets.get()`, `budgets.put(request)` | `/v1/tenant/models`, `/providers`, `/model`, `/model/selection`, `/usage`, `/budgets` |
| `admin.vaults` | `create`, `list(ownerUserId?)`, `get`, `delete`, `credentials.create`, `.list`, `.get`, `.rotate`, `.delete` | `/v1/tenant/vaults…` |
| `admin.mcp` | `preview({ url, type?, name?, vaultId? })` | `POST /v1/tenant/mcp/preview` |
| `admin.signingKeys` | `list()`, `rotate({ force? })`, `revoke(kid)` | `/v1/tenant/signing-keys…` |
| `admin.settings` | `sandbox.get()`, `sandbox.put(request)`, `artifacts.get()`, `artifacts.put(request)` | `/v1/tenant/sandbox`, `/v1/tenant/artifacts` |

A request body's `requestId` is optional: the client makes one.

`admin.keys` manages the Tenant's **application keys**, the keys app servers
use on the Runtime API. `put` creates a key or rotates it and returns it once;
a rotated or deleted key stops authenticating on its next request. `list`
shows every key's id, role and when it was issued, never the keys. Ids match
`^[a-z][a-z0-9-]{0,31}$`. `studio`, `bootstrap` and the id of a management key
are refused, so a management key can never mint another.

```ts
const { key } = await admin.keys.put("backend"); // { id, role, createdAt, key, rotated }
await admin.keys.list(); // [{ id, role, createdAt }]
await admin.keys.delete("backend"); // true when it existed
```

Installation vaults hold the installation's shared credentials. A session
attaches them by id (`vaultIds`) through the Runtime API:

```ts
const vault = await admin.vaults.create({ scope: "installation", name: "tools", idempotencyKey: "tools" });
await admin.vaults.credentials.create(vault.id, {
  name: "linear",
  idempotencyKey: "linear",
  auth: { type: "bearer", url: "https://mcp.linear.app/mcp", token: process.env.LINEAR_TOKEN! },
});
```

`admin.mcp.preview` shows what that server offers with that credential, before
an agent names it: the Runtime connects, lists the tools within 15 s and calls
none. Each tool has the name the model would call it (made with `name`,
default from the URL's host), its annotations and its input schema's size. A
server that answers `401` comes back with `authRequired` and its RFC 9728
protected-resource metadata; one that cannot be listed rejects with
`mcp_preview_failed` (`details.failure`).

```ts
const preview = await admin.mcp.preview({ url: "https://mcp.linear.app/mcp", name: "linear", vaultId: vault.id });
for (const tool of preview.tools) console.log(tool.modelName, tool.schemaBytes);
if (preview.authRequired) console.log("needs a sign-in:", preview.authRequired.resourceMetadata);
```

## In a browser

`@nylorun/admin/client` exports `createManagementClient({ url, key?, fetch?,
headers? })` and `ManagementClient`, with the same groups and no Node module.
It is for a browser app behind its own server that adds the management key, as
Studio's Connections page is: omit `key`, and point `url` at that server. Never
send a management key from a browser: the Runtime refuses any key sent with an
`Origin` (`403 origin_rejected`).

```ts
import { createManagementClient } from "@nylorun/admin/client";

const admin = createManagementClient({ url: "/my-proxy" });
```

The main entry exports `createManagementClient` too, for a server that already
has its URL and key.

## Studio's key and login tokens

The admin key in `host-credentials.json` is the installation's root secret, and
no request accepts it. Two helpers use it locally:

- `deriveStudioToken(adminKey)` returns Studio's key: HMAC-SHA256 with the admin
  key over `nylorun/studio/v2`. It names no Tenant. The Host registers its hash
  as principal `studio` (role `studio`, which reaches both APIs) at every start,
  so Studio stores no key and rotating the admin key rotates it. It is the only
  key derived from the admin key.
- `mintStudioLoginToken({ studioUrl, adminKey, tenant?, subject? })` asks Studio
  (`POST /_studio/login-tokens`) for a single-use login token, for an app that
  embeds Studio. Its optional `tenant` must name the Host's Tenant; `subject`
  names the person in Studio's log.

## Errors and exports

Errors are `AdminError` with a registry `code` from `@nylorun/core`
(`ERROR_CODES`) and the HTTP `status`. An application key here is
`403 key_role_mismatch`; a management key sent with `Nylorun-Subject` or
`Nylorun-Scopes` is `403 subject_invalid`.

Exports: `createAdmin`, `createManagementClient`, `ManagementClient`,
`AdminError`, `deriveStudioToken`, `mintStudioLoginToken`, `tenantHostRoot`,
`PROTOCOL_FEATURES`, `ERROR_CODES` and `compareVersions`.
