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
npx nylorun logs studio
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
   key changes (`nylorun reset`).
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

A Tenant with no agents shows its name, full Tenant id and Runtime connection
status, with a short link to the documentation. Developers can use the SDK, CLI
or any Runtime API client; the agent list appears when the first agent registers.
Existing sessions open with their original owner and Environment.
The dashboard calls the Runtime through
`/_studio/tenants/<id>/runtime/…`, which the server forwards with Studio's key
(`deriveStudioToken(adminKey)`, derived from the admin key in memory; role
`studio`, which reaches the Runtime API and the Management API) and no
`Nylorun-Tenant` header. No installation Runtime, admin or Tenant key ever reaches
the browser.

Studio lists the Tenant's sessions, sends text, displays completed
assistant responses and tool inputs/results, restores history, observes
canonical SSE events, and cancels a turn. **Sessions** is one table of every
session (agent, owner, status), filtered to an agent from the table or from the
agents listed under Sessions in the sidebar, with **New session** for a
registered agent; `/tenants/<id>/sessions?agent=<agentId>` is the filtered list,
and `/tenants/<id>/agents/<agentId>` opens it. Each session shows chat beside an
**Events** inspector, an **Outputs** tab (the session's artifacts), an
**Environment** tab and an optional Agent Manifest tab. The sidebar holds
**Sessions** and **Environments**; its header shows the Tenant and the Runtime's
status, and selecting the Tenant opens its Overview. **Models** is the one
setting, at the bottom of the sidebar. **New session** opens an Environment
picker first when the Tenant has Environments or the agent's MCP servers or HTTP
tools take a credential: **None** (no sandbox, no credentials) or one
Environment, with what each server and tool would get from its secrets
(`POST /v1/tenant/credential-coverage { agentId, environmentId }`): covered, no
credential (an MCP server is called without one) or a call that would fail. An
Environment whose owner guard names another owner than Studio's
(`local-developer`) cannot be picked. The session opens with `environment: <id>`.
Otherwise the session starts at once, without an Environment.

A session's **Environment** tab shows where it runs: the Environment it names
(linked to its page), its kind and state, the recipe version the session opened
on beside the current one, the harness, sandbox and allowed hosts, what this
agent's MCP servers and HTTP tools get from the Environment's secrets (the same
coverage check), its latest disk version, and the other sessions that name it.
It only reads: a reset, a restore or a secret change applies to every session
that names the Environment, so those stay on the Environment's page. A session
without an Environment says it has no sandbox and no secrets.

Settings links use `/tenants/<id>/settings/overview` and `/settings/models`
under the same Tenant prefix; a legacy `/settings` link redirects to Models.
A session paused on a tool call the Tenant's tool policy holds shows an approval card with the
tool, why it is held and its input, with **Approve** and **Deny**. Token streaming and media are
deferred.

## Environments

An Environment is where sessions run: one sandbox (kind `virtual`, `pod` or
`none`), one vault of secrets and versions of its disk. Studio shows them on one
page per Environment instead of separate Sandboxes, Credentials and Artifacts
pages. The sidebar includes Environments even before agents register.

The Environments table (`/environments`) lists each one's kind and state, recipe
version (and the version a pod still runs), owner guard, labels, sessions and
last use, with server paging and label filters. **New Environment** opens a form
built from the recipe (`PUT /v1/environments/{id}`): id, kind, image and storage
for a pod, CPUs and memory, allowed hosts, harness, a pod's setup commands
(command, directory, timeout) and input files (a Tenant-wide artifact's version
and the path it is copied to), labels, owner guard, and `lifecycle.idle` and
`lifecycle.deleteAfter`.

Each Environment's page is `/environments/<id>` (the id percent-encoded as one
segment), with **Edit recipe** (the same form; kind and storage are fixed),
**Stop** and **Reset** for a pod, and **Delete**; confirmations name how many
sessions still name it. Its tabs (`?tab=`):

- **Overview**: its sandbox, recipe and use, as fields, with the recipe as JSON.
- **Secrets**: its vault, through the Runtime API
  (`PUT|DELETE /v1/environments/{id}/secrets/{name}`): a Bearer token or a
  Headers map (name and value rows) bound to a URL, with an optional gateway URL
  (`via`) and identity header, or a shell secret or variable for skills' CLIs in
  its sandbox (not offered for kind `none`). A `PUT` replaces the secret, so
  rotating sends the whole credential again. **Preview tools** on a URL-bound one
  lists the MCP server's tools behind it with that Environment's credential
  (`POST /v1/tenant/mcp/preview`, Management API); secret reads return names,
  types and bindings, never values. There are no user or installation vaults.
- **Disk** (not for kind `none`): its disk versions, newest first. **Snapshot
  disk** keeps one; **Restore** puts one back (a pod gets a new volume seeded
  before the next turn); **New Environment** creates one whose disk starts from
  that version (`PUT … { from }`; its vault starts empty); **Delete** removes one;
  **Browse** opens the version in the artifact inspector (files and changes),
  since the versions are versions of a folder artifact the Environment owns.
- **Setup & files**: a pod's input files (linked to the artifact) and setup
  commands, run on a new disk; a change applies at the next reset.
- **Sessions**: paged sessions that name it, each linked to its page and Outputs.
- **Events**: manually refreshed lifecycle events.

Old links redirect, including in embeds: `/environments?selected=<id>&tab=…` to
the page, `/settings/credentials?environment=<id>` and `/vault?environment=<id>`
to its Secrets tab (without an Environment, to `/environments`), and
`/sandboxes` to `/environments`. Pages keep their selection and tabs in the URL.

## Artifacts

Artifacts open where they belong: a session's outputs on its Outputs tab, an
Environment's disk versions on its Disk tab, and an input file from its
Environment's Setup & files tab. `/artifacts` has no sidebar entry; it opens a
known artifact by id (`/artifacts?selected=<id>&version=<n>`) or a session's
artifacts (`?sessionId=`), which keeps existing and embedded links working. The
inspector pins a numbered version and shows metadata, version history, bounded
previews, exported folder files and changes between adjacent versions. Session
artifact events and versioned message file parts open that exact version. Text
previews stop at 256 KiB; raster images at 10 MiB. HTML and SVG appear as
escaped source. Downloads stream through the proxy as attachments using a
60-second capability minted by the existing Runtime API, including in embeds. No
full-file browser buffer is used for downloads.

A Tenant-wide artifact table awaits the public paged artifact API described in
[API_REQUIREMENTS.md](API_REQUIREMENTS.md). Studio never requests an unbounded
tenant artifact list or accesses databases, Kubernetes or object storage.
Artifact uploads, deletion and sharing are deferred.

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
