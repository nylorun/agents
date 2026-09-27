# @nylorun/cli

The local `nylorun` executable. Depends on `@nylorun/agents` and `@nylorun/admin`
only among Nylorun packages. It runs the local Runtime and Studio as a Docker
Compose stack and never imports `@nylorun/runtime`. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

Prerequisites, installed by the developer (the CLI never downloads them): Node
24 or newer, and Docker with Compose v2 ([Docker
Desktop](https://www.docker.com/products/docker-desktop/),
[OrbStack](https://orbstack.dev), [Colima](https://github.com/abiosoft/colima) or
another engine). On Windows, install them inside
[WSL2](https://learn.microsoft.com/windows/wsl/install); native Windows is not
supported.

```sh
nylorun doctor                     # Node 24+, Docker, Compose v2, and the stack's health
```

## Commands

```sh
nylorun start [--no-studio]        # start the stack; print the Runtime URL and a Studio login URL
nylorun stop                       # stop the containers; keep volumes
nylorun status [--json]            # services, endpoints, Runtime health
nylorun status --env               # export lines for the linked Project
nylorun logs [service] [-f] [--tail <n>]   # postgres, restate, s2, runtime, studio
nylorun studio [--no-open]         # fresh Studio login (on the linked Project's Tenant); starts the stack if needed
nylorun reset [--yes]              # delete the stack's volumes and every Tenant
nylorun dev [entry] [--ephemeral] [--no-studio] [--no-open]
nylorun configure                  # replace the model credential on the linked Tenant
nylorun tenant current|list|use|status|reset|delete
nylorun doctor [--json]            # prerequisites and stack health
nylorun doctor sandbox [--json]    # sandbox backend via the Tenant API
```

`nylorun runtime …`, `nylorun up` and `nylorun down` were removed with the
launcher (exit 2 with the replacement). `nylorun stack <command>` still works
as a hidden alias of the commands above. `nylorun serve` remains removed.
Production `start` is `node dist/src/main.js` with `connectAgents` in the
application.

## The stack

`nylorun start` writes `compose.yaml` and `.env` (mode 0600) under
`<Host root>/stack/`, and runs the Compose project `nylorun` (override with
`NYLORUN_STACK_PROJECT`): `postgres`, `restate`, `s2`, `runtime` and `studio`.
The Runtime and Studio images are pinned by this CLI release;
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them (local builds,
CI). Ports publish on loopback only: the Runtime on `8787`, Studio on `4161`
and the Restate UI on `9070`, or free ports chosen on the first start and kept
in `.env`.

Studio has no password: the CLI asks the Studio container for a single-use
login token with the admin key (`POST /_studio/login-tokens`) and opens
`http://localhost:<port>/login?token=…`, which sets a session cookie. The
token expires after two minutes; `nylorun studio` mints a fresh one.

## `nylorun dev`

1. Starts the stack unless it is running (the `start` code path, without its
   banner).
2. Creates the Project's Tenant through `@nylorun/admin` on first run and
   writes the format-1 link and credentials; later runs check them.
3. Seeds Tenant settings from `.env`.
4. Opens Studio on the Tenant: a login URL with `next=/tenants/<tenantId>`.
   `--no-open` prints it only; `--no-studio` skips Studio.
5. Runs `tsx watch <entry>` (default `src/main.ts`) with
   `NYLORUN_RUNTIME_URL=http://localhost:<port>`, `NYLORUN_TENANT` and
   `NYLORUN_SERVER_KEY`.

Ctrl-C stops the application; the stack keeps running (`nylorun stop`).

`--ephemeral` runs the same watcher on a temporary Tenant instead of the
Project's: it is created through `@nylorun/admin` (no link or credentials are
written), seeded from `.env` with the Tenant-level fixture model
(`fixtureModel: true`; no model credential is needed or sent), opened in
Studio, and deleted with its active work cancelled when the watcher ends,
Ctrl-C included. It needs a Runtime with the `tenant-fixture-model` feature.

## Host root, Tenants and Project link

The **Host root** is `NYLORUN_HOME` or `~/.nylorun`. It is bind-mounted into the
Runtime and Studio containers, and holds `host.json` (the client-facing host
and port), `host-credentials.json` (the admin key, mode 0600), the stack files
and each Tenant's directory. Tenant data lives in the stack's Postgres, Restate
and S2 volumes. Isolation is per **Tenant**, not per Project directory.

A **Project** stores only:

- `.nylorun/link.json` — `{ format, hostUrl, hostId, tenantId }`
- `.nylorun/credentials.json` — application key and principal id (0600); no
  executor tokens
- `.nylorun/.gitignore` containing `*`

```sh
eval "$(npx nylorun status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure, including a missing Docker or Compose v2 |
| 2 | Usage error, or a removed command or flag |
| 3 | `status`: the Runtime is not answering; `stop`/`logs`: no stack yet |
| 4 | The Runtime port is held by another Host |
| 6 | `configure`: no Runtime at the linked URL |
| 7 | The stack or Studio did not become ready |
| 130 / 143 | SIGINT / SIGTERM |

Install the CLI as a **devDependency**. Generated applications keep
`@nylorun/agents` alone in production dependencies.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Docker missing or not running | Install or start Docker Desktop, OrbStack or Colima; `nylorun doctor` checks |
| Quarantined Tenant | `nylorun tenant status` shows reason and `repair` |
| `426` from the Runtime | Upgrade the CLI, or pin a matching older set |
| Port conflict | Change `NYLORUN_PORT` / `NYLORUN_STUDIO_PORT` in `<Host root>/stack/.env` |
| Logs | `nylorun logs runtime -f` |
| Studio login expired | `nylorun studio` |

See [MIGRATION.md](../MIGRATION.md).
