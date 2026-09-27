# @nylorun/runtime

The independent OSS **Runtime Host** consumes `@nylorun/harness/run` and
`@nylorun/core/contracts`. Cloud installs published `@nylorun/harness` from npm
and does not import this package. Client authoring and sessions belong to
`@nylorun/agents`; Tenant lifecycle management belongs to `@nylorun/admin`.
Vocabulary: [src/CONTEXT.md](./src/CONTEXT.md).

Requires Node 24+. Build from the repository root:

```sh
npm install
npm run build --workspace @nylorun/core
npm run build --workspace @nylorun/harness
npm run build --workspace @nylorun/runtime
```

## Install and the launcher

Developers install the Runtime as a prerequisite; nothing downloads it for
them. It runs on macOS and Linux, including [WSL2](https://learn.microsoft.com/windows/wsl/install) on
Windows; on native Windows the launcher refuses with `platform_unsupported`.

```sh
node --version                            # 24 or newer
npm install --global @nylorun/runtime     # provides nylorun-runtime
nylorun-runtime --version
```

The **launcher** (`nylorun-runtime`, source in `src/launcher/`, not listed in
`exports`) starts, stops and restarts the Host on the Node it runs on, from
this package. Clients (CLI, desktop apps) find it on PATH and run it as a
process; prefer `nylorun runtime up`. A project may instead add this package
as a devDependency to pin its Runtime version; do not make it an application
production dependency. For tests and ephemeral embeds, use
`startEphemeralRuntime()` from `@nylorun/runtime/core`. See
[MIGRATION.md](../MIGRATION.md#runtime-clients-and-admin-api-breaking-beta).

Default address: loopback port `8787` (persisted in `host.json`). The Host root
is `NYLORUN_HOME` or `~/.nylorun`. Tenants live under `tenants/<tenantId>/`.

## Layout

```text
<host root>/
  host.json                 # format 1: hostId, bind, port, runtimeVersion, …
  host-state.json           # pid, url — removed on shutdown
  host-credentials.json     # adminKey (0600)
  runtime.log
  tenants/<tenantId>/       # envelope, SQLite, KEK, logs, sandboxes, …
  trash/                    # deleted Tenants
```

## HTTP surface

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /health` | none | `service: "nylorun-runtime"`, `hostId`, protocol `{min,max,features}` (includes `admin-status`), pid |
| `GET /ready` | none | Listener up and Tenant discovery finished |
| `GET /v1/admin/status` | admin key | `AdminStatusSchema`; alias `GET /v1/admin/host` |
| `/v1/admin/tenants*` | admin key | Create / list / get / delete Tenants |
| `POST /v1/admin/host/shutdown` | admin key | Launcher-private; not in `@nylorun/admin` |
| `/v1/*` Tenant routes | application or executor | Require `Nylorun-Tenant` + `Nylorun-Protocol` |

Every route checks `Host` first (`421 host_rejected`), rejects any `Origin`
(`403 origin_rejected`, no CORS headers), and rejects non-JSON bodies with
`415 unsupported_media_type`. Missing or unsupported protocol → `426` before
authentication. Unknown, quarantined or rejected Tenant credentials → opaque
`404` with identical body.

## Embedding and tests

Tests and ephemeral embeds use `startEphemeralRuntime()` from
`@nylorun/runtime/core`: private Host on port 0, temporary Host root, one Tenant,
returns `{ url, tenantId, applicationKey, adminKey, close() }`. It is not durable:
its Tenants live in memory and are gone after `close()`. `nylorun dev
--ephemeral` does not use it; it creates a temporary Tenant on the Docker stack.

Register executors with `PUT /v1/executors` using the application principal
(application-mode `connectAgents` does this with derived tokens). Model gateway
and sandbox backend are Tenant configuration (vault / seed), not Host process
env.

## Session behaviour

The session-first `/v1` API is specified in
[HOST_CONTRACT.md](../harness/HOST_CONTRACT.md). Application tokens authorize
definition/session APIs; executor credentials authorize authenticated SSE
connect, action discovery, claims, renewal and results. Session observers cannot
claim actions.

SQLite transactions persist session checkpoints, command receipts, individual
effects/actions, waits and canonical history — **per Tenant**. An advance owns
its session through a lease with an epoch; a Worker that takes over after a
crash marks in-flight effects `uncertain`. Keep the database and its WAL/journal
together. Vault ciphertext needs that Tenant's own KEK.

Agents that declare `.use(sandbox())` get Runtime-executed sandbox tools. The
Tenant owns each sandbox; backend names are prefixed `nylorun-<tenant-id>-`.

## Local Project workflow

Install `@nylorun/cli` as a devDependency. `nylorun runtime up` starts the Host
via the launcher; `nylorun dev` creates or uses a Project link and runs
`src/main.ts` under `tsx watch`. Studio is `nylorun-studio` / `npm run studio`.

```sh
eval "$(npx nylorun runtime status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `kek-missing` | Restore the Tenant KEK beside the database |
| `corrupt` / `migration-failed` / `envelope-invalid` | Follow `nylorun tenant status` repair string |
| `schema-too-new` / `host_schema_newer` | Upgrade the Host build (`nylorun runtime restart`) |
| `426 protocol_unsupported` | Upgrade clients or Host to a compatible set |
| `421 host_rejected` / `403 origin_rejected` | Call from main process / Node; loopback Host only |
| Port in use | Explicit `--port` fails closed. First setup may pick a free loopback port |
| Logs | `nylorun runtime logs [--follow]` |

Definitions have no `agent.run()`; applications use `@nylorun/agents`.
