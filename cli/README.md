# @nylorun/cli

The Runtime client, command `nylo`: it acts on the one Tenant of an
installation, a local Tenant or any Runtime reachable by URL and key. Setting up
and running local Tenants is [`nylorun`](../nylorun/README.md)'s job; the two
packages are independent and never call each other. Depends on
`@nylorun/agents` and `@nylorun/admin` only among Nylorun packages. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

```sh
npx nylorun start                     # in the project: its Tenant and the Project link
npx @nylorun/cli status               # the linked Tenant
```

## Commands

```sh
nylo status [--json]                  # the Tenant, its checks and counts
nylo reset [--sessions|--sandboxes|--all] [--yes]
nylo endpoints [--json]|ping <agent>  # the registered Action endpoints and their health
nylo access …                         # access policy, publishable and signing keys, subject tokens
nylo configure                        # set or replace the Tenant's model provider
nylo env                              # export lines for the linked Project
nylo doctor sandbox [--json]          # sandbox backend via the Tenant API
```

Every command acts on the linked installation: the Project link and
credentials (below), or `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY` when the
Project has no link. An installation serves one Tenant, so nothing selects it.

Local Tenant commands (`up`, `down`, `start`, `stop`, `logs`, `studio`) exit 2
naming `npx nylorun <command>`. `nylo tenant …` exits 2: `npx nylorun start`
creates the project's Tenant and the link, and `nylo status|reset|endpoints`
replace `nylo tenant status|reset|endpoints`. `nylorun dev` was removed: run
`npx nylorun start` once, then the project's own `npm run dev`
(`tsx watch src/main.ts`).

## `nylo status`

Reads the Tenant API status (`GET /v1/tenant`) and prints the Tenant, the
Runtime URL, the checks, the counts and the sandbox
backend. When the Tenant is not open it does not answer; `nylo status` then
asks the Admin API (`/v1/admin/status`, through the local Tenant's Host root or
`NYLORUN_ADMIN_URL` and `NYLORUN_ADMIN_KEY`) and prints why, with the repair.

## `nylo reset`

Clears the Tenant's sessions (the default), its sandboxes, or all its data
(`--all`), after draining work in flight. `--all` asks first; pass `--yes` when
not in a terminal. The Project link and credentials are kept.

## Project link

`npx nylorun start` writes it; `nylo` only reads it. A **Project** stores only:

- `.nylorun/link.json`: `{ format: 3, tenant, hostUrl, hostId, tenantId }`
  (`tenant` is the local Tenant's name; `tenantId` is information)
- `.nylorun/credentials.json`: the key of the derived principal `project` and
  its id (0600)
- `.nylorun/.gitignore` containing `*`

A link from an older nylorun (format 0 to 2): `nylo` refuses it and says to run
`npx nylorun start`, which links the project again.

`createActionHandler` and `createClient` in `@nylorun/agents` read the link (or
the two variables), so the project's `npm run dev` and `npm start` need no
Nylorun tool.

```sh
eval "$(npx @nylorun/cli env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure |
| 2 | Usage error, or a moved or removed command |
| 6 | No Runtime at the linked or local URL |
| 130 / 143 | SIGINT / SIGTERM |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No Runtime answers | `npx nylorun start`, then `npx nylorun status` |
| Tenant not open | `nylo status` shows the cause and its `repair` |
| Old Project link refused | `npx nylorun start` in the project |
| `426` from the Runtime | Upgrade the CLI, or pin a matching older set |

See [MIGRATION.md](../MIGRATION.md).
