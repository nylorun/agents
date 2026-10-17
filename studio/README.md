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

Studio lists the Tenant's sessions, sends text, displays completed
assistant responses and tool inputs/results, restores history, observes
canonical SSE events, and cancels a turn. Every session runs on an Agent
(protocol 16), and none is special (D71). **Sessions** is one table of every
session (Agent, owner, last activity, status), newest activity first; its
**Last activity** header sorts oldest first. Last activity is the session's last
committed event, else when it opened; a Runtime without `session-reads` lists no
times. The table is filtered to an Agent from its **All Agents** menu;
`/tenants/<id>/sessions?agent=<agentId>` is the filtered list. A session's page is
`/agents/<agentId>/sessions/<sessionId>` (each id one percent-encoded segment);
`/sessions/<sessionId>` finds its Agent and opens it. Each session shows chat beside
an **Events** inspector, an **Outputs** tab (the session's artifacts), a
**Manifest** tab (**Workflow** for a flow), an **Agent** tab and a **Usage** tab.
**Manifest** shows the loop manifest the session pinned when it opened
(`GET /v1/sessions/{id}/manifest`, Host feature `session-reads`; without it, the
harness section of the version its Agent runs), named `name@version`, and says when
the manifest has a newer version: an Agent keeps its version, and moves by a fork.
**Usage** shows the session's recorded model usage (tokens in and out, cache reads
and writes, reasoning tokens, cost and model calls) and each model call, read again
when a turn ends. The header's inspector button hides the inspector and gives the
chat the whole width; the browser remembers the choice. A chat message shows its
time while it is hovered or focused. The sidebar holds **New session** (a menu of
the Agents, grouped by manifest, on every page), **Sessions**, **Agents** (the
Agents grouped by the manifest each was made from, each with its state and number
of sessions) and **Agent manifests**; its header shows the Tenant and the Runtime's
status, and selecting the Tenant opens its Overview. **Models** is the one setting,
at the bottom of the sidebar. **New session** opens a session on the Agent picked
(`PUT /v1/sessions/{id} { agent }`, owner `local-developer`); an Agent whose owner
guard names another owner cannot be picked. An Agent's page has **New session** too.

A session's **Agent** tab shows where it runs: its Agent (linked to its page), its
kind, state and compute, the manifest version the session opened on beside the one
the Agent runs, the harness, sandbox and allowed hosts, what its MCP servers and
HTTP tools get from the Agent's secrets
(`POST /v1/tenant/credential-coverage { agentId }`: covered, no credential, or a
call that would fail), its latest disk version, the connections its sandbox opened
while this session's turns ran, and the other sessions on it. It only reads: a
reset, a restore or a secret change applies to every session on the Agent, so
those stay on the Agent's page. `?inspector=environment` opens it too.

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

The Agents table (`/agents`, `GET /v1/agents`) lists every Agent: its id (with its
labels), the manifest version it runs (`triage@3`, **tracks** or **pinned**), its
owner guard, its state (`working`, `sleeping`, `input_required`, `failing`,
`paused`; the reasons behind it in a tooltip), its sessions and its last activity.
Agents that need input, then those failing, come first; the rest by last activity.
It filters by state, manifest, owner and label (`?state=`, `?manifest=<name>`,
`?owner=<owner>` or `?owner=-` for none, repeated `?label=key=value`); a manifest
in the sidebar or the table filters on it, and so does a label. **New Agent**
makes one from a saved manifest: the manifest, **Track the latest** or a version to
pin, its id, owner guard (`local-developer` by default) and labels
(`PUT /v1/agents/{id} { manifest, owner?, labels? }`). Creating it opens no session.

Each Agent's page is `/agents/<id>` (the id percent-encoded as one segment), with
**New session**, **Edit labels and owner** (`PUT` with its manifest as it was made),
**Fork** (**Fork to v<n>** when its manifest has a newer version), **Stop** and
**Reset** for a pod, and **Delete**; confirmations name how many sessions run on it.
Its tabs (`?tab=`):

- **Overview**: its state and what made it (each linked to its session), its
  compute, the manifest version it runs, and its use, as fields, with its runtime
  as JSON.
- **Sessions**: the sessions on it, by last activity, each linked to its page and
  Outputs; none is marked special.
- **Secrets**: its vault, through the Runtime API
  (`PUT|DELETE /v1/agents/{id}/secrets/{name}`): a Bearer token or a Headers map
  (name and value rows) bound to a URL, with an optional gateway URL (`via`) and
  identity header, or a shell secret or variable for skills' CLIs in its sandbox
  (not offered for kind `none`). A `PUT` replaces the secret, so rotating sends the
  whole credential again. **Preview tools** on a URL-bound one lists the MCP
  server's tools behind it with the Agent's credential
  (`POST /v1/tenant/mcp/preview { url, agentId }`, Management API). Below, the slots
  its manifest declares (set, missing or not set) and what its tools get
  (`credential-coverage`). Secret reads return names, types and bindings, never
  values.
- **Disk** (not for kind `none`): its disk versions, newest first. **Snapshot
  disk** keeps one; **Restore** puts one back (a pod gets a new volume seeded
  before the next turn); **Fork** makes a new Agent whose disk starts from that
  version; **Delete** removes one; **Browse** opens the version in the artifact
  inspector (files and changes), since the versions are versions of a folder
  artifact the Agent owns.
- **Setup & files**: a pod's input files (linked to the artifact) and setup
  commands, run on a new disk; they never change.
- **Events**: manually refreshed events: all, its lifecycle (`agent.*`), or the
  connections its sandbox opened (`agent.egress`).

**Fork** (`POST /v1/agents/{id}/fork`) names the new Agent's id, the manifest
(`name` for its latest, or `name@n`), where its disk starts (a snapshot now, a disk
version, or empty) and whether the secrets the new version declares are copied;
**Check** shows the plan first (`dryRun`). The source keeps what it runs, its disk
and its sessions.

## Agent manifests

`/agent-manifests` lists the Tenant's agent manifests (`GET /v1/agent-manifests`):
each name with its latest version, the kind of Agent it makes, who saved it and
how many Agents were made from it. A manifest's page (`/agent-manifests/<name>`,
`?version=<n>`) lists its versions (with the Agents made from each), shows the
version's **Harness** section (what runs inside the loop: harness, instructions,
tools, skills, MCP servers or a flow's agents) beside its **Runtime** section (kind,
image, resources, allowed hosts, lifecycle, setup, files and secret slots), each
also as JSON, and the Agents made from the manifest. **New Agent from v<n>** makes
an Agent pinned to that version. Manifests are read only in Studio: edit one in its
repository and save its next version with `nylorun apply`.

Old links redirect, including in embeds: `/environments/<id>` and
`/environments?selected=<id>&tab=…` to the Agent's page, `/environments` to
`/agents` (its filters kept), `/settings/credentials?environment=<id>` and
`/vault?environment=<id>` to its Secrets tab (without one, to `/agents`), and
`/sandboxes` to `/agents`. Pages keep their selection and tabs in the URL.

## Artifacts

Artifacts open from where they belong: a session's Outputs tab, an
Agent's Disk tab, or its Setup & files tab; the sidebar has no entry for
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
