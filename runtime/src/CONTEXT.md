# Runtime Clients vocabulary

Terms follow the Runtime Tenants model, Runtime Clients and Admin API
(version 1), and the Runtime architecture (Postgres, Restate, S2). Every agent
uses these terms in code, comments, errors and CLI output.

Agent definitions describe capabilities. The harness engine advances execution.
A **Runtime Host** listens once and routes work into isolated **Tenants**. A
developer **Project** attaches through a **Project link**, not by owning the
Host process or its storage. Every process that talks to a Runtime is a
**Client**.

## Language

**Client**: Any process that talks to a Runtime over HTTP — a developer
application, Studio, the CLI, a desktop app, an IDE extension or CI.
_Avoid_: calling only the SDK or only the CLI "the client".

**Tenant API**: Every route a Tenant principal calls, identified by the
`Nylorun-Tenant` header. Agents, sessions, events, executors, vaults, Tenant
settings and status. Client package: `@nylorun/agents`.
_Avoid_: "SDK API" or "application API" as the surface name.

**Admin API**: The `/v1/admin/tenants` and `/v1/admin/status` routes, called
with an admin key. Shared by OSS and Cloud. Client package: `@nylorun/admin`.
`POST /v1/admin/host/shutdown` is Host-private on OSS and is not part of
this surface.
_Avoid_: treating Host shutdown as a shared Admin API method.

**Client package**: `@nylorun/agents` or `@nylorun/admin` — a library a client
imports to call one surface. Each depends only on `@nylorun/core`.
_Avoid_: depending on `runtime` or `harness` from application code.

**Local stack**: The Runtime image with Postgres, Restate and S2, run by
`nylorun up` (the `nylorun` package) on a developer machine. It never creates
Tenants; `@nylorun/cli` (`nylo`) and Studio do. `@nylorun/runtime` is a library with no
bin; the Runtime runs as the `ghcr.io/nylorun/runtime` image.
_Avoid_: "native Host", or installing `@nylorun/runtime` globally.

**Prerequisites**: What a developer installs before using the Runtime: Node 24
or newer and Docker, on macOS or Linux; Windows developers use WSL2. A missing
prerequisite is an error naming what to install.
_Avoid_: "bootstrap" for installing the Runtime.

**Local Host settings**: `host.json` and `host-credentials.json` in the Host
root. `@nylorun/admin` reads them for local connection resolution.

**Runtime Host** (or **Host**): The code in every Runtime process that listens,
validates `Nylorun-Protocol` and `Nylorun-Tenant`, serves admin routes, and
forwards Tenant routes to the matching Tenant Runtime, opening it on demand
(`host/create-host.ts`). `/health` reports `service: "nylorun-runtime"`,
`hostId` and protocol range; `/ready` reports Postgres, Restate and S2
(`infra/readiness.ts`). Tenant data is a Postgres schema per Tenant; the Host
keeps each Tenant's key, plugin data and logs under `tenants/` in its Host root
(`NYLORUN_HOME` or `~/.nylorun`). `nylorun up` writes `host.json` and
`host-credentials.json`.
_Avoid_: calling the Host a "scope", "project Runtime", or "global Runtime".

**Tenant**: One isolated unit of sessions, principals, vault, sandboxes, plugin
data and logs: the Postgres schema `tenant_<id>` and the Tenant directory
`<host root>/tenants/<tenantId>/`. Selected only by the
`Nylorun-Tenant` header (never by a default, query string or body field). Ids
match `tn_` plus 26 Crockford characters. Quarantine leaves other Tenants
running.
_Avoid_: "scope" or "database" as the name for this unit.

**Tenant Runtime**: The in-process handler for one open Tenant. Created from a
`TenantConfig` (paths, model, sandbox, child env, logger). It authenticates its
own principals and never reads ambient environment, cwd, or home.
_Avoid_: equating "Runtime" alone with a single Project's process.

**Host root**: The absolute directory that holds Host files, `tenants/`, and
`trash/`. Resolved once from `NYLORUN_HOME` or `~/.nylorun`. The local stack
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
table. Authorizes definition and session routes for that Tenant only.
_Avoid_: "server token" / `serverToken` as the public name (legacy API).

**Executor principal**: Bearer credential hashed in the Tenant `executors`
table, scoped to an `agentId`. Never equal to an application principal hash.
Version 1 derives the token from the application key (HMAC); nothing stores it.
_Avoid_: startup env registration of executors (removed); persisting random
executor tokens in Project credentials.

**Admin key**: Host-level secret in `host-credentials.json` (mode 0600).
Authorizes `/v1/admin/*` only; never accepted as a Tenant bearer.

**Protocol**: Wire integer and feature set in `Nylorun-Protocol` /
`HOST_PROTOCOL` (`PROTOCOL_VERSION = 2`; required features `runtime-tenants`,
`admin-status` and `studio-principal`; optional Host features
`tenant-fixture-model`, `transcript-events` and `derived-principals`).
Independent of package semver. Incompatible clients receive `426` before
authentication. A client that uses an optional feature checks `/health` first.
_Avoid_: treating package-version equality as the compatibility check.

**Studio principal**: Application principal `studio` that every Tenant created
by `@nylorun/admin` registers. Its key is derived from the admin key and the
Tenant id (`deriveStudioToken`, `admin/src/derived-credentials.ts`); the Tenant
stores only its hash (`tenant/principals.ts`). Studio derives it to call the
Tenant API; the admin key is never a Tenant bearer.

**Derived principal**: Application principal, named by its client (`babai`),
whose key is derived from the admin key, the principal id and the Tenant id
(`deriveTenantKey`, `admin/src/derived-credentials.ts`). Registered by hash when
the Tenant is created (`derivedPrincipals`, feature `derived-principals`), so
the client stores no key. The Studio principal is the first of these, with its
own derivation.
_Avoid_: storing an application key on a machine that already holds the admin
key.

**Transcript event**: A session event a chat UI renders (feature
`transcript-events`): `message.assistant` for each completed model step (text
and tool calls, keyed by the model's `invocationId` and each call's `callId`),
`tool.completed` for an MCP or sandbox tool, and the `callId` on tool
`action.*` and `delegation.*` events. Written in the transaction that completes
the effect, so a replay writes nothing (`tenant/transcript.ts`); payload
schemas and `parseTranscriptEvent` are in `@nylorun/core/contracts`.
`@nylorun/agents/ag-ui` turns them into AG-UI events.
_Avoid_: rebuilding a chat from `turn.completed` output or from `actionId`
formats.

## Runtime architecture

One line each; the module named is where the term lives in code.

- **Profile**: Who operates the Runtime's infrastructure, OSS or Cloud; not a code switch, since only endpoints (`host/stack-config.ts`) and the vault key differ.
- **Tenant handle**: The `TenantHandle` of one open Tenant Runtime, bound to its schema, basin and vault key (`tenant/types.ts`, opened by `tenant/store-pg.ts`).
- **API node**: A Runtime process with `--role api` or `all` serving the Tenant API, Admin API and SSE (`host/stack-config.ts`, `infra/workers.ts`).
- **Worker**: A Runtime process with `--role worker` or `all` whose Restate endpoint runs advances and sweeps (`infra/workers.ts`, `tenant/worker.ts`).
- **Session Store**: A Tenant's durable state in its Postgres schema, behind the async `SessionStore`/`Tx` seam (`store/types.ts`, `store/postgres/`).
- **Durable Session Execution**: Delivers wakes, runs at most one advance per session, and arms the Tenant sweep; Restate (`execution/types.ts`, `adapters/execution/restate.ts`).
- **Durable Streams**: One ordered, resumable stream per session plus `tenant/work` and `tenant/control`; S2 (`streams/types.ts`, `adapters/streams/s2.ts`).
- **Advance**: One run of a session's current segment under ownership: load the checkpoint, run the engine, settle (`tenant/advance.ts`).
- **Wake**: A request, delivered at least once, that a session advance (`WakeReason` in `execution/types.ts`).
- **Ownership epoch**: The counter an advance takes with a session's lease; every write the advance makes checks it (`store/ownership.ts`).
- **Engine host**: `resolveEffect`, which journals each effect's intent and outcome and dispatches it by kind (`tenant/effects.ts`).
- **Outbox**: Session Store rows holding events committed but not yet in Durable Streams (`OutboxRow` in `store/types.ts`).
- **Relay**: Appends outbox rows to their session's stream in order and deletes them once S2 has them; the only writer of events (`streams/relay.ts`).
- **Tenant sweep**: A per-Tenant durable timer that expires claims, re-wakes orphaned sessions, drains the outbox and stops idle sandboxes (`tenant/sweep.ts`).
- **Stream incarnation**: The id in a session's stream name `sessions/<id>/<incarnation>`, new each time a session id is created (`streams/types.ts`, `tenant/streams.ts`).

## Terms to avoid (appear nowhere in new copy)

| Avoid | Use instead |
| --- | --- |
| project scope / global scope | Host root + Tenant + Project link |
| scopeId (as Host identity) | `hostId` |
| `--global`, `--db`, a database path variable | Host root + Tenant (CLI) |
| `/v1/host/model*` (Tenant routes) | `/v1/tenant/model*` |
| `startRuntime` / `createRuntime` | `startEphemeralRuntime` (tests) / Host entry |
| `NYLORUN_EXECUTORS_JSON` | `PUT /v1/executors` with application credential |
| `nylorun serve` | `node dist/src/main.js` / `connectAgents` entry |
| importing `@nylorun/runtime` from a client | call the Admin or Tenant API |
| storing executor tokens in the Project | derived executor credentials |
| `nylorun-runtime`, the launcher, `nylorun runtime up` | the local stack: `nylorun up` |
| `nylorun dev`, `nylorun dev --ephemeral` | `nylo tenant create` once, then the project's `npm run dev` |
| `tenant.sqlite`, the SQLite store | the Tenant's Postgres schema (Session Store) |
| Hosted Studio, `local.nylorun.studio`, pairing | the stack's Studio service and its login URL |
