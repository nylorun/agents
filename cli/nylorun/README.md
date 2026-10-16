# nylorun

Sets up and runs local Nylorun Tenants (the Runtime and Studio, in Docker
Compose, one Tenant per project), and is the client of a Tenant's APIs, local or
remote. It needs nothing in your project; run it with `npx` in the project's
directory:

```sh
npx nylorun start   # create (first run) and start this project's Tenant, and the Project link
npx nylorun stop    # stop it; volumes (and the Tenant's data) are kept
```

A local Tenant is one installation: one Runtime with its own Postgres, Restate
and S2, serving exactly that Tenant, and its name is the Tenant's name.
`nylorun start` in a project creates the project's Tenant (the Runtime creates
it on its first start) and links the project to it; anywhere else, it starts
the Tenant `default`. Projects that must not share agents, credentials or
history run separate Tenants. The `tenant` and `environments` groups act on a
Tenant over its APIs, so they work on a remote installation too
([below](#remote-installations)). Depends on `@nylorun/core`,
`@nylorun/admin` and `@nylorun/agents` among Nylorun packages and never imports
`@nylorun/runtime`; `start`, `stop` and the `local` commands load neither
`@nylorun/agents` nor `@nylorun/admin`. Vocabulary:
[runtime/server/src/CONTEXT.md](../../runtime/server/src/CONTEXT.md).

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

The installation's lifecycle is a handful of top-level commands; everything else
is in a group that follows the API it uses, and each group has its own `--help`.

```sh
nylorun up|start [--tenant <name>] [--no-link] [--no-studio] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset] [--restate-ui]
                                   # create (first run) and start the Tenant; link the project; print the URLs
                                   # --restate-ui (or NYLORUN_RESTATE_UI=1): publish Restate's UI on loopback for this start
nylorun down|stop [--tenant <name> | --all]   # stop the containers (--all: every Tenant's); keep volumes
nylorun status [--tenant <name>] [--json]   # the Tenant, its Host root and id, services, endpoints, Runtime health
nylorun studio [--tenant <name>] [--no-open]   # sign a browser in to Studio on the Tenant; starts it if needed
nylorun doctor [--json]            # prerequisites and the Tenant's health
nylorun doctor sandbox [--tenant <name>] [--json]   # the sandbox backend the Tenant's Host offers

# agents, sessions, environments, artifacts: the Runtime API (an application key, or NYLORUN_TOKEN)
# every one takes --tenant <name>, and --as <subject> [--scope <scope>]... to act for a person
nylorun agents list [--json]
nylorun agents get <id>                     # its manifest
nylorun agents save <manifest.json|-> [--files <dir>]... [--implementation-version <v>] [--dry-run]
nylorun sessions list [--agent <id>] [--status <s>] [--environment <id>] [--owner <user>] [--limit <n>] [--cursor <c>] [--json]
nylorun sessions create --agent <id> --owner <user> [--environment <id>] [--id <id>] [--info <json>]
nylorun sessions get <id>
nylorun sessions send <id> [<text>] [--data <json>] [--file <artifact>[@<version>]]... [--idempotency-key <k>]
nylorun sessions approve <id> <interaction> [--deny]
nylorun sessions respond <id> <interaction> <json>
nylorun sessions cancel <id> [--reason <text>]
nylorun sessions watch <id> [--follow] [--cursor <c>]   # events as JSON lines until interrupted
nylorun sessions history|usage|calls [--tool]|trace <id> …
nylorun sessions exec <id> [--timeout <s>] -- <command>...   # bash in the session's sandbox
nylorun environments list [--label <key=value>]... [--behind] [--limit <n>] [--cursor <c>] [--json]   # --behind: made from an older manifest version
nylorun environments get|stop|reset|delete|snapshot|versions <id>
nylorun environments put <id> --manifest <name[@n]> [--label <key=value>]...   # made from a manifest version; what it runs never changes
nylorun environments put <id> [<inline.json|->] [--kind <virtual|pod|none>] [--label <key=value>]...
nylorun environments fork <id> <new-id> [--manifest <name[@n]>] [--disk <latest|n|empty>] [--secrets <copy|none>] [--dry-run]   # onto a new manifest version
nylorun environments restore <id> <version|latest>
nylorun environments delete-version <id> <version>
nylorun environments events <id> [--from <n>] [--types <type,…>] [--since <time>] [--until <time>]
nylorun environments secrets list|get|put|rm <id> [<name>] [<secret.json|->]   # put without a file: a slot's value on stdin
nylorun environments manifests list [--json] | get <name> [--version <n>] | versions <name> | rm <name>
nylorun environments manifests save <manifest.json>... [--if-match <n>] [--dry-run]   # files with "from": a folder, uploaded by hash
nylorun artifacts list [--session <id>] [--label <key=value>]... [--limit <n>] [--cursor <c>] [--json]
nylorun artifacts get|tree|diff|link|rm <id> …
nylorun artifacts upload <file|-> [--name <name>] [--content-type <type>] [--session <id>] [--label <key=value>]... [--to <id>]
nylorun artifacts download <id> [--version <n>] [--output <file>]
nylorun artifacts zip <id> [--version <n>] --output <file>

# tenant: the Tenant's settings (Management API, a management key)
nylorun tenant reset [--sessions|--environments|--all] [--yes] [--tenant <name>]
nylorun tenant keys put <id> [--management] [--tenant <name>]   # create or rotate key <id>; prints it once
nylorun tenant keys list [--tenant <name>] [--json]   # id, role, when issued
nylorun tenant keys rm <id> [--tenant <name>]         # it stops working at once
nylorun tenant signing-keys list|rotate [--force]|revoke <kid> [--tenant <name>]
nylorun tenant models catalog|providers|get [--tenant <name>] [--json]   # the models the Runtime knows, the providers with a credential, the Tenant's model
nylorun tenant models set [--tenant <name>]           # sign in to a model provider and set the Tenant's model
nylorun tenant models set --provider <id> --model <id> [--base-url <url>] [--tenant <name>]   # the same, with an API key piped in on stdin (CI)
nylorun tenant models select <provider> [--model <id>] [--tenant <name>]   # use another provider that has a credential
nylorun tenant usage [--scope tenant|agent|turn] [--id <id>] [--period day|month|total] [--tenant <name>]   # calls, tokens and cost (JSON)
nylorun tenant calls [--after <cursor>] [--limit <n>] [--tenant <name>]   # every recorded model call as NDJSON, until caught up
nylorun tenant budgets [get | put <file|->] [--tenant <name>]       # the model spend caps
nylorun tenant tool-policy [get | put <file|->] [--tenant <name>]   # the Tool Gate's rules
nylorun tenant settings sandbox|artifacts|skills|limits [get | put <file|->] [--tenant <name>]   # Environment, artifact store and skill settings, Runtime limits
nylorun tenant coverage --agent <id> [--environment <id>] [--tenant <name>] [--json]   # which secret each MCP server and HTTP tool would get
nylorun tenant mcp inspect <url> [--server <name>] [--environment <id>] [--sse] [--tenant <name>] [--json]

# local: the Tenants on this machine (Docker and kubectl)
nylorun local ls [--json]          # the Tenants on this machine, with their state, memory and URLs
nylorun local delete <tenant> --yes   # remove a Tenant: containers, volumes, Host root and vault key
nylorun local logs [service] [--tenant <name>] [-f] [--tail <n>]   # postgres, restate, s2-lite, rustfs, gateway, runtime, harness, studio, sandboxes
nylorun local reset [--tenant <name>] [--yes]   # delete the Tenant's volumes, Tenant directory and vault key; the next start creates it anew
nylorun local sandbox enable --context <name> [--tenant <name>] [--host-address <ip>] [--bind-address <ip>] [--no-pull]
nylorun local sandbox disable [--tenant <name>] [--delete-namespace]
nylorun local sandbox status [--tenant <name>] [--json]   # pods on a Kubernetes context (see Sandboxes)
nylorun local telemetry [status|enable|disable]   # Studio's anonymous usage analytics
```

`up` and `down` are the Docker Compose spellings of `start` and `stop`: `down`
stops the containers and keeps the volumes, so no Tenant data is lost. A command
that moved into a group, or was removed, exits 2 naming its replacement:
`nylorun logs`, `ls`, `delete`, `reset` and `telemetry` are under `local` (and
`sandbox enable|disable|status`); `nylorun key` and `mcp` are under `tenant`;
`nylorun sandbox ls|rm` is `nylorun environments list|delete`; `nylorun
configure` is `nylorun tenant models set`. `nylorun dev`, `nylorun env` and the
MCP OAuth `connect` subcommand of `nylorun tenant mcp` (protocol 10: write a key
or a gateway credential as an Environment's secret instead) are gone.

The package's second command, `nylo`, was the Runtime client until nylorun took
its commands. For one release it names the `nylorun` command that replaced each
of its own and exits 2:

| `nylo` | `nylorun` |
| --- | --- |
| `nylo status` | `nylorun status` |
| `nylo reset [--sessions\|--environments\|--all]` | `nylorun tenant reset …` |
| `nylo access signing-keys …` | `nylorun tenant signing-keys …` |
| `nylo configure` | `nylorun tenant models set` |
| `nylo doctor sandbox` | `nylorun doctor sandbox` |
| `nylo env` | none: the SDKs read the Project link themselves |

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
a Tenant id (`tn_…`) is refused: pass the Tenant's name (`nylorun local ls` lists
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
`nylorun studio --tenant <name>` opens any Tenant's Studio signed in. `nylorun local ls`
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
starting it, naming the old volumes: run `nylorun local reset --tenant <name>` to
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
(`/ready`), then writes, in a `.nylorun/` directory (mode 0700, with
its own `.gitignore` of `*`):

- `link.json`: `{ "format": 3, "tenant", "tenantId", "hostUrl", "hostId" }`.
  `tenant` is the local Tenant's name; the Tenant id is information only:
  nothing in a request selects a Tenant.
- `credentials.json` (mode 0600): `{ "format": 1, "applicationKey",
  "principalId", "managementKey", "managementPrincipalId" }`, the application
  key `project` (for the Runtime API) and the management key
  `project-management` (for the Management API). A later `start` keeps the file
  while both keys still reach the Tenant (one authenticated read each);
  otherwise it writes the Tenant's `project` and `project-management` keys,
  which the Host root keeps in `project-credentials.json` (mode 0600) so every
  checkout linked to the Tenant shares them, or puts new ones through
  `nylorun-operate keys`. A file from an earlier release, with only an
  application key, keeps it and gains the management key.

Later starts reuse the Tenant and rewrite the link only when the Tenant's name,
URL, Host or id changed (after `nylorun local reset`, for example). When it writes a
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

No key is derived from the admin key but Studio's. A project holds the
application key `project` and the management key `project-management`; a key
an older nylorun derived for it keeps working while it authenticates and is
replaced by the application key otherwise.

## Keys

Every Tenant serves the Runtime API, which takes **application keys**, and the
Management API (`/v1/tenant/*`), which takes **management keys**
([SELF_HOSTING.md](../../guides/SELF_HOSTING.md#keys)). On a local Tenant,
`nylorun tenant keys` manages both through `nylorun-operate` in its runtime
container, so only this machine can issue a management key. On a remote
installation ([below](#remote-installations)) it manages application keys
through the Management API, and refuses `--management`.

`nylorun tenant keys put <id>` creates the application key `<id>` (or rotates it:
the previous key stops working at once) and prints it once on stdout; with
`--management` it puts a management key. `nylorun tenant keys list [--json]`
shows each key's id, role and when it was issued, never the keys; `nylorun
tenant keys rm <id>` deletes one. Ids match `^[a-z][a-z0-9-]{0,31}$`; `studio`
belongs to Studio and `bootstrap` to `NYLORUN_MANAGEMENT_KEY_FILE`, and both are
refused. Putting an id that holds the other role is refused. Give each app server
its own application key. On a local Tenant, the `tenant` and `environments`
commands use the linked project's keys, or the keys `cli` and `cli-management`
they put once and keep in `<Host root>/cli-credentials.json` (mode 0600).

## MCP servers

An agent names its MCP servers by URL; a session gets a credential for a URL from
the Environment it is opened on (`createSession({ environment })`): a secret of that
Environment, a `bearer` token or a `headers` map, with `via` and an identity
header when an MCP gateway holds each person's sign-in. Write it with
`nylorun environments secrets put <id> <name> <secret.json|->` (the secret's JSON
comes from a file or standard input, never the command line),
`client.environments.secrets.put(id, name, secret)` of `@nylorun/agents` (the
Runtime API, an application key) or in Studio.
The whole flow, with gateway recipes, is in
[DEPLOYMENT.md](../../guides/DEPLOYMENT.md#mcp-servers-and-http-tools).

`nylorun tenant mcp inspect <url>` shows what a remote MCP server offers before an
agent names it, through the Tenant's Management API
(`POST /v1/tenant/mcp/preview`, with the management key). The Runtime connects
with Environment `<id>`'s credential for `<url>` when `--environment <id>` names one
(without it, no credential is sent), lists the tools within 15 s and calls none. It
prints a table of each tool's model name, input schema size, hints
(`read-only`, `destructive`, `idempotent`) and description, then the tools
renamed for the model. `--server` is the server name your manifest uses (default:
the host's name, `linear` for `mcp.linear.app`); `--sse` speaks the older SSE
transport; `--json` prints the Runtime's answer. A server that answers `401`
needs a credential: it says so, and names the server's sign-in from its
protected-resource metadata, since such a server needs a key in an Environment's
secrets or an MCP gateway that holds each person's sign-in. A server it cannot list exits 1 with
the reason (`mcp.unreachable` for an address the Runtime refuses).

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
turns and workspaces, apart from the `runtime` container. It holds only the
harness token (`NYLORUN_HARNESS_TOKEN` in `.env`) and mounts only the Tenant
directory's `sandboxes/`. `NYLORUN_HARNESS=in-process` in `.env` rolls back to running them in the
`runtime` container (no `harness` container); `nylorun status` shows which.

Postgres initialises the Tenant's database with C collation. Restate runs with
its own defaults. A running Tenant uses about 1.2 GB, most of it Restate; stop
the Tenants you are not using (`nylorun stop`, or `nylorun stop --all`). The Runtime and Studio images are pinned by
this release (`package.json` `nylorun.runtime` and `nylorun.studio`);
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them (local builds,
CI). Ports publish on loopback only: the Runtime on `8787` and Studio on
`4161`, or free ports chosen on the
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
Studio needs no login on its published loopback address (`localhost` or
`127.0.0.1` at its port): a browser on this machine is served as signed in. A
host behind a sign-in proxy and an embedding app keep their sign-in.

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
this machine with `nylorun local telemetry disable` (kept in
`~/.nylorun/telemetry.json`), or for one start with `NYLORUN_TELEMETRY_DISABLED=1`
or `DO_NOT_TRACK=1`. It is always off when `CI` is set. `nylorun start` decides
on every start and writes the result to `NYLORUN_STUDIO_ANALYTICS_ID` in
`docker/.env` (empty when off); `nylorun local telemetry` reports the current choice.

## Sandboxes

A session gets a sandbox from the Environment it is opened on
(`createSession({ environment: id })`; protocol 11): an Environment has its own id
(`PUT /v1/environments/{id}`, `client.environments` in `@nylorun/agents`), one
sandbox and one vault of secrets, and outlives the sessions that name it. A session
opened on none has no sandbox. Kind `virtual` (the default) runs on the Runtime's
**virtual** backend: an emulated shell in the Runtime process, with no extra
containers. It is not a VM or container boundary. Kind `pod` runs in a pod on a
cluster (below).

`nylorun environments list` lists the Tenant's Environments with their kind,
state, sessions and labels; `nylorun environments delete <id>` deletes one, with its files
and vault (refused while a turn runs in it). Neither starts a stopped Tenant
(exit 3). The Tenant's limits for Environments (`limits.environments`, `idle`,
resources, network) are `PUT /v1/tenant/sandbox` on the Management API.

### Pods on a cluster (preview)

`nylorun local sandbox enable --context <name>` prepares a Kubernetes context for the
Tenant's sandboxes as pods ([agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
v1.0.5): Docker Desktop's cluster (`--context docker-desktop`) or kind. It only
touches the context you name. It installs the pinned agent-sandbox controller
when the cluster has none (and refuses another version), creates the namespace
`nylorun-sbx-<tenant>` with a ServiceAccount limited to Sandbox lifecycle, proves
with a probe that the cluster enforces NetworkPolicy (and refuses it otherwise),
lets pods reach only three ports on the Docker host, and adds the `sandboxes`
service to the Tenant: the one container holding the cluster credentials
(`<Host root>/sandboxes/`). On kind under Linux, pass `--host-address 172.17.0.1`.
`nylorun local sandbox disable` removes the service (`--delete-namespace` also deletes
the namespace and every sandbox in it). Sessions run in a pod when their
Environment has kind `pod` (`client.environments.put(id, { kind: "pod" })`).

## Host root

The **Host root** is `~/.nylorun/tenants/<name>/`, or `NYLORUN_HOME`. It is
bind-mounted into the Runtime and Studio containers, and holds `tenant.json`
(`{ "format": 1, "name", "project"? }`: the Tenant's name and the project it
was created for), `host.json` (the client-facing host and port),
`host-credentials.json` (the admin key, mode 0600), `project-credentials.json`
and `cli-credentials.json` (the keys `project` and `project-management`, `cli`
and `cli-management`, mode 0600, when they were put), the Docker Compose files in `docker/`, the Tenant directory `tenant/` (homes, logs) and `keys/vault-kek`,
the Tenant's vault key, which only the gateway container mounts. The Tenant's data lives in its Postgres, Restate and S2 volumes.

`nylorun local reset` deletes the selected Tenant's volumes, `tenant/` and `keys/`, and keeps
its files and ports; the next start creates the Tenant anew (with a new id) and
relinks the project. `nylorun local delete <tenant> --yes` removes the Tenant's
containers, volumes and Host root: the vault key (KEK) and all its data go with it.

## Remote installations

The `agents`, `sessions`, `environments`, `artifacts` and `tenant` groups,
`status` and `doctor sandbox` act on a Tenant over its APIs. Without `--tenant`, they act on the installation the
environment names, when it names one for their API:

| Variables | Acts on |
| --- | --- |
| `NYLORUN_RUNTIME_URL` and `NYLORUN_MANAGEMENT_KEY` | `status`, `doctor sandbox` and `tenant` (the Management API) |
| `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY` | `agents`, `sessions`, `environments` and `artifacts` (the Runtime API) |
| `NYLORUN_RUNTIME_URL` and `NYLORUN_TOKEN` | the same, with an identity provider's token in place of the key: the person it names, with the scopes it grants |

`NYLORUN_RUNTIME_URL` alone is an app's and names nothing, as for
`createAdmin` in `@nylorun/admin`. Otherwise they act on the local Tenant
`--tenant` names, else the linked project's, else the default one, while it runs;
they never start it. An installation serves one Tenant, so nothing else selects
it. The SDKs read the [Project link](#the-project-link) (or the two variables)
themselves, so the project's `npm run dev` and `npm start` need no Nylorun tool.
For a process outside the project, give it a key of its own (`nylorun tenant
keys put <id>`) and the Runtime URL that `nylorun status` prints.

### Acting for a person

An application key acts for the whole Tenant. `--as <subject>` on a Runtime API
command sends `Nylorun-Subject` and `Nylorun-Scopes`, as `client.as(subject)` of
`@nylorun/agents` does, so the Runtime limits the command to that person's own
sessions and to the scopes given (`--scope`, repeatable; default
`sessions:own`). Use it to see what one person sees, or to act on their sessions
from a terminal.

### Saving an agent from its manifest

`nylorun agents save agent.json --files skills/` saves the agent a manifest
describes, as `saveAgent` does from code. A manifest names each definition file
(a skill folder's files) by the SHA-256 of its bytes, so the files under the
`--files` folders are matched by content, whatever their paths; the ones the
Runtime does not hold are uploaded first (`PUT /v1/files/sha256:…`). A file the
manifest names but no folder holds stops the save before any request, naming
where the manifest names it. `nylorun agents get <id>` prints a saved agent's
manifest; the Runtime does not hand files back, so keep them with the manifest.

### `local reset` or `tenant reset`

Both reset a Tenant, in different ways:

| | `nylorun local reset` | `nylorun tenant reset` |
| --- | --- | --- |
| Acts on | the local Tenant on this machine, through Docker | the Tenant, local or remote, through the Management API with a management key |
| Deletes | all the Tenant's data: volumes, `tenant/` and the vault key; the next `start` creates it anew, with a new id, and relinks the project | the sessions (the default), the Environments (`--environments`) or all the data (`--all`) after draining work in flight; the Tenant, its keys and the Project link are kept |

`nylorun tenant reset --all` asks first; pass `--yes` when not in a terminal.
`nylorun local reset` asks too, or takes `--yes`.

### `nylorun tenant models set`

Lists the Tenant's model catalog (`GET /v1/tenant/models`), asks for a provider,
a model and its sign-in (an API key, or the provider's OAuth), and sets the
Tenant's model provider (`PUT /v1/tenant/model`). The sign-in flows come from
`@earendil-works/pi-ai`, about 100 MB with its provider SDKs, which no other
command needs, so it is not a dependency of nylorun and `npx nylorun` stays
small. When it does not resolve beside nylorun, the first `nylorun tenant models
set` installs the version nylorun was tested with, with npm and without install
scripts, into `~/.nylorun/lib/pi-ai-<version>/` (under `NYLORUN_HOME` when that
is set), and later runs reuse it. Studio's model settings, and `.env` at
`nylorun start`, set the provider without it.

For CI, `--provider` and `--model` (and `--base-url` for an OpenAI-compatible
endpoint, provider `custom`) set an API key without prompts or pi-ai. The key is
read from stdin, never from the arguments, so it stays out of the shell's
history and the process list; a terminal on stdin is refused (exit 2). OAuth
providers need the prompts.

```sh
printenv OPENAI_API_KEY | nylorun tenant models set --provider openai --model gpt-5
```

`nylorun tenant models select <provider>` switches to another provider that
already has a credential, keeping its model (or `--model`) and endpoint.

### Files in, files out

`budgets`, `tool-policy`, `settings sandbox`, `settings artifacts`,
`settings skills` and `settings limits` are documents: `get` (the default)
prints one as JSON, and `put <file>` (or `put -` for stdin) replaces the whole
document with the JSON body in the file, the Management API's request body
(`PUT /v1/tenant/budgets`, `/tool-policy`, `/sandbox`, `/artifacts`, `/skills`,
`/limits`). The body is checked against its schema before anything is sent; one
that does not parse exits 2. What `budgets`, `tool-policy`, `settings artifacts`,
`settings skills` and `settings limits` print, `put` takes back (their `updatedAt` and
`usedBytes` are dropped), so they can be kept in a repository and applied from
CI:

```sh
nylorun tenant tool-policy get > tool-policy.json   # edit it, then
nylorun tenant tool-policy put tool-policy.json
```

`settings sandbox get` prints the effective settings and what the Host offers;
its `put` takes the settings alone (`limits`, `lifecycle`, `placement`).

`settings limits` is the Tenant's Runtime limits: the sizes, counts and
deadlines the Runtime holds what crosses it to, such as `recordEntryBytes`,
`requestBodyBytes`, `environmentLabels`, `pageItems`, `modelRequestMs` and
`httpToolTimeoutMs` (each one, with its default and ceiling, in DEPLOYMENT.md's
Runtime limits). A
limit left out of a `put` takes its default; one above its ceiling (S2's 1 MiB
record, the Harness API's 64 MiB frame, a JavaScript timer) is refused, and the
error names the ceiling.

`nylorun tenant calls` prints each recorded model call as one JSON line, page
after page, until it is caught up, then the cursor on stderr: pass it as
`--after` to read only the newer calls. A call may come twice across runs;
deduplicate by `id`.

### The CLI's own waits

How long `nylorun start` waits for the stack, how often it polls, the healthchecks
it writes into the Compose file and the waits of `nylorun local sandbox` are the
CLI's tuning: a JSON object in `NYLORUN_CLI_TUNING`, each value left out keeping
its default (`{"stack":{"healthWaitMs":120000}}`). DEPLOYMENT.md ("The CLI") lists
them. The Runtime's own are `NYLORUN_TUNING`, which `nylorun start` passes on.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure, including a missing Docker or Compose v2 |
| 2 | Usage error (including no Tenant selected, or `local delete` without `--yes`), or a removed or moved command |
| 3 | `status`: the Runtime is not answering; `tenant`, `environments`, `local sandbox`: the local Tenant is not running; `stop`/`local logs`: no Tenant yet; `local delete`: no such Tenant; `start`: a Tenant created by nylorun 0.5 (reset it) |
| 4 | The Runtime port is held by another Host |
| 5 | `up`/`start`/`studio`: this nylorun pins a Runtime older than the one that last ran the Tenant; update nylorun, or `start --allow-downgrade` |
| 7 | The containers, the Tenant or Studio did not become ready (an unavailable Tenant's cause is printed) |
| 130 / 143 | SIGINT / SIGTERM (also `tenant models set` cancelled) |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Docker missing or not running | Install or start Docker Desktop, OrbStack or Colima; `nylorun doctor` checks |
| `426` from the Runtime | Upgrade nylorun (`npx nylorun@latest start`), or pin a matching older set |
| `Refusing to start Runtime …` (exit 5) | Upgrade nylorun (`npx nylorun@latest start`); `--allow-downgrade` only when both Runtimes share the database schema |
| `Tenant … is unavailable` (exit 7) | Follow the repair it names; `nylorun local logs runtime` |
| Port conflict | Change `NYLORUN_PORT` / `NYLORUN_STUDIO_PORT` in `~/.nylorun/tenants/<name>/docker/.env` |
| Logs | `nylorun local logs runtime -f` |
| Studio login expired | `nylorun studio` |
| Which Studio is which | `nylorun local ls` lists each Tenant's Studio URL; `nylorun studio --tenant <name>` opens one signed in |
| `Tenant … was created by nylorun 0.5` (exit 3) | `nylorun local reset --tenant <name>` (its data starts fresh) |
| `tenant` or `environments`: the Tenant is not running or not open | `npx nylorun start`, then `npx nylorun status`, which shows the cause and its `repair` |
| No management key for a remote installation | Set `NYLORUN_MANAGEMENT_KEY`; on the Runtime's machine `nylorun tenant keys put <id> --management` issues one |
| `403 key_role_mismatch` | The key belongs to the other API: a management key for the Management API, an application key for the Runtime API |
| Old Project link refused | `npx nylorun start` in the project |

See [MIGRATION.md](../../guides/MIGRATION.md).
