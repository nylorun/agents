# Runtime Clients vocabulary

Terms follow the Runtime Tenants model plus Runtime Clients and Admin API
(version 1). Every agent uses these terms in code, comments, errors and CLI
output.

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
`nylorun start` on a developer machine. `@nylorun/runtime` is a library with no
bin; the Runtime runs as the `ghcr.io/nylorun/runtime` image.
_Avoid_: "native Host", or installing `@nylorun/runtime` globally.

**Prerequisites**: What a developer installs before using the Runtime: Node 24
or newer and Docker, on macOS or Linux; Windows developers use WSL2. A missing
prerequisite is an error naming what to install.
_Avoid_: "bootstrap" for installing the Runtime.

**Local Host settings**: `host.json` and `host-credentials.json` in the Host
root. `@nylorun/admin` reads them for local connection resolution.

**Runtime Host** (or **Host**): The long-lived process that binds one address,
discovers Tenants under its Host root (`NYLORUN_HOME` or `~/.nylorun`), validates
`Nylorun-Protocol` and `Nylorun-Tenant`, serves admin routes, and forwards Tenant
routes to the matching Tenant Runtime. `/health` reports `service: "nylorun-runtime"`,
`hostId` and protocol range; `/ready` is true only after discovery has finished.
Tenant data is a Postgres schema per Tenant; the Host keeps each Tenant's key,
plugin data and logs under `tenants/`. `nylorun start` writes `host.json` and
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
`trash/`. Resolved once from `NYLORUN_HOME` or `~/.nylorun`. The Runtime itself
is installed by npm, not under the Host root.

**Project link**: Project-local `.nylorun/link.json` with
`{ format, hostUrl, hostId, tenantId }`, plus `.nylorun/credentials.json`
(mode 0600) holding the application key and principal id. Format `0` (missing
`format`) may still contain an `executors` map; version 1 ignores it and drops
it on write. A fresh clone or second worktree does not attach until it creates
or chooses a link.
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
`HOST_PROTOCOL` (`PROTOCOL_VERSION = 2`, features include `runtime-tenants` and
`admin-status`). Independent of package semver. Incompatible clients receive
`426` before authentication.
_Avoid_: treating package-version equality as the compatibility check.

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
