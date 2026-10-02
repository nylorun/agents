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

**Local stack**: The Runtime image with Postgres, Restate and S2, run by
`nylorun up` (the `nylorun` package) on a developer machine: one installation. Its
Runtime creates the stack's one Tenant on first start. `@nylorun/runtime` is a library
with no bin; the Runtime runs as the `ghcr.io/nylorun/runtime` image.
_Avoid_: "native Host", or installing `@nylorun/runtime` globally.

**Prerequisites**: What a developer installs before using the Runtime: Node 24
or newer and Docker, on macOS or Linux; Windows developers use WSL2. A missing
prerequisite is an error naming what to install.
_Avoid_: "bootstrap" for installing the Runtime.

**Local Host settings**: `host.json` and `host-credentials.json` in the Host
root. `@nylorun/admin` reads them for local connection resolution: `port` is
the Tenant API, `adminPort` (when present) the operator listener.

**Public listener** / **Operator listener**: With an operator listener
(`adminPort` in host.json, or `NYLORUN_ADMIN_LISTEN_PORT` in a container; the
stack's is container port 4001, published on loopback as `NYLORUN_ADMIN_PORT`),
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
key, plugin data and logs under `tenant/` in its Host root (`NYLORUN_HOME` or
`~/.nylorun`). `nylorun up` writes `host.json` and `host-credentials.json`.
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

**Host root**: The absolute directory that holds Host files and the Tenant directory
`tenant/`. Resolved once from `NYLORUN_HOME` or `~/.nylorun`. The local stack
bind-mounts it into the Runtime container at `/nylorun`.

**Project link**: Project-local `.nylorun/link.json` with
`{ format, hostUrl, hostId, tenantId }`, plus `.nylorun/credentials.json`
(mode 0600) holding the application key and principal id. Format `0` (missing
`format`) may still contain an `executors` map; version 1 ignores it and drops
it on write. `nylo tenant create` writes it; `nylo tenant use` chooses another
Tenant. A fresh clone or second worktree does not attach until it creates or
chooses a link.
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
`vaults:own`, `tenant:settings` (`SUBJECT_SCOPES`). Each route declares
the scopes that allow it (`RouteAccess`, `api/http/define.ts`), decided from the route alone before any
lookup (`403 scope_required`); reset, config seed, endpoints, actions, the
sandbox tool routes, `/v1/tokens` and `/v1/access/**` are open to no subject.
A subject token carries only `TOKEN_SCOPES` (`agents:read`, `sessions:own`,
`vaults:own`).

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
(`browserAccess`; `NYLORUN_BROWSER_ACCESS`, on in the stack). The Host answers
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

**Protocol**: Wire integer and feature set in `Nylorun-Protocol` /
`HOST_PROTOCOL` (`PROTOCOL_VERSION = 5`; the Host serves 4 and 5; required features
`admin-status`, `studio-principal` and `action-endpoints`, and the Host still advertises
`runtime-tenants` for protocol 4 clients; optional Host features
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
- **Packing**: Which services share a container. The local stack's combined packing runs `core,loop` in the `runtime` container and `gates` in the `gateway` container; core and loop may share a process, gates never joins them (`NYLORUN_PACKING`, `nylorun/src/stack/compose-file.ts`).
- **Gateway**: The local stack's container for the gates service (and, in later releases, egress and keys). _Avoid_: confusing it with `gatewayModel`, an embedder's model provider.
- **Model Gate**: The gates service's endpoint for model calls, `POST /nylorun/v1/model-calls` (`api/gate/routes.ts`, `host/gates.ts`), and the `ModelGate` seam the loop calls (`gates/model-gate.ts`): in process (`gates/in-process.ts`) or over HTTP (`gates/http-client.ts`). Only it reads a model credential (`vault/host-model.ts`); a hop failure is a failure outcome, never an uncertain effect.
- **API node**: A Runtime process that runs the core service, serving the Tenant API, Admin API and SSE (`host/stack-config.ts`, `infra/workers.ts`).
- **Worker**: A Runtime process that runs the loop service, whose Restate endpoint runs advances and sweeps (`infra/workers.ts`, `tenant/worker.ts`).
- **Session Store**: The Tenant's durable state in the fixed schemas of its own Postgres database, behind the async `SessionStore`/`Tx` seam (`store/types.ts`, `store/postgres/`).
- **Durable Session Execution**: Delivers wakes, runs at most one advance per session, and arms the Tenant sweep; Restate (`execution/types.ts`, `adapters/execution/restate.ts`).
- **Durable Streams**: One ordered, resumable stream per session plus `tenant/control`; S2 (`streams/types.ts`, `adapters/streams/s2.ts`).
- **SessionStreams**: A process's readers of Durable Streams for one open Tenant (`ctx.sessionStreams`): one `SessionStream` per observed session, and the streams wiring (`tenant/session-streams.ts`).
- **SessionStream**: The shared read of one observed session's stream in this process, followed by that session's SSE and in-process clients, each from its own next sequence (`tenant/session-streams.ts`).
- **Advance**: One run of a session's current segment under ownership: load the checkpoint, run the engine, settle (`tenant/advance.ts`).
- **Wake**: A request, delivered at least once, that a session advance (`WakeReason` in `execution/types.ts`).
- **Ownership epoch**: The counter an advance takes with a session's lease; every write the advance makes checks it (`store/ownership.ts`).
- **Engine host**: `resolveEffect`, which journals each effect's intent and outcome and dispatches it by kind (`tenant/effects.ts`).
- **Record**: Every session event, written in its state transaction to Postgres `nylorun_streams.session_events` (keyed by session and seq: the database holds one Tenant), with each session's log head; Durable Streams are fed from it (`Tx.event`, `store/postgres/migrations/shared/`).
- **Record module**: The one write path into the Record (`record/`, blueprint D27): it builds each event on the `nylorun.event/2` envelope, checks it against the event catalog and holds the only insert into `session_events` and `session_log_heads`. The store calls it from `Tx.event` under the session lock; `scripts/check-boundaries.mjs` refuses an insert anywhere else.
- **Transcript fold**: The own loop's model-facing transcript, rebuilt from the session's `transcript.updated` events (internal, never served) at each segment start; `turn.cancelled` and `turn.failed` undo their turn's edits. The session row stores the engine state without it, folding from `Session.history.from` (`tenant/history.ts`, blueprint P0.3). Tests run in shadow mode (`test/setup/transcript-shadow.ts`), which also keeps the transcript on the row and checks the fold against it.
- **Stream relay**: Feeds Durable Streams from the record, exactly once and in order per session (`matchSeq`), acknowledging the replication slot only after S2 has the events; reconciles the record with S2 after a new or lost slot. On a Host with S2 one process-wide relay reads logical replication once the Tenant is open, filling in its id (`streams/relay/`, `adapters/replication/pgoutput.ts`); otherwise the Tenant relays its own commits (`tenant/streams.ts`). The only writer of session streams.
- **Basin generation**: The Tenant's current S2 basin, from 0; a sessions reset moves to the next, so ids it frees start in an empty basin, and the old basin is deleted after a grace period (`streams/basin.ts`, `tenant/streams.ts`).
- **Pinned sandbox**: The sandbox a session was opened with (`PutSessionRequest.sandbox`, or the Tenant default), resolved against the Tenant's `sandbox.config` limits and stored on the session (`Session.sandbox`). An agent session carries it as the `nylorun.sandbox` capability in its pinned manifest; sessions that share or inherit it point at the owner with `sandboxOwnerId` (`sandbox/resolve.ts`, `sandbox/session-sandbox.ts`).
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
| `nylorun-runtime`, the launcher, `nylorun runtime up` | the local stack: `nylorun up` |
| `nylorun dev`, `nylorun dev --ephemeral` | `nylo tenant create` once, then the project's `npm run dev` |
| `tenant.sqlite`, the SQLite store | the Tenant's Postgres database (Session Store) |
| `tenant_<id>` schemas, the Tenant catalog, quarantine | one Tenant per database; a readiness cause |
| `Nylorun-Tenant` on new clients, `/v1/admin/tenants` | nothing selects the Tenant; `/v1/admin/status` names it |
| Hosted Studio, `local.nylorun.studio`, pairing | the stack's Studio service and its login URL |
