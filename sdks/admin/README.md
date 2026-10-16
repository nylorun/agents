# @nylorun/admin

The Management API client (protocol 15): the Tenant's status, seed and reset, its
models, credential coverage, MCP server previews, signing keys, settings and application keys, through
`/v1/tenant/*` with a **management key**. It also holds the two helpers over the
admin key that Studio needs. Depends only on `@nylorun/core`.
Requires Node 24+. Vocabulary: [runtime/server/src/CONTEXT.md](../../runtime/server/src/CONTEXT.md).

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
   link (`.nylorun/link.json`, format 3, in the nearest directory with
   `.nylorun/` from `options.cwd` upwards, below the home directory). The
   key is the `managementKey` of the linked Project's `.nylorun/credentials.json`,
   else of the Host root's `project-credentials.json`, else of its
   `cli-credentials.json`. `nylorun start` writes them (the keys
   `project-management` and `cli-management`). On POSIX a credentials file must
   be the user's and not group- or world-readable.

When none resolves, or the Project link is from an older nylorun or does not
validate (and nothing else names the Host root), or the linked Project's
`credentials.json` does not validate, it throws `connection_missing` and lists
what it tried. Only this local-Host step reads the Host root: `@nylorun/agents`
takes the Runtime API's key from the Project or the environment only. The
Project files' reader is `@nylorun/core/project`. The first request checks the
Host's `/health` and throws `incompatible_host` unless the Host serves this client's protocol
(14) with its features, `management-api` among them.

Management keys are issued on the Tenant's machine only:
`npx nylorun tenant keys put <id> --management` on a local Tenant, or
`nylorun-operate keys put <id> --role management` inside the runtime container
([SELF_HOSTING.md](../../guides/SELF_HOSTING.md#keys)). No API call creates one.

## The groups

| Group | Methods | Routes |
| --- | --- | --- |
| `admin.tenant` | `status()`, `seed(request)`, `reset(request)` | `GET /v1/tenant`, `PUT /v1/tenant/config/seed`, `POST /v1/tenant/reset` |
| `admin.keys` | `list()`, `put(id)`, `delete(id)` | `/v1/tenant/keys…` |
| `admin.models` | `catalog()`, `providers()`, `get()`, `put(request)`, `select(request)`, `setInputs(request)`, `usage(query)`, `budgets.get()`, `budgets.put(request)` | `/v1/tenant/models`, `/providers`, `/model`, `/model/selection`, `/models/inputs`, `/usage`, `/budgets` |
| `admin.coverage` | called directly: `admin.coverage({ agentId })`, an Agent's id | `POST /v1/tenant/credential-coverage` |
| `admin.mcp` | `preview({ url, type?, name?, agentId? })` | `POST /v1/tenant/mcp/preview` |
| `admin.toolPolicy` | `get()`, `put({ rules })`: which MCP and HTTP tool calls run, wait for a person (`ask`) or are refused (`deny`) | `/v1/tenant/tool-policy` |
| `admin.signingKeys` | `list()`, `rotate({ force? })`, `revoke(kid)` | `/v1/tenant/signing-keys…` |
| `admin.settings` | `sandbox.get()`, `sandbox.put(request)`, `artifacts.get()`, `artifacts.put(request)`, `skills.get()`, `skills.put(request)`, `limits.get()`, `limits.put(request)` | `/v1/tenant/sandbox`, `/v1/tenant/artifacts`, `/v1/tenant/skills`, `/v1/tenant/limits` |

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

Credentials for MCP servers, HTTP tools and skills are not the Management
API's: each Agent has one vault, whose secrets the app writes on the
Runtime API (`client.agents.secrets.put` in
[`@nylorun/agents`](../agents/README.md), `PUT /v1/agents/{id}/secrets/{name}`)
and never reads back. See "MCP servers and HTTP tools" in
[DEPLOYMENT.md](../../guides/DEPLOYMENT.md#mcp-servers-and-http-tools), with
gateway recipes.

`admin.coverage` says what a session on an Agent would send for each MCP server
and HTTP tool credential of the manifest version the Agent runs, from the
Agent's vault, before any session starts: `covered` (with the secret's name and
`via`) or `missing`. It reads no secret and calls no server (Host feature
`credential-coverage`).

```ts
const coverage = await admin.coverage({ agentId: "projects/acme" });
if (!coverage.complete)
  for (const entry of coverage.entries) if (entry.status !== "covered") console.log(entry.name, entry.message);
```

`admin.mcp.preview` shows what a server offers with an Agent's credential
for its URL (none without `agentId`), before a manifest names it: the
Runtime connects, lists the tools within 15 s and calls none. Each tool has the
name the model would call it (made with `name`, default from the URL's host),
its annotations and its input schema's size. A server that answers `401` comes
back with `authRequired` and its RFC 9728 protected-resource metadata; one that
cannot be listed rejects with `mcp_preview_failed` (`details.failure`).

```ts
const preview = await admin.mcp.preview({ url: "https://mcp.linear.app/mcp", name: "linear", agentId: "projects/acme" });
for (const tool of preview.tools) console.log(tool.modelName, tool.schemaBytes);
if (preview.authRequired) console.log("needs a sign-in:", preview.authRequired.resourceMetadata);
```

`admin.settings.sandbox` reads and replaces the Tenant's settings for its
Agents' environments (Tenant setting `environments.config`): `limits`
(`network`, `resources`, `defaultResources`, `idle`, `environments`, the most
Agents), the pods' `lifecycle.stopGrace` and `placement`.
`admin.tenant.reset({ scope })` takes `sessions`, `agents` (the Agents, their
vaults and disks, and their sessions) or `all`.

`admin.models.usage({ scope, id?, period? })` totals the Tenant's model calls
for the Tenant, the Agents made from one agent manifest (`scope: "manifest"`,
`id` its name) or one turn (`scope: "turn"`), and `admin.models.budgets.put`
caps them: a `manifest` budget caps the sessions of every Agent made from that
manifest, over a day or a month.

```ts
await admin.models.budgets.put({
  budgets: [
    { scope: "manifest", id: "triage", period: "month", limitUsd: 50 },
    { scope: "turn", limitTokens: 200_000 },
  ],
});
const spent = await admin.models.usage({ scope: "manifest", id: "triage", period: "month" });
```

`admin.settings.limits` reads and replaces the Tenant's Runtime limits (Tenant
setting `limits.config`): the sizes, counts and deadlines the Runtime holds what
crosses it to. A harness's (`turn.start.limits`): `recordEntryBytes` (one event
or effect outcome in the record), `modelCallBytes`, `modelFileBytes`,
`toolAnswerBytes`, `harnessStateBytes` (a custom harness's state), `chunkBytes`
(one chunked Harness API answer) and `folderEntries` (the files of one folder a
harness writes, a count). The Runtime's own: request bodies and inline files
(`requestBodyBytes`, `inlineFileBytes`), `messageParts`, page sizes (`pageItems`,
`exportPageItems`, `environmentEventItems`), `a2aWaitMs`, `errorExcerptChars`,
`traceContentBytes`, an Agent's labels, setup and input files
(`environmentLabels`, `environmentSetupCommands`, `environmentFiles`,
`environmentFilesPerEntry`, `environmentSecretSlots`, `setupCommandChars`,
`setupCommandMs`, `setupOutputChars`, `setupReasonChars`, `setupCommandExcerptChars`,
`manifestDescriptionChars`, `secretDescriptionChars`), labels (`artifactLabels`,
`labelKeyChars`, `labelValueChars`), secrets (`secretValueChars`, `secretHosts`),
the tool policy and budgets (`toolRules`, `toolRuleFieldChars`, `toolRuleTextChars`,
`modelBudgets`), flows (`flowConcurrency`, `flowMapItems`, `flowLoopIterations`), disk versions (`diskVersionEntries`, `diskVersionBytes`,
`diskLeaseMs`, `diskPodWaitMs`), model calls (`modelRequestMs`, `modelIdleMs`,
`modelAttempts`, `modelRetryDelayMs`, `modelProviderRetries`,
`modelRetryDelayMaxMs`) and tools (`toolAttempts`, `httpToolTimeoutMs`,
`mcpSnapshotBytes`, `mcpPreviewMs`, `mcpMetadataBytes`). A limit left out takes
its default; one above its ceiling, which a dependency such as S2's 1 MiB record
or a JavaScript timer sets, is refused with `400`. See DEPLOYMENT.md's Runtime
limits for each one's default and ceiling.

## In a browser

`@nylorun/admin/client` exports `createManagementClient({ url, key?, fetch?,
headers? })` and `ManagementClient`, with the same groups and no Node module.
It is for a browser app behind its own server that adds the management key, as
Studio is: omit `key`, and point `url` at that server. Never
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
