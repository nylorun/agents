# The Runtime API as an OAuth resource server (protocol 9)

The Runtime API now behaves as an OAuth 2.1 resource server for your identity provider's
tokens. Nylorun is still never the authorization server: it signs no one in and mints no
person's token. This release changes how refused credentials are answered, publishes where
tokens come from, and simplifies the identity file. Clients and SDKs of this release send
`Nylorun-Protocol: 9`; the Runtime still serves protocol 4 to 8 clients, but answers them the
new way too.

## A refused credential is `401`, not the opaque `404`

| Request | Before | Now |
| --- | --- | --- |
| No `Authorization` header | `404 not_found` | `401 credential_required`, `WWW-Authenticate: Bearer resource_metadata="…"` |
| A key the Tenant does not know (rotated, deleted, another Tenant's, the admin key) | `404 not_found` | `401 credential_invalid`, `WWW-Authenticate: Bearer error="invalid_token", …` |
| A token no trusted issuer signed, or one that fails a check | `404 not_found` | `401 credential_invalid` |
| An expired token | `401 token_expired` | The same, with `error_description` and `resource_metadata` in the challenge |
| A token without the route's scope | `403 scope_required` | The same, with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` |
| A request with neither `Nylorun-Protocol` nor `Authorization` on an API route | `426` | `401 credential_required` |

The reason a credential was refused stays in the runtime's log (`credential rejected`). A
Tenant id that is not this installation's, a Tenant that could not be opened and a capability
link the Runtime did not sign are still the opaque `404`. On the Management API the challenge
is a bare `Bearer`: it takes management keys only.

What to change:

- Code that treated a `404` as "bad key" should look for `401` and the codes
  `credential_required` and `credential_invalid` (both in `ERROR_CODES`). In `@nylorun/agents`
  they are a `RuntimeError` with `status` 401 and the code in `body.code`; in `@nylorun/admin`
  an `AdminError` with that `code`.
- A browser app that refreshes its token on `401` can now rely on it for every refused token,
  not only an expired one.
- If your reverse proxy rewrites `401` or strips `WWW-Authenticate`, stop: clients need both.
  Expose `WWW-Authenticate` in your CORS answer (DEPLOYMENT.md already lists it).

## Protected resource metadata

With an identity file, `GET /.well-known/oauth-protected-resource` (RFC 9728) answers the
resource (`NYLORUN_PUBLIC_URL`, else the request's origin), the trusted issuers in the file's
order, and their scopes. It needs no key or `Nylorun-Protocol`. Forward it at your reverse
proxy beside `/health`, `/ready` and `/v1/*`, and set `NYLORUN_PUBLIC_URL` so `resource` is
the URL your clients use. Without an identity file it is a `404`.

## The identity file

- `maxLifetime` is removed. How long a token lives is your identity provider's setting; the
  Runtime checks `exp` only, and no longer requires `iat` (one in the future is still refused).
  A file that still has `maxLifetime` boots: the key is ignored and logged.
- Any key the file does not define is ignored with a warning (`identity_file_key_ignored` in
  the runtime's log) instead of stopping the boot. Check the log after editing the file: a
  misspelled optional field such as `agent:` is ignored, not refused.
- `subject`, `scopes` and `allowedScopes` are optional:

  | Field | Default |
  | --- | --- |
  | `subject` | `"{sub}"` |
  | `scopes` | `{ claim: scope }`, OAuth's standard claim |
  | `allowedScopes` | `[agents:read, sessions:own, sandboxes:write]`; list `studio` to grant it |

  A file that sets them keeps working unchanged. If you leave `subject` out, note that the
  default is the bare `sub`: a file that used `u:{sub}` must keep it, or every person's
  sessions get a new owner.
- Set `audience` to the Runtime's public URL where your provider allows it: that is the
  RFC 8707 `resource` an OAuth client asks for.

# Manifest-only agents (protocol 8, manifest v5)

The Runtime now runs an agent from its manifest alone: during a session it never calls your
code. This release removes what used to run your code mid-session, Action endpoints included;
it ships in the same protocol 8 beta as the Runtime and Management APIs. Manifests are
`manifestSchemaVersion: 5`. A Runtime of this release refuses a v4 manifest with a message that
names what changed, and a session pinned to a v4 manifest cannot take another turn: rebuild and
save your agents with this SDK, then start new sessions.

## Hooks are removed

`.beforeTurn()`, `.beforeModel()`, `.afterModel()` and `.afterTurn()` (with the deprecated
`.before()` and `.after()`), a capability's `before` and `after`, the manifest's
`capabilities[].hooks`, the `hook` Action and the `Patch`, `Decision` and `TurnDecision` types are
gone. A manifest or capability that still names them is refused with
`hooks were removed: …`. Each use has a replacement that needs no code of yours mid-turn:

| Hook use                                            | Instead                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Add instructions for a turn (`beforeTurn`)          | `.instructions()`, or send the message with a turn manifest that changes them |
| Hide tools or capabilities for a turn               | A turn manifest that leaves them out (a variant may remove tools)            |
| Deny or approve a proposed tool call (`afterModel`) | `approval` on the tool                                                       |
| Check or redo the final answer (`afterTurn`)        | An output schema, or a flow `loop` with a verifier agent                     |
| Write session state                                 | Your service keeps it, keyed by `Nylorun-Session-Id` (an HTTP tool)          |
| A policy over every model call                      | Bring your own harness (Harness API)                                         |

Studio's Agent Manifest tab no longer shows hooks or the turn lifecycle. The engine version is
`hosted-4`.

## Remote MCP servers only

Nylorun accepts remote MCP servers only: `streamable-http` and `sse`, declared by URL and reached
through the Runtime's gates with an optional vault credential. A `stdio` server is refused
wherever it is declared: `.mcp({...})`, a plugin's `mcp.json` (`.plugin()` and `plugin()` throw
`PluginError` with code `plugin.mcp-stdio`), and `PUT /v1/agents/:id` (`400`):

```text
MCP server 'local' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL.
```

What to do: run the server behind an HTTP transport (several open gateways wrap a stdio server as
streamable HTTP) and declare its URL instead of its command:

```ts
// Before
Agent({ id: "assistant" }).mcp({ files: { type: "stdio", command: "npx", args: ["files-mcp"] } });

// After
Agent({ id: "assistant" }).mcp({ files: { type: "streamable-http", url: "https://mcp.example.com/files" } });
```

Also gone with stdio: `pluginRoots` in `PUT /v1/agents/:id` (the strict schema now refuses it),
`prepareStdioLaunch`, `expandPluginPlaceholders` and `StdioLaunch` from `@nylorun/agents`,
`tenantChildEnvironment` and `startEphemeralRuntime({ baseline })` from `@nylorun/runtime`, and
the local stack's `plugins/` mount and the harness's `plugin-data/`, `home/` and `tmp/` mounts. A
plugin's skills work as before.

## HTTP tools replace code tools

A code tool (`tool({ run })`) used to run in your process, delivered to your Action endpoint.
Action endpoints are removed ([below](#action-endpoints-are-removed)), so the Runtime refuses
a definition with a code tool. Move each one to an **HTTP tool**: the Runtime makes one request
to your service per call, through its Tool Gate, or serve it from a remote MCP server.

```ts
// Before: a code tool, run by your Action endpoint
const refundOrder = tool({
  name: "refund_order",
  input: z.object({ orderId: z.string(), amount: z.number() }),
  approval: () => true,
  run: async (input) => billing.refund(input),
});

// After: an HTTP tool; your service serves POST /refunds
const refundOrder = http({
  name: "refund_order",
  input: z.object({ orderId: z.string(), amount: z.number() }),
  url: "https://billing.example.com/refunds",
  credential: "billing", // a vault credential bound to the URL, instead of a secret in your code
  approval: "always",
});
```

Your service receives the model's input as the JSON body, with `Nylorun-Session-Id`,
`Nylorun-Turn-Id`, `Nylorun-Agent-Id` and an `Idempotency-Key` that stays the same when the
call is re-sent; it answers JSON (checked against `output`) or text, and any other status is a
tool error the model sees. What does not carry over:

- `approval` is static (`"never"` or `"always"`), not a function of the input.
- `ctx.state`, `ctx.ask`, `ctx.approve`, `ctx.sleep`, `ctx.waitFor`, `ctx.step` and progress
  events have no HTTP form; keep that logic in your service or in the agent's instructions.
- A code tool used as a flow stage becomes an HTTP stage the same way: put the `http()` tool in
  `.pipe()` (see [Flows run no code](#flows-run-no-code)). Its input is the previous stage's
  output, and `approval` is not supported on a flow stage yet.
- The methods are `POST` (default), `PUT` and `PATCH`; the input is always the body.

See [agents/README.md](./agents/README.md#http-tools).

## Skills are files the Runtime serves

A skill is now every file of its folder, uploaded once and served by the Runtime: no skill call
reaches your process. The manifest's `skills.<name>` gains `files`, each path of the folder
(`SKILL.md` required) mapped to `sha256:<hex>`; the build hashes them, binary files included.

- **Nothing to change** if you load skills with `.skills(folder)`, `skills(folder)` or
  `.plugin(folder)` and register with `saveAgent`: it uploads the files the Runtime lacks
  (`client.files`) before the definition.
- **`PUT /v1/agents/{id}` by hand** must upload each file first with
  `PUT /v1/files/sha256:<hex>` (application key, the raw bytes, at most 10 MiB; `HEAD` says
  whether the Runtime holds it). A definition naming a file the Runtime lacks is
  `400 definition_files_missing`, with the hashes in `details.missing`.
- **`skillRecords` is gone** from capability declarations (and `SkillRecord` from
  `@nylorun/core/define`): declare `skills` with `files`, and `skillFiles` for the bytes to upload.
- **`load_skill` and `read_skill_resource` run only on the Runtime.** In a local run without one
  they fail with `skills.runtime-only`. `read_skill_resource` refuses a binary file; with a
  sandbox the model finds it under `/skills/<name>/`.
- A top-level `functions` key in a manifest is reserved: it is refused for now.

## Flows run no code

Flow agents compile to workflow manifest v3 (`workflowSchemaVersion: 3`) on the `flow-3`
engine. A flow is data: stage `input` functions, `switch` `on`, loop `verify` functions and
`decide` are gone, and so are the `fn` and `verify` Actions they were delivered as. A v1 or v2
workflow manifest is refused with `workflowSchemaVersion 2 is no longer supported: …`, and a
builder option that names a function is refused with what replaces it. The first stage gets the
flow's input and every later stage the previous stage's output, so each agent returns what the
next stage needs through its `.output()` schema. An agent after the first stage also sees the
flow's input as the original request.

| Before                                                                           | Instead                                                                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `{ input: ({ input, results, flowInput }) => … }` on a stage                     | The previous agent's output schema returns what the next stage takes                                      |
| `.switch(cases, { on: ({ input }) => input.kind })`                              | `.switch(cases)`: the previous output is the case name, or has a `route` field                            |
| `.map(each, { input: ({ input }) => input.tasks })`                              | `.map(each)` over an array output, or an output with an `items` array                                     |
| `.loop(body, { verify: ({ output }) => verdict })`                               | `.loop(body, { verify: verifierAgent, max })`, the agent's output schema `VerdictSchema`                  |
| `.loop(body, { verify: ({ output }) => check(output) })`, `check` in your service | `.loop(body, { verify: http({ url }), max })`: your service answers the verdict                           |
| `.loop(body, { verify, decide })`                                                | `.loop(body, { verify, max })`: a fail retries with the feedback until `max`; `max` is required           |
| `.step(x)`, `.step(x, { id })`                                                   | `.pipe(x)`, `.pipe(x.withId(id))`; `.pipe(a, b, c)` adds three stages (`.step` warns, `NYLORUN_DEP_STEP`) |
| `Chain`, `Switch`, `Parallel`, `Map`, `Loop`, `withInstructions`, `withoutTools` | A flow agent: `Agent({ id }).pipe(…)`, `.switch()`, `.parallel()`, `.map()`, `.loop()`                    |
| `Agent.from(flow, { nodes: { "route:on": fn, … } })`                             | `Agent.from(flow, { nodes: { open_pr: tool } })`: only tool nodes take code                               |

A verifier agent gets `{ task, response, iteration }` and must return `{ pass, feedback? }`, with
feedback when `pass` is false; anything else fails the loop with `loop.verify-failed`. Each
verdict is recorded as a `loop.verified` event; `loop.decided` is gone.

A verify function that checked the output with your own code moves to your service as an
**HTTP verifier**: `http({ url, method?, credential?, timeoutMs? })`, with no name or input.
The Runtime makes one request per attempt through its Tool Gate, as for an HTTP tool (the
identity headers, an `Idempotency-Key` per attempt, the vault credential), with the body
`{ input, output, iteration }`: the Loop's input, the attempt's output and its number. Your
service answers `{ pass: true }` or `{ pass: false, feedback }`; any other answer, a failure
status or a timeout fails the loop with `loop.verify-failed`.

```ts
// Before: a verify function run by your Action endpoint
.loop(fixer, { verify: async ({ output }) => ((await ci.run(output)).ok ? { pass: true } : { pass: false, feedback: "tests fail" }), max: 3 })

// After: your service serves POST /verify and answers the verdict
.loop(fixer, { verify: http({ url: "https://ci.example.com/verify", credential: "ci" }), max: 3 })
```

A code tool stage (`tool({ run })`) runs only in the local engine: the Runtime refuses a flow
agent with one ([below](#action-endpoints-are-removed)). `fn` and `command` verify targets are
reserved and refused for now.

## Action endpoints are removed

The Runtime no longer delivers tool calls to your process. Gone:

- `PUT`, `GET` and `DELETE /v1/endpoints`, `POST /v1/endpoints/{agentId}/ping` and
  `/v1/actions/{actionId}/{heartbeat,result,sandbox/:tool}` (they answer `404`); delivery tokens
  (`Nylorun-Signature`, `Nylorun-Outcome`, `nylorun-delivery+jwt`); the gates service's
  `/nylorun/v1/deliveries`; the `actions` and `endpoints` tables (a migration drops them).
- `createActionHandler`, `executeAction`, `createActionSandbox` and the `Action`, `ActionOutcome`
  and `ActionHandler*` types in `@nylorun/agents`; `tool({ background: true })`; `ctx.sandbox`,
  `ctx.state`, `ctx.ask` and `ctx.approve` in a tool on the Runtime (they still work in the local
  engine, `@nylorun/harness/run`).
- The `action.pending`, `.delivered`, `.delivery_failed`, `.completed` and `.uncertain` events:
  a tool the Runtime ran is a `tool.completed` event, and a `turn.paused` interaction carries the
  tool call's `callId`.
- The `action-endpoints` protocol feature: protocol stays 8, and a client that requires the
  feature (an earlier SDK, CLI or Studio) is refused by the Host's feature check. The Harness API
  is v2: held runs (`holdMs`, `effect.resolved`) are gone.
- `nylo endpoints`, and in Tenant status `checks.endpoints`, `agents[].registered`,
  `agents[].endpoint` and `counts.pendingActions`.

`PUT /v1/agents/{id}` refuses (`400`) a definition with a tool that has no `http` and no
`agent` and is not one of the Runtime's built-ins, and a flow agent with a code tool stage (a
tool stage without `http`);
`saveAgent` refuses the same before sending:

```text
Tool 'lookup_order' of agent 'assistant' runs your code, and the Runtime runs no code of yours during a session. Make it an http() tool or serve it from a remote MCP server (see MIGRATION.md).
```

What to do:

```ts
// Before: serve the agents' tools and register the URL
const actions = createActionHandler({ agents, url });
createServer(actions.node).listen(3001);
await actions.register({ url });

// After: save the agents; their tools are http() tools or MCP servers
const client = createClient();
for (const agent of agents) await client.saveAgent(agent);
```

A process that only served Actions is no longer needed; the service your HTTP tools call is
an ordinary HTTP service (see [HTTP tools](#http-tools-replace-code-tools)). `saveAgent`'s
`implementationVersion` is optional (`NYLORUN_IMPLEMENTATION_VERSION`, else `dev`). The
starter (`npm create @nylorun/agent`) saves its agent and runs no server.

# Runtime and Management APIs (protocol 8)

Every Tenant now serves two APIs on its one URL, split by route and by key. The **Runtime API**
is for developers: everything under `/v1` but `/v1/tenant/*` (agents, sessions with AG-UI and
A2A, sandboxes, artifacts, `/v1/me` and the JWKS). It takes application keys and trusted
issuers' tokens, through `@nylorun/agents`. The
**Management API** is for operators: `/v1/tenant/*` (models, vaults, signing keys, settings,
application keys, seed and reset) and `GET /v1/oauth/callback`. It takes **management keys**
only, through `@nylorun/admin`. The Admin API and its operator listener are gone: Host work runs
on the machine, with `nylorun` or `nylorun-operate`.
[SELF_HOSTING.md](./SELF_HOSTING.md#keys) describes the result.

The protocol is now 8, with the required feature `management-api`. A Runtime of this release
serves protocols 4 to 8: an older client keeps reaching the Runtime API, whose routes keep their
request and response shapes, but not `/v1/tenant/*` with an application key, nor the moved and
removed paths. Upgrade every package together (`@nylorun/core`, `@nylorun/runtime`,
`@nylorun/agents`, `@nylorun/admin`, `@nylorun/cli`, `nylorun` and Studio; `nylorun start` pins
the matching images). Old paths answer `404`, with no alias.

**Who is affected.** A developer on a local Tenant who uses the SDK with the Project link, Studio,
`nylo` and `nylorun` has nothing to do: the first `nylorun start` of this release gives the
project a management key beside its application key. You are affected if you:

- configure the Tenant (models, budgets, sandbox or artifact settings, seed, reset) with an
  application key, or act for a subject with `tenant:settings`;
- create vaults or rotate signing keys from an app (`client.createVault`,
  `client.access.signingKeys`, `/v1/vaults`, `/v1/access/signing-keys`);
- call the Admin API (`/v1/admin/*`, `admin.status()`, `NYLORUN_ADMIN_URL` and
  `NYLORUN_ADMIN_KEY`), or issue keys with it;
- run a Runtime yourself with `NYLORUN_ADMIN_LISTEN_*` or `adminPort`, or proxy `/v1/admin`;
- embed Studio and derive its key with `deriveStudioToken(adminKey, tenantId)`;
- publish or read `admin-openapi.json`.

What to do:

1. **`/v1/tenant/*` → a management key and `@nylorun/admin`.** An application key there, alone or
   acting for a subject, is `403 key_role_mismatch`, and so is a management key on any other
   route but `/v1/me` and the public `GET /v1/access/jwks`. Get a management key (step 5), then
   move the calls to `createAdmin()`, which reads `NYLORUN_RUNTIME_URL` and
   `NYLORUN_MANAGEMENT_KEY`, or the Project link's management key:

   ```ts
   // Before: an application key, by hand
   await fetch(`${url}/v1/tenant/sandbox`, {
     method: "PUT",
     headers: { authorization: `Bearer ${process.env.NYLORUN_SERVER_KEY}`, "nylorun-protocol": "7", "content-type": "application/json" },
     body: JSON.stringify({ default: "virtual" }),
   });

   // After: a management key
   import { createAdmin } from "@nylorun/admin";

   const admin = createAdmin();
   await admin.settings.sandbox.put({ default: "virtual" });
   ```

   Over HTTP, send the management key with `Nylorun-Protocol: 8`. The groups are
   `admin.tenant` (status, seed, reset), `admin.keys`, `admin.models` (catalog, providers,
   credentials, selection, usage, budgets), `admin.vaults`, `admin.signingKeys` and
   `admin.settings` (sandbox, artifacts) ([admin/README.md](./admin/README.md)). `nylo status`,
   `reset`, `configure`, `doctor` and `access signing-keys` use the Project's management key, or
   `NYLORUN_MANAGEMENT_KEY`. `/v1/tenant/models` and `/v1/tenant/providers` no longer admit
   `agents:write` subjects: apps don't read the model catalog.
2. **Vaults and signing keys moved to the Management API.** `/v1/vaults…` (including
   `…/oauth/start`) is now `/v1/tenant/vaults…`, and `/v1/access/signing-keys…` is
   `/v1/tenant/signing-keys…`, for management keys only. `@nylorun/agents` drops the vault
   methods (`createVault`, `listVaults`, `getVault`, `deleteVault`, `createCredential`,
   `listCredentials`, `getCredential`, `rotateCredential`, `deleteCredential`),
   `client.access.signingKeys` and `SigningKeysClient`:

   ```ts
   // Before (@nylorun/agents, an application key)
   const vault = await client.createVault({ scope: "installation", name: "tools", idempotencyKey: "tools" });
   await client.createCredential(vault.id, { name: "linear", idempotencyKey: "linear", auth });
   const { vaults } = await client.listVaults();
   await client.access.signingKeys.rotate();

   // After (@nylorun/admin, a management key)
   const vault = await admin.vaults.create({ scope: "installation", name: "tools", idempotencyKey: "tools" });
   await admin.vaults.credentials.create(vault.id, { name: "linear", idempotencyKey: "linear", auth });
   const vaults = await admin.vaults.list(); // the array itself
   await admin.signingKeys.rotate();
   ```

   An MCP OAuth connect starts with `admin.vaults.startOAuth(vaultId, { url, server,
   clientId? })`; `nylorun mcp connect` already does. Unchanged: opening a session with
   `vaultIds`, `GET /v1/oauth/callback` (providers keep the redirect URI they have), and
   `GET /v1/access/jwks` with `client.access.jwks()`.
3. **`tenant:settings` is retired.** It leaves `SUBJECT_SCOPES`; `Nylorun-Scopes` may still name
   it, and it grants nothing. No subject reaches the Management API: a management key with
   `Nylorun-Subject` or `Nylorun-Scopes` is `403 subject_invalid`, and one sent with an `Origin`
   is `403 origin_rejected`. An app server that changed settings for a person calls the
   Management API from the server, as the management key itself, and keeps its own record of
   who asked.
4. **The Admin API and the operator listener → the machine.** `/v1/admin/*` (status, host,
   shutdown, keys, `openapi.json`) answers `404`. The operator listener,
   `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`, `NYLORUN_ADMIN_ALLOWED_HOSTS`,
   `host.json`'s `adminPort` and nylorun's `NYLORUN_ADMIN_PORT` are gone (an existing one in
   `docker/.env` is ignored and no longer published). `@nylorun/admin` drops `admin.status()`,
   `adminUrl`, `NYLORUN_ADMIN_URL`, `NYLORUN_ADMIN_KEY`, the Admin API's keys and
   `OPERATOR_KEYS_FEATURE`. Host work runs on the Tenant's machine:

   ```sh
   # Before: the Admin API on the operator port
   curl -H "Authorization: Bearer $ADMIN_KEY" http://127.0.0.1:8788/v1/admin/status
   curl -X PUT -H "Authorization: Bearer $ADMIN_KEY" http://127.0.0.1:8788/v1/admin/keys/backend

   # After: a local Tenant
   npx nylorun status                       # runs nylorun-operate status in the runtime container
   npx nylorun key put backend              # an application key
   npx nylorun stop

   # After: a Runtime you run yourself
   docker compose exec runtime nylorun-operate status --json
   kubectl exec <runtime pod> -- nylorun-operate keys list
   ```

   `nylorun-operate status [--json]` reports the version, protocol and the Tenant's id, name,
   state and cause, and exits 2 when the Tenant is not open; it needs no key, so it works when
   the Tenant cannot open. The Tenant's own status over HTTP is `admin.tenant.status()`
   (`GET /v1/tenant`). `/ready` adds `harness: { mode, connected }`, and `nylorun start` waits
   for `/ready`. Stop a Runtime with SIGTERM. `startEphemeralRuntime` loses `operatorListener`
   and `adminUrl`, takes `managementKey`, and returns it (the key `bootstrap`).
5. **Issue management keys on the machine.** No API call creates one, so a leaked key can't mint
   another. `nylorun start` gives a linked project `project-management` (and keeps `cli-management`
   outside a project), in `.nylorun/credentials.json` (`managementKey`,
   `managementPrincipalId`; still format 1) and the Host root's credentials files. Elsewhere:

   ```sh
   npx nylorun key put ci --management                                       # a local Tenant
   docker compose exec runtime nylorun-operate keys put ci --role management  # your own Compose file
   kubectl exec <runtime pod> -- nylorun-operate keys put ci --role management
   ```

   Or mount a **bootstrap secret**: a file holding a key of 64 lowercase hex characters
   (`openssl rand -hex 32`), named by `NYLORUN_MANAGEMENT_KEY_FILE` on the runtime. The Runtime
   registers it as the management key `bootstrap` at every start, and replaces it when the file
   changes. Give the tool `NYLORUN_RUNTIME_URL` and `NYLORUN_MANAGEMENT_KEY`. Application keys
   now come from a management key: `admin.keys.put(id)` or `PUT /v1/tenant/keys/{keyId}`, which
   refuse a management key's id, `studio` and `bootstrap`; `nylorun key put <id>` still works.
   Existing keys stay application keys.
6. **Self-hosted Runtime and reverse proxy.** Remove `NYLORUN_ADMIN_LISTEN_*` and `adminPort`, and
   the proxy's `/v1/admin` block: the Runtime has one listener and the path answers `404`.
   Optionally answer `/v1/tenant/*` with `403` outside your operator networks, leaving
   `/v1/oauth/callback` open
   ([DEPLOYMENT.md](./DEPLOYMENT.md#reaching-the-runtime-from-another-machine)). Clients that
   check `/health` look for `management-api`: `operator-keys` is gone, and the Host advertises
   `admin-status` only for protocol 5 to 7 clients. Migration `0011_key_roles` gives the `studio`
   principal its role. The reference documents are `GET /openapi/runtime.json` (alias
   `/openapi.json`) and `GET /openapi/management.json`, with no key; the package and each release
   ship `openapi.json` and `management-openapi.json`, which replaces `admin-openapi.json`.
7. **Studio: key v2, and no login on loopback.** Studio's key is derived from the admin key alone
   (HMAC-SHA256 over `nylorun/studio/v2`), and the Host registers the new key's hash at its next
   start, replacing the old one. An app that embeds Studio and derives its key updates the call:

   ```ts
   // Before
   const studioKey = deriveStudioToken(adminKey, tenantId);
   // After
   const studioKey = deriveStudioToken(adminKey);
   ```

   `mintStudioLoginToken` is unchanged, and embedding keeps its login. Local Studio needs no
   login on its published loopback address (`localhost` or `127.0.0.1` at its port); a host
   behind a sign-in proxy keeps its sign-in. Studio reads its Tenant from `GET /v1/tenant` with
   its own key, and its Connections page manages vaults at `/v1/tenant/vaults`.

| Before | After |
| --- | --- |
| An application key on `/v1/tenant/*` | A management key: `createAdmin()` (`NYLORUN_RUNTIME_URL` + `NYLORUN_MANAGEMENT_KEY`) |
| `client.createVault`, `listVaults`, `getVault`, `deleteVault`, `createCredential`, `listCredentials`, `getCredential`, `rotateCredential`, `deleteCredential`; `/v1/vaults…` | `admin.vaults.create`, `list`, `get`, `delete`, `credentials.create`, `.list`, `.get`, `.rotate`, `.delete`; `/v1/tenant/vaults…` |
| `POST /v1/vaults/{vaultId}/oauth/start` | `admin.vaults.startOAuth(vaultId, …)`; `POST /v1/tenant/vaults/{vaultId}/oauth/start` |
| `client.access.signingKeys.list`, `rotate`, `revoke`; `SigningKeysClient`; `/v1/access/signing-keys…` | `admin.signingKeys.list`, `rotate`, `revoke`; `/v1/tenant/signing-keys…` |
| `tenant:settings` | Retired: the Management API as the management key itself |
| `GET /v1/admin/status`, `GET /v1/admin/host`, `admin.status()` | `nylorun status`, `nylorun-operate status`; `admin.tenant.status()` for the open Tenant |
| `POST /v1/admin/host/shutdown` | `nylorun stop`; SIGTERM |
| `PUT /v1/admin/keys/{id}`, `GET /v1/admin/keys`, `DELETE /v1/admin/keys/{id}` | `PUT`, `GET`, `DELETE /v1/tenant/keys…` (`admin.keys`, application keys); `nylorun key put <id> [--management]`, `nylorun-operate keys` |
| `GET /v1/admin/openapi.json`, `@nylorun/runtime/admin-openapi.json` | `GET /openapi/management.json`, `@nylorun/runtime/management-openapi.json` |
| `GET /openapi.json` | `GET /openapi/runtime.json` (`/openapi.json` stays as its alias) |
| `NYLORUN_ADMIN_URL`, `NYLORUN_ADMIN_KEY`, `adminUrl` | `NYLORUN_RUNTIME_URL`, `NYLORUN_MANAGEMENT_KEY` |
| `NYLORUN_ADMIN_PORT`, `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`, `NYLORUN_ADMIN_ALLOWED_HOSTS`, `adminPort`; the operator listener | One listener; `nylorun-operate` in the runtime container |
| `startEphemeralRuntime({ operatorListener })`, `.adminUrl` | `managementKey` (option and result) |
| `deriveStudioToken(adminKey, tenantId)` | `deriveStudioToken(adminKey)` |
| Required feature `admin-status`; Host feature `operator-keys`; `OPERATOR_KEYS_FEATURE` | Required feature `management-api` |
| Core: `AdminStatusSchema`, `AdminHostStatusSchema`, `HostAggregateSchema`, `HostShutdownResponseSchema` | Removed; `KEY_ROLES`, `KeyRole`, `BOOTSTRAP_KEY_ID` and the error code `key_role_mismatch` are new |

- **Kept:** every Runtime API route and its shapes, application keys (existing keys stay
  `application`), `client.as()` with `Nylorun-Subject` and `Nylorun-Scopes`, `vaultIds` on
  sessions, `GET /v1/access/jwks`, `GET /v1/oauth/callback`, `GET /v1/me` (a management key is
  `via: management:<id>`), the admin key in `host-credentials.json` (no request accepts it),
  `mintStudioLoginToken`, and the package name `@nylorun/admin`.

# Open-source auth (protocol 7)

Open source now verifies and enforces, and leaves sign-in, people and their secrets to you.
Servers use **operator keys**, browsers and apps present **your identity provider's JWTs**
(a trusted issuer in the identity file), shared credentials live in **installation vaults**,
and a person's own credentials come from **your credential resolver**. Subject tokens,
publishable keys, the access policy, derived keys and per-person vault routes are removed.
[SELF_HOSTING.md](./SELF_HOSTING.md) describes the result.

The protocol is now 7. A Runtime of this release still serves protocol 4, 5 and 6 clients on
every route that remains; a protocol 7 client (this release's `@nylorun/agents`,
`@nylorun/admin`, `@nylorun/cli`, `nylorun` and Studio) needs this release's Runtime, so
upgrade them together (`nylorun start` pins the matching image). Removed routes answer `404`.

**Who is affected.** A single developer on a local Tenant who uses the SDK with the Project
link, Studio and `nylorun sandbox` has nothing to do: `nylorun start` adopts the project's key.
You are affected if you mint subject tokens, ship a publishable key or use
`@nylorun/agents/browser`, set an access policy, derive keys from the admin key
(`NYLORUN_DERIVED_PRINCIPALS`, `deriveTenantKey`), create or read vaults while acting for a
person (`vaults:own`), embed Studio in another app, or refresh OAuth credentials against a
token endpoint on a private address.

What to do:

1. **Derived keys → operator keys.** Only Studio's key is still derived from the admin key.
   `NYLORUN_DERIVED_PRINCIPALS` is ignored and no longer written, and `@nylorun/admin` drops
   `deriveTenantKey`, `PROJECT_PRINCIPAL_ID` and `admin.deriveTenantKey`. A key an earlier Host
   derived stays in the database and keeps working as an ordinary key. Give each client its own
   operator key: `npx nylorun key put <id>` on a local Tenant, `admin.keys.put(id)` in
   `@nylorun/admin`, or `PUT /v1/admin/keys/{id}` on the operator listener. Putting the id of a
   derived key (`project`, or your own) rotates it to a random key, so do that once the client
   has its new key. `nylorun start` already gives linked projects the key `project` and keeps an
   existing project key that works.
2. **Subject tokens and `createTokenEndpoint` → a trusted issuer.** `POST /v1/tokens`,
   `POST /v1/access/revocations`, `client.tokens`, `createTokenEndpoint`,
   `client.access.revokeSubject` and `nylo access token|revoke` are gone, and a JWT no trusted
   issuer signed is the opaque `404`. Remove your token route. List your identity provider in
   the identity file (`<Host root>/identity.yaml`, or `NYLORUN_IDENTITY_FILE`), with `issuer`,
   `audience`, `jwks`, a `subject` template such as `u:{sub}` and the scopes, and send the
   provider's token as the bearer
   ([SELF_HOSTING.md](./SELF_HOSTING.md#the-identity-file)). Revoke people at the provider and
   keep its tokens short-lived: a stream opened with a token now ends only at its expiry
   (`token_expired`; `StreamClosedFrame` loses `revoked`, and the `subject.revoked` signal is
   gone).
3. **Publishable keys, `createBrowserClient` and browser access → the IdP's JWT and CORS at your
   proxy.** `/v1/access/publishable-keys*`, `@nylorun/agents/browser` (`createBrowserClient`),
   `client.access.publishableKeys`, `nylo access keys`, the `Nylorun-Key` header,
   `NYLORUN_BROWSER_ACCESS` and `browserAccess` (`host.json`, `createHost`,
   `startEphemeralRuntime`) are removed, and the Runtime sends no CORS headers. In the page, sign
   in with your provider's SDK and call the Runtime with `fetch`, sending
   `Authorization: Bearer <token>` and `Nylorun-Protocol: 7`; for a chat UI, give
   `@ag-ui/client`'s `HttpAgent` a `fetch` that adds them. Answer preflights and add
   `Access-Control-Allow-Origin` for your app's origins at the reverse proxy
   ([SELF_HOSTING.md](./SELF_HOSTING.md#cors-at-your-proxy)). An application key or delivery
   token sent with an `Origin` is `403 origin_rejected`.
4. **Access policy roles and limits → issuer settings and proxy limits.**
   `GET`/`PUT /v1/access/policy`, `client.access.getPolicy`/`putPolicy` and
   `nylo access policy` are gone, and a stored policy is ignored. Move each role to the identity
   file: its scopes to `allowedScopes` and your tokens' scope claim (or `scopes.fixed`), its
   agents to `agents`, its sandboxes to `sandboxes` templates, and `tokens.maxTtlSeconds` to
   `maxLifetime`. Turn limits (`429 limit_exceeded`) are gone: limit requests per person at your
   proxy.
5. **Per-person vaults and `vaults:own` → installation vaults and your resolver.** Every
   `/v1/vaults` route takes an application key acting for no one; acting for a person, or with
   an issuer's token, it is `403 scope_required`. `vaults:own` grants nothing. Move shared
   credentials into an installation vault: Studio's Connections page,
   `client.createVault({ scope: "installation", … })`, or `nylorun mcp connect <url>` for an
   OAuth MCP server. Keep each person's own credentials in your secret store and answer for them
   from a resolver (`NYLORUN_RESOLVER_URL`, `NYLORUN_RESOLVER_TOKEN` on the gateway;
   [SELF_HOSTING.md](./SELF_HOSTING.md#the-credential-resolver)). Existing person vaults stay
   attachable to their owner's sessions; `client.listVaults()` takes an optional owner.
6. **Studio embedding.** The embed message `open.babai` is now `open.session` (`{ sessionId }`):
   it asks the embedding app to open that session in its own UI. Embedding is opt-in: no origin
   may frame Studio by default (`NYLORUN_STUDIO_FRAME_ANCESTORS` is empty); list your app's
   origins with `nylorun start --studio-embed-origin <origin>`. A Tenant's `.env` from an
   earlier nylorun keeps the origins it had; `--studio-embed-origin-reset` clears them.
7. **OAuth refresh follows `NYLORUN_ENDPOINT_*`.** Refreshing an OAuth vault credential now goes
   through the same address policy as Action deliveries: no redirects, and with
   `NYLORUN_ENDPOINT_PRIVATE=refuse` a token endpoint on a private address is refused where
   refresh used to call it. Allow private addresses on that gateway, or move the token endpoint.

| Before | After |
| --- | --- |
| `NYLORUN_DERIVED_PRINCIPALS`, `deriveTenantKey`, `admin.deriveTenantKey`, `PROJECT_PRINCIPAL_ID` | `nylorun key put <id>`, `admin.keys.put(id)`, `PUT /v1/admin/keys/{id}` |
| `hostPrincipals({ derived })`, `startEphemeralRuntime({ derivedPrincipals })` | Operator keys; `DERIVED_PRINCIPAL_ID_PATTERN` is `APPLICATION_KEY_ID_PATTERN` |
| `POST /v1/tokens`, `client.tokens.create`, `createTokenEndpoint`, `nylo access token` | Your identity provider's tokens, trusted through the identity file |
| `POST /v1/access/revocations`, `client.access.revokeSubject`, `nylo access revoke` | Revoke at the provider; tokens end at their expiry |
| `GET`/`PUT /v1/access/policy`, `client.access.getPolicy`/`putPolicy`, `nylo access policy` | The issuer's `allowedScopes`, `agents`, `sandboxes` and `maxLifetime`; limits at your proxy |
| `/v1/access/publishable-keys*`, `client.access.publishableKeys`, `nylo access keys`, `Nylorun-Key` | The IdP's JWT as the bearer |
| `@nylorun/agents/browser`, `createBrowserClient` | `fetch` with `Authorization` and `Nylorun-Protocol` |
| `NYLORUN_BROWSER_ACCESS`, `browserAccess`; CORS from the Runtime | CORS at your reverse proxy |
| `vaults:own`; vault routes acting for a person | Installation vaults (application keys); your credential resolver |
| `Destination.publishableKey`; `Destination.token` for subject tokens | `Destination.token` takes a trusted issuer's tokens |
| Default Studio frame ancestors | None; `--studio-embed-origin <origin>` |
| `GET /v1/me` `via: token` | `via: issuer:<name>` |
| Core: `SUBJECT_TOKEN_*`, `subjectTokenIssuer`, `CreateTokenRequest`, `AccessPolicy*`, `PUBLISHABLE_KEY_*`, `originAllowed`, … | Removed; `tenantTokenIssuer` for the Runtime's own tokens; `TOKEN_SCOPES` is `agents:read`, `sessions:own`, `sandboxes:write` |

- **Kept:** `GET /v1/access/jwks`, the signing-key routes and `nylo access signing-keys
  list|rotate|revoke` (delivery tokens and capability links), `client.as()` with
  `Nylorun-Subject` and `Nylorun-Scopes`, and Studio's own sign-in and embedding.
- **Self-hosted Runtime.** Remove `NYLORUN_DERIVED_PRINCIPALS` and `NYLORUN_BROWSER_ACCESS`.
  Set `NYLORUN_IDENTITY_FILE` on the runtime for your issuers, `NYLORUN_RESOLVER_URL` and
  `NYLORUN_RESOLVER_TOKEN` on the gateway for a resolver, and `NYLORUN_PUBLIC_URL` to the public
  address the OAuth callback uses. Migration `0010_oss_auth_removals` drops the
  `subject_epochs`, `subject_usage` and `publishable_keys` tables.

# File artifacts and message parts (protocol 6); `MediaStore` removed

Files that users upload or agents make are **file artifacts**: an id, a name and numbered
versions, metadata in the Tenant's database and bytes in the Object store (RustFS in a local
Tenant). Clients use `client.artifacts` (`@nylorun/agents`): `upload` streams a file in one
request, `list`, `get`, `download` (with Range), `link` (a short-lived capability URL that needs
no credential) and `delete`. A user message can name files: `session.inputParts([{ type:
"text", text }, { type: "file", artifactId }])`, and the model reads an image as an image and a
text file as text. A session with a sandbox has `save_artifact`, so the agent can hand the user
a file it made. A Tenant's limits are `PUT /v1/tenant/artifacts` (default 100 MiB per file, 10
GiB in all).

The protocol is now 6. A Runtime of this release still serves protocol 4 and 5 clients; a
protocol 6 client (this release's `@nylorun/agents`, `@nylorun/admin`, `@nylorun/cli` and
`nylorun`) needs this release's Runtime, so upgrade them together (`nylorun start` pins the
matching image).

**`MediaStore` and `localMedia` are removed from `@nylorun/runtime/node`**, and `piModel` no
longer takes `media`. Store images as file artifacts and name them in message parts; an
embedder that calls `piModel` itself passes `files`, a resolver from an artifact reference
(`{ artifactId, version }`) to `{ name, mediaType, bytes }`. `decodeImageBase64`,
`validateImageBytes`, `IMAGE_MEDIA_TYPES` and `MAX_IMAGE_BYTES` stay in `@nylorun/runtime` for
code that checks image bytes itself.

# Local Tenants: Studio at `http://localhost:<port>` again

The Studio proxy of nylorun 0.6 is gone. Each Tenant's Studio is at
`http://localhost:<port>` again (`nylorun ls` lists them; `nylorun studio --tenant <name>`
opens one signed in), and each keeps its own session cookie (`nylorun_studio_<name>`), so
two Studios in one browser stay signed in. Restate runs with its own defaults: the 256 MiB
RocksDB cap of 0.6 is removed, since it did not lower Restate's memory.

Nothing to do: the first `nylorun` command of this release removes the proxy's container
and network (`nylorun-proxy`) and `~/.nylorun/proxy/`, and says so once. Update bookmarks
from `http://<name>.localhost:4160` to the Studio URL `nylorun ls` shows. `NYLORUN_PROXY_PORT`,
`NYLORUN_PROXY_DISABLED` and Studio's `NYLORUN_STUDIO_PUBLIC_ORIGINS` are no longer read;
`nylorun status --json` has no `studio.proxyUrl` (`studio.url` is unchanged).

# Local Tenants: readable names, several Tenants, Studio at `<name>.localhost`

Every container, network and volume of a local Tenant is now named after the Tenant and
labelled `dev.nylorun.tenant: <name>`, so several Tenants run side by side and are easy to
tell apart in Docker. The Compose service `s2` is now `s2-lite`. Each Studio has its own
address, `http://<name>.localhost:4160`, through one small proxy container per machine
(`nylorun-proxy`), and its own session cookie. `nylorun ls` shows each Tenant's memory
(a Tenant uses about 1.2 GB, most of it Restate), and `nylorun stop --all` stops them all.

**A Tenant created by nylorun 0.5 starts fresh.** Its data is in volumes with the old
names; `nylorun start` refuses it (exit 3) and names them, so it never runs on new, empty
volumes with the old keys.

What to do, from nylorun 0.5:

1. Upgrade `nylorun`.
2. For each Tenant created by 0.5 (`nylorun ls`), run `nylorun reset --tenant <name>`. It
   deletes the Tenant's data, keys and old volumes (`<project>_postgres`, `_restate`,
   `_s2`, `_workspaces`) and the old network `<project>_default`; the next
   `nylorun start` creates the Tenant anew and relinks the project. Re-enter model
   credentials that were not in `.env`, and run `npm run dev` to register your agents
   again.
3. Replace the old names in scripts, CI and bookmarks:

| Before | After (Tenant `shop`) |
| --- | --- |
| Containers `nylorun-shop-<service>-1` | `nylorun-shop-<service>`: `nylorun-shop-postgres`, `-restate`, `-s2-lite`, `-gateway`, `-runtime`, `-studio` |
| Service `s2` (`nylorun logs s2`, `docker compose … s2`) | `s2-lite` (`nylorun logs s2-lite`) |
| Network `nylorun-shop_default` | `nylorun-shop` |
| Volumes `nylorun-shop_postgres`, `_restate`, `_s2`, `_workspaces` | `nylorun-shop-postgres`, `-restate`, `-s2-lite`, `-workspaces` |
| Studio at `http://localhost:<port>` | `http://shop.localhost:4160` (`start`, `ls`, `nylorun studio`); `http://localhost:<port>` still works and `nylorun status` shows it |
| Studio session cookie `nylorun_studio_session` | `nylorun_studio_shop` (`NYLORUN_STUDIO_SESSION_COOKIE`; Studio's default is unchanged): sign in again with `nylorun studio` |
| `nylorun ls` columns `TENANT STATE RUNTIME STUDIO PROJECT` | `TENANT STATE MEMORY RUNTIME STUDIO PROJECT`; JSON adds `memoryBytes` |

The proxy publishes on `127.0.0.1` and `[::1]` at port 4160 (or a free port chosen once,
kept in `~/.nylorun/proxy/.env`) and holds no Tenant data. Set `NYLORUN_PROXY_DISABLED=1`
to run without it; Studio is then `http://localhost:<port>` as before. A Tenant under
`NYLORUN_HOME` or `NYLORUN_COMPOSE_PROJECT` never uses it. (The next release removes the
proxy; see above.)

# Local Tenants: "Tenant" replaces "stack"

`nylorun` now calls what it runs a **Tenant**: each local installation holds one Tenant,
and the installation's name is the Tenant's name. Commands take `--tenant <name>` and
`NYLORUN_TENANT`, Host roots move to `~/.nylorun/tenants/<name>/`, and the Project link is
format 3 with a `tenant` field. `nylorun start` also works outside a project: there it
runs the Tenant `default`.

What to do, from nylorun 0.4:

1. Upgrade `nylorun`, `@nylorun/agents`, `@nylorun/cli` and `@nylorun/admin` together:
   they read link format 3.
2. Nothing for Host roots. The first `nylorun` command moves each
   `~/.nylorun/stacks/<name>/` to `~/.nylorun/tenants/<name>/` (`stack.json` becomes
   `tenant.json`, the `docker/.env` key `NYLORUN_STACK_NAME` becomes
   `NYLORUN_TENANT_NAME`) and says so once. Compose projects, ports, volumes and keys do
   not change.
3. Run `npx nylorun start` in each project. It rewrites `.nylorun/link.json` as format 3.
   Until then the SDK, `nylo` and `@nylorun/admin` refuse the old link and say so.
4. Replace the old names in scripts, CI and code:

| Before | After |
| --- | --- |
| `nylorun <command> --name <stack>` | `nylorun <command> --tenant <name>` |
| `NYLORUN_STACK` | `NYLORUN_TENANT` (a name; a `tn_…` id is refused) |
| `NYLORUN_STACK_PROJECT` | `NYLORUN_COMPOSE_PROJECT` |
| `~/.nylorun/stacks/<name>/`, `stack.json` | `~/.nylorun/tenants/<name>/`, `tenant.json` (moved for you) |
| `NYLORUN_STACK_NAME` in `docker/.env` | `NYLORUN_TENANT_NAME` (renamed for you) |
| `.nylorun/link.json` format 2 `{ stack, hostUrl, hostId, tenantId }` | Format 3 `{ tenant, tenantId, hostUrl, hostId }`; `npx nylorun start` rewrites it |
| `createAdmin({ stack })`, `stackHostRoot(name)` | `createAdmin({ tenant })`, `tenantHostRoot(name)` |
| Outside a project, `--name` required | The Tenant `default` (also for `start --no-link`) |
| `nylorun ls`: column `STACK`, JSON `{ stacks, legacy }` | Column `TENANT`, JSON `{ tenants }` |
| `nylorun legacy stop\|delete` | Removed: [remove the old installation with Docker](#one-tenant-per-installation-protocol-5) |
| `nylorun stack <command>`, `nylorun doctor stack\|runtime` | `nylorun <command>`, `nylorun doctor` |
| `nylo status` / `nylo endpoints`: `stack` line and JSON key | Removed; the Tenant's name is printed |

A `NYLORUN_TENANT=tn_…` left from releases before 0.4 is refused: unset it, or set a
Tenant's name (`nylorun ls` lists them).

# One Tenant per installation (protocol 5)

A Runtime now serves exactly one Tenant, the one its own Postgres database holds, and
nothing in a request selects it. Locally that means one Tenant per project: `nylorun start`
in a project creates the project's Tenant and the Project link together. Two Tenants are
two installations.

**This release starts fresh.** The old installation under `~/.nylorun` (Compose project
`nylorun`, `tenant_<id>` schemas) is never migrated, changed or deleted. Your agents, sessions, keys and vault credentials stay in it until you remove it.

What to do:

1. Upgrade the packages together (`@nylorun/agents`, `@nylorun/cli`, `@nylorun/admin`,
   `nylorun`): clients speak protocol 5.
2. In each project, run `npx nylorun start`. It creates the project's Tenant
   (`~/.nylorun/tenants/<project>/`, Compose project `nylorun-<project>`, its own ports and
   volumes), writes a new `.nylorun/link.json` and `.nylorun/credentials.json`, and seeds
   the model provider from the project's `.env`. A link to the old installation is
   replaced. To share one Tenant between checkouts, run
   `npx nylorun start --tenant <name>` in the others.
3. Re-enter model credentials that were not in `.env` (`npm run configure`, or Studio),
   and register your agents again: `npm run dev` does this.
4. Stop or remove the old installation with Docker when you no longer need it (`nylorun`
   no longer handles it). Stop it:
   `docker compose --project-name nylorun --file ~/.nylorun/stack/compose.yaml --env-file ~/.nylorun/stack/.env stop`.
   Remove it with `down --volumes` in place of `stop` (its volumes, its Tenants and their
   vault keys go), then delete `host.json`, `host-credentials.json`, `host-state.json`,
   `stack/`, `home/`, `tmp/` and `trash/` under `~/.nylorun`, and the `tn_…` directories
   in `~/.nylorun/tenants/` (never one with a `tenant.json`).

| Before | After |
| --- | --- |
| One installation per machine (`~/.nylorun`, Compose project `nylorun`) serving many Tenants | One Tenant per project: `~/.nylorun/tenants/<name>/`, Compose project `nylorun-<name>`; `nylorun ls`, `nylorun delete <name>` |
| `nylo tenant create\|use\|list\|current\|delete` | `nylorun start` in the project (creates its Tenant and the link); `--tenant <name>` attaches to an existing Tenant |
| `nylo tenant status\|reset\|endpoints` | `nylo status\|reset\|endpoints` on the linked installation; `nylorun status` shows the Tenant |
| `NYLORUN_TENANT`, `Nylorun-Tenant`, `createClient({ tenant })`, `runtime: { url, tenant }` | Gone: `NYLORUN_RUNTIME_URL` + `NYLORUN_SERVER_KEY` (or the link), `createClient({ url, key })`, `runtime: { url }` |
| `.nylorun/link.json` format 1 `{ hostUrl, hostId, tenantId }` with a minted application key | Format 3 `{ tenant, tenantId, hostUrl, hostId }`; `credentials.json` holds the key of the derived principal `project`. Clients refuse a link below format 3 and name `nylorun start` |
| `admin.createTenant`, `listTenants`, `getTenant`, `deleteTenant`; `/v1/admin/tenants*` | Gone (404). The Host creates its Tenant on first start; `admin.status().tenant` names it and why it is not open |
| `AdminStatus.tenants[]`, per-Tenant quarantine | `AdminStatus.tenant`; a Tenant that cannot be opened fails `/ready` with its cause (`schema-too-new`, `kek-missing`, `database-layout-old`, …) |
| `verifyDeliveryToken({ tenantId })` required | `tenantId` optional: the endpoint accepts its installation's Tenant |
| Studio's Tenant picker, list and create | Studio serves its installation's Tenant; `/` opens `/tenants/<id>` |
| `<Host root>/tenants/<id>/` | `<Host root>/tenant/` |
| `ERROR_CODES` `tenant_conflict`, `active_work` | Removed |

- **Self-hosted Runtime.** Point the Runtime at a new, empty database. One that holds
  `tenant_<id>` schemas fails readiness with `database-layout-old`. Set
  `NYLORUN_TENANT_NAME` (and optionally `NYLORUN_TENANT_ID`) for the Tenant it creates, and
  `NYLORUN_DERIVED_PRINCIPALS` (default `project`) for the clients whose keys the admin key
  derives, e.g. `project,app-server`.
- **Protocol 4 clients** keep working against this Runtime for one release: a request
  without `Nylorun-Tenant`, or naming the Host's Tenant, reaches it; one naming another
  Tenant is the opaque `404`.
- **Keys and ids.** The Tenant id stays as identity (token issuers, key formats, basin
  names); application and publishable keys of the new Tenant keep their formats.

# `startEphemeralRuntime` needs a database

The in-memory Session Store is gone: `startEphemeralRuntime()` (`@nylorun/runtime`,
`@nylorun/runtime/core`) now requires `database`, the Postgres database of the Tenant it
serves. Pass a URL, and the Runtime opens a pool and ends it on `close()`, or a pool you end
yourself. It creates its Tenant in that database on first start (or serves the one the
database holds), and the data stays after `close()`, so give each test its own database and
drop it afterwards.

```ts
const runtime = await startEphemeralRuntime({
  hostRoot,
  database: "postgres://nylorun:nylorun@127.0.0.1:55432/my_test_db",
});
```

# Session events on the `nylorun.event/2` envelope (protocol 4)

Protocol 4 puts every session event on the `nylorun.event/2` envelope and types each event
type in one catalog (`EVENT_CATALOG` in `@nylorun/core/contracts`), published in
`openapi.json`. A Runtime and SDK must both speak protocol 4; upgrade them together. An older
client is refused with `426 protocol_unsupported`.

| Before | After |
| --- | --- |
| `createdAt` | `time` |
| `eventId`, `sessionId`, `tenantId`, `turnId`, `cursor`, `type`, `payload` | Unchanged |
| — | New: `schema` (`"nylorun.event/2"`), `seq`, `epoch`, `runId` (null), `incarnation` (0), `schemaVersion`, `source`, `evidence`, `visibility`, `retention`, optional `trace` |
| `LiveEventSchema` was strict: any new field failed parsing | Unknown top-level fields are dropped, and `parseSessionEvent` returns an event of an unknown type as the bare envelope instead of throwing |
| `payload` typed for the 14 transcript events (`parseTranscriptEvent`) | Every type typed: `SessionEvent` is a union discriminated on `type`; `SessionEventOf<"action.delivered">` names one |
| `GET /v1/sessions/:id/items` items: `LiveEvent` | `SessionEvent` (the client reads unknown types as `LiveEvent`) |

- **Your code.** Read `event.time` instead of `event.createdAt`. Switch on `event.type` to
  narrow `payload`, and ignore types you do not know.
- **Other languages.** Generate types from `openapi.json`: each type is a component named
  after it (`MessageAssistantEvent`, `ActionDeliveryFailedEvent`, …), and `SessionEvent` is
  their union.
- **Writers.** The Runtime checks every event against the catalog before it commits it, so a
  stream never carries an event the catalog does not describe.

## Session history starts fresh

This release makes Postgres the record of every session event and S2 the delivery tier fed
from it. Upgrading deletes each Tenant's sessions (with their commands, checkpoints, effects,
Actions and links) and their history; Tenant settings, agents, Action endpoints, keys, policy
and vaults stay. Cursors from before the upgrade are not valid after it.

- **Local stack.** `nylorun start` recreates the Postgres container with `wal_level=logical`;
  its data volume is kept.
- **Your own Postgres.** Set `wal_level = logical` and restart it, and give the Runtime's role
  `REPLICATION` (see `DEPLOYMENT.md`). An `api` or `all` Runtime with S2 refuses to start
  without them.

# Action endpoints replace executors (superseded: [Action endpoints are removed](#action-endpoints-are-removed))

Protocol 3 removes executors. The Runtime no longer offers Actions for a process to claim.
It POSTs each Action (tool, hook, `fn`, `verify`) to the URL your app registers, signed with a
short-lived delivery token, and your app answers with the outcome. A Runtime and SDK must both
speak protocol 3; upgrade them together.

| Before | After |
| --- | --- |
| `connectAgents({ agents })` | `const actions = createActionHandler({ agents, url })`, served by your HTTP server (`actions.node` or `actions.fetch`), then `await actions.register({ url })` |
| `@nylorun/agents/executor` | `createActionHandler` from `@nylorun/agents` |
| Executor keys: `NYLORUN_EXECUTOR_KEY`, derived keys, `PUT /v1/executors` | None. `register()` sends `PUT /v1/endpoints` with the application key; each delivery carries its own token |
| `GET /v1/executors`, `DELETE /v1/executors/:agentId` | `GET /v1/endpoints`, `DELETE /v1/endpoints/:agentId`, `POST /v1/endpoints/:agentId/ping`, `nylo tenant endpoints` |
| `GET /v1/executors/connect`, `GET /v1/actions`, `POST /v1/actions/:id/claim` | None: the Runtime POSTs to the endpoint |
| The `action_result` session command | The endpoint's answer. A tool marked `background: true` answers `202` and posts `POST /v1/actions/:id/result` |
| `POST /v1/actions/:id/heartbeat` with a claim | The same route with the delivery token, for background tools. It returns a fresh token |
| `POST /v1/actions/:id/sandbox/:tool` with `claimId` and `generation` | The same route with the delivery token. `ctx.sandbox` is unchanged |
| Action status `claimed`, `claimId`, `leaseExpiresAt` | `delivering`, `deadlineAt` |
| `action.claimed` events | `action.delivered`, and `action.delivery_failed` while the endpoint can't be reached |
| Tenant summary `connectedExecutors` | `inFlightDeliveries` |

- **Reachability.** The Runtime must reach the URL. On the local stack, `localhost` means the
  machine running Docker. A Runtime elsewhere needs a public URL, such as a tunnel. A Runtime
  that refuses private addresses (Cloud) refuses `localhost` URLs.
- **Long tools.** An inline delivery lasts `timeoutMs` (default 60 s, at most 840 s). Mark
  longer tools `background: true`; the handler heartbeats and posts the result.
- **In flight during the upgrade.** Postgres migration 6 treats Actions that an executor had
  claimed as lost deliveries. A tool becomes `uncertain`. A hook, `fn` or `verify` is
  delivered again once the agent's endpoint is registered.
- **Status.** `GET /v1/tenant/status` lists `endpoint` per agent instead of `connected`, and
  checks `endpoints` instead of `executors`.

# Sandboxes are chosen when a session is opened

Agent and flow agent definitions no longer declare a sandbox. A session gets one when
it is opened, within limits its Tenant sets, so the same agent runs in any Tenant.

| Before | After |
| --- | --- |
| `Agent(…).sandbox()` or `.use(sandbox())` | Remove it. Open the session with `createSession({ …, sandbox: {} })`, or set the Tenant's default |
| `.sandbox({ image, network, resources })` | `createSession({ …, sandbox: { network: { allow }, resources } })`. `image` is not supported yet: the virtual sandbox has no images |
| `.sandbox({ idle })` | The Tenant's `limits.idle` (`PUT /v1/tenant/sandbox`) |
| `network.preset: "dev"` (the old default) | List the hosts in `network.allow`. The Tenant's ceiling defaults to the same package registries and code hosts; no `allow` means no egress |
| `.sandbox(spec)` on a flow agent, `.sandbox()` on its agents | Open the flow's session with the sandbox; its agents, tool steps and `verify` inherit it |
| Identical specs across a tree (`sandbox.mismatch`, `workflow.sandbox-mismatch`) | Gone: a tree shares the sandbox its session was opened with |
| `sandbox`, `SandboxError`, `SandboxOptions` exports | Removed |

- **Registration.** `PUT /v1/agents/:id` refuses a definition that declares a sandbox
  with a `400` that names it. The builder fails with `sandbox.in-definition`.
- **Tenant default.** Unset, it is `none`: sessions that name no sandbox get none, as
  agents without `.sandbox()` did. Set it with `PUT /v1/tenant/sandbox`, for example
  `{ "default": "virtual" }`, so Studio sessions and AG-UI threads get one.
- **Callers acting for a user.** An inline sandbox from `app.as(…)` is a `403`; use the
  Tenant's default or `false`.
- **Already stored.** Definitions registered before the upgrade keep their declared
  sandbox until they are saved again, and sessions keep the sandbox they were created
  with.
- **Executors.** `ctx.sandbox` follows the session (the action claim says whether it
  has one), so tools and `verify` in a tree opened with a sandbox get it.

# The Admin API on its own port

The stack now serves the Admin API on a second port, `NYLORUN_ADMIN_PORT` (default
8788, published on loopback only), and the Runtime port (`NYLORUN_PORT`) serves the
Tenant API alone: admin routes there answer `404`. `nylorun start` picks the port,
writes it to `stack/.env` and to `host.json` as `adminPort`, and Studio reaches the
Runtime on the stack network at `runtime:4001`.

- `@nylorun/admin` reads `adminPort` from `host.json` and sends Admin API requests
  there; `admin.url` stays the Tenant API URL and `admin.adminUrl` is new. A
  `host.json` without `adminPort` keeps working against one port.
- Code that called `/v1/admin/*` on the Runtime port itself, or `NYLORUN_ADMIN_URL`
  pointing at it, must use the admin port.
- A Runtime you run yourself keeps one port unless you set `adminPort` in
  `host.json`, or `NYLORUN_ADMIN_LISTEN_PORT` (with `NYLORUN_ADMIN_ALLOWED_HOSTS`
  off loopback) in a container.
- Reverse proxies forward the Runtime port only. Keep the `/v1/admin` block as
  defense in depth.

# Studio opens signed in

`nylorun up` prints Studio as `http://localhost:<port>`, without a login token.
In a terminal it opens Studio in the browser, signed in; `--no-open` (or CI)
keeps the browser closed and says to run `nylorun studio`. A sign-in lasts 30
days and survives Studio restarts. `nylorun studio` also prints the plain URL
when it opens the browser; `nylorun studio --no-open` still prints the
single-use login URL, so scripts that read the `Studio` line of `nylorun up`
should use `nylorun studio --no-open` instead.

# Flow agents as subagents

`.subagents(flowAgent)` now works: the flow agent's workflow manifest v2 is inlined in
the delegating tool (`tools[].agent` may be a workflow manifest), and the Runtime runs
it in a linked session per call. `delegation.flow-unsupported` now only reports a
workflow built with `Chain`, `Switch`, `Parallel`, `Map` or `Loop`. A Runtime older than
this release rejects a manifest with a flow subagent at registration.

# Flow agents on workflow manifest v2

Flow agents now compile to workflow manifest v2 and run on the `flow-2` engine.
Code written with the flow agent syntax needs no change; what changes is on the wire
and in session ids.

- **One document.** The manifest embeds every agent the flow runs (`agents`), and
  `saveAgent(flowAgent)` PUTs that one document with the agents' plugin roots. The
  flow's agents are no longer registered, or listed, on their own.
- **Sessions follow the agents.** An agent's linked session is named by its id
  (`fixer`, `implementer[0]`, `review/reader`), not by the control stages around it.
  Runs started before the upgrade finish on `flow-1` with their old paths; new runs
  of a redeployed flow open new linked sessions.
- **Stage keys.** Functions are bound under a stage's `id`, or its position
  (`@1.default.1`), plus `:input`, `:on`, `:verify` or `:decide`. A flow executor
  only runs flow actions for the manifest hash it serves.
- **Nested `flow()`** functions receive `flowInput` (the enclosing agent's input);
  `flow.flow-input-nested` is gone.
- **A Loop that runs out of attempts** fails with `loop.exhausted` (was `loop.stopped`).
- **The same agent twice** in one flow needs a new id (`flow.duplicate-leaf`).
- **Sandbox.** Declare the spec once with `.sandbox(spec)` on the flow agent; agents
  in it use `.sandbox()` with no options, or the same spec.
- **Nesting.** A flow agent can be a step of another flow agent. It can't be a child
  of `Chain`, `Switch`, `Parallel`, `Map` or `Loop`, which keep building v1 workflows,
  and a v1 workflow can't be a step of a flow agent.
- `Agent.from(json, { nodes, agents })` rebuilds a flow agent from its v2 document.

# One `Agent` builder: named methods and flow agents (deprecations)

Every capability now has its own method on `Agent`, and deterministic workflows
are written as flow agents on the same builder. The old forms keep working for one
minor release and warn once each (`DeprecationWarning`, codes below). Manifests are
unchanged: the new syntax compiles to exactly what the old syntax produced.

| Before | After | Warning code |
| --- | --- | --- |
| `Agent({ id, instructions, tools, outputSchema })` | `Agent({ id }).instructions(…).tools(…).output(schema)` | `NYLORUN_DEP_AGENT_OPTIONS` |
| agents inside `tools: [...]` | `.subagents(agent)` | — |
| `.use(mcp({ gh: { name: "gh", … } }))` | `.mcp({ gh: { … } })`; `name` defaults to the key | `NYLORUN_DEP_USE` |
| `.use(skills(dir))` / `.use(plugin(dir))` | `.skills(dir)` / `.plugin(dir)` | `NYLORUN_DEP_USE` |
| `.use(sandbox(spec))` | `.sandbox(spec)` | `NYLORUN_DEP_USE` |
| `.use(capability({ id, instructions, tools }))` | `.capability(capability({ id }).instructions(…).tools(…))` | `NYLORUN_DEP_USE`, `NYLORUN_DEP_CAPABILITY_OPTIONS` |
| `.before("turn", fn)` / `.before("step", fn)` | `.beforeTurn(fn)` / `.beforeModel(fn)` | `NYLORUN_DEP_HOOKS` |
| `.after("step", fn)` / `.after("turn", fn)` | `.afterModel(fn)` / `.afterTurn(fn)` | `NYLORUN_DEP_HOOKS` |

`.use(middlewareFunction)` has no replacement yet and does not warn.
`.skills()` and `.plugin()` read files, so they are on the `Agent` exported from
`@nylorun/agents`; `@nylorun/agents/define` exports the portable builder without them.

Workflows become flow agents. `Chain`, `Switch`, `Parallel`, `Map` and `Loop` still
work and produce the same (v1) manifests.

| Before | After |
| --- | --- |
| `Chain({ id, steps: [a, b] })` | `Agent({ id }).step(a).step(b)` |
| slot `{ run, id, input: ({ value, results }) => … }` | `.step(x, { id, input: ({ input, results, flowInput }) => … })` |
| `Switch({ id, on: (input) => key, cases, default })` | `.switch({ ...cases, default }, { on: ({ input }) => key, id })` |
| `Parallel({ id, branches })` | `.parallel(branches, { id })` |
| `Map({ id, over: (input) => list, each })` | `.map(each, { id, input: ({ input }) => list })`; a Map runs over its input |
| `Loop({ id, run, verify, decide })` | `.loop(body, { verify, max })`, or `{ verify, decide }` returning `{ output }` or `{ retry, agent? }` |

A loop needs `max` or `decide` (`loop.max-required`).

# `nylorun` and `nylo`: setup and the Runtime client (breaking beta)

The `nylorun` command moves to a new unscoped package, `nylorun`, which only
sets up and runs the local stack and never creates Tenants. `@nylorun/cli`
stays as the Runtime client with its own command, `nylo`: Tenants, the Project
link and the model provider. The two packages are independent. A project
depends on `@nylorun/agents` alone and runs both tools with `npx`:

```sh
npx nylorun up                   # set up the stack on the first run, then start it
npx @nylorun/cli tenant create   # the project's Tenant and Project link, model from .env
npm run dev                      # tsx watch src/main.ts
```

| Before | After |
| --- | --- |
| `nylorun start` / `nylorun stop` (from `@nylorun/cli`) | unchanged, from `nylorun`; `nylorun up` / `nylorun down` are aliases |
| `nylorun dev` | `nylo tenant create` once, then the project's `npm run dev` (`tsx watch`) |
| `nylorun dev --ephemeral` | removed; the repository's smoke checks create temporary fixture-model Tenants themselves |
| `nylorun dev --no-studio` / `--no-open` | `npm run dev`; `nylorun studio` opens Studio on the linked Tenant |
| `nylorun tenant …` | `nylo tenant …` (plus `nylo tenant create [name]`) |
| `nylorun configure` | `nylo configure` |
| `nylorun status --env` | `nylo env` |
| `nylorun doctor sandbox` | `nylo doctor sandbox` |
| `package.json` `nylorun.runtime` / `nylorun.studio` in `@nylorun/cli` | the same fields in `nylorun` |

The moved `nylorun` commands exit 2 and name their replacement; `nylo` does the
same for the stack commands. In a generated project, drop the CLI and change
the `dev` script:

```diff
   "scripts": {
-    "dev": "nylorun dev",
+    "dev": "tsx watch --env-file-if-exists=.env src/main.ts",
     "start": "node dist/src/main.js"
   },
   "devDependencies": {
-    "@nylorun/cli": "…",
```

An existing Project link keeps working: `connectAgents` reads it, so a linked
project only needs the new `dev` script. `npm create @nylorun/agent` now
installs the project and prints these steps instead of starting development;
`--no-open` is accepted and ignored.

# Runtime V1: the Docker stack (breaking beta)

The local Runtime moves from one SQLite file per Tenant, run by the
`nylorun-runtime` launcher, to a Docker Compose stack that `nylorun` manages:

| Service | Role |
| --- | --- |
| `postgres` | Session Store: one schema `tenant_<id>` per Tenant |
| `restate` | Durable Session Execution: wakes, one advance per session, the Tenant sweep |
| `s2` (s2-lite) | Durable Streams: one event stream per session, read by history and SSE |
| `runtime` | The Runtime, image `ghcr.io/nylorun/runtime` |
| `studio` | Studio's dashboard and trusted proxy, image `ghcr.io/nylorun/studio` |

Upgrade in this order: install the prerequisites, move to the new commands,
recreate your Tenants, then update generated projects. Upgrade
`@nylorun/core`, `@nylorun/agents`, `@nylorun/admin`, `@nylorun/cli` and
`@nylorun/create-agent` together; the CLI pins the Runtime and Studio images.

### 1. Prerequisites

Node 24 or newer and Docker with Compose v2 (Docker Desktop, OrbStack or
Colima); on Windows, both inside WSL2. A global `@nylorun/runtime` is no longer
used: remove it with `npm uninstall --global @nylorun/runtime`. `nylorun doctor`
checks the prerequisites and the stack's health.

### 2. Commands

| Before | After |
| --- | --- |
| `nylorun runtime up`, `nylorun runtime run` | `nylorun start` (or its alias `nylorun up`) |
| `nylorun runtime down` | `nylorun stop` (or its alias `nylorun down`; volumes are kept) |
| `nylorun runtime restart` | `nylorun stop`, then `nylorun start` |
| `nylorun runtime status [--json]` | `nylorun status [--json]` |
| `nylorun runtime status --env` | `nylo env` ([above](#nylorun-and-nylo-setup-and-the-runtime-client-breaking-beta)) |
| `nylorun runtime logs`, `nylorun logs` (launcher) | `nylorun logs [service] [-f] [--tail <n>]` |
| `nylorun stack logs`, `nylorun stack studio` | `nylorun logs`, `nylorun studio` |
| `nylorun studio [--local-ui] [--port <n>]` (in-process proxy) | `nylorun studio [--no-open]`: a fresh login URL for the stack's Studio, on the linked Project's Tenant |
| `nylorun dev --local-ui` | `npm run dev`, then `nylorun studio` (opens Studio on the Project's Tenant) |
| `nylorun dev --ephemeral` (in-process Runtime) | removed ([step 6](#6-nylorun-dev---ephemeral-and-the-fixture-model)) |
| `nylorun doctor runtime` | `nylorun doctor` (Node, Docker, Compose v2, stack health) |
| `nylorun-runtime up\|down\|status\|logs` | `nylorun start\|stop\|status\|logs` |
| — | `nylorun reset [--yes]`: delete the stack's volumes and every Tenant |

The removed `nylorun` commands exit 2 and name their replacement. `nylorun
start` writes `compose.yaml` and `.env` (mode 0600) under `<Host root>/stack/`
and publishes on loopback only: the Runtime on `8787` and Studio on `4161` by
default, or free ports chosen on the first start and kept in `.env`.
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` replace the pinned images.

### 3. Tenants move to Postgres; SQLite Tenants are not migrated

A Tenant is now a Postgres schema, and the SQLite Session Store is removed.
On its first start the Runtime moves every Tenant directory from the SQLite
Runtime (`~/.nylorun/tenants/<id>/` holding a `tenant.sqlite`) to
`~/.nylorun/trash/<id>-sqlite-<time>/` and logs `sqlite_tenant_moved_to_trash`
with its id. Copy anything you still need out of `trash/`, then delete it.

Recreate each Tenant: remove `.nylorun/link.json` and
`.nylorun/credentials.json`, then run `nylo tenant create` in the project.

### 4. The `nylorun-runtime` launcher is removed

`@nylorun/runtime` is a library with no bin. The launcher and its
`host-state.json` are gone; the Runtime runs only as the
`ghcr.io/nylorun/runtime` image, whose entry requires `NYLORUN_DATABASE_URL`.
`openTenantRuntime(config, hooks)` requires the Tenant's opened `store` and
`envelope`, and `HostStateFile` is no longer exported.

### 5. Studio is a stack service

`@nylorun/studio` is no longer published to npm; it ships only as the
`ghcr.io/nylorun/studio` image, served on `http://localhost:4161`. The hosted
dashboard at `local.nylorun.studio`, the local UI mode (`--local-ui`,
`ui: "local" | "hosted"`), the pairing fragment, the `nylorun-studio` bin and
`startStudio()` are removed. The CLI asks the Studio container for a
single-use login token (valid for two minutes) with the admin key and opens
`/login?token=…`, which sets an `HttpOnly`, `SameSite=Strict` cookie;
`nylorun studio` mints a fresh one.

Studio reaches each Tenant as the **Studio principal**: application principal
`studio`, whose key Studio derives from the admin key and the Tenant id
(`deriveStudioToken` in `@nylorun/admin`). `createTenant` registers its hash
when it creates the Tenant. Tenants created before this release have no Studio
principal, which is one more reason to recreate them.

In a generated project, remove the Studio dependency and script:

```diff
   "scripts": {
     "dev": "nylorun dev",
-    "studio": "nylorun-studio",
     "start": "node dist/src/main.js"
   },
   "devDependencies": {
     "@nylorun/cli": "…",
-    "@nylorun/studio": "…",
```

Then run `npm install` and use `npx nylorun studio` (or just `npm run dev`).
`npm create @nylorun/agent` no longer adds Studio, checks for Docker with
Compose v2 instead of `nylorun-runtime`, and accepts `--no-studio` only as a
deprecated no-op.

### 6. `nylorun dev --ephemeral` and the fixture model

`--ephemeral` is removed with `nylorun dev`. The repository's smoke checks
create a temporary Tenant through `@nylorun/admin`, seed it with the
Tenant-level fixture model and delete it afterwards
(`scripts/lib/temporary-tenant.mjs`).

The fixture model is a Tenant setting rather than a Host-wide mode:
`PUT /v1/tenant/config/seed` accepts `fixtureModel: true` (stored as
`model.fixture`, insert-if-absent). Other Tenants on the same Host keep their
model. In the CLI, `NYLORUN_DEV_MODEL=fixture` now only skips model setup. The
Runtime no longer reads it: a Host started with it no longer answers every
Tenant with the fixture model. Seed the Tenant setting instead.

`startEphemeralRuntime()` (`@nylorun/runtime`, `@nylorun/runtime/core`) keeps
its signature, but its Tenants live in memory (the memory Session Store and
memory Durable Streams) instead of SQLite under the Host root. Nothing survives
`close()`, and a retained Host root cannot be reopened with its sessions. Use it
for tests and embeds that need the Runtime's HTTP API without Docker; use the
stack for anything durable.

### 7. Sandboxes: the microsandbox backend is removed

The Runtime has one sandbox backend, `virtual` (an emulated shell in the
Runtime process; not a VM boundary). The optional `microsandbox` dependency is
gone.

- `sandbox.backend` (`PUT /v1/tenant/config/seed`) and `NYLORUN_SANDBOX` accept
  `auto` or `virtual`; `microsandbox` is rejected. `auto` selects `virtual`.
- A Tenant that stored `sandbox.backend=microsandbox` reads it as `auto`.
- Sandbox reports (`GET /v1/tenant/sandbox`, `nylorun doctor sandbox`) list only
  `virtual` with `process` isolation.
- Remove leftover microVMs with the `msb` commands under
  [Microsandbox cleanup](#microsandbox-cleanup-old-nylorun-scopeid--prefixes),
  or `msb rm --force` on names starting with `nylorun-`, then uninstall `msb`.

### 8. Wire and contract changes

Protocol stays `2`. Clients from this release require `studio-principal`, so
they report an older Host as `incompatible_host`.

| Change | Where |
| --- | --- |
| Required feature `studio-principal`: `POST /v1/admin/tenants` accepts optional `studioCredentialHash` (SHA-256 of the derived Studio key) and stores application principal `studio`; idempotent create compares it too. `principalId: "studio"` is reserved (400) | `PROTOCOL_FEATURES`, `CreateTenantRequestSchema` |
| Optional Host feature `tenant-fixture-model`: `fixtureModel: true` on the Tenant seed. Clients do not require it; the temporary test Tenants check `/health` for it | `OPTIONAL_HOST_FEATURES`, `SeedTenantConfigRequestSchema` |
| `GET /v1/tenant` reports `checks.store` instead of `checks.sqlite`, and gains optional `execution` (stuck Restate invocations) and `streams` (basin, outbox depth, relay lag) | `TenantStatusSchema` |
| `GET /v1/admin/status` aggregates gain optional `outboxDepth` and `relayLagMs` | `HostAggregateSchema` |
| Quarantine code `locked` and its `lockPath`/`lockPid` are removed; the codes are `kek-missing`, `corrupt`, `schema-too-new`, `migration-failed`, `envelope-invalid`, `open-timeout` and `open-failed`. A schema newer than the Runtime is `schema-too-new` | `QuarantineSchema` |
| `sandbox.backend` accepts `auto` or `virtual` | `SeedTenantConfigRequestSchema` |
| `LAUNCHER_PROTOCOL` and the launcher `ERROR_CODES` (`platform_unsupported`, `launcher_failed`, `lock_timeout`, `foreign_port`, `host_unresponsive`, `host_start_failed`, `host_schema_newer`, `host_format_newer`, `downgrade_refused`, `upgrade_failed`) are removed | `@nylorun/core/compatibility` |
| `GET /ready` covers Postgres, Restate and S2 (`checks`); a Tenant whose Postgres or Restate is unreachable answers `503` | Runtime Host |

# Runtime Clients and Admin API (breaking beta)

Vocabulary: [runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

> Runtime V1 (above) replaces this release's launcher, its global
> `@nylorun/runtime` install and the `nylorun-studio` binary. The client
> packages, `src/main.ts` and the three deployment variables below still apply.

Every process that talks to a Runtime is a **client**. Two client packages
cover the two surfaces: `@nylorun/agents` (Tenant API) and `@nylorun/admin`
(Admin API). A local OSS Runtime is the npm package `@nylorun/runtime`, which
developers install as a prerequisite, and it is started by its **launcher**
(`nylorun-runtime`). The CLI and desktop apps find that launcher on PATH and
run it as a process; nothing imports `@nylorun/runtime`, and nothing downloads
it.

Before upgrading, install the prerequisites. Native Windows is no longer
supported: on Windows, install them inside WSL2 and move projects there.

```sh
node --version                            # 24 or newer
npm install --global @nylorun/runtime     # provides nylorun-runtime
```

### Upgrade a generated application (steps 1–4)

#### 1. Add `src/main.ts`; `serve` → `dev` / `start`

Replace `nylorun serve` with one development entry (`nylorun dev`) and one
production entry (`node dist/src/main.js`).

Before (Tenants-era starter):

```json
{
  "scripts": {
    "dev": "nylorun dev",
    "start": "nylorun serve"
  },
  "dependencies": {
    "@nylorun/agents": "…",
    "@nylorun/cli": "…"
  }
}
```

After:

```ts
// src/main.ts
import { connectAgents } from "@nylorun/agents";
import { agents } from "../agents/index.js";

await connectAgents({ agents }).ready;
```

```json
{
  "scripts": {
    "dev": "nylorun dev",
    "build": "…unchanged…",
    "start": "node dist/src/main.js",
    "check": "tsc --noEmit"
  }
}
```

`connectAgents` in application mode saves definitions, registers executor
credentials **derived** from the application key, and connects. The same entry
runs under `nylorun dev` (with `tsx watch`) and in production (`npm start`).
Stored executor tokens in `.nylorun/credentials.json` are ignored and dropped
on the next write.

#### 2. Studio is a separate package binary

Move `@nylorun/cli` and `@nylorun/studio` to `devDependencies`. Point the npm
`studio` script at Studio's own binary (`nylorun-studio`). The Project-aware
`nylorun studio` command remains available from the CLI for direct use.

Before:

```json
{
  "dependencies": {
    "@nylorun/agents": "…",
    "@nylorun/cli": "…"
  },
  "devDependencies": {
    "@nylorun/studio": "…"
  },
  "scripts": {
    "studio": "nylorun studio"
  }
}
```

After:

```json
{
  "dependencies": {
    "@nylorun/agents": "…",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@nylorun/cli": "…",
    "@nylorun/studio": "…",
    "tsx": "…",
    "typescript": "…"
  },
  "scripts": {
    "studio": "nylorun-studio"
  }
}
```

Production `npm ls --omit=dev` must list only `@nylorun/agents` and
`@nylorun/core` from Nylorun. Studio never depends on the CLI (or the reverse).

#### 3. Deployments use three environment variables

Do not ship executor tokens. Set the Tenant API trio; `createClient()` /
`connectAgents({ agents })` resolve from options, then these variables, then
the Project link.

Before (executor tokens or Project-only credentials in production):

```sh
# ❌ do not ship derived or stored executor tokens
export NYLORUN_EXECUTOR_KEY=…
# or rely on a checked-in .nylorun/credentials.json executors map
```

After:

```sh
export NYLORUN_RUNTIME_URL=https://runtime.example
export NYLORUN_TENANT=tn_…
export NYLORUN_SERVER_KEY=…   # application key only
node dist/src/main.js
```

#### 4. Removed commands; Admin package; launcher

| Removed | Replacement |
| --- | --- |
| `nylorun serve` | `nylorun dev` (watch) / `node dist/src/main.js` (`npm start`) against a running Host |
| `nylorun studio` | `nylorun-studio` (Studio's own binary) |
| `--no-studio` on `dev` | Omit the `studio` script / `@nylorun/studio` if unused |
| CLI depending on `@nylorun/runtime` | CLI runs the installed Runtime's **launcher** (`nylorun-runtime` on PATH) |
| In-process CLI Host install/lifecycle | `nylorun runtime …` → `nylorun-runtime`; install the Runtime with npm first |
| Ad-hoc Host admin HTTP from the CLI | `@nylorun/admin` (`createAdmin`, `createTenant`, `status`, …) |

Managing clients (CLI, desktop Runtime panel, CI) add `@nylorun/admin` for the
Admin API. Developer applications do **not** depend on it — only
`@nylorun/agents`. Local Host start/stop/upgrade goes through the launcher,
never through an import of `@nylorun/runtime`.

### Existing Host roots

- A Host started by the Tenants-era CLI is reused while it runs.
- Its next restart moves it onto the installed `@nylorun/runtime`.
- `host.json` gains `format` and `runtimeVersion` on the first launcher write.
- Project link and credentials accept format `0` (missing `format`) and write
  format `1`.

Upgrade `@nylorun/core`, `@nylorun/agents`, `@nylorun/admin`, `@nylorun/cli`,
`@nylorun/studio` and the installed `@nylorun/runtime` together (breaking beta
set). Protocol feature `admin-status` is additive on
protocol `2`.

# Scoped hooks and manifest schema 4

`beforeModelCall` and `afterModelCall` are replaced by two verbs with an explicit scope.
There are no compatibility aliases.

| Previous                                               | Replacement                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `.beforeModelCall(fn)`                                 | `.before("step", fn)`, or `.before("turn", fn)` when the decision holds for the whole turn |
| `.afterModelCall((args, ctx) => …)`                    | `.after("step", ({ text, toolCalls, info, state, step, attempt }) => …)` (one argument)    |
| `capability({ beforeModelCall, afterModelCall })`      | `capability({ before: { turn?, step? }, after: { step?, turn? } })`                        |
| —                                                      | `after("turn", ({ text, output, attempt }) => TurnDecision)` for the final answer          |
| Manifest `beforeModelCall` / `afterModelCall` booleans | `capabilities[].hooks: { at, scope }[]` in `manifestSchemaVersion: 4`                      |
| Action kinds `beforeModelCall` / `afterModelCall`      | Action kind `hook` with `hook: { at, scope, capabilityIds }`                               |
| `BeforeModelCallFn` / `AfterModelCallFn`               | `BeforeHook<scope>` / `AfterHook<scope>`                                                   |

`before("turn")` runs once per turn and its `Patch` applies to every model call in that
turn; `before("step")` and `after("step")` run on every model call. In a Runtime, every
capability registered at one hook point runs in a single executor action, so a hook point
costs one round trip per turn or per model call.

Hooks may run more than once when a delivery is retried: an expired hook claim is offered
again instead of becoming uncertain. Keep side effects in tools.

`retry` now retries. From `after("step")` it denies the proposed tool calls with the feedback,
or sends a text answer back with the feedback as a message; from `after("turn")` it sends the
final answer back. The engine does not cap retries: bound them with the `attempt` argument,
for example `attempt < 2 ? { retry: "…" } : { block: "…" }`.

Rebuild agents to publish schema 4 manifests. `Agent.from` rejects schema 3. On startup the
Runtime cancels pending `beforeModelCall` / `afterModelCall` actions and fails any turn that
was in flight under a schema 3 manifest; start new sessions after upgrading. The durable
engine version is now `hosted-2`, because hook effect ids changed.
Later Runtimes no longer run this startup cleanup, so upgrade through this release first
if a Tenant still has schema 3 turns in flight.

# Runtime Tenants (breaking beta)

Vocabulary: [runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

One **Runtime Host** process serves many isolated **Tenants**. A Project
attaches through a **Project link** (`.nylorun/link.json` + `credentials.json`),
not by owning a SQLite file beside the Project or under the home directory.

### Pre-Tenant layout → Host + Tenant + Project link

| Previous                                                                                                  | Replacement                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| SQLite beside the Project (`.nylorun/`) or a shared home-directory database selected by removed CLI flags | Host root (`NYLORUN_HOME` or `~/.nylorun`) + Tenant under `tenants/<id>/` + Project link         |
| Removed CLI / env selectors for shared home or explicit SQLite path                                       | Host root / Tenant paths only                                                                    |
| `.nylorun/local-credentials.json`                                                                         | `.nylorun/credentials.json` (0600) + `.nylorun/link.json`                                        |
| Unauthenticated health field naming the SQLite path digest                                                | `/health.hostId` + `/health.protocol` (`min` / `max` / `features`); `service: "nylorun-runtime"` |
| Exact package-version equality for CLI ↔ Runtime                                                          | `Nylorun-Protocol` + `checkCompatibility` (protocol `2`, feature `runtime-tenants`)              |
| `createClient({ url, key })`                                                                              | `createClient({ url, key, tenant })` (or `NYLORUN_TENANT`)                                       |
| Tenant model routes under `/v1/host/…`                                                                    | `/v1/tenant/…`                                                                                   |
| Executor registration via Host process env at startup                                                     | Removed; `PUT /v1/executors` with the application principal only                                 |
| In-process embed helpers that started a single SQLite host                                                | `startEphemeralRuntime()` for tests/embeds; CLI starts `@nylorun/runtime/server`                 |
| Env overrides for vault KEK, sandbox backend, model gateway on the Host process                           | Tenant paths / `TenantConfig` / `PUT /v1/tenant/config/seed`                                     |
| Sandbox name prefix `nylorun-<scopeId>-` (16-hex digest of a former SQLite path)                          | `nylorun-<tenant-id>-` (`tn_` + 26 Crockford chars)                                              |

### What to do when upgrading

1. Upgrade `@nylorun/core`, `@nylorun/runtime`, `@nylorun/agents`, `@nylorun/cli`,
   and `@nylorun/studio` together (breaking beta set). Protocol `2` with feature
   `runtime-tenants` is required.
2. Stop every old Runtime process that still owns a Project-local or
   home-directory SQLite file. Start the new Host once: `nylorun runtime up`.
3. From each Project, run `nylorun dev` (or the Project link flow) so a Tenant
   is created and `.nylorun/link.json` / `credentials.json` are written. Do not
   reuse an old Tenant id from another checkout.
4. Point custom clients at `createClient({ url, key, tenant })` and send
   `Nylorun-Tenant` / `Nylorun-Protocol` on every request. Update Studio callers
   to `startStudio({ runtimeUrl, serverKey, tenant: { id, name } })`.
5. Replace Tenant model routes under `/v1/host/*` with `/v1/tenant/*`. Move any
   embedding tests to `startEphemeralRuntime`.
6. Export linked env with:
   `eval "$(npx nylorun runtime status --env)"`.

Existing Project-local SQLite files and KEKs are **not** auto-imported into
Tenants. Prefer new Tenants and new sessions after upgrading; session
export/import remains deferred.

### Microsandbox cleanup (old `nylorun-<scopeId>-` prefixes)

After upgrade, leftover microsandbox entries may still use the old prefix
`nylorun-<scopeId>-`, where `<scopeId>` was the first 16 hex characters of the
SHA-256 of a former SQLite path. New sandboxes use `nylorun-<tenant-id>-` and
must not be deleted.

One cleanup command (matches only the old 16-hex digest prefix):

```sh
msb ls -q | grep -E '^nylorun-[0-9a-f]{16}-' | xargs -r msb rm --force
```

Never delete names that start with `nylorun-tn_`.

# Package architecture beta migration

> **Superseded for dependency rules and application production trees:** the
> [Runtime Clients section](#runtime-clients-and-admin-api-breaking-beta)
> requires production apps to depend on `@nylorun/agents` only (CLI/Studio are
> `devDependencies`). Keep this section for the earlier define/contracts move.

Cloud upgrades published packages from npm independently. Upgrade the tested
package combination in `create-agent/compatibility.json`.

| Previous                                             | Replacement                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@nylorun/harness/define` or authoring from its root | `@nylorun/agents/define` (applications), `@nylorun/core/define` (infrastructure) |
| `@nylorun/harness/contracts`                         | `@nylorun/core/contracts`                                                        |
| Harness hash/protocol metadata                       | `@nylorun/core/compatibility`                                                    |
| Harness checkpoint compatibility                     | `@nylorun/harness/compatibility`                                                 |
| Runtime-owned `nylorun`                              | Install `@nylorun/cli` as a **devDependency**; see Runtime Clients steps 1–4     |

SDK root imports remain supported. Studio imports `agents/client`. Runtime has no
SDK dependency. SDK has no engine dependency. Bindings use `getBinding()` rather
than shared module object identity; only manifests serialize. The package split
does not change wire formats, canonical manifest hashes, or stored checkpoints.

Generated applications keep `@nylorun/agents` (and transitive `@nylorun/core`)
in production dependencies; CLI and Studio are development tooling. Custom
runtime host code keeps a direct runtime and core dependency. Do not copy
private compiled definition objects: use `bindingFromAgent()` from `harness/run`
for explicit execution.

No npm release or deployment is performed by this migration.

## Earlier session-first migration

# Local Runtime beta migration

> **Superseded for application scripts and Studio:** the [Runtime Clients
> section](#runtime-clients-and-admin-api-breaking-beta) replaces `nylorun
> serve` with `npm start` (`node dist/src/main.js`) and points the generated
> npm script at `nylorun-studio`. Keep the rest of this section only for
> historical session-first / Tenants-era upgrades that already applied it.

Upgrade the harness, SDK, Runtime, Studio, and creator as the tested compatible set in `create-agent/compatibility.json`. This migration changes public entry points and the session protocol.

1. Import `Agent` and `tool` from `@nylorun/agents`. Export `agents` from `agents/index.ts`. Keep model selection in Runtime configuration.
2. Remove the starter's Hono application and old `Runtime` / `serveAgents` / `openSession` imports. Definitions no longer expose `agent.run()`.
3. `nylorun start` was removed in favor of `nylorun serve [entry]` for the compiled build. **That `serve` command is itself removed** in Runtime Clients — use `node dist/src/main.js` / `nylorun dev` (see steps 1–4 above). The Runtime Host remains its own persistent process: `nylorun runtime up` / `down` / `status`, with Host root `NYLORUN_HOME` / `~/.nylorun` and a Project link under `.nylorun/`.
4. Update custom applications to SDK `createClient` and session commands with stable idempotency keys. Trusted servers supply `ownerUserId`; input text uses `content`. Pass `tenant` (see Runtime Tenants section above).
5. Custom connected executors use `connectAgents({ agents, runtime: { url, key, tenant } })`. Prefer application-mode `connectAgents({ agents })` with derived tokens (Runtime Clients). The local CLI no longer writes executor tokens into Project credentials.
6. Studio uses canonical history and authenticated SSE through its local proxy. Attach with the generated `nylorun-studio` npm script or the Project-aware `nylorun studio` CLI command; both resolve the Project link. Remove AG-UI and legacy manifest endpoint configuration.

Keep credentials in gitignored `.nylorun/`; provider configuration uses `.env` only as a one-time seed into the Tenant vault. Keep backups of old SessionRecord/event files. They are not automatically converted to new SQLite checkpoints. Session export/import and migration tooling are deferred. Start new sessions after changing definitions or implementations. Because the Host now outlives `dev`, a source change re-registers agents and reconnects executors rather than restarting the Host.

Explicit in-process engine execution remains available to host authors through `@nylorun/harness/run`; it is not loaded by the application SDK. OSS and Cloud consume the harness independently.

The release workflow covers local text and ordinary tools. Advanced examples remain source references outside the default registry. Media, approvals UI, deployment recipes, and broad recovery/conformance gates remain for later releases. Subagents (agents used as tools, one level deep) ship with this branch; see [the SDK](agents/README.md).

## Execution API rename

Replace `@nylorun/harness/engine` imports with `@nylorun/harness/run`. Rename `runHosted` to `runDurable`, `createHostedCheckpoint` to `createDurableCheckpoint`, `HostedCheckpoint` / `HostedResult` to `DurableCheckpoint` / `DurableResult`, and `EngineHost` to `DurableHost`. Rename `EngineBinding`, `EngineRunOptions`, and `createEngineState` to `RunBinding`, `BoundRunOptions`, and `createRunState`. There are no compatibility aliases.

Durable execution reconstructs progress from a checkpoint and individually journaled effect outcomes; the host must persist both. Existing checkpoint fields and `ENGINE_VERSION = "hosted-1"` remained compatible at the time of this rename; scoped hooks later moved the engine to `hosted-2`.
