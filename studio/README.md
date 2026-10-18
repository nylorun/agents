# @nylorun/studio

The Studio server: the session dashboard and the trusted Runtime proxy on one
origin. It ships only as the `ghcr.io/nylorun/studio` image, which each local
Tenant runs as its `studio` Compose service. This workspace package is private
and is not published to npm. It depends only on `@nylorun/agents` and
`@nylorun/admin` among Nylorun packages. Vocabulary:
[runtime/server/src/CONTEXT.md](../runtime/server/src/CONTEXT.md).

## Using Studio

Developers never install this package. `nylorun` runs it for each Tenant:

```sh
npx nylorun start      # starts the project's Tenant, including Studio, and opens it signed in
npx nylorun studio     # signs a browser in
npx nylorun status     # reports Studio's health and URL
npx nylorun local logs studio
```

Studio publishes on loopback (`127.0.0.1:4161` by default) and the CLI opens it
as `http://localhost:<port>`. Each local Tenant's Studio has its own port and
session cookie; `nylorun studio --tenant <name>` opens any of them signed in.

## Login and access

Studio on this machine needs no sign-in: a request on the published loopback
address (`localhost` or `127.0.0.1` at Studio's port) with no session is served
as signed in, for the whole Tenant and no subject. A host in
`NYLORUN_STUDIO_ALLOWED_HOSTS` (a sign-in proxy) and an embedded Studio keep
their sign-in, below.

1. The CLI asks Studio for a login token: `POST /_studio/login-tokens` with the
   Host's admin key. The token is 256 random bits, single-use, and valid for
   two minutes. Its login URL is on the origin the CLI called (`localhost` or
   `127.0.0.1`).
2. The CLI opens `/login?token=…` (optionally `&next=/tenants/<id>`) in the
   browser and prints only Studio's origin. Studio consumes the token, sets an
   `HttpOnly`, `SameSite=Strict` session cookie for 30 days and redirects to
   `next` or `/`.
3. Except for an existing public Runtime artifact capability download, every `/_studio/*` request needs that cookie (or an embedded session's
   bearer, or the loopback address). The dashboard's files carry no data and the `/` redirect names only
   the Tenant id, so they need none. The `Host` header must be `localhost` or
   `127.0.0.1` on the published port, or a host in
   `NYLORUN_STUDIO_ALLOWED_HOSTS` (any other answers `421`);
   state-changing requests must carry the request's own `Origin`; Studio never
   sends CORS headers.
4. The session cookie (`nylorun_studio_session`, or
   `NYLORUN_STUDIO_SESSION_COOKIE`) is `v1.<issued>.<nonce>.<signature>`, an
   HMAC-SHA256 with a key derived from the admin key. Studio keeps no session state, so a
   session survives container restarts and ends after 30 days or when the admin
   key changes (`nylorun local reset`).
5. Behind a sign-in proxy, a request with no session that carries a JWT
   (`X-Forwarded-Access-Token`, or an `Authorization` bearer that is not a
   Studio session) signs in once the Runtime's `GET /v1/me` verifies it and
   reports the `studio` scope: Studio sets the same cookie, as
   `v3.<claims>.<signature>` naming the subject (for its log of state
   changes) and ending no later than the token. Without the scope it answers
   `403`; a token the Runtime refuses gets `401`. See
   [Studio behind a sign-in proxy](../guides/DEPLOYMENT.md#studio-behind-a-sign-in-proxy).

Studio serves its installation's one Tenant: there is no Tenant list, picker
or create. It reads the Tenant from the Runtime's `GET /v1/tenant` with its own
key, and `/` redirects to `/tenants/<id>`. While the Host cannot open its
Tenant, `/` answers `503` and points to `nylorun status` for the cause, the
dashboard shows the same, and Studio asks the Runtime again on the next request. The `/tenants/<id>` routes
and the `tenant` claim of embed login tokens stay (the embed contract); they
must name that Tenant, and any other id is an unknown Tenant (`404`).

A Tenant with no Agents and no sessions shows its name, full Tenant id and Runtime
connection status, with a short link to the documentation; the Agents appear when the
first is made. Existing sessions open with their original owner and Agent.
The dashboard calls the Runtime through
`/_studio/tenants/<id>/runtime/…`, which the server forwards with Studio's key
(`deriveStudioToken(adminKey)`, derived from the admin key in memory; role
`studio`, which reaches the Runtime API and the Management API) and no
`Nylorun-Tenant` header. No installation Runtime, admin or Tenant key ever reaches
the browser.

Studio lists the Tenant's Agents and their sessions, sends text, displays completed
assistant responses and tool inputs/results, restores history, observes
canonical SSE events, and cancels a turn. Every session runs on an Agent
(protocol 16), and none is special, so an Agent's sessions are on its page: the
**Sessions** tab lists them (owner, last activity, status), newest activity first.
Last activity is the session's last committed event, else when it opened; a Runtime
without `session-reads` shows no times. Studio opens on the Agents list; `/sessions`
opens it too, and `/sessions?agent=<agentId>` opens that Agent's page. A session's page is
`/agents/<agentId>/sessions/<sessionId>` (each id one percent-encoded segment);
`/sessions/<sessionId>` finds its Agent and opens it. Each session shows chat beside
an inspector of four tabs, one per kind of data and the same for agent and workflow
sessions: **Manifest** (what the agent is), **Record** (what the session holds),
**Events** (what happened) and **Usage** (what it cost). `?inspector=` names the tab
and `?view=` its view. **Manifest** has two views. **Declared** shows the loop
manifest the session pinned when it opened (`GET /v1/sessions/{id}/manifest`, Host
feature `session-reads`; without it, the harness section of the version its Agent
runs), named `name@version`, and says when the manifest has a newer version: an
Agent keeps its version, and moves by a fork. **Deployed** shows where it runs (below).
**Record** lists the session's artifacts (outputs and uploads). **Events** is the session's
event log; a workflow session adds **Progress** (its tree, live) and **Iterations**,
and opens on Progress.
**Usage** shows the session's recorded model usage (tokens in and out, cache reads
and writes, reasoning tokens, cost and model calls) and each model call, read again
when a turn ends. The header's inspector button hides the inspector and gives the
chat the whole width; the browser remembers the choice. A chat message shows its
time while it is hovered or focused. Each sidebar item opens the page it names:
**Agents** opens the Agents list, and each Agent under it (with its state, and how many
of its sessions wait on a person) opens its page; **Manifests** and **Models** are
below them. The sidebar's header shows the Tenant and the Runtime's status, and
selecting the Tenant opens its Overview. A session always runs on one Agent, so it
starts from one: hovering an Agent in the sidebar shows a **+** that opens a new
session on it (`PUT /v1/sessions/{id} { agent }`, owner `local-developer`), as do the
Agent page's **New session** and the **New session** of its row's ⋯ in the Agents list.
An Agent whose owner guard names another owner offers none.

A session's **Manifest** tab, under **Deployed**, shows where it runs: its Agent (linked to its page), its
kind, state and compute, the manifest version the session opened on beside the one
the Agent runs, the harness, sandbox and allowed hosts, what its MCP servers and
HTTP tools get from the Agent's secrets
(`POST /v1/tenant/credential-coverage { agentId }`: covered, no credential, or a
call that would fail), its latest disk version, the connections its sandbox opened
while this session's turns ran, and the other sessions on it. It only reads: a
reset, a restore or a secret change applies to every session on the Agent, so
those stay on the Agent's page. The tab names before the four tabs still open their
place: `?inspector=agent` (or `environment`) opens Deployed, `artifacts` opens Record,
and `tree` and `iterations` open Events' workflow views.

Settings links use `/tenants/<id>/settings/overview` and `/settings/models`
under the same Tenant prefix; a legacy `/settings` link redirects to Models.
Tool calls show the tool by its identity: an MCP tool as `server / tool` (the server's own name
for it), with the name the model called it by when that differs, such as
`github / create_issue (as github__create_issue)`; any other tool by the model's name.
A session paused on a tool call the Tenant's tool policy holds shows an approval card with the
tool by the same identity (and what the model called it), why it is held and its input, with
**Approve** and **Deny**. Token streaming is deferred.

### Attachments

The message card's paperclip, a paste or a drop attaches files; each shows as a chip
(an image's thumbnail, else a file icon, with its name and size) until the message is
sent. Any file goes, whatever the active model reads (protocol 15): the agent's
harness decides how its model sees each one, and tells the model when it cannot read
one. Studio sends files as they are: it resizes and converts nothing. On **Send** each new file is uploaded into the session
(`POST /v1/artifacts?name=…&sessionId=…` through the proxy, which checks the session
exists, needs a `Content-Length` and streams the bytes, refusing a file over
`maxUploadBytes` when the Studio server sets one; it has no default, so a file is held only to
the Tenant's artifact limits, `/v1/tenant/artifacts`), then the message goes as text and file parts
(`session.inputParts`). When the message fails, the draft and its chips stay, and a
resend reuses the files already uploaded. In the chat, a message's files
show their name, type and an image's thumbnail, and open the artifact.

**Models** shows each connected provider's model's **Inputs** (protocol 12): what its
catalog reads (its `inputs` less `addableInputs`) checked and fixed, and what the
operator may add (`addableInputs`: images, PDF, Office documents, audio or video,
as the model's API carries them) as checkboxes that call `models.setInputs()`. A type
the model neither reads nor may add is not shown. The custom endpoint's form sets
Images, PDF, Audio and Video in `settings.inputs` (text only when none).

## Agents

An Agent (protocol 16) is the live instance of one version of an agent manifest:
its compute (kind `virtual`, `pod` or `none`), one vault of secrets, versions of
its disk, and the sessions that run on it. It is made only from a saved manifest,
tracking it (`name`: its latest version, and each version saved later) or pinned
(`name@n`), and moves in place: its page moves it (Move to vN, Pin, Track), restarts
a pod on a version waiting for its next start, and retries one that failed to start.

The Agents table (`/agents`, `GET /v1/agents`), where Studio opens, lists every Agent
in single-line rows: its id (with its labels), the manifest version it runs
(`triage@3`, **tracks** or **pinned**), its state (`working`, `sleeping`,
`input_required`, `failing`, `paused`; the reasons behind it in a tooltip), its kind,
its sessions (and how many wait on a person) and its last activity; a row opens its
page, and its ⋯ opens it, starts a session on it or copies its id.
Agents that need input, then those failing, come first; the rest by last activity.
It filters by state, manifest, owner and label (`?state=`, `?manifest=<name>`,
`?owner=<owner>` or `?owner=-` for none, repeated `?label=key=value`), and its search
by id or manifest; a manifest in the table filters on it, and so does a label. **New Agent**
makes one from a saved manifest: the manifest, **Track the latest** or a version to
pin, its id, owner guard (`local-developer` by default) and labels
(`PUT /v1/agents/{id} { manifest, owner?, labels? }`). Creating it opens no session.

Each Agent's page is `/agents/<id>` (the id percent-encoded as one segment): an
instance of one agent manifest version, with what it holds. Its header names that
version (linked to it), whether it tracks the manifest or is pinned, its kind, owner
guard and labels, with **New session** and a ⋯ menu: **Edit labels and owner** (`PUT`
with its manifest as it was made), **Stop compute** and **Reset disk** for a pod,
**Fork into a new Agent** and **Delete Agent**; confirmations name how many sessions
run on it. The app header's Refresh reads the page and its open tab again.

Its tabs (`?tab=`) are one full-width table each, of single-line rows, with a search,
filter menus and a count; a row's actions are behind its ⋯ and a row opens its
details in a panel on the right. It opens on its sessions:

- **Sessions**: the sessions on it, by last activity, filtered by who started them
  and their status; a row opens the session. None is marked special.
- **Triggers**: what starts its turns with no client connected
  (`GET /v1/agents/{id}/triggers`): each trigger's schedule in words, the session its
  runs go to, its next run and status, with **Run now**, **Pause**, **Resume** and
  **Copy webhook URL** (`POST …/triggers/{id}/run|pause|resume`); its panel shows the
  prompt its manifest version gives it. Below, every run, newest first
  (`GET …/runs`), filtered by trigger and result.
- **Artifacts**: what its sessions made, read one session at a time
  (`GET /v1/artifacts?sessionId=…`), and the input files its runtime copies in,
  filtered by source and session; a row opens the artifact inspector.
- **Memory**: what it keeps across every session (`GET …/memories`), each memory
  with its description, version and who changed it last (`GET …/memory_versions`),
  filtered by who changed it; a row opens its content and history, and **Delete**
  removes one (`DELETE …/memories/{path}`).
- **Disk** (not for kind `none`): its disk versions, newest first. **Snapshot now**
  (the toolbar's ⋯) keeps one; a row's **Restore** puts one back (a pod gets a new
  volume seeded before the next turn), **Fork into a new Agent** makes one whose disk
  starts from that version, **Delete** removes one, and **Browse** (or the row) opens
  the version in the artifact inspector (files and changes), since the versions are
  versions of a folder artifact the Agent owns.
- **Activity**: its events, newest first, read on from the last one it holds: its
  lifecycle (`agent.*`) and the connections its sandbox opened (`agent.egress`),
  filtered by type and result; a row opens the event.
- **Vault**: the slots its manifest version declares, each with its type, what in
  the harness uses it and whether the vault holds a value. Everything but the value
  is the manifest's, so **Set value** asks only for it (a token, a secret value, a
  variable's value, or a headers slot's name and value rows) and sends
  `PUT /v1/agents/{id}/secrets/{name} { value }` (or `{ headers }`); the panel shows
  what the manifest says of the slot (its description, what uses it, where it is
  sent and how, and whether it is required). A secret no slot declares can only be
  deleted. Secret reads return names, types and bindings, never values.
- **Manifest**: the version it runs as a readable spec, with an outline: its harness
  section (instructions, tools, skills, MCP servers, memory), then its runtime section
  (compute, lifecycle, network, setup and input files, vault slots, triggers,
  limits), each item on one line with a quiet note of what it is now. A row opens its
  part of the manifest as JSON. The ⋯ menu moves the Agent within its manifest
  (**Pin**, **Track the manifest**, **Move to v<n>**, **Restart**, **Retry**), shows
  the whole manifest, or opens all its versions.

The tabs it had before still open their place: `?tab=overview` opens Sessions,
`secrets` Vault, `setup` Manifest and `events` Activity.

**Fork** (`POST /v1/agents/{id}/fork`) names the new Agent's id, the manifest
(`name` for its latest, or `name@n`), where its disk starts (a snapshot now, a disk
version, or empty) and whether the secrets the new version declares are copied;
**Check** shows the plan first (`dryRun`). The source keeps what it runs, its disk
and its sessions.

## Agent manifests

`/agent-manifests` lists the Tenant's agent manifests (`GET /v1/agent-manifests`) in
single-line rows: each name with its description, latest version, the kind of Agent it
makes (`flow · …` for a flow), how many Agents were made from it and when it was saved
(and by whom, on hover), searched by name or description and filtered by kind, type
(Agent or flow) and whether any Agent was made from it. A row opens the manifest beside
the list (`?selected=<name>&version=<n>`; the list keeps its name, version, kind and
Agents): a version picker, its description, the Agents made from it (each linked to its
page, with the version it runs), and the version as a readable spec, its **Harness**
section (instructions, tools or a flow's agents, skills, MCP servers, memory) then its
**Runtime** section (compute, lifecycle, network, setup and input files, vault slots,
triggers, limits), one line each; a line opens its part of the manifest as JSON. Its ⋯
makes an Agent pinned to the version shown (**New Agent from v<n>**), shows the whole
manifest as JSON, or copies its name. `/agent-manifests/<name>` opens it so too.
Manifests are read only in Studio: edit one in its repository and save its next
version with `nylorun apply`.

Old links redirect, including in embeds: `/environments/<id>` and
`/environments?selected=<id>&tab=…` to the Agent's page, `/environments` to
`/agents` (its filters kept), `/settings/credentials?environment=<id>` and
`/vault?environment=<id>` to its Vault tab (without one, to `/agents`), and
`/sandboxes` to `/agents`. Pages keep their selection and tabs in the URL.

## Artifacts

Artifacts open from where they belong: a session's Record tab, an
Agent's Artifacts and Disk tabs; the sidebar has no entry for
them. `/artifacts` is every artifact the Tenant holds, newest first, 50 at a
time with **Load more** (`GET /v1/artifacts?limit=50`, Host feature
`artifact-reads`), filtered by kind, session and labels (`?kind=`,
`?sessionId=`, repeated `?label=key=value`). Each row names its owner: a session
(linked to it), an Agent's disk (`artifact.agentId`, linked to its Disk tab), or
the Tenant itself, such as an input file an application uploaded for a pod. A Host
without `artifact-reads` gets a session lookup instead, and Studio never reads the
unbounded list. Any artifact also opens by id
(`/artifacts?selected=<id>&version=<n>`), which keeps existing and embedded
links working.

The inspector pins a numbered version and shows metadata (with its owner),
version history, bounded previews, exported folder files and changes between
adjacent versions. Session artifact events and versioned message file parts open
that exact version, as do the artifacts a harness stored a large tool result in: a tool call
links each artifact its result names (`{artifactId, version, size}`, whole or per part). Text previews stop at 256 KiB; raster images at 10 MiB. HTML
and SVG appear as escaped source. Downloads stream through the proxy as
attachments using a 60-second capability minted by the existing Runtime API,
including in embeds. No full-file browser buffer is used for downloads. Studio
never accesses databases, Kubernetes or object storage. Uploads are a message's
attachments only; deletion and sharing are deferred.

Run `npm run check --workspace @nylorun/studio` for package and unit checks, and
`npm run test:e2e --workspace @nylorun/studio` for public-API browser fixtures
(requires Playwright Chromium).

## The image

```sh
docker build -f studio/Dockerfile -t nylorun-studio:dev .   # from the repository root
NYLORUN_STUDIO_IMAGE=nylorun-studio:dev nylorun start        # run it for the Tenant
```

The container entry is `dist/server-main.js`:

| Variable | Meaning |
| --- | --- |
| `NYLORUN_RUNTIME_URL` | The Runtime, e.g. `http://runtime:4000` (required) |
| `NYLORUN_ADMIN_KEY_FILE` | `host-credentials.json`, mounted read-only (required) |
| `PORT` | Listen port inside the container (default `3000`) |
| `NYLORUN_STUDIO_PUBLIC_PORT` | The published loopback port the browser uses |
| `NYLORUN_STUDIO_ALLOWED_HOSTS` | Extra `Host` values Studio serves behind a sign-in proxy, comma-separated, such as `studio.acme.dev` (default none). See [Studio behind a sign-in proxy](../guides/DEPLOYMENT.md#studio-behind-a-sign-in-proxy) |
| `NYLORUN_STUDIO_SESSION_COOKIE` | The session cookie's name, `[A-Za-z0-9_-]+` (default `nylorun_studio_session`). `nylorun start` sets `nylorun_studio_<tenant>`: browsers share cookies across ports, so Studios on one host need their own |
| `NYLORUN_STUDIO_FRAME_ANCESTORS` | Exact origins that may frame the dashboard (default none) |
| `NYLORUN_STUDIO_ANALYTICS_ID` | Google Analytics measurement id for anonymous page views (default none: no analytics). `nylorun start` sets it unless telemetry is off; see [Telemetry](../cli/nylorun/README.md#telemetry) |

`npm run build` type-checks and builds the server (`dist/*.js`) and the
dashboard (`dist/web`). `startStudioServer()` is exported for tests.

For repository development, see [CONTRIBUTING](../CONTRIBUTING.md).
