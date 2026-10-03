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
nylorun up|start [--tenant <name>] [--no-link] [--no-studio] [--no-open] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset]
                                   # create (first run) and start the Tenant; link the project; print the URLs; open Studio signed in
nylorun down|stop [--tenant <name> | --all]   # stop the containers (--all: every Tenant's, and the Studio proxy); keep volumes
nylorun status [--tenant <name>] [--json]   # the Tenant, its Host root and id, services, endpoints, Runtime health
nylorun logs [service] [--tenant <name>] [-f] [--tail <n>]   # postgres, restate, s2-lite, gateway, runtime, studio
nylorun studio [--tenant <name>] [--no-open]   # sign a browser in to Studio on the Tenant; starts it if needed
nylorun reset [--tenant <name>] [--yes]        # delete the Tenant's volumes, Tenant directory and vault key; the next start creates it anew
nylorun ls [--json]                # the Tenants on this machine, with their state, memory and URLs
nylorun delete <tenant> --yes      # remove a Tenant: containers, volumes, Host root and vault key
nylorun doctor [--json]            # prerequisites and the Tenant's health
nylorun telemetry [status|enable|disable]   # Studio's anonymous usage analytics
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
600–700 MB. Each Studio has its own address through the
[Studio proxy](#the-studio-proxy), `http://<name>.localhost:4160`. `nylorun ls`
lists them with their state, the memory their containers use (`MEMORY`: the sum
of `docker stats` over the containers labelled `dev.nylorun.tenant=<name>`, `-`
when stopped; `memoryBytes` in `--json`, `null` when stopped or unknown), the
Runtime's URL and Studio's:

```text
TENANT   STATE    MEMORY  RUNTIME                STUDIO                         PROJECT
api      running  652 MB  http://localhost:8790  http://api.localhost:4160      /Users/me/api
default  stopped  -       http://localhost:8787  http://default.localhost:4160  -
```

When other Tenants are running, `start` says so after its summary, on stderr
(without the size when Docker does not report it):

```text
Also running: default, api (about 1.3 GB). "nylorun stop --all" stops them all.
```

`nylorun stop --all` stops every running Tenant on this machine and the Studio
proxy, keeping their volumes; it cannot be combined with `--tenant` (exit 2).
`stop` of one Tenant leaves the proxy running.

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
- `credentials.json` (mode 0600): the key of the derived principal `project`,
  derived from the Tenant's admin key, and its id.

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

The Runtime registers the derived principals of `NYLORUN_DERIVED_PRINCIPALS`
(comma-separated, from the environment of `nylorun start`, kept in the Tenant's
`.env`) when it creates the Tenant; `project` is always among them.

## The containers

`nylorun start` writes `compose.yaml` and `.env` (mode 0600) under
`~/.nylorun/tenants/<name>/docker/` on every start; `.env` keeps the ports and
secrets chosen on the first run. The services are `postgres`, `restate`,
`s2-lite`, `gateway`, `runtime` and `studio`. Container, network and volume
names are global on the Docker engine, so each carries the Tenant's Compose
project, and each has the label `dev.nylorun.tenant: <name>`. For Tenant `shop`:

| Thing | Name |
| --- | --- |
| Containers | `nylorun-shop-postgres`, `nylorun-shop-restate`, `nylorun-shop-s2-lite`, `nylorun-shop-gateway`, `nylorun-shop-runtime`, `nylorun-shop-studio` |
| Network | `nylorun-shop` |
| Volumes | `nylorun-shop-postgres`, `nylorun-shop-restate`, `nylorun-shop-s2-lite`, `nylorun-shop-workspaces` |

Postgres initialises the Tenant's database with C collation. Restate's RocksDB
memory is capped at 256 MiB (`RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE`; Restate's
default is 2 GiB), so several Tenants fit on a laptop: a Tenant uses about
600–700 MB, down from about 1.3 GB. The Runtime and Studio images are pinned by
this release (`package.json` `nylorun.runtime` and `nylorun.studio`);
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them (local builds,
CI). Ports publish on loopback only: the Runtime on `8787`, its operator
listener (Admin API) on `8788`, Studio on `4161` and the Restate UI on `9070`,
or free ports chosen on the Tenant's first start, avoiding the ports other
Tenants and the Studio proxy keep, and kept in its `.env`.

`start`, `ls` and `nylorun studio` give Studio as `http://<name>.localhost:4160`,
its address through the Studio proxy (below); `status` adds Studio's own
`http://localhost:<port>` (`--json` has both: `studio.url` is Studio's own port,
which an embedding app frames, and `studio.proxyUrl` the proxy's). Studio has no
password: in a terminal (not in CI, and not with `--no-open`), `start` asks the
Studio container for a single-use login token with the admin key (`POST
/_studio/login-tokens`, through the proxy; on Studio's own port, saying so,
when the proxy does not answer) and opens `…/login?token=…` on the Tenant's
page in the browser. That sets a session cookie for 30 days, which survives
Studio restarts, so the printed URL keeps working in that browser. The token
itself is never printed unless no browser starts. Otherwise `start` says to run
`nylorun studio`, which signs a browser in the same way; `nylorun studio
--no-open` prints the login URL (it works once, for two minutes) instead.

Each Tenant's Studio sets its own session cookie, `nylorun_studio_<name>`
(`NYLORUN_STUDIO_SESSION_COOKIE`).

### The Studio proxy

One small Caddy container per machine (`nylorun-proxy`, Compose project
`nylorun-proxy`, label `dev.nylorun.proxy: "true"`) gives every Tenant's Studio
the address `http://<name>.localhost:<port>`. Browsers keep cookies per host,
not per port, so separate hosts keep the Studios' sessions apart. The proxy is
for browsers only: programs keep using the Runtime's `http://localhost:<port>`.
It holds no Tenant data; its files are in `~/.nylorun/proxy/` (`compose.yaml`,
`Caddyfile`, and `.env` with `NYLORUN_PROXY_PORT`, 4160 or a free port chosen
on its first start and kept; Caddy's own state is tmpfs). Its image is pinned
by this release (`caddy:2.11.6`).

- Caddy listens on port 80 in the container, published at `NYLORUN_PROXY_PORT`
  on `127.0.0.1` and `[::1]` (macOS resolves `*.localhost` to `::1` only); when
  Docker refuses `::1` (IPv6 off), it publishes on `127.0.0.1` alone and says
  so once.
- It routes every Tenant under `~/.nylorun/tenants/`: it joins each Tenant's
  network and reaches `<project>-studio:3000`, passing the browser's `Host`
  through, which Studio checks. A stopped Tenant answers 502 naming
  `nylorun start --tenant <name>`; an unknown host 404 naming `nylorun ls`.
- `start` rewrites its files, brings it up (only when Studio starts: not with
  `--no-studio`), joins every Tenant's network and reloads Caddy; Studio learns
  its proxy origin from `NYLORUN_STUDIO_PUBLIC_ORIGINS`, written to the
  Tenant's `.env` on every start. A proxy that does not come up never fails
  `start`: it warns once and prints Studio's own URL.
- `reset` and `delete` detach it from the Tenant's network first; `delete`
  removes the Tenant's route. `stop --all` stops it.
- `NYLORUN_PROXY_DISABLED=1` turns it off: Studio is `http://localhost:<port>`.
  A Tenant under `NYLORUN_HOME` or `NYLORUN_COMPOSE_PROJECT` (the repository's
  smokes) does not use it either.

`nylorun doctor` reports it on a `proxy` row: running (on which loopbacks and
port), stopped, not created yet, or disabled.

### Embedding Studio in a desktop app

A desktop app such as Babai Desktop can show Studio inside its own window, in
an iframe loaded from Studio's URL (`studio.url` in `nylorun status --json`).
Only exact origins listed in `NYLORUN_STUDIO_FRAME_ANCESTORS` (in
`~/.nylorun/tenants/<name>/docker/.env`) may frame it. The default is Babai's
`nylorun://localhost http://nylorun.localhost`; `nylorun status` lists them
under `Embeds`. While building such an app, add its dev server once with
`nylorun start --studio-embed-origin http://localhost:1420`; the list is kept
across starts until `--studio-embed-origin-reset`. Wildcards are refused.

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

## Host root

The **Host root** is `~/.nylorun/tenants/<name>/`, or `NYLORUN_HOME`. It is
bind-mounted into the Runtime and Studio containers, and holds `tenant.json`
(`{ "format": 1, "name", "project"? }`: the Tenant's name and the project it
was created for), `host.json` (the client-facing host and port),
`host-credentials.json` (the admin key, mode 0600), the Docker Compose files in
`docker/`, the Tenant directory `tenant/` (homes, logs) and `keys/vault-kek`,
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
| 3 | `status`: the Runtime is not answering; `stop`/`logs`: no Tenant yet; `delete`: no such Tenant; `start`: a Tenant created by nylorun 0.5 (reset it) |
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
| `http://<name>.localhost:<port>` does not answer | `nylorun doctor` (the `proxy` row); `nylorun start` brings the proxy up; Studio's own port is in `nylorun status` |
| `Tenant … was created by nylorun 0.5` (exit 3) | `nylorun reset --tenant <name>` (its data starts fresh) |

See [MIGRATION.md](../MIGRATION.md).
