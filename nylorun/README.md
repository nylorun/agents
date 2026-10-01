# nylorun

Sets up and runs the local Nylorun stack: the Runtime and Studio, as a Docker
Compose stack. It needs nothing in your project; run it with `npx`:

```sh
npx nylorun up      # set up the stack on the first run, then start it
npx nylorun down    # stop it; volumes (and Tenants) are kept
```

`nylorun` only manages the stack. It never creates Tenants: create one in
Studio, or with the Runtime client, [`@nylorun/cli`](../cli/README.md) (command
`nylo`), which also links a project to it. Depends on `@nylorun/core` only
among Nylorun packages and never imports `@nylorun/runtime`. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

Prerequisites, installed by the developer (nylorun never downloads them): Node
24 or newer, and Docker with Compose v2 ([Docker
Desktop](https://www.docker.com/products/docker-desktop/),
[OrbStack](https://orbstack.dev), [Colima](https://github.com/abiosoft/colima) or
another engine). On Windows, install them inside
[WSL2](https://learn.microsoft.com/windows/wsl/install); native Windows is not
supported.

```sh
npx nylorun doctor                 # Node 24+, Docker, Compose v2, and the stack's health
```

## Commands

```sh
nylorun up|start [--no-studio] [--no-open] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset]
                                   # set up (first run) and start the stack; print the Runtime and Studio URLs; open Studio signed in
nylorun down|stop                  # stop the containers; keep volumes
nylorun status [--json]            # services, endpoints, Runtime health
nylorun logs [service] [-f] [--tail <n>]   # postgres, restate, s2, runtime, studio
nylorun studio [--no-open]         # sign a browser in to Studio (on the linked Project's Tenant); starts the stack if needed
nylorun reset [--yes]              # delete the stack's volumes and every Tenant
nylorun doctor [--json]            # prerequisites and stack health
```

`up` and `down` are the Docker Compose spellings of `start` and `stop`: `down`
stops the containers and keeps the volumes, so no Tenant data is lost.
`nylorun stack <command>` still works as a hidden alias. Commands that act on a
Tenant moved to the Runtime client and exit 2 naming the replacement:
`nylorun dev`, `nylorun tenant …`, `nylorun configure`, `nylorun status --env`
and `nylorun doctor sandbox`.

## The stack

`nylorun up` writes `compose.yaml` and `.env` (mode 0600) under
`<Host root>/stack/` on the first run and reuses them after that. It runs the
Compose project `nylorun` (override with `NYLORUN_STACK_PROJECT`): `postgres`,
`restate`, `s2`, `runtime` and `studio`. The Runtime and Studio images are
pinned by this release (`package.json` `nylorun.runtime` and `nylorun.studio`);
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them (local builds,
CI). Ports publish on loopback only: the Runtime on `8787`, Studio on `4161`
and the Restate UI on `9070`, or free ports chosen on the first start and kept
in `.env`. While the Host has no Tenant, `up` says how to create one.

`up` never downgrades the stack on its own. Every project and app on the
machine shares it, and a Runtime older than a Tenant's schema quarantines that
Tenant. `up` records the pinned Runtime version in `host.json`
(`runtimeVersion`) and exits 5 when that version is older than the one recorded
there or the one running. Update nylorun, or pass `--allow-downgrade` to start
the older Runtime anyway. With `NYLORUN_RUNTIME_IMAGE` set, the image's version
is unknown: `up` does not check it and keeps the recorded version.

`up` prints Studio as `http://localhost:<port>`. Studio has no password: in a
terminal (not in CI, and not with `--no-open`), `up` asks the Studio container
for a single-use login token with the admin key (`POST /_studio/login-tokens`)
and opens `http://localhost:<port>/login?token=…` in the browser. That sets a
session cookie for 30 days, which survives Studio restarts, so the printed URL
keeps working in that browser. The token itself is never printed unless no
browser starts. Otherwise `up` says to run `nylorun studio`, which signs a
browser in the same way; `nylorun studio --no-open` prints the login URL (it
works once, for two minutes) instead. Inside a linked project, `nylorun studio`
reads `.nylorun/link.json` (never writes it) and lands on that project's Tenant.

### Embedding Studio in a desktop app

A desktop app such as Babai Desktop can show Studio inside its own window, in
an iframe loaded from Studio's URL (`studio.url` in `nylorun status --json`).
Only exact origins listed in `NYLORUN_STUDIO_FRAME_ANCESTORS` (in
`<Host root>/stack/.env`) may frame it. The default is Babai's
`nylorun://localhost http://nylorun.localhost`; `nylorun status` lists them
under `Embeds`. While building such an app, add its dev server once with
`nylorun start --studio-embed-origin http://localhost:1420`; the list is kept
across starts until `--studio-embed-origin-reset`. Wildcards are refused.

The app's backend mints a single-use login token limited to one Tenant with
`mintStudioLoginToken` from `@nylorun/admin` (it needs the admin key), and its
page passes the token to Studio by `postMessage`. The message contract is
`@nylorun/agents/studio-embed`.

## Sandboxes

A session gets a sandbox when it is opened with one, or when the Tenant's
default names one (`PUT /v1/tenant/sandbox`). The stack runs them on the
Runtime's **virtual** backend: an emulated shell in the Runtime process, with no
extra containers. It is not a VM or container boundary.

## Host root

The **Host root** is `NYLORUN_HOME` or `~/.nylorun`. It is bind-mounted into the
Runtime and Studio containers, and holds `host.json` (the client-facing host
and port), `host-credentials.json` (the admin key, mode 0600), the stack files
and each Tenant's directory. Tenant data lives in the stack's Postgres, Restate
and S2 volumes. The stack is one per machine: every project on it shares it,
each with its own Tenant.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure, including a missing Docker or Compose v2 |
| 2 | Usage error, or a removed or moved command |
| 3 | `status`: the Runtime is not answering; `stop`/`logs`: no stack yet |
| 4 | The Runtime port is held by another Host |
| 5 | `up`/`start`/`studio`: this nylorun pins a Runtime older than the one the Host last ran or is running; update nylorun, or `up --allow-downgrade` |
| 7 | The stack or Studio did not become ready |
| 130 / 143 | SIGINT / SIGTERM |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Docker missing or not running | Install or start Docker Desktop, OrbStack or Colima; `nylorun doctor` checks |
| `426` from the Runtime | Upgrade nylorun (`npx nylorun@latest up`), or pin a matching older set |
| `Refusing to downgrade` (exit 5) | Upgrade nylorun (`npx nylorun@latest up`); `--allow-downgrade` only if you accept quarantined Tenants |
| Port conflict | Change `NYLORUN_PORT` / `NYLORUN_STUDIO_PORT` in `<Host root>/stack/.env` |
| Logs | `nylorun logs runtime -f` |
| Studio login expired | `nylorun studio` |

See [MIGRATION.md](../MIGRATION.md).
