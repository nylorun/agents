# nylorun

Sets up and runs local Nylorun Tenants: the Runtime and Studio, in Docker
Compose, one Tenant per project. It needs nothing in your project; run it with
`npx` in the project's directory:

```sh
npx nylorun start   # create (first run) and start this project's Tenant, and the Project link
npx nylorun stop    # stop it; volumes (and the Tenant's data) are kept
```

A local Tenant is one installation: one Runtime with its own Postgres, Restate
and S2, serving exactly that Tenant, and its name is the Tenant's name.
`nylorun start` in a project creates the project's Tenant (the Runtime creates
it on its first start) and links the project to it; anywhere else, it starts
the Tenant `default`. Projects that must not share agents, credentials or
history run separate Tenants. Agents, sessions and model providers belong to
the Runtime client, [`@nylorun/cli`](../cli/README.md) (command `nylo`).
Depends on `@nylorun/core` only among Nylorun packages and never imports
`@nylorun/runtime`. Vocabulary: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

Prerequisites, installed by the developer (nylorun never downloads them): Node
24 or newer, and Docker with Compose v2 ([Docker
Desktop](https://www.docker.com/products/docker-desktop/),
[OrbStack](https://orbstack.dev), [Colima](https://github.com/abiosoft/colima) or
another engine). On Windows, install them inside
[WSL2](https://learn.microsoft.com/windows/wsl/install); native Windows is not
supported.

```sh
npx nylorun doctor                 # Node 24+, Docker, Compose v2, and the Tenant's health
```

## Commands

```sh
nylorun up|start [--tenant <name>] [--no-link] [--no-studio] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset] [--restate-ui]
                                   # create (first run) and start the Tenant; link the project; print the URLs
                                   # --restate-ui (or NYLORUN_RESTATE_UI=1): publish Restate's UI on loopback for this start
nylorun down|stop [--tenant <name> | --all]   # stop the containers (--all: every Tenant's); keep volumes
nylorun status [--tenant <name>] [--json]   # the Tenant, its Host root and id, services, endpoints, Runtime health
nylorun logs [service] [--tenant <name>] [-f] [--tail <n>]   # postgres, restate, s2-lite, rustfs, gateway, runtime, harness, studio, sandboxes
nylorun studio [--tenant <name>] [--no-open]   # sign a browser in to Studio on the Tenant; starts it if needed
nylorun reset [--tenant <name>] [--yes]        # delete the Tenant's volumes, Tenant directory and vault key; the next start creates it anew
nylorun ls [--json]                # the Tenants on this machine, with their state, memory and URLs
nylorun delete <tenant> --yes      # remove a Tenant: containers, volumes, Host root and vault key
nylorun sandbox ls [--tenant <name>] [--label <key=value>]... [--json]   # the running Tenant's sandboxes
nylorun sandbox rm <id> [--tenant <name>]   # delete a sandbox and its files
nylorun key put <id> [--tenant <name>]      # create or rotate the Tenant's operator key <id>; prints it once
nylorun key list [--tenant <name>] [--json] # the Tenant's keys: id, role, when issued
nylorun key rm <id> [--tenant <name>]       # delete a key: it stops working at once
nylorun mcp connect <url> --server <name> [--vault <id>] [--client-id <id>] [--tenant <name>] [--no-open]   # sign the Tenant in to a remote MCP server with OAuth
nylorun doctor [--json]            # prerequisites and the Tenant's health
nylorun telemetry [status|enable|disable]   # Studio's anonymous usage analytics
nylorun sandbox enable --context <name> [--tenant <name>] [--host-address <ip>] [--bind-address <ip>] [--no-pull]
nylorun sandbox disable [--tenant <name>] [--delete-namespace]
nylorun sandbox status [--tenant <name>] [--json]   # pods on a Kubernetes context (see Sandboxes)
```

`up` and `down` are the Docker Compose spellings of `start` and `stop`: `down`
stops the containers and keeps the volumes, so no Tenant data is lost. Removed
commands exit 2 naming the replacement: `nylorun dev`, `nylorun configure`,
`nylorun status --env` and `nylorun doctor sandbox`.

## Tenants

Every command acts on one Tenant, chosen in this order:

1. `--tenant <name>`;
2. `NYLORUN_TENANT`;
3. the Tenant in the project's link (`.nylorun/link.json`, found from the
   working directory upwards);
4. for `start` in a project: the project directory's name, lowercased, with
   characters outside `[a-z0-9_-]` as `-`, and a suffix (`-2`, `-3`, …) when a
   Tenant of that name was created for another project directory;
5. outside a project, or `start --no-link`: the Tenant `default`.

In a project without a link, the commands other than `start` exit 2 and list
the Tenants on this machine. A name is lowercase letters, digits, `-` and `_`;
a Tenant id (`tn_…`) is refused: pass the Tenant's name (`nylorun ls` lists
them).

Each Tenant has its own Host root `~/.nylorun/tenants/<name>/`, Compose project
`nylorun-<name>` (`NYLORUN_COMPOSE_PROJECT` overrides it), volumes, network and
ports. `NYLORUN_HOME` replaces the whole Host root (the Tenant's name then
comes from its `tenant.json`, the project directory or the Host root's own
name). nylorun 0.4 kept Host roots in `~/.nylorun/stacks/`: the first command
of this release moves them to `~/.nylorun/tenants/`, keeping their Compose
projects and volumes.

### Several Tenants

Tenants run side by side, each on its own ports, containers, network and
volumes ([The containers](#the-containers)); a running Tenant uses about
1.2 GB. Each Studio is on its own port, `http://localhost:<port>`, with its own
session cookie, so two Studios in one browser stay signed in;
`nylorun studio --tenant <name>` opens any Tenant's Studio signed in. `nylorun ls`
lists them with their state, the memory their containers use (`MEMORY`: the sum
of `docker stats` over the containers labelled `dev.nylorun.tenant=<name>`, `-`
when stopped; `memoryBytes` in `--json`, `null` when stopped or unknown), the
Runtime's URL and Studio's:

```text
TENANT   STATE    MEMORY  RUNTIME                STUDIO                 PROJECT
api      running  1.2 GB  http://localhost:8790  http://localhost:4162  /Users/me/api
default  stopped  -       http://localhost:8787  http://localhost:4161  -
```

When other Tenants are running, `start` says so after its summary, on stderr
(without the size when Docker does not report it):

```text
Also running: default, api (about 2.4 GB). "nylorun stop --all" stops them all.
```

`nylorun stop --all` stops every running Tenant on this machine, keeping their
volumes; it cannot be combined with `--tenant` (exit 2).

A Tenant created by nylorun 0.5 keeps its data in volumes Compose named
`<project>_postgres`, `<project>_restate`, `<project>_s2` and
`<project>_workspaces`; this release names them `<project>-postgres`, … (see
[The containers](#the-containers)). `start` on such a Tenant exits 3 without
starting it, naming the old volumes: run `nylorun reset --tenant <name>` to
start it fresh. `reset` and `delete` also remove the old volumes (and the old
network `<project>_default`).

A Tenant refuses only a Runtime older than its own database: `start` records
the pinned Runtime version in `host.json` (`runtimeVersion`) and exits 5 when
this nylorun pins an older one. Update nylorun, or pass `--allow-downgrade`
when both versions use the same database schema (otherwise the Runtime reports
the Tenant unavailable, `schema-too-new`). With `NYLORUN_RUNTIME_IMAGE` set,
the image's version is unknown: `start` does not check it and keeps the
recorded version.

## The Project link

`nylorun start` in a project waits until the Tenant is open
(`/v1/admin/status`), then writes, in a `.nylorun/` directory (mode 0700, with
its own `.gitignore` of `*`):

- `link.json`: `{ "format": 3, "tenant", "tenantId", "hostUrl", "hostId" }`.
  `tenant` is the local Tenant's name; the Tenant id is information only:
  nothing in a request selects a Tenant.
- `credentials.json` (mode 0600): `{ "format": 1, "applicationKey",
  "principalId" }`, the operator key `project`. A later `start` keeps the file
  while its key still reaches the Tenant (one authenticated read); otherwise it
  writes the Tenant's `project` key, which the Host root keeps in
  `project-credentials.json` (mode 0600) so every checkout linked to the Tenant
  shares one key, or puts a new one through the Admin API.

Later starts reuse the Tenant and rewrite the link only when the Tenant's name,
URL, Host or id changed (after `nylorun reset`, for example). When it writes a
new link, `start` seeds the Tenant from the project's `.env`: the sandbox
backend (`NYLORUN_SANDBOX=auto|virtual`) and the model credential
(`MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY`, `MODEL_PROVIDER_BASE_URL`,
or `.nylorun/auth.json`), unless the Tenant has a model or
`NYLORUN_DEV_MODEL=fixture`. `.env` never configures the containers.

A fresh clone or a second worktree has no link: `nylorun start` there creates a
new Tenant, or `nylorun start --tenant <name>` attaches it to an existing one so
both share it. `--no-link` starts a Tenant without linking the working
directory (scripts). A link of an older nylorun (format 0 to 2) counts as no
link: `start` replaces it.

No key is derived from the admin key but Studio's. A project holds the operator
key `project`; a key an older nylorun derived for it keeps working while it
authenticates and is replaced by the operator key otherwise.

## Operator keys

`nylorun key put <id>` creates the running Tenant's key `<id>` (or rotates it:
the previous key stops working at once) and prints it once on stdout.
`nylorun key list [--json]` shows each key's id, role and when it was issued,
never the keys; `nylorun key rm <id>` deletes one. Ids match
`^[a-z][a-z0-9-]{0,31}$`; `studio` belongs to Studio and is refused. Give each
app server its own key. `nylorun sandbox` and `nylorun mcp` use the linked
project's key, or the key `cli` they put once and keep in
`<Host root>/cli-credentials.json` (mode 0600).

`nylorun mcp connect <url> --server <name>` signs the running Tenant in to a
remote MCP server that uses OAuth: it opens the server's sign-in page in the
browser and waits until the Runtime has stored the credential in the
installation vault `mcp` (created if needed; `--vault <id>` picks another),
which sessions attach with `vaultIds`. Pass `--client-id` when the server does
not let clients register themselves. See
[Connecting a remote MCP server with OAuth](../DEPLOYMENT.md#connecting-a-remote-mcp-server-with-oauth).

## The containers

`nylorun start` writes `compose.yaml` and `.env` (mode 0600) under
`~/.nylorun/tenants/<name>/docker/` on every start; `.env` keeps the ports and
secrets chosen on the first run. The services are `postgres`, `restate`,
`s2-lite`, `rustfs`, `gateway`, `runtime`, `harness` and `studio`. Container, network and volume
names are global on the Docker engine, so each carries the Tenant's Compose
project, and each has the label `dev.nylorun.tenant: <name>`. For Tenant `shop`:

| Thing | Name |
| --- | --- |
| Containers | `nylorun-shop-postgres`, `nylorun-shop-restate`, `nylorun-shop-s2-lite`, `nylorun-shop-rustfs`, `nylorun-shop-gateway`, `nylorun-shop-runtime`, `nylorun-shop-harness`, `nylorun-shop-studio` |
| Networks | `nylorun-shop` (egress, published ports), `nylorun-shop-store` (internal: the stores), `nylorun-shop-harness` (the harness, the runtime and the gateway) |
| Volumes | `nylorun-shop-postgres`, `nylorun-shop-restate`, `nylorun-shop-s2-lite`, `nylorun-shop-rustfs`, `nylorun-shop-workspaces` |

The `harness` container (the Runtime image as `--service harness`) runs agent
turns, stdio MCP servers and workspaces, apart from the `runtime` container. It
holds only the harness token (`NYLORUN_HARNESS_TOKEN` in `.env`), mounts only
the Tenant directory's `sandboxes/`, `plugin-data/`, `home/` and `tmp/`, and the
Host root's `plugins/` read-only at its own path: put a plugin whose stdio MCP
server the agent runs under `~/.nylorun/tenants/<name>/plugins/` and load it from
there. `NYLORUN_HARNESS=in-process` in `.env` rolls back to running them in the
`runtime` container (no `harness` container); `nylorun status` shows which.

Postgres initialises the Tenant's database with C collation. Restate runs with
its own defaults. A running Tenant uses about 1.2 GB, most of it Restate; stop
the Tenants you are not using (`nylorun stop`, or `nylorun stop --all`). The Runtime and Studio images are pinned by
this release (`package.json` `nylorun.runtime` and `nylorun.studio`);
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them (local builds,
CI). Ports publish on loopback only: the Runtime on `8787`, its operator
listener (Admin API) on `8788` and Studio on `4161`, or free ports chosen on the
Tenant's first start, avoiding the ports other Tenants keep, and kept in its
`.env`. Restate's UI and admin API (unauthenticated) are not published; `nylorun
start --restate-ui` (or `NYLORUN_RESTATE_UI=1`) publishes them for that start on
`9070` (or the port kept in `.env`), and the next start without it closes them.

`start`, `status`, `ls` and `nylorun studio` give Studio as
`http://localhost:<port>` (`studio.url` in `status --json`). Studio has no
password, and `start` opens no browser: it prints the URLs and says to run
`nylorun studio` to sign a browser in (`--no-open` is accepted and ignored).
`nylorun studio` asks the Studio container for a single-use login token with the
admin key (`POST /_studio/login-tokens`) and opens
`http://localhost:<port>/login?token=…` on the Tenant's page in the browser.
That sets a session cookie for 30 days, which survives Studio restarts, so the
printed URL keeps working in that browser. The token itself is never printed
unless no browser starts; `nylorun studio --no-open` prints the login URL (it
works once, for two minutes) instead.

Browsers share cookies across the ports of one host, so each Tenant's Studio
sets its own session cookie, `nylorun_studio_<name>`
(`NYLORUN_STUDIO_SESSION_COOKIE`): signing in to one Studio does not sign you
out of another.

### Embedding Studio in a desktop app

A desktop or web app can show Studio inside its own window, in an iframe loaded
from Studio's URL (`studio.url` in `nylorun status --json`). Embedding is
opt-in: only exact origins listed in `NYLORUN_STUDIO_FRAME_ANCESTORS` (in
`~/.nylorun/tenants/<name>/docker/.env`) may frame it, and the list is empty by
default. Add the app's origins once with `nylorun start --studio-embed-origin
<origin>` (for example `app://localhost`, or a dev server's
`http://localhost:1420`); the list is kept across starts until
`--studio-embed-origin-reset`, and `nylorun status` shows it under `Embeds`.
Wildcards are refused. A Tenant started by an older nylorun keeps the origins it
had.

The app's backend mints a single-use login token for the Tenant with
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
default names one (`PUT /v1/tenant/sandbox`). A local Tenant runs them on the
Runtime's **virtual** backend: an emulated shell in the Runtime process, with no
extra containers. It is not a VM or container boundary.

A sandbox can also be a resource with its own id (`PUT /v1/sandboxes/{id}`,
`client.sandboxes` in `@nylorun/agents`) that sessions attach to and that
outlives them. `nylorun sandbox ls` lists the running Tenant's sandboxes with
their state, attached sessions and labels; `nylorun sandbox rm <id>` deletes one
and its files (refused while a turn runs in it). Neither starts a stopped Tenant
(exit 3).

### Pods on a cluster (preview)

`nylorun sandbox enable --context <name>` prepares a Kubernetes context for the
Tenant's sandboxes as pods ([agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
v1.0.5): Docker Desktop's cluster (`--context docker-desktop`) or kind. It only
touches the context you name. It installs the pinned agent-sandbox controller
when the cluster has none (and refuses another version), creates the namespace
`nylorun-sbx-<tenant>` with a ServiceAccount limited to Sandbox lifecycle, proves
with a probe that the cluster enforces NetworkPolicy (and refuses it otherwise),
lets pods reach only three ports on the Docker host, and adds the `sandboxes`
service to the Tenant: the one container holding the cluster credentials
(`<Host root>/sandboxes/`). On kind under Linux, pass `--host-address 172.17.0.1`.
`nylorun sandbox disable` removes the service (`--delete-namespace` also deletes
the namespace and every sandbox in it). Sessions keep using the virtual backend
in this release.

## Host root

The **Host root** is `~/.nylorun/tenants/<name>/`, or `NYLORUN_HOME`. It is
bind-mounted into the Runtime and Studio containers, and holds `tenant.json`
(`{ "format": 1, "name", "project"? }`: the Tenant's name and the project it
was created for), `host.json` (the client-facing host and port),
`host-credentials.json` (the admin key, mode 0600), `project-credentials.json`
and `cli-credentials.json` (the operator keys `project` and `cli`, mode 0600, when
they were put), the Docker Compose files in `docker/`, the Tenant directory `tenant/` (homes, logs) and `keys/vault-kek`,
the Tenant's vault key, which only the gateway container mounts. The Tenant's data lives in its Postgres, Restate and S2 volumes.

`nylorun reset` deletes the selected Tenant's volumes, `tenant/` and `keys/`, and keeps
its files and ports; the next start creates the Tenant anew (with a new id) and
relinks the project. `nylorun delete <tenant> --yes` removes the Tenant's
containers, volumes and Host root: the vault key (KEK) and all its data go with it.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure, including a missing Docker or Compose v2 |
| 2 | Usage error (including no Tenant selected, or `delete` without `--yes`), or a removed or moved command |
| 3 | `status`: the Runtime is not answering; `sandbox`: the Tenant is not running; `stop`/`logs`: no Tenant yet; `delete`: no such Tenant; `start`: a Tenant created by nylorun 0.5 (reset it) |
| 4 | The Runtime port is held by another Host |
| 5 | `up`/`start`/`studio`: this nylorun pins a Runtime older than the one that last ran the Tenant; update nylorun, or `start --allow-downgrade` |
| 7 | The containers, the Tenant or Studio did not become ready (an unavailable Tenant's cause is printed) |
| 130 / 143 | SIGINT / SIGTERM |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Docker missing or not running | Install or start Docker Desktop, OrbStack or Colima; `nylorun doctor` checks |
| `426` from the Runtime | Upgrade nylorun (`npx nylorun@latest start`), or pin a matching older set |
| `Refusing to start Runtime …` (exit 5) | Upgrade nylorun (`npx nylorun@latest start`); `--allow-downgrade` only when both Runtimes share the database schema |
| `Tenant … is unavailable` (exit 7) | Follow the repair it names; `nylorun logs runtime` |
| Port conflict | Change `NYLORUN_PORT` / `NYLORUN_STUDIO_PORT` in `~/.nylorun/tenants/<name>/docker/.env` |
| Logs | `nylorun logs runtime -f` |
| Studio login expired | `nylorun studio` |
| Which Studio is which | `nylorun ls` lists each Tenant's Studio URL; `nylorun studio --tenant <name>` opens one signed in |
| `Tenant … was created by nylorun 0.5` (exit 3) | `nylorun reset --tenant <name>` (its data starts fresh) |

See [MIGRATION.md](../MIGRATION.md).
