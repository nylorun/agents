# Runtime Clients vocabulary

Terms follow the Runtime Tenants model, Runtime Clients and Admin API
(version 1), and the Runtime architecture (Postgres, Restate, S2). Every agent
uses these terms in code, comments, errors and CLI output.

Agent definitions describe capabilities. The harness engine advances execution.
A **Runtime Host** listens once and serves the one **Tenant** of its
installation: one Runtime with its own database and infrastructure. A developer
**Project** attaches through a **Project link**, not by owning the Host process
or its storage. Every process that talks to a Runtime is a **Client**.

## Language

**Client**: Any process that talks to a Runtime over HTTP — a developer
application, Studio, the CLI, a desktop app, an IDE extension or CI.
_Avoid_: calling only the SDK or only the CLI "the client".

**Tenant API**: Every route a Tenant principal calls, on the Host's one Tenant: nothing
in a request selects it (protocol 5). Agents, sessions, events, Action endpoints, vaults,
Tenant settings and status. Client package: `@nylorun/agents`.
_Avoid_: "SDK API" or "application API" as the surface name.

**Admin API**: `/v1/admin/status` (the Host, its protocol, its Tenant and why it is not
open, `AdminStatus.tenant`), called with an admin key (`host/admin-api.ts`). There are no
Tenant routes: the Host creates its Tenant itself. Shared by OSS and Cloud. Client package:
`@nylorun/admin`.
Served on the **operator listener** when the Host has one, otherwise on its
only listener.
`POST /v1/admin/host/shutdown` is Host-private on OSS and is not part of
this surface.
_Avoid_: treating Host shutdown as a shared Admin API method.

**Client package**: `@nylorun/agents` or `@nylorun/admin` — a library a client
imports to call one surface. Each depends only on `@nylorun/core`.
_Avoid_: depending on `runtime` or `harness` from application code.

**Local Tenant**: The Tenant of an installation that `nylorun start` (the `nylorun`
package, `nylorun/src/stack/`) runs on a developer machine: the Runtime image with
Postgres, Restate and S2 in Docker Compose. One per project by default; outside a
project, or with `start --no-link`, the Tenant `default`. Its name is the Tenant's name:
`--tenant`, else `NYLORUN_TENANT`, else the Project link's `tenant`, else (on `start`)
the project directory's; a name starting with `tn_` (a Tenant id) is refused. It has its
Compose project `nylorun-<name>`, its Host root `~/.nylorun/tenants/<name>/` (with
`tenant.json`), ports and volumes. Docker names are global on the engine, so its
containers, network and volumes are named `nylorun-<name>-<role>` (`nylorun-shop-studio`,
volume `nylorun-shop-postgres`, network `nylorun-shop`) and labelled
`dev.nylorun.tenant: <name>`. Its Runtime creates the Tenant and its id on first
start. Local Tenants start and stop only when the developer says so. Each Tenant's Studio
is on its own port, `http://localhost:<port>`, with its own session cookie.
`@nylorun/runtime` is a library with no bin; the Runtime runs as the
`ghcr.io/nylorun/runtime` image.
_Avoid_: stack; "native Host", or installing `@nylorun/runtime` globally.

**Prerequisites**: What a developer installs before using the Runtime: Node 24
or newer and Docker, on macOS or Linux; Windows developers use WSL2. A missing
prerequisite is an error naming what to install.
_Avoid_: "bootstrap" for installing the Runtime.

**Local Host settings**: `host.json` and `host-credentials.json` in the Host
root. `@nylorun/admin` reads them for local connection resolution: `port` is
the Tenant API, `adminPort` (when present) the operator listener.

**Public listener** / **Operator listener**: With an operator listener
(`adminPort` in host.json, or `NYLORUN_ADMIN_LISTEN_PORT` in a container; a
local Tenant's is container port 4001, published on loopback as `NYLORUN_ADMIN_PORT`),
the Host serves two ports (`ListenerRole` in `host/create-host.ts`). The public
listener serves the Tenant API, with browser access when enabled, and answers
admin routes with the opaque `404`. The operator listener serves the Admin API,
Host shutdown and the Tenant API, never to browsers. Without one, a single
`combined` listener serves everything. Studio uses the operator listener.
_Avoid_: proxying the operator port.

**Runtime Host** (or **Host**): The code in every Runtime process that listens,
validates `Nylorun-Protocol`, serves admin routes, and forwards Tenant routes to its one
Tenant Runtime, which it opens at start (`host/create-host.ts`: the listeners and the
`Host` check; `host/app.ts`: the rest of the pipeline, a Hono app). A protocol 4
`Nylorun-Tenant`, or a publishable key, naming another Tenant gets the opaque `404`. Only
`host/` and `api/` import Hono. `/health` reports `service: "nylorun-runtime"`, `hostId`
and protocol range; `/ready` reports the Tenant, Postgres, Restate and S2
(`infra/readiness.ts`). The Tenant's data is its Postgres database; the Host keeps its
key, plugin data and logs under `tenant/` in its Host root (`NYLORUN_HOME`, or a
local Tenant's `~/.nylorun/tenants/<name>/`). `nylorun start` writes `host.json` and
`host-credentials.json`.
_Avoid_: calling the Host a "scope", "project Runtime", or "global Runtime".

**Tenant**: One isolated unit of sessions, principals, vault, sandboxes, plugin
data and logs: the one Tenant of an installation, its state in the Postgres schema
`nylorun` of its own database (the `nylorun.tenant` row holds its envelope), its record in
`nylorun_streams`, and the Tenant directory `<host root>/tenant/`. The Host creates it on
first start (`store/postgres/tenant.ts`: `NYLORUN_TENANT_ID`, `NYLORUN_TENANT_NAME`, its
Studio and derived principals). Nothing in a request selects it. Ids match `tn_` plus 26
Crockford characters; the id stays as identity (token issuers, keys, basins). A Tenant
that cannot be opened fails the Host's readiness with its cause (`tenant/cause.ts`).
_Avoid_: "scope" as the name for this unit.

**Tenant Runtime**: The in-process handler for one open Tenant. Created from a
`TenantConfig` (paths, model, sandbox, child env, logger). It authenticates its
own principals and never reads ambient environment, cwd, or home. Its Tenant
API routes are in `api/`: the `/v1` HTTP routes (`api/http/`), the AG-UI
endpoint (`api/ag-ui/`) and the A2A endpoint (`api/a2a/`).
_Avoid_: equating "Runtime" alone with a single Project's process.

**Host root**: The absolute directory that holds Host files, the Tenant directory
`tenant/` and, for a local Tenant, its Docker Compose files in `docker/`. Resolved once from `NYLORUN_HOME`, or for a local Tenant
`~/.nylorun/tenants/<name>/`. A local Tenant bind-mounts it into the Runtime container
at `/nylorun`.

**Project link**: Project-local `.nylorun/link.json` with
`{ format: 3, tenant, tenantId, hostUrl, hostId }` (`tenant` is the local Tenant's
name, absent for an installation that is not local; `tenantId` is information:
nothing selects a Tenant), plus `.nylorun/credentials.json` (mode 0600) holding the
key of the derived principal `project` and its id. `nylorun start` writes both. A
link below format 3 is from an older nylorun; clients refuse it and `nylorun start`
replaces it. A fresh clone or second worktree does not attach until `nylorun start`
creates its Tenant, or `nylorun start --tenant <name>` attaches it to an existing one.
_Avoid_: naming isolation by Project-local vs shared home layout; removed CLI
flags and env vars that selected a database path.

**Application principal**: Bearer credential hashed in the Tenant `principals`
table. Authorizes definition and session routes for that Tenant only. May act
for a **subject** on any request, which only narrows what it can reach.
_Avoid_: "server token" / `serverToken` as the public name (legacy API).

**Subject**: The person an application principal acts for, named with
`Nylorun-Subject` (feature `subject-headers`, `tenant/auth.ts`). Chosen by the
integrator (`app:42`); 1–200 visible ASCII characters, `host` reserved (it owns
the host model's vault). A subject reaches only sessions and vaults whose
`ownerUserId` is the subject; another owner's resource is the same `404` as a
missing one. Only application principals may send it; with a delivery token it is
`403`.
A **subject token** names its subject itself.
_Avoid_: "user" for the header value (the Runtime has no user accounts).

**Scope**: What a subject may do, sent with the subject in `Nylorun-Scopes`
(required, no default): `agents:read`, `agents:write`, `sessions:own`,
`vaults:own`, `tenant:settings`, `sandboxes:write` (`SUBJECT_SCOPES`). Each route declares
the scopes that allow it (`RouteAccess`, `api/http/define.ts`), decided from the route alone before any
lookup (`403 scope_required`); reset, config seed, endpoints, actions, the
sandbox tool routes, `/v1/tokens` and `/v1/access/**` are open to no subject.
A subject token carries only `TOKEN_SCOPES` (`agents:read`, `sessions:own`,
`vaults:own`, `sandboxes:write`).

**Subject token**: ES256 JWT (`typ: nylorun-subject+jwt`) for one subject and one
**role**, minted by `POST /v1/tokens` with an application key and sent as the
bearer (feature `subject-tokens`, `tenant/tokens.ts`). Lives at most 15 minutes.
Its scopes and agents are its role's, narrowed by the mint, resolved on every
request. Forged, foreign or malformed tokens are the opaque `404`; a verified
token that a new one would fix (expired, revoked, key revoked, role removed) is
`401 token_expired`. It may not set session `info`, send `message.manifest` or
store OAuth refresh credentials, and sees only `{ agentId, name, description }`
of the agents it may use.
_Avoid_: "session token", "JWT" as the public name; accepting one from a query
string.

**Signing key**: A Tenant's ES256 key pair for subject and delivery tokens (`signing_keys`,
`tenant/signing-keys.ts`): the public JWK in the clear, the private key sealed
with the vault KEK. States `standby`, `current` (signs), `previous` (verifies),
`revoked`. Rotation never signs anyone out; `force` does.

**Access policy**: The Tenant setting `access.policy`: its **roles** (token
scopes, an agent allowlist, **subject limits**), what a publishable key grants
alone (`anon`), and the longest token lifetime. Without roles nothing is minted
(`tenant/access-policy.ts`).

**Revocation epoch**: A per-subject counter in every subject token (`epc`).
`POST /v1/access/revocations` bumps it: older tokens are refused and the
subject's open streams end with `event: nylorun.closed` on every process
(`subject.revoked` on `tenant/control`, `checkSessionStreams` as backstop).

**Runtime AG-UI endpoint**: `/v1/ag-ui/agents/:agent` (feature
`ag-ui-endpoint`, `api/ag-ui/routes.ts`): run, thread messages, reattach and
cancel, for a person named by a subject token or by subject headers. The SDK's
`createAgUiHandler` forwards here. A **thread session** is
`sessionIdFor(subject, agent, thread)` (`api/ag-ui/session-id.ts`), the same on
every path; it is created on the thread's first run with the options in
`forwardedProps.nylorun.session` and never changed by a later run.
_Avoid_: re-`PUT`ting a thread's session (it would replace its vaults).

**Publishable key**: `nr_pub_<tenantId>_<32 Crockford characters>` in
`Nylorun-Key` (feature `browser-access`, `tenant/browser.ts`): names the Tenant
and one client app, with an **origin allowlist** (exact origins, or
`http://localhost:*` and `http://127.0.0.1:*`; `[]` for native apps). Public by
design and stored as it is; revocable. Alone it grants the **anon role**
(`anon` in the access policy: at most `agents:read`, empty by default) and owns
no session or vault.
_Avoid_: calling it an API key or a secret; using it to authorize (tokens do).

**Browser access**: Whether requests with an `Origin` may reach Tenant routes
(`browserAccess`; `NYLORUN_BROWSER_ACCESS`, on in a local Tenant). The Host answers
preflights for browser routes from the route alone; the Tenant admits an
`Origin` only with a publishable key that lists it, and only then sets CORS
headers. `/health`, `/ready`, admin routes and delivery tokens refuse
`Origin` always.

**Subject limits**: A role's `turnsPerHour` (a token bucket per subject) and
`concurrentTurns` (sessions `runnable`, `running` or `waiting`), checked when a
subject token starts a turn (`429 limit_exceeded`, `tenant/subject-limits.ts`).

**App server**: The developer's own server: signs people in, names the subject
and scopes on each Runtime call (`client.as`) or mints subject tokens for its
pages, hosts the AG-UI handler (which forwards to the Runtime's AG-UI endpoint)
and the Action endpoint, and strips any `Nylorun-*` header its clients send. Nylorun ships
libraries that run inside it, not the server.
_Avoid_: "proxy" or "gateway" for it in Nylorun docs.

**Reverse proxy**: Infrastructure on the Runtime's machine, needed only when the
Runtime is reached from another machine: TLS, `Host` rewrite, only the public
port proxied (admin routes blocked as well), Studio and the operator port never
proxied, `OPTIONS`, `Origin` and `Nylorun-Key` passed through, no CORS headers
of its own. Configured by the developer (Caddy, nginx, Tailscale).

**Action endpoint**: The URL an app registers for one agent (`PUT /v1/endpoints`,
`endpoints` table, `tenant/endpoints.ts`), served by `createActionHandler` from
`@nylorun/agents`. The Runtime POSTs each of the agent's Actions (tool, hook, `fn`,
`verify`) there. The endpoint answers with the outcome, or with `202` for a
background tool, which later posts `POST /v1/actions/:id/result`. Health comes from
recent deliveries and `POST /v1/endpoints/:agentId/ping`.
_Avoid_: "executor", "webhook" or "callback URL" for it.

**Delivery**: One POST of an Action to its endpoint (`tenant/delivery.ts`, run by the
execution's `deliver` handler). The Action is `delivering` until its `deadlineAt`; then it
is lost. A lost tool is `uncertain`; a lost hook, `fn` or `verify` is delivered again.
Unreachable endpoints are retried with backoff (`action.delivery_failed`), and a cancel
aborts the request.

**Delivery token**: ES256 JWT (`typ: nylorun-delivery+jwt`) in `Nylorun-Signature`,
signed with the Tenant's signing key (`tenant/delivery-token.ts`). It names the
endpoint URL (`aud`), the Action and generation (`sub`, `gen`), and the SHA-256 of the
body (`bdy`), and lives at most 900 s. It authorizes only that Action's
`/v1/actions/:id/{heartbeat,result,sandbox/:tool}`, and only while that generation is
being delivered. Endpoints verify it with the public JWKS (`GET /v1/access/jwks`,
readable without a credential).
_Avoid_: "executor key" (removed in protocol 3).

**Admin key**: Host-level secret in `host-credentials.json` (mode 0600).
Authorizes `/v1/admin/*` only; never accepted as a Tenant bearer.

**File artifact**: A file a client uploaded or our engine saved (`artifacts/`, protocol 6): an
`af_` id, a name, a kind (`file`, or `folder`) and numbered immutable versions, each with its
size, SHA-256, media type and source (`upload`, `engine`, or `export` for a folder). Rows in `artifacts` and `artifact_versions`; bytes
in the Object store at a random key per version, counted once the version's row commits. It
belongs to a session (and goes with it on a sessions reset) or, made by an application, to the
Tenant. An upload is one streamed request (`POST /v1/artifacts`, `POST
/v1/artifacts/{id}/versions`) within the Tenant's **artifact limits** (`artifacts.config`:
`fileBytes`, default 100 MiB; `totalBytes`, default 10 GiB; `413 limit_exceeded` past either,
with nothing stored). Downloads stream through core with Range. A session's artifacts are in its
history as `artifact.created`, `artifact.version.created` and `artifact.deleted`. A subject
reaches only the artifacts of their own sessions (`artifacts/service.ts`).
_Avoid_: "media", "asset" or "attachment" for it; `MediaStore` (removed).

**Folder artifact**: An artifact of kind `folder` (F8.2, `artifacts/folders.ts`): each version is
a **manifest**, JSON `{ format: "nylorun.folder.v1", entries: [{ path, size, sha256, contentType }] }`
sorted by path, stored at the version's `blobKey`; each file's bytes are stored once,
content-addressed, at `blobs/sha256/<hex>` (a `head` that finds them skips the `put`). The
`artifact_content` table indexes which hashes each version names, so the Tenant total counts each
file once and deleting a folder removes only the files nothing else names. Content is deleted only
under the quota lock, and each such delete moves the **content epoch** (`artifacts.content_epoch`)
that a writer re-checks at commit. Read as a tree, one file by path with Range, a diff between
versions, or a streamed zip (`artifacts/zip.ts`); a version's `/content` is a `400`. Folders
come only from the turn-end export today; a client cannot upload one.

**Turn-end export**: When an agent's turn completes, the advance calls `exportOutputs`
(`artifacts/export.ts`) after `settle` commits, outside its transaction and still holding the
lease: core lists and reads `/workspace/outputs` of the session's sandbox through the
**`WorkspaceReader`** seam (`artifacts/workspace.ts`: `list(session, dir)` and
`readBytes(session, path)`, over the in-process `SandboxManager` today, over the Harness API's
`workspace.read` from F6.2, and for F7.2's pods) and writes a version of the session's folder
`outputs` (source `export`, `claimed: true` on its event: the listing and bytes are the
harness's claim). A turn whose outputs did not change adds no version; no sandbox, a sandbox never
created or no outputs export nothing. Bounded by 10,000 files and 1 GiB per export, the per-file
limit and the Tenant total; past one it records `artifact.export.skipped` with the reason, and a
failure records `artifact.export.failed`. Neither fails the turn.
_Avoid_: "reader pod" (dropped; D37).

**Capability link**: A short-lived URL that downloads one artifact version with no credential
and no `Nylorun-Protocol` (`GET /v1/artifact-links/<token>`, minted by `POST
/v1/artifacts/{id}/links`): an ES256 JWT (`typ: nylorun-artifact+jwt`, `aud: nylorun-artifact`,
`sub` the artifact, `ver` the version) signed by the keys service with the Tenant's signing key,
at most 15 minutes, opening nothing once the artifact is deleted (`artifacts/links.ts`). A
folder's link opens its zip, or with a `path` claim (`file` when minted) one of its files. The
Host's request log shows its path as `/v1/artifact-links/:token`.
_Avoid_: "presigned URL" (the Object store's own URLs never leave the Runtime).

**Message parts**: A user message's `parts` (protocol 6): `text`, and `file` naming an artifact
the caller may read, of the session or Tenant-wide, at a version or its latest. The commands
service pins each file to a version and gives the engine an opaque media part whose reference is
`{ artifactId, version }`; model-gate reads the bytes (`artifacts/files.ts`) only for the call's
session, the run token's on the gate's route, and reads none for a call without one, so the
transcript and the record hold only the reference. An image becomes image input, a text file text, and
another file a refused call (`invalid_request`).

**`save_artifact`**: Our engine's built-in tool (`nylorun.artifacts` capability, added beside the
sandbox capability to a session with a sandbox): it saves a sandbox file (`path`) or text
(`content`) as a file artifact of its session, with its turn and tool call on the event
(`tenant/artifact-tool.ts`).

**Protocol**: Wire integer and feature set in `Nylorun-Protocol` /
`HOST_PROTOCOL` (`PROTOCOL_VERSION = 6`; the Host serves 4, 5 and 6; required features
`admin-status`, `studio-principal`, `action-endpoints` and `artifacts`, and the Host still
advertises `runtime-tenants` for protocol 4 clients; optional Host features
`tenant-fixture-model`, `transcript-events`, `derived-principals`,
`subject-headers`, `subject-tokens`, `browser-access`, `ag-ui-endpoint` and
`a2a-endpoint`).
Independent of package semver. Incompatible clients receive `426` before
authentication. A client that uses an optional feature checks `/health` first.
_Avoid_: treating package-version equality as the compatibility check.

**Studio principal**: Application principal `studio` that the Host registers when it
creates its Tenant. Its key is derived from the admin key and the Tenant id
(`deriveStudioToken`, `admin/src/derived-credentials.ts`; the Host's side is
`tenant/principals.ts`); the Tenant stores only its hash. Studio derives it to call the
Tenant API; the admin key is never a Tenant bearer.

**Derived principal**: Application principal, named by its client (`babai`),
whose key is derived from the admin key, the principal id and the Tenant id
(`deriveTenantKey`, `admin/src/derived-credentials.ts`). The Host registers each one
it is configured with (`NYLORUN_DERIVED_PRINCIPALS`, default `project`) by hash when
it creates its Tenant, and adds one configured later on its next start (feature
`derived-principals`), so the client stores no key. The Studio principal is the first
of these, with its own derivation. `project` (`PROJECT_PRINCIPAL_ID`) is the one a
Project on the same machine derives.
_Avoid_: storing an application key on a machine that already holds the admin
key.

**Transcript event**: A session event a chat UI renders (feature
`transcript-events`): `message.assistant` for each completed model step (text
and tool calls, keyed by the model's `invocationId` and each call's `callId`),
`tool.completed` for an MCP or sandbox tool, and the `callId` on tool
`action.*` and `delegation.*` events. Written in the transaction that completes
the effect, so a replay writes nothing (`tenant/transcript.ts`); payload
schemas and `parseTranscriptEvent` are in `@nylorun/core/contracts`.
The Runtime's AG-UI endpoint turns them into AG-UI events
(`runtime/src/api/ag-ui/`).
_Avoid_: rebuilding a chat from `turn.completed` output or from `actionId`
formats.

**A2A endpoint**: The Tenant routes `POST /v1/a2a/agents/:agent` (A2A 1.0
JSON-RPC) and `GET /v1/a2a/agents/:agent/card` (feature `a2a-endpoint`,
`api/a2a/routes.ts`, protocol in `api/a2a/`). A request acts for a subject with
`sessions:own`; an application key without one is `400 subject_required`. An
A2A **context** is one session per subject, agent and `contextId`; an A2A
**task** is one turn, named `t1.<base64url context>.<turnId>` and always
resolved within the caller's own sessions. `SendMessage`, `GetTask` and
`CancelTask` work; the rest answer with the A2A error for them.
_Avoid_: calling the task id a session id; trusting a task id to select a
session.

**Gateway mode**: A2A through the app server: `createA2aHandler`
(`@nylorun/agents/a2a`) authenticates partners, names each one's subject, and
forwards the JSON-RPC body to the A2A endpoint with the application key. It
publishes the Agent Card with its own URL and security schemes. The Runtime
stays private.
_Avoid_: "A2A proxy"; parsing A2A messages in the app server.

## Runtime architecture

One line each; the module named is where the term lives in code.

- **Route declaration**: A Tenant or Admin route declared once with who may call it (`RouteAccess`: credentials, subject scopes, browser access), which serves it, checks subject scopes (`requireScopes`), answers its browser preflight and describes it (`api/http/define.ts`, `api/route.ts`). A path or method no route declares is `404 Route not found` once the caller is known.
- **OpenAPI document**: The Tenant API's and the Admin API's OpenAPI 3.2 descriptions, generated from the route declarations (`api/openapi.ts`): served (`/openapi.json`, `/v1/admin/openapi.json`), packed (`@nylorun/runtime/openapi.json`, `/admin-openapi.json`), attached to each release; `runtime/openapi/` is their committed snapshot.
- **Profile**: Who operates the Runtime's infrastructure, OSS or Cloud; not a code switch, since only endpoints (`host/stack-config.ts`) and the vault key differ.
- **Tenant handle**: The `TenantHandle` of the Host's open Tenant Runtime, bound to its database, basin and vault key (`tenant/types.ts`, opened by `tenant/store-pg.ts`, kept by `tenant/module.ts`).
- **Service**: What one Runtime process runs, chosen with `--service` (blueprint §19): `core` (the Tenant and Admin APIs, SSE, the stream relay), `loop` (the agent loop and the Worker endpoint) or `gates` (the Model Gate); `--role api|worker|all` is its deprecated alias (`host/stack-config.ts`). A service is not a container. _Avoid_: "role", which means a Postgres or access-policy role.
- **Packing**: Which services share a container. A local Tenant's combined packing runs `core,loop` in the `runtime` container and `gates` in the `gateway` container; core and loop may share a process, gates never joins them (`NYLORUN_PACKING`, `nylorun/src/stack/compose-file.ts`).
- **Gateway**: A local Tenant's container for the gates and keys services, and egress when sandboxes are enabled (`--service gates,keys,egress`). _Avoid_: confusing it with `gatewayModel`, an embedder's model provider.
- **Keys service**: The `keys` service (F4.2), run in the gateway's process (`--service gates,keys`): the only process that reads the vault key (`<Host root>/keys/vault-kek`). It runs the vault writes that touch a secret and signs every token, behind the `Keys` seam (`keys/keys.ts`): in process, or over HTTP (`keys/client.ts`, `POST /nylorun/v1/keys/{operation}`, `NYLORUN_KEYS_URL`). With it, a Tenant runtime never reads, creates or holds the key.
- **Tool Gate**: The gates service's routes for remote MCP servers (`/nylorun/v1/mcp/*`, `/nylorun/v1/tool-calls`) and Action deliveries (`/nylorun/v1/deliveries`), and the `ToolGate` seam the Tenant calls (`gates/tool-gate.ts`): in process, or over HTTP (`gates/tool-client.ts`). Only it holds a remote MCP connection and its credential (`gates/mcp-handler.ts`). A keyed MCP call runs once (`gates/tool-calls.ts`, the `tool_crossings` table): a re-send joins it or gets its answer, and one lost with an earlier gateway is `uncertain`. Stdio MCP servers and the sandbox tools never cross it.
- **egress-gate**: The `egress` service (F7.2, D42), run in the gateway's process on 4200 (`NYLORUN_EGRESS_LISTEN_*`): pod sandboxes' only way out, a CONNECT proxy that verifies an egress token, checks its sandbox's host epoch, and tunnels only to a host name in the spec's `network.allow` (exact or `*.suffix`) on 443 or 80 that resolves to a public address, 64 tunnels per sandbox (`gates/egress.ts`). No TLS interception, no credential injection, no events; refusals are logged.
- **Egress token**: The ES256 JWT (`typ: nylorun-egress+jwt`, `aud: nylorun-egress`) a pod's harness gets at join, naming its sandbox, host epoch and pod UID; minted with every host token (`mintEgressToken`, `tenant/host-token.ts`) and accepted only by egress-gate, as the proxy credential (`sandbox/egress-token.ts`).
- **Model Gate**: The gates service's endpoint for model calls, `POST /nylorun/v1/model-calls` (`api/gate/routes.ts`, `host/gates.ts`), and the `ModelGate` seam the loop calls (`gates/model-gate.ts`): in process (`gates/in-process.ts`) or over HTTP (`gates/http-client.ts`). Only it reads a model credential (`vault/host-model.ts`); a hop failure is a failure outcome, never an uncertain effect.
- **API node**: A Runtime process that runs the core service, serving the Tenant API, Admin API and SSE (`host/stack-config.ts`, `infra/workers.ts`).
- **Worker**: A Runtime process that runs the loop service, whose Restate endpoint runs advances and sweeps (`infra/workers.ts`, `tenant/worker.ts`).
- **Session Store**: The Tenant's durable state in the fixed schemas of its own Postgres database, behind the async `SessionStore`/`Tx` seam (`store/types.ts`, `store/postgres/`). Drizzle defines its tables (`store/postgres/schema.ts`), generates its migrations (`store/postgres/drizzle/`) and runs its queries; only `store/postgres/` imports Drizzle or the driver.
- **Migration**: One step of the Tenant database's schema: a SQL file drizzle-kit generated from `schema.ts`, or custom SQL for what it does not model (the schemas, `doc()`, the relay's publication). The Host applies the missing ones at startup under an advisory lock and records them in `nylorun.__drizzle_migrations`; a database holding one this Runtime does not ship is `schema-too-new`. The schema version is the number applied (`store/postgres/migrate.ts`).
- **Durable Session Execution**: Delivers wakes, runs at most one advance per session, and arms the Tenant sweep; Restate (`execution/types.ts`, `adapters/execution/restate.ts`).
- **Durable Streams**: One ordered, resumable stream per session plus `tenant/control`; S2 (`streams/types.ts`, `adapters/streams/s2.ts`).
- **Object store**: Where the Tenant's file bytes live, behind the `BlobStore` seam (`blob/types.ts`): the `s3` adapter over the plain S3 API (`blob/s3.ts`; RustFS in the local stack, `NYLORUN_OBJECT_STORE_*`), or the `fs` adapter under `TenantPaths.blobs` without one (`blob/fs.ts`). Tenant code reaches it as `ctx.blobs`; model-gate builds its own from the same configuration to read the files a prompt names. Postgres stays the record: a blob counts only once a committed row names its key (a file artifact's version).
- **SessionStreams**: A process's readers of Durable Streams for one open Tenant (`ctx.sessionStreams`): one `SessionStream` per observed session, and the streams wiring (`tenant/session-streams.ts`).
- **SessionStream**: The shared read of one observed session's stream in this process, followed by that session's SSE and in-process clients, each from its own next sequence (`tenant/session-streams.ts`).
- **Advance**: One run of a session's current segment under ownership: load the checkpoint, offer the segment to a harness as a run, settle what it reports (`tenant/advance.ts`). A run whose harness connection is lost keeps the lease until it lapses, so the next advance takes the session over.
- **Harness API**: The protocol between core and a harness (v1, `@nylorun/core/harness-api`, blueprint D37): requests and messages over a channel, in process by reference (or through JSON in tests), or over WebSocket (F6.2: core's listener `harness-api/ws-server.ts`, `NYLORUN_HARNESS_LISTEN_*`, accepting only `NYLORUN_HARNESS_TOKEN`; the client `harness/ws-client.ts`). A harness says `hello`, keeps a `lease` waiting, and per run sends `effect.intent`/`effect.outcome` (the Record seam), `lease.renew`, and one output (`turn.completed`, `turn.paused`, `turn.waiting`, `turn.failed`, `checkpoint` for a yield) or `lease.release`. Core sends `cancel` with the advance's abort reason, and `effect.resolved` to a run held for a pending Action. A harness readies the session's MCP servers itself (`session.mcp`) and claims its `sandbox.*` events (`event`). Not a public API: protocol 5 does not cover it.
- **Harness**: One long-running client of the Harness API that runs the engine for the runs it leases, with injected executors for model, MCP and sandbox calls (`@nylorun/harness/api`, `harness/executors.ts`). Each Tenant runs one in process (`harness-api/in-process.ts`), or none with `NYLORUN_HARNESS=remote`: harness services (`--service harness`, `harness/main.ts`, `harness/service.ts`) attach over WebSocket with their own MCP pool and SandboxManager. It reaches no store (`scripts/check-boundaries.mjs`).
- **Workspace capability**: What core does with sandbox workspaces outside a run (`ctx.sandbox`, a `WorkspacePort`, `harness-api/workspace.ts`): the sandbox tool routes, `save_artifact`'s reads, Tenant status, the sweep, a sandbox resource's deletion and a sandboxes reset. In process it is the Tenant's SandboxManager; with remote harnesses it is the `workspace.*` requests to the harness that declared `workspace` in its `hello` (`503 request_rejected` when none is connected). The SandboxManager keeps its compute records through a `SandboxRecords` port (`sandbox/records.ts`: the `sandboxes` table, or `<root>/sandboxes/records.json` in a harness, mirrored into the table from its `sandbox.state` claims and sweep answers).
- **Held run**: A run waiting in its lease for a pending Action's outcome (F6.2), at most `actionHoldMs` (default 5 minutes): the outcome reaches it as `effect.resolved` (from another process through the `action.resolved` control signal) and the segment goes on without a replay.
- **Run**: A lease on one session's segment, offered by an advance to the first waiting harness (`harness-api/server.ts`): a `runId` bound to the connection that leased it (any other gets `run_not_held`), the turn, the epoch and, from F5, a run token. Its `turn.start` carries the segment's checkpoint without the transcript, its completed outcomes and the transcript's cursor.
- **Transcript cursor**: The record `seq` of the last event that changed a session's transcript fold (`transcript.updated`, `turn.cancelled`, `turn.failed`). A harness that holds the transcript at the run's cursor resumes from its cache; otherwise it reads it once (`transcript.read`).
- **Wake**: A request, delivered at least once, that a session advance (`WakeReason` in `execution/types.ts`).
- **Ownership epoch**: The counter an advance takes with a session's lease; every write the advance makes checks it (`store/ownership.ts`).
- **Engine host**: The `DurableHost` the engine resolves effects through: over the Harness API (`@nylorun/harness/api` `apiHost`), which replays a run's recorded outcomes and asks core for the rest; core's journal is `harness-api/record.ts`, which journals each effect's intent (its request hash, a model call without its prompt) and outcome, runs Actions and flow work itself, and tells the harness to execute model, MCP and sandbox calls.
- **Record**: Every session event, written in its state transaction to Postgres `nylorun_streams.session_events` (keyed by session and seq: the database holds one Tenant), with each session's log head; Durable Streams are fed from it (`Tx.event`, `store/postgres/schema.ts`, `store/postgres/record.ts`).
- **Record module**: The one write path into the Record (`record/`, blueprint D27): it builds each event on the `nylorun.event/2` envelope, checks it against the event catalog and holds the only insert into `session_events` and `session_log_heads`, whose two statements it runs through the store's `RecordWriter` (`store/postgres/record-writer.ts`, behind the driver boundary). The store calls it from `Tx.event` under the session lock; `scripts/check-boundaries.mjs` refuses an insert anywhere else.
- **Transcript fold**: The own loop's model-facing transcript, rebuilt from the session's `transcript.updated` events (internal, never served) at each segment start; `turn.cancelled` and `turn.failed` undo their turn's edits. The session row stores the engine state without it, folding from `Session.history.from` (`tenant/history.ts`, blueprint P0.3). Tests run in shadow mode (`test/setup/transcript-shadow.ts`), which also keeps the transcript on the row and checks the fold against it.
- **Stream relay**: Feeds Durable Streams from the record, exactly once and in order per session (`matchSeq`), acknowledging the replication slot only after S2 has the events; reconciles the record with S2 after a new or lost slot. On a Host with S2 one process-wide relay reads logical replication once the Tenant is open, filling in its id (`streams/relay/`, `adapters/replication/pgoutput.ts`); otherwise the Tenant relays its own commits (`tenant/streams.ts`). The only writer of session streams.
- **Basin generation**: The Tenant's current S2 basin, from 0; a sessions reset moves to the next, so ids it frees start in an empty basin, and the old basin is deleted after a grace period (`streams/basin.ts`, `tenant/streams.ts`).
- **Sandbox resource**: A sandbox with its own id, kind (`virtual`, or `pod` with sandbox pods; see **Pod sandbox**), spec and labels (`PUT`/`GET`/`DELETE /v1/sandboxes/{id}`, `GET /v1/sandboxes?label=k=v`, the `sandbox_resources` table, `tenant/sandboxes.ts`; Host feature `sandboxes`, blueprint D39). Ids are `/`-separated segments, sent percent-encoded as one path segment. A session attaches with `PutSessionRequest.sandbox = { id }` (`Session.sandboxId`) and pins the sandbox's spec; its workspace is keyed by the sandbox id (`SandboxManager.sandboxKeyOf`), so attached sessions share files, and deleting a session (a sessions reset) only detaches it. Turns are serial per sandbox (`409 sandbox_busy`), checked with the subject token's `sbx` grants at every turn start (`checkSandboxTurn`). The Tenant holds at most `limits.sandboxes` (default 100). Lifecycle events (`sandbox.created`, `.attached`, `.detached`, `.deleted`) go to the sandbox's own stream in the record (`nylorun_streams.sandbox_events`, `record/sandbox.ts`), not relayed to S2; the session's log records `sandbox.attached`.
- **Pod sandbox** (F7.2, Host feature `sandbox-pods`, D32–D34, D36, D38, D42): a sandbox resource of kind `pod`: an agent-sandbox Sandbox on the Tenant's cluster, driven only by the sandboxes service (`sandbox/pods/client.ts`, `NYLORUN_SANDBOXES_URL`). Its lifecycle is a pure decision (`sandbox/pods/lifecycle.ts`) carried out by the `Sandbox` object's reconcile (`sandbox/pods/reconcile.ts`; Restate `NylorunSandbox`, or `MemoryExecution`), serialized per sandbox, with `idle` and `ttl` timers; the row's `desired`/`observed`/`rev`/`host_epoch` columns are its state. The pod runs the engine (`--service harness` with `NYLORUN_SANDBOX_KIND=pod`) copied from the Runtime image: it waits for its NetworkPolicy (`sandbox/pods/network-gate.ts`), exchanges its join token for a host token (`sandbox/join.ts`, `tenant/host-token.ts`, `POST /nylorun/harness/v1/host/join`), and connects to the Harness API as its sandbox's host: it alone leases the turns of sessions attached to it and serves their workspace (`local` backend). Placement (`sandbox/placement.ts`) is checked at session open: `placement_refused`, `sandbox_unavailable`; turns refuse `sandbox_lost` and `sandbox_expired`.
_Avoid_: "scope" for who shares a sandbox; the Runtime has none.
- **sbx grant**: An entry of a subject token's `sbx` claim (`POST /v1/tokens` `sandboxes`): an exact sandbox id, or a prefix ending in `/*` (`team-a/*` reaches `team-a/proj-42`, not `team-a`). A token without one reaches no sandbox; any other id is the 404 of a missing one. Application keys, with or without subject headers, reach every sandbox; changing one through a subject needs `sandboxes:write`.
- **Pinned sandbox**: The sandbox a session was opened with (`PutSessionRequest.sandbox`, or the Tenant default), resolved against the Tenant's `sandbox.config` limits and stored on the session (`Session.sandbox`). An agent session carries it as the `nylorun.sandbox` capability in its pinned manifest; sessions that share or inherit it point at the owner with `sandboxOwnerId` (`sandbox/resolve.ts`, `sandbox/session-sandbox.ts`). Sharing through `{ session }` is deprecated for clients: they share a sandbox resource; linked sessions of a flow still inherit through `sandboxOwnerId`, and a tree whose owner is attached to a sandbox resource works in that sandbox.
- **Tenant sweep**: A per-Tenant durable timer that settles lapsed deliveries, re-wakes orphaned sessions and stops idle sandboxes (`tenant/sweep.ts`).

## Terms to avoid (appear nowhere in new copy)

| Avoid | Use instead |
| --- | --- |
| project scope / global scope | Host root + Tenant + Project link |
| scopeId (as Host identity) | `hostId` |
| `--global`, `--db`, a database path variable | Host root + Tenant (CLI) |
| `/v1/host/model*` (Tenant routes) | `/v1/tenant/model*` |
| `startRuntime` / `createRuntime` | `startEphemeralRuntime` (tests) / Host entry |
| `NYLORUN_EXECUTORS_JSON`, executors, `connectAgents` | Action endpoints: `createActionHandler` and `PUT /v1/endpoints` |
| `nylorun serve` | `node dist/src/main.js` / the app's Action endpoint |
| importing `@nylorun/runtime` from a client | call the Admin or Tenant API |
| `nylorun-runtime`, the launcher, `nylorun runtime up` | the local Tenant: `nylorun start` |
| `nylorun dev`, `nylorun dev --ephemeral` | `nylorun start` once, then the project's `npm run dev` |
| `nylo tenant create\|use\|list\|current\|delete`, one installation for every project | `nylorun start` in the project: its own local Tenant and link |
| stack, `nylorun start --name`, `NYLORUN_STACK`, `~/.nylorun/stacks/`, `nylorun legacy` | local Tenant, `--tenant`, `NYLORUN_TENANT`, `~/.nylorun/tenants/` (`nylorun legacy` is removed) |
| `nylo tenant status\|reset\|endpoints` | `nylo status\|reset\|endpoints` on the linked installation |
| `tenant.sqlite`, the SQLite store | the Tenant's Postgres database (Session Store) |
| `tenant_<id>` schemas, the Tenant catalog, quarantine | one Tenant per database; a readiness cause |
| `schema_version` tables, hand-written migrations, `lockSchema` | Drizzle migrations and their journal (`store/postgres/migrate.ts`) |
| `Nylorun-Tenant` on new clients, `/v1/admin/tenants` | nothing selects the Tenant; `/v1/admin/status` names it |
| Hosted Studio, `local.nylorun.studio`, pairing | the local Tenant's Studio service and its login URL |
