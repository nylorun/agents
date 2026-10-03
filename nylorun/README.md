# nylorun

Sets up and runs local Nylorun stacks: the Runtime and Studio, as Docker
Compose stacks, one per project. It needs nothing in your project; run it with
`npx` in the project's directory:

```sh
npx nylorun start   # create (first run) and start this project's stack, its Tenant and the Project link
npx nylorun stop    # stop it; volumes (and the Tenant's data) are kept
```

A stack is one installation: one Runtime with its own Postgres, Restate and
S2, serving exactly one Tenant. `nylorun start` in a project creates the
project's stack, the Runtime creates the stack's Tenant on its first start,
and `nylorun start` links the project to it. There are no Tenant commands:
projects that must not share agents, credentials or history run separate
stacks. Agents, sessions and model providers belong to the Runtime client,
[`@nylorun/cli`](../cli/README.md) (command `nylo`). Depends on `@nylorun/core`
only among Nylorun packages and never imports `@nylorun/runtime`. Vocabulary:
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
nylorun up|start [--name <stack>] [--no-link] [--no-studio] [--no-open] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset]
                                   # create (first run) and start the stack; link the project; print the URLs; open Studio signed in
nylorun down|stop [--name <stack>] # stop the containers; keep volumes
nylorun status [--name <stack>] [--json]   # the stack, its Host root and Tenant, services, endpoints, Runtime health
nylorun logs [service] [--name <stack>] [-f] [--tail <n>]   # postgres, restate, s2, gateway, runtime, studio
nylorun studio [--name <stack>] [--no-open]   # sign a browser in to Studio on the stack's Tenant; starts the stack if needed
nylorun reset [--name <stack>] [--yes]        # delete the stack's volumes and Tenant directory; the next start creates a new Tenant
nylorun ls [--json]                # the stacks on this machine
nylorun delete <stack> --yes       # remove a stack: containers, volumes, Host root and vault key
nylorun legacy stop|delete [--yes] # the single stack of older releases
nylorun doctor [--json]            # prerequisites and stack health
nylorun telemetry [status|enable|disable]   # Studio's anonymous usage analytics
```

`up` and `down` are the Docker Compose spellings of `start` and `stop`: `down`
stops the containers and keeps the volumes, so no Tenant data is lost.
`nylorun stack <command>` still works as a hidden alias. Removed commands exit
2 naming the replacement: `nylorun tenant …` (`nylorun start` creates the
Tenant; `nylorun status|reset`, or `nylo status|reset|endpoints`), `nylorun
dev`, `nylorun configure`, `nylorun status --env` and `nylorun doctor sandbox`.

## Stacks

Every command acts on one stack, chosen in this order:

1. `--name <stack>`;
2. `NYLORUN_STACK`;
3. the stack in the project's link (`.nylorun/link.json`, found from the
   working directory upwards);
4. for `start` in a project only: the project directory's name, lowercased,
   with characters outside `[a-z0-9_-]` as `-`, and a suffix (`-2`, `-3`, …)
   when a stack of that name was created for another project directory.

Outside a project, `start` needs `--name`, and the other commands need
`--name`, `NYLORUN_STACK` or a linked project. `nylorun ls` lists the stacks.

Each stack has its own Host root `~/.nylorun/stacks/<name>/`, Compose project
`nylorun-<name>` (`NYLORUN_STACK_PROJECT` overrides it), volumes, network and
ports. `NYLORUN_HOME` replaces the whole Host root (the stack's name then comes
from its `stack.json`, the project directory or the Host root's own name).

A stack refuses only a Runtime older than its own database: `start` records
the pinned Runtime version in `host.json` (`runtimeVersion`) and exits 5 when
this nylorun pins an older one. Update nylorun, or pass `--allow-downgrade`
when both versions use the same database schema (otherwise the Runtime reports
the Tenant unavailable, `schema-too-new`). With `NYLORUN_RUNTIME_IMAGE` set,
the image's version is unknown: `start` does not check it and keeps the
recorded version.

## The Project link

`nylorun start` in a project waits until the stack's Tenant is open
(`/v1/admin/status`), then writes, in a `.nylorun/` directory (mode 0700, with
its own `.gitignore` of `*`):

- `link.json`: `{ "format": 2, "stack", "hostUrl", "hostId", "tenantId" }`.
  The Tenant id is information only: nothing in a request selects a Tenant.
- `credentials.json` (mode 0600): the key of the derived principal `project`,
  derived from the stack's admin key, and its id.

Later starts reuse the stack and rewrite the link only when the stack, its URL,
Host or Tenant changed (after `nylorun reset`, for example). When it writes a
new link, `start` seeds the Tenant from the project's `.env`: the sandbox
backend (`NYLORUN_SANDBOX=auto|virtual`) and the model credential
(`MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY`, `MODEL_PROVIDER_BASE_URL`,
or `.nylorun/auth.json`), unless the Tenant has a model or
`NYLORUN_DEV_MODEL=fixture`. `.env` never configures the stack itself.

A fresh clone or a second worktree has no link: `nylorun start` there creates a
new stack, or `nylorun start --name <stack>` attaches it to an existing one so
both share the stack's Tenant. `--no-link` starts a stack without linking the
working directory (scripts). A link of format 0 or 1 named a Tenant on the
shared stack of an older Runtime: `start` says so, creates the project's own
stack and replaces the link.

The Runtime registers the derived principals of `NYLORUN_DERIVED_PRINCIPALS`
(comma-separated, from the environment of `nylorun start`, kept in the stack's
`.env`) when it creates the Tenant; `project` is always among them.

## The stack

`nylorun start` writes `compose.yaml` and `.env` (mode 0600) under
`~/.nylorun/stacks/<name>/docker/` on the first run and reuses them after that: `postgres`,
`restate`, `s2`, `gateway`, `runtime` and `studio`. Postgres initialises the
stack's database with C collation. The Runtime and Studio images are pinned by
this release (`package.json` `nylorun.runtime` and `nylorun.studio`);
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them (local builds,
CI). Ports publish on loopback only: the Runtime on `8787`, its operator
listener (Admin API) on `8788`, Studio on `4161` and the Restate UI on `9070`,
or free ports chosen on the stack's first start, avoiding the ports other
stacks keep, and kept in its `.env`.

`start` prints Studio as `http://localhost:<port>`. Studio has no password: in a
terminal (not in CI, and not with `--no-open`), `start` asks the Studio container
for a single-use login token with the admin key (`POST /_studio/login-tokens`)
and opens `http://localhost:<port>/login?token=…` on the stack's Tenant in the
browser. That sets a session cookie for 30 days, which survives Studio
restarts, so the printed URL keeps working in that browser. The token itself is
never printed unless no browser starts. Otherwise `start` says to run `nylorun
studio`, which signs a browser in the same way; `nylorun studio --no-open`
prints the login URL (it works once, for two minutes) instead.

### Embedding Studio in a desktop app

A desktop app such as Babai Desktop can show Studio inside its own window, in
an iframe loaded from Studio's URL (`studio.url` in `nylorun status --json`).
Only exact origins listed in `NYLORUN_STUDIO_FRAME_ANCESTORS` (in
`~/.nylorun/stacks/<name>/docker/.env`) may frame it. The default is Babai's
`nylorun://localhost http://nylorun.localhost`; `nylorun status` lists them
under `Embeds`. While building such an app, add its dev server once with
`nylorun start --studio-embed-origin http://localhost:1420`; the list is kept
across starts until `--studio-embed-origin-reset`. Wildcards are refused.

The app's backend mints a single-use login token for the stack's Tenant with
`mintStudioLoginToken` from `@nylorun/admin` (it needs the admin key), and its
page passes the token to Studio by `postMessage`. The message contract is
`@nylorun/agents/studio-embed`.

### Telemetry

Studio reports anonymous page views to Google Analytics, so we can see which
parts of it are used. A page view carries the route's shape only: every Tenant,
agent and session id becomes `:id` (`/tenants/:id/agents/:id/sessions/:id`)
and the query is dropped. Nothing you send to agents, no names, keys or
responses, and no Google signals or ad personalization are collected. Studio
loads no analytics inside an embedding app, or when the browser sends Do Not
Track or Global Privacy Control.

It is on by default, and `nylorun start` says so the first time. Turn it off on
this machine with `nylorun telemetry disable` (kept in
`~/.nylorun/telemetry.json`), or for one start with `NYLORUN_TELEMETRY_DISABLED=1`
or `DO_NOT_TRACK=1`. It is always off when `CI` is set. `nylorun start` decides
on every start and writes the result to `NYLORUN_STUDIO_ANALYTICS_ID` in
`docker/.env` (empty when off); `nylorun telemetry` reports the current choice.

## Sandboxes

A session gets a sandbox when it is opened with one, or when the Tenant's
default names one (`PUT /v1/tenant/sandbox`). The stack runs them on the
Runtime's **virtual** backend: an emulated shell in the Runtime process, with no
extra containers. It is not a VM or container boundary.

## Host root

The **Host root** is `~/.nylorun/stacks/<name>/`, or `NYLORUN_HOME`. It is
bind-mounted into the Runtime and Studio containers, and holds `stack.json`
(the stack's name and the project it was created for), `host.json` (the
client-facing host and port), `host-credentials.json` (the admin key, mode
0600), the Docker Compose files in `docker/`, the Tenant directory `tenant/` (homes, logs) and
`keys/vault-kek`, the Tenant's vault key, which only the gateway container
mounts. The Tenant's data lives in the stack's Postgres, Restate and S2
volumes.

`nylorun reset` deletes the selected stack's volumes, `tenant/` and `keys/`, and keeps
its files and ports; the next start creates a new Tenant and relinks the
project. `nylorun delete <stack> --yes` removes the stack's containers,
volumes and Host root: the vault key (KEK) and all the Tenant's data go with it.

## Upgrading from a shared stack

Older releases ran one stack per machine (Compose project `nylorun`, Host root
`~/.nylorun`) with a Tenant per project. This release starts fresh and leaves
that stack as it is: `nylorun start` mentions it once, and `nylorun ls` shows
it. `nylorun legacy stop` stops it; `nylorun legacy delete --yes` removes its
containers, volumes and files under `~/.nylorun` (never `~/.nylorun/stacks`).
Model credentials come from each project's `.env` (or Studio), and agents
register again (`npm run dev`). See [MIGRATION.md](../MIGRATION.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure, including a missing Docker or Compose v2 |
| 2 | Usage error (including no stack selected, or `delete` without `--yes`), or a removed or moved command |
| 3 | `status`: the Runtime is not answering; `stop`/`logs`: no stack yet; `delete`: no such stack |
| 4 | The Runtime port is held by another Host |
| 5 | `up`/`start`/`studio`: this nylorun pins a Runtime older than the one that last ran the stack; update nylorun, or `start --allow-downgrade` |
| 7 | The stack, its Tenant or Studio did not become ready (an unavailable Tenant's cause is printed) |
| 130 / 143 | SIGINT / SIGTERM |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Docker missing or not running | Install or start Docker Desktop, OrbStack or Colima; `nylorun doctor` checks |
| `426` from the Runtime | Upgrade nylorun (`npx nylorun@latest start`), or pin a matching older set |
| `Refusing to start Runtime …` (exit 5) | Upgrade nylorun (`npx nylorun@latest start`); `--allow-downgrade` only when both Runtimes share the database schema |
| `The Tenant of stack … is unavailable` (exit 7) | Follow the repair it names; `nylorun logs runtime` |
| Port conflict | Change `NYLORUN_PORT` / `NYLORUN_STUDIO_PORT` in `~/.nylorun/stacks/<name>/docker/.env` |
| Logs | `nylorun logs runtime -f` |
| Studio login expired | `nylorun studio` |

See [MIGRATION.md](../MIGRATION.md).
