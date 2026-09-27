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

## Running the Runtime

The Runtime runs as the `ghcr.io/nylorun/runtime` image, next to Postgres,
Restate and S2: `nylorun start` runs that stack on a developer machine. The
package is a library with no bin; its Host entry is `@nylorun/runtime/server`
(`dist/host/main.js`), which requires `NYLORUN_DATABASE_URL`. For tests and
ephemeral embeds, use `startEphemeralRuntime()` from `@nylorun/runtime/core`.
See [MIGRATION.md](../MIGRATION.md).

The Host root is `NYLORUN_HOME` or `~/.nylorun`. Each Tenant's data is the
Postgres schema `tenant_<id>`; what stays on the Host is under
`tenants/<tenantId>/`.

## Layout

```text
<host root>/
  host.json                 # format 1: hostId, bind, port, runtimeVersion, …
  host-credentials.json     # adminKey (0600)
  tenants/<tenantId>/       # vault-kek, plugin-data, logs, home, tmp, sandboxes
  trash/                    # SQLite Tenants from before the Postgres switch
```

## HTTP surface

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /health` | none | `service: "nylorun-runtime"`, `hostId`, protocol `{min,max,features}` (includes `admin-status`), pid |
| `GET /ready` | none | Listener up and Tenant discovery finished |
| `GET /v1/admin/status` | admin key | `AdminStatusSchema`; alias `GET /v1/admin/host` |
| `/v1/admin/tenants*` | admin key | Create / list / get / delete Tenants |
| `POST /v1/admin/host/shutdown` | admin key | Host-private; not in `@nylorun/admin` |
| `/v1/*` Tenant routes | application or executor | Require `Nylorun-Tenant` + `Nylorun-Protocol` |

Every route checks `Host` first (`421 host_rejected`), rejects any `Origin`
(`403 origin_rejected`, no CORS headers), and rejects non-JSON bodies with
`415 unsupported_media_type`. Missing or unsupported protocol → `426` before
authentication. Unknown, quarantined or rejected Tenant credentials → opaque
`404` with identical body.

## Embedding and tests

Tests and ephemeral embeds use `startEphemeralRuntime()` from
`@nylorun/runtime/core`: private Host on port 0, temporary Host root, one Tenant,
returns `{ url, tenantId, applicationKey, adminKey, close() }`.

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

Postgres transactions persist session checkpoints, command receipts, individual
effects/actions, waits and the event outbox — **per Tenant schema**; history is
read from Durable Streams (S2). An advance owns its session through a lease with
an epoch; a Worker that takes over after a crash marks in-flight effects
`uncertain`. Vault ciphertext needs that Tenant's own KEK.

Agents that declare `.use(sandbox())` get Runtime-executed sandbox tools. The
Tenant owns each sandbox; backend names are prefixed `nylorun-<tenant-id>-`.

## Local Project workflow

Install `@nylorun/cli` as a devDependency. `nylorun start` runs the local
stack (Docker); `nylorun dev` creates or uses a Project link and runs
`src/main.ts` under `tsx watch`; `nylorun studio` opens Studio.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `kek-missing` | Restore `vault-kek` in the Tenant directory |
| `corrupt` / `migration-failed` / `envelope-invalid` | Follow `nylorun tenant status` repair string |
| `schema-too-new` | Run a Runtime at least as new as the one that migrated the schema |
| `426 protocol_unsupported` | Upgrade clients or Host to a compatible set |
| `421 host_rejected` / `403 origin_rejected` | Call from main process / Node; loopback Host only |
| Port in use | Explicit `--port` fails closed. First setup may pick a free loopback port |
| Logs | `nylorun logs` |

Definitions have no `agent.run()`; applications use `@nylorun/agents`.
