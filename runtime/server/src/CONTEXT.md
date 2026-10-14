# Runtime Clients vocabulary

Terms follow the Runtime Tenants model, Runtime Clients, the Runtime and
Management APIs (protocol 8), and the Runtime architecture (Postgres, Restate,
S2). Every agent uses these terms in code, comments, errors and CLI output.

An agent definition is its manifest (manifest 7, flat): instructions, tools, skills and MCP
servers. The harness engine advances execution.
A **Runtime Host** listens once and serves the one **Tenant** of its
installation: one Runtime with its own database and infrastructure. A developer
**Project** attaches through a **Project link**, not by owning the Host process
or its storage. Every process that talks to a Runtime is a **Client**.

## Language

**Client**: Any process that talks to a Runtime over HTTP — a developer
application, Studio, the CLI, a desktop app, an IDE extension or CI.
_Avoid_: calling only the SDK or only the CLI "the client".

**Runtime API**: The Tenant's routes for developers' apps and browsers: everything under
`/v1` except `/v1/tenant/*` (protocol 8). Agents and their definition files, sessions with
AG-UI and A2A, Environments and their secrets, artifacts, `/v1/me` and the public JWKS
(`/v1/access/jwks`). It
takes application keys and trusted issuers' tokens; a management key here is `403
key_role_mismatch` (except `/v1/me` and the JWKS).
Nothing in a request selects the Tenant (protocol 5). Client package: `@nylorun/agents`.
Reference: `/openapi/runtime.json` (alias `/openapi.json`).
_Avoid_: "Tenant API" for the whole surface (say which API), "SDK API" or "application API".

**Management API**: The Tenant's routes for operators, `/v1/tenant/*` (status, seed and
reset, models, usage and budgets, credential coverage, MCP server previews, signing keys, sandbox backend, Environment and
artifact settings, application keys) (protocol 8; its routes' credentials are `management`, `RouteAccess` in
`api/http/define.ts`). It takes management
keys only: an application key,
alone or acting for a subject, is `403 key_role_mismatch`. Client package: `@nylorun/admin`.
Reference: `/openapi/management.json`.
_Avoid_: "Admin API" (removed), "Tenant settings API".

**Client package**: `@nylorun/agents` (the Runtime API) or `@nylorun/admin` (the
Management API) — a library a client imports to call one API. Each depends only on
`@nylorun/core`.
_Avoid_: depending on `runtime` or `harness` from application code.

**Local Tenant**: The Tenant of an installation that `nylorun start` (the `nylorun`
package, `cli/nylorun/src/stack/`) runs on a developer machine: the Runtime image with
Postgres, Restate and S2 in Docker Compose. One per project by default; outside a
project, or with `start --no-link`, the Tenant `default`. Its name is the Tenant's name:
`--tenant`, else `NYLORUN_TENANT`, else the Project link's `tenant`, else (on `start`)
the project directory's; a name starting with `tn_` (a Tenant id) is refused. It has its
Compose project `nylorun-<name>`, its Host root `~/.nylorun/tenants/<name>/` (with
`tenant.json`), ports and volumes. Docker names are global on the engine, so its
containers, network and volumes are named `nylorun-<name>-<role>` (`nylorun-shop-studio`,
volume `nylorun-shop-postgres`, network `nylorun-shop`) and labelled
`dev.nylorun.tenant: <name>`. Its Runtime creates the Tenant and its id on first
start. Local Tenants start and stop only when the developer says so. Each Tenant's Studio
is on its own port, `http://localhost:<port>`, with its own session cookie.
`@nylorun/runtime` is a library with no bin; the Runtime runs as the
`ghcr.io/nylorun/runtime` image.
_Avoid_: stack; "native Host", or installing `@nylorun/runtime` globally.

**Prerequisites**: What a developer installs before using the Runtime: Node 24
or newer and Docker, on macOS or Linux; Windows developers use WSL2. A missing
prerequisite is an error naming what to install.
_Avoid_: "bootstrap" for installing the Runtime.

**Local Host settings**: `host.json` in the Host root and the credentials files
beside it. `@nylorun/admin` reads them for local connection resolution: the URL
from `host.json` (`host`, `port`), the management key from the linked Project's
`.nylorun/credentials.json`, else `project-credentials.json`, else
`cli-credentials.json`.

**`nylorun-operate`**: The Runtime image's operator command (`host/operate.ts`), run
inside the runtime container (`docker compose exec runtime nylorun-operate …`,
`kubectl exec … -- nylorun-operate …`; `nylorun status` and `nylorun key` run it on a
local Tenant). It reads the Tenant's database from `NYLORUN_DATABASE_URL`, does one job
and exits: `status [--json]` (version, protocol, the Tenant's id, name, state and cause;
exit 2 when it is not open, needing no key) and `keys list | put <id> [--role
application|management] | rm <id>`. Being able to run it is the authorization: it is the
only way, with the bootstrap secret, to issue a management key.
_Avoid_: "Admin API" or "operator listener" for Host work (both removed).

**Runtime Host** (or **Host**): The code in every Runtime process that listens,
validates `Nylorun-Protocol`, and forwards the `/v1` routes of both APIs to its one
Tenant Runtime, which it opens at start (`host/create-host.ts`: the listener and the
`Host` check; `host/app.ts`: the rest of the pipeline, a Hono app). It has one listener
(protocol 8). A protocol 4 `Nylorun-Tenant` naming another Tenant gets the opaque `404`.
Only `host/` and `api/` import Hono. `/health` reports `service: "nylorun-runtime"`,
`hostId` and protocol range; `/ready` reports the Tenant, Postgres and Restate, never S2
(`infra/readiness.ts`, D48), and `harness: { mode, connected }` while the Tenant is open. It
stops on SIGTERM. The Tenant's data is its Postgres database; the Host keeps its
key and logs under `tenant/` in its Host root (`NYLORUN_HOME`, or a
local Tenant's `~/.nylorun/tenants/<name>/`). `nylorun start` writes `host.json` and
`host-credentials.json`.
_Avoid_: calling the Host a "scope", "project Runtime", or "global Runtime".

**Tenant**: One isolated unit of sessions, principals, Environments with their vaults and
logs: the one Tenant of an installation, its state in the Postgres schema
`nylorun` of its own database (the `nylorun.tenant` row holds its envelope), its record in
`nylorun_streams`, and the Tenant directory `<host root>/tenant/`. The Host creates it on
first start (`store/postgres/tenant.ts`: `NYLORUN_TENANT_ID`, `NYLORUN_TENANT_NAME`, its
Studio principal). Nothing in a request selects it. Ids match `tn_` plus 26
Crockford characters; the id stays as identity (token issuers, keys, basins). A Tenant
that cannot be opened fails the Host's readiness with its cause (`tenant/cause.ts`).
_Avoid_: "scope" as the name for this unit.

**Tenant Runtime**: The in-process handler for one open Tenant. Created from a
`TenantConfig` (paths, model, sandbox, child env, logger). It authenticates its
own principals and never reads ambient environment, cwd, or home. The routes of
both APIs are in `api/`: the `/v1` HTTP routes (`api/http/`), the AG-UI
endpoint (`api/ag-ui/`) and the A2A endpoint (`api/a2a/`).
_Avoid_: equating "Runtime" alone with a single Project's process.

**Host root**: The absolute directory that holds Host files, the Tenant directory
`tenant/` and, for a local Tenant, its Docker Compose files in `docker/`. Resolved once from `NYLORUN_HOME`, or for a local Tenant
`~/.nylorun/tenants/<name>/`. A local Tenant bind-mounts it into the Runtime container
at `/nylorun`.

**Project link**: Project-local `.nylorun/link.json` with
`{ format: 3, tenant, tenantId, hostUrl, hostId }` (`tenant` is the local Tenant's
name, absent for an installation that is not local; `tenantId` is information:
nothing selects a Tenant), plus `.nylorun/credentials.json` (mode 0600, format 1)
holding the application key `project` and the management key `project-management`, with
their ids (`applicationKey`, `principalId`, `managementKey`, `managementPrincipalId`).
`nylorun start` writes both, and keeps the credentials while both keys still
authenticate. A
link below format 3 is from an older nylorun; clients refuse it and `nylorun start`
replaces it. A fresh clone or second worktree does not attach until `nylorun start`
creates its Tenant, or `nylorun start --tenant <name>` attaches it to an existing one.
_Avoid_: naming isolation by Project-local vs shared home layout; removed CLI
flags and env vars that selected a database path.

**Key role**: What a key in the `principals` table may reach (`principals.role`,
`KEY_ROLES` in `@nylorun/core`, protocol 8): `application` (the Runtime API),
`management` (the Management API) or `studio` (both; only the Studio principal). Each
route's credentials say which roles reach it (`RouteAccess`, `api/http/define.ts`;
`tenant/auth.ts` maps the role); a valid key of the wrong role
is `403 key_role_mismatch`, naming the API it belongs to, and an unknown key is `401
credential_invalid` (protocol 9). A rotated key keeps its role; putting an id that holds the other role is
refused.

**Application key** (or **application principal**): A key with role `application`,
hashed in the Tenant's `principals` table and named by its principal id
(`^[a-z][a-z0-9-]{0,31}$`). It reaches the Runtime API: definition, session,
sandbox and artifact routes. May act for a **subject** on any request, which only narrows
what it can reach. Issued by a management key (`PUT /v1/tenant/keys/{keyId}`,
`admin.keys.put`), or on the machine (`nylorun tenant keys put <id>`, `nylorun-operate keys
put`); the key is returned once and only its hash is kept, and a rotated or deleted key
stops authenticating on its next request (`tenant/operator-keys.ts`). App servers hold
them (`NYLORUN_SERVER_KEY`).
_Avoid_: "operator key" (the protocol 7 name), "server token" / `serverToken` as the
public name (legacy API).

**Management key**: A key with role `management`. It reaches the Management API
(`/v1/tenant/*`) and `/v1/me` only, as itself: with `Nylorun-Subject` or
`Nylorun-Scopes` it is `403 subject_invalid`, with an `Origin` `403 origin_rejected`.
`/v1/me` reports it as `via: management:<id>`, with no scopes and no agents. Issued only
on the Tenant's machine (`nylorun tenant keys put <id> --management`, `nylorun-operate keys put
<id> --role management`) or from the **bootstrap secret** (`NYLORUN_MANAGEMENT_KEY_FILE`,
64 hex characters, registered as the key `bootstrap` at every start and replaced when the
file changes). No API call creates, rotates or deletes one, so a leaked key cannot mint
another. `nylorun start` keeps `project-management` for a Project and `cli-management`
outside one; `@nylorun/admin` reads it from `NYLORUN_MANAGEMENT_KEY` or those files.
_Avoid_: using one for an app server or a browser; "admin key" for it.

**Subject**: The person an application principal acts for, named with
`Nylorun-Subject` (feature `subject-headers`, `tenant/auth.ts`). Chosen by the
integrator (`app:42`); 1–200 visible ASCII characters, `host` and `installation`
reserved (`host` owns the host model's vault; `installation` is a session for no person). A subject reaches only sessions whose
`ownerUserId` is the subject; another owner's resource is the same `404` as a
missing one. No subject reaches the Management API (protocol 8). Only
application keys may send it; with a management key it is `403`.
A **trusted issuer**'s token names its subject itself.
_Avoid_: "user" for the header value (the Runtime has no user accounts).

**Environment**: Where sessions run (D55, protocol 11, `tenant/environments.ts`, the
`environments` table): one sandbox, of kind `virtual` (a just-bash workspace in the harness
container), `pod` (an agent-sandbox pod with its own volume; see **Pod Environment**) or `none` (no
compute), with what it runs (its `recipe`, the view's `manifest`) and one **vault** (D56). `PUT`/`GET`/`DELETE
/v1/environments/{id}`, `GET /v1/environments?label=k=v`, `POST .../stop|reset`; ids are
`/`-separated segments, sent percent-encoded as one path segment. It is made from one version of an
**Environment manifest** (`manifestName`, `manifestVersion`) or from inline fields, and never
changes what it runs after that (protocol 14, D63): a `PUT` on an existing id may change labels and
the owner guard, fields that match are accepted, and anything else is `409 environment_immutable`.
`recipe` and `applied` stay equal (egress-gate reads `applied.network`), and `version` stays 1;
`manifestHash` hashes what it runs. When what it runs declares secret **slots** (`recipe.secrets`,
D64), a secret write sends only the value (`secretRequestFor`) and a name it does not declare is
`409 secret_not_in_manifest`. A session names
one with `environment` (`Session.environmentId`) and pins its sandbox spec then
(`Session.sandbox`, `sandbox/resolve.ts` `sandboxSpecOf`); its workspace is keyed by the
Environment's id, so its sessions share files, and deleting a session only detaches it. Its
sessions run their turns at the same time (D66; one turn per session stays); a turn start checks a
token caller's grants, a disk copy in progress and the **owner guard**
(`ownerUserId`: only that owner's sessions may name it; `403 environment_owner_mismatch`, the
opaque `404` to a caller acting for a person) in `checkEnvironmentTurn`. `lifecycle.idle` (at most
the Tenant's) stops a pod; `lifecycle.deleteAfter` deletes an Environment unused that long, counted
from `lastUsedAt` (a turn's end, a `PUT`, a secret write, a stop or reset) by the Tenant sweep
(`sweepUnusedEnvironments`). The Tenant holds at most `limits.environments` (default 100).
Lifecycle events (`environment.created`, `.attached`, `.detached`, `.deleted` and a pod's) go to
its own stream in the record (`nylorun_streams.environment_events`, `record/environment.ts`), not
relayed to S2; the session's log records `environment.attached`. Every egress connection goes
there too (`environment.egress`, see **Egress event**); `GET .../events` filters by `types`, `since`
and `until`.
_Avoid_: "scope" for who uses an Environment (the app maps people to ids), "space", "sandbox
resource" (protocol 10).

**Environment manifest**: A named, versioned definition of a kind of Environment (protocol 14,
D63, `tenant/environment-manifests.ts`, the `environment_manifests` table), saved like an agent
with `PUT /v1/environment-manifests/{name}`: a save whose hash equals the latest's answers it
`unchanged`, any other writes the next version, under `If-Match` (`412 manifest_changed`) and with
a plan on `?dryRun=true`. A version records `savedBy` and is never changed; a save changes no
Environment. `DELETE` removes every version, refused while an Environment names one
(`409 manifest_in_use`). An agent manifest's `requires` (D65) is checked against the session's
Environment when the session opens (`409 environment_unsuitable`, `tenant/sessions.ts`).
_Avoid_: "recipe" for the manifest (the recipe is what one Environment runs), "template".

**Disk setup**: A pod Environment's `files` and `setup` (R2d step 2, `sandbox/setup.ts`,
`harness/setup.ts`), run once per new disk: the join answer carries the plan (`setupPlanOf`), the
engine copies the input files through `GET host/files/{index}` and runs the commands before it
serves a turn, marking the volume (`/harness/setup.json` with the volume id). A failure is
`POST host/setup`: the pod is `observed: failed` with reason `setup: …`, kept while it is ready
until a turn start asks it to run again, when `GET host/setup` tells the engine to retry. A volume
seeded from a disk version skips it.

**Disk version**: A version of an Environment's disk (R2d step 3, `artifacts/disk.ts`,
`sandbox/disk-fs.ts`): a version of the folder artifact the Environment owns
(`artifacts.environment_id`), manifest `nylorun.folder.v2` with modes, file times, links and empty
directories, its files content-addressed and shared with every other folder version. Disk work
holds the Environment's **disk lease** (`environments.disk_op`: snapshot, restore or seed, with a
heartbeat), refused while any session's turn runs and refusing turns (`409 environment_busy`). A snapshot lists and
reads the disk through the workspace (`SandboxManager.disk`, over the Harness API for a pod) in
8 MiB ranges. A restore rewrites a virtual workspace at once; for a pod it takes a new volume
(`newVolume`) with `disk_seed`, which `runPendingSeed` writes once the new pod's engine connects
(started at join, swept by the Tenant sweep), turns waiting meanwhile. `from` on a create seeds a
new Environment the same way, and a lost volume with a version is recovered from the latest one
(`recoverLostVolume`). The engine's own files (`volume-id`, the trust bundle, the setup marker,
`sandboxes/`) are never in a version.
_Avoid_: "snapshot" for the stored thing (a snapshot is the act; the result is a disk version),
"checkpoint".

**Vault**: One Environment's secrets (D56, `vault/service.ts`): a `vaults` row whose
`environment_id` names its Environment (unique, deleted with it), created in the transaction that
creates the Environment. Its credentials are written on the Runtime API with
`PUT /v1/environments/{id}/secrets/{name}` (an application key, or `environments:write`; through
the keys service, `Keys.putEnvironmentSecret`), replaced by name, and never read back; a second
`environment_secret` for a host or a second `bearer`/`headers` credential for a URL is `409
credential_conflict` at the write. The `host` vault (no Environment) holds the model credential
and is never written this way. There are no user or installation vaults (protocol 11).
_Avoid_: "attach a vault" (protocol 10), "shared vault", "org vault".

**Session credentials**: Where a session's MCP servers and HTTP tools get their credentials:
the vault of the session's Environment, matched by the URL the manifest names (`vault/sources.ts`,
`sessionCredentials` over `VaultService.authorize`), in the gateway or in process; a session
without an Environment sends none. OSS holds no OAuth client and asks no credential resolver
(protocol 10, D49): a person's own keys go in the Environment the app maps to them. A credential is a `bearer` token or a
`headers` map; its **via** sends the server's requests elsewhere (an MCP gateway) while the manifest's
URL still picks it, and its **identity header** carries the session owner's subject (none for an
`installation` session). A `401` is the tool error `credential_rejected` (R2b C1, C2). **Credential
coverage** (`POST /v1/tenant/credential-coverage`, `VaultService.coverage`, `vault/coverage.ts`)
answers ahead of a session what each URL an agent names would get in a given Environment
(`covered` or `missing`), decided as a call decides it, with no secret read. A server
that takes only a person's OAuth sign-in is reached through an **MCP gateway**; the operator's
guide, with recipes, is "MCP servers and HTTP tools" in DEPLOYMENT.md (R2b C5).
_Avoid_: "MCP OAuth connect" and "credential resolver" (both removed in protocol 10), "broker"
(Cloud's).

**Scope**: What a subject may do, sent with the subject in `Nylorun-Scopes`
(required, no default): `agents:read`, `agents:write`, `sessions:own`,
`environments:write` (`SUBJECT_SCOPES`; `sandboxes:write` was renamed in protocol 11 and is
refused with a message naming the new one). `vaults:own` (retired in protocol 7) and
`tenant:settings` (retired in protocol 8, when the Tenant's settings moved to the
Management API) are still accepted and grant nothing. Each route declares the scopes that
allow it (`RouteAccess`, `api/http/define.ts`), decided from the route alone before any
lookup (`403 scope_required`); the sandbox tool routes are open to no subject, and no subject reaches the Management API.
A trusted issuer's token carries only `TOKEN_SCOPES` (`agents:read`, `sessions:own`,
`environments:write`) and `studio`.

**Trusted issuer**: An identity provider whose JWTs the Runtime API accepts as
bearers (feature `trusted-issuers`, F9 I2), declared in the **identity file**
(`NYLORUN_IDENTITY_FILE`, YAML, `tenant/identity-file.ts`, read once at boot; a
malformed file stops the boot; a key it does not define is logged and ignored). Entries
default `subject` to `{sub}`, `scopes` to `{ claim: scope }` and `allowedScopes` to the
token scopes. A bearer is its token when the unverified `iss`
names it (`tenant/issuers.ts`): RS256, ES256 or
EdDSA, at most 16 KiB, `aud` matching, `exp` present (its lifetime is the issuer's), a key
from its static `keys` or its JWKS (configured URL only, cached by `kid`, one
refetch a minute for an unknown `kid`; unreachable → `401 issuer_unavailable`
for new kids). It becomes the `token` AuthScope with `issuer: <name>`: the subject
its template renders from scalar claims, the claim's scopes within `allowedScopes`
(`ISSUER_SCOPES`: the token scopes plus `studio`, an operator scope no route
requires), the issuer's agent allowlist and rendered Environment grants; only its expiry
ends it (an expired one is `401 token_expired`, and a stream it opened ends with
`event: nylorun.closed`). It may not set session `info` or send `message.manifest`,
and sees only `{ agentId, name, description }` of the agents it may use. Accepted from
browsers with no toggle; the Runtime sends no CORS headers (the operator's proxy
does). Any other JWT is `401 credential_invalid`. `GET /v1/me` reports it as
`via: issuer:<name>`.
_Avoid_: "SSO login" (the Runtime signs no one in), "external token".

**Resource server**: The Runtime API's OAuth 2.1 role (protocol 9, Host feature
`resource-server`, `tenant/resource-server.ts`): it accepts the trusted issuers' access
tokens and is never the authorization server. `GET /.well-known/oauth-protected-resource`
(RFC 9728, no key or protocol) names the resource (`NYLORUN_PUBLIC_URL`, else the request's
origin), the issuers in the identity file's order and their scopes; without issuers it is a
`404`. Credential failures are **challenges**: `401 credential_required` (no credential, no
error code), `401 credential_invalid` (`error="invalid_token"`, the reason only logged),
`token_expired` and `issuer_unavailable`, each with `WWW-Authenticate: Bearer` naming the
metadata (`resource_metadata`); a token without a route's scope gets `403 scope_required` with
`error="insufficient_scope"` and the first scope a token can carry. The Management API takes
management keys only and is no OAuth resource: its challenge is a bare `Bearer`. A request with
neither `Nylorun-Protocol` nor `Authorization` gets the route's `401` before the `426`, so a
generic OAuth client learns where to sign in.
_Avoid_: "authorization server" for Nylorun, "OAuth login".

**Signing key**: A Tenant's ES256 key pair for the tokens the Runtime signs itself
(capability links, run and host tokens; `signing_keys`,
`tenant/signing-keys.ts`): the public JWK in the clear (`GET /v1/access/jwks`, the
Runtime API, no key), the private key sealed with the vault KEK. States `standby`,
`current` (signs), `previous` (verifies), `revoked`. Listing, rotating and revoking them
is the Management API's (`/v1/tenant/signing-keys…`, `admin.signingKeys`). Rotation never
signs anyone out; `force` does.

**Runtime AG-UI endpoint**: `/v1/ag-ui/agents/:agent` (feature
`ag-ui-endpoint`, `api/ag-ui/routes.ts`): run, thread messages, reattach and
cancel, for a person named by a trusted issuer's token or by subject headers. The SDK's
`createAgUiHandler` forwards here. A **thread session** is
`sessionIdFor(subject, agent, thread)` (`api/ag-ui/session-id.ts`), the same on
every path; it is created on the thread's first run with the options in
`forwardedProps.nylorun.session` and never changed by a later run. A user message's media
parts are **inbound files** (below); history gives each back as a media part whose source is
`{ type: "file", provider: "nylorun", value: <artifact id> }`.
_Avoid_: re-`PUT`ting a thread's session (its Environment is fixed when it is created).

**Inbound files**: Files that arrive inside an AG-UI or A2A message (`api/inbound-files.ts`):
bytes sent inline (AG-UI `data` sources, A2A `raw` parts; at most 20 MiB each decoded, bodies
up to 28 MiB) are stored as artifacts of the message's session, and the message goes through
the commands service as `parts`. A retried message reuses the files the first one stored; a
refused one deletes the files it stored. A file URL is refused (AG-UI `400`, A2A
`ContentTypeNotSupportedError`): the Runtime fetches nothing.
_Avoid_: fetching a client's URL; storing a retried message's files twice.

**Browsers**: A request with an `Origin` reaches the `/v1` routes (protocol 7): a
trusted issuer's token is served, any key (application or management) is `403
origin_rejected`. The Runtime sends no CORS headers and answers
`OPTIONS` with `204` and `Allow` only; the operator's proxy answers preflights.
`/health`, `/ready` and the OpenAPI documents refuse `Origin`.
_Avoid_: browser keys and Runtime CORS settings (gone in protocol 7).

**App server**: The developer's own server: signs people in, names the subject
and scopes on each Runtime call (`client.as`), hosts the AG-UI handler (which forwards to the Runtime's AG-UI endpoint)
and the services its HTTP tools call, and strips any `Nylorun-*` header its clients send. Nylorun ships
libraries that run inside it, not the server.
_Avoid_: "proxy" or "gateway" for it in Nylorun docs.

**Reverse proxy**: Infrastructure on the Runtime's machine, needed only when the
Runtime is reached from another machine: TLS, `Host` rewrite, only the Runtime port
proxied (`/health`, `/ready`, `/v1/*`), Studio never proxied, `/v1/tenant/*` optionally
limited to operator networks, `OPTIONS`, `Origin` and the `Nylorun-*` headers passed
through, CORS answered for the app's origins only. Configured by the developer (Caddy,
nginx, Tailscale).

**Manifest-only agent** (track R2): The Runtime runs the whole agent from its manifest and
the definition files uploaded with it; during a session it never calls back into the
developer's code. A developer's service is reached only as a tool: an HTTP tool or a remote
MCP server, one request and one answer. `PUT /v1/agents/:id` refuses a definition with a tool
that would run the developer's code (`tool({ run })` with no `http` and no `agent`, or a flow
agent's tool stage; `codeToolRefusal` in `@nylorun/core/define`), and so does `saveAgent`.
_Avoid_: "Action endpoint", "delivery", "delivery token", "background tool", "held run"
(removed in protocol 8 with track R2).

**Admin key**: The installation's root secret in `host-credentials.json` (mode 0600),
written by `nylorun start`. No request accepts it (protocol 8). Studio's key derives from
it (`deriveStudioToken(adminKey)`), Studio signs its sessions with a key derived from it,
and it mints Studio login tokens (`mintStudioLoginToken`, `POST /_studio/login-tokens`).
_Avoid_: calling a management key the admin key.

**File artifact**: A file a client uploaded or our engine saved (`artifacts/`, protocol 6): an
`af_` id, a name, a kind (`file`, or `folder`) and numbered immutable versions, each with its
size, SHA-256, media type and source (`upload`, `engine`, or `export` for a folder). Rows in `artifacts` and `artifact_versions`; bytes
in the Object store at a random key per version, counted once the version's row commits. It
belongs to a session (and goes with it on a sessions reset) or, made by an application, to the
Tenant. An upload is one streamed request (`POST /v1/artifacts`, `POST
/v1/artifacts/{id}/versions`) within the Tenant's **artifact limits** (`artifacts.config`:
`fileBytes`, default 100 MiB; `totalBytes`, default 10 GiB; `413 limit_exceeded` past either,
with nothing stored). Downloads stream through core with Range. A session's artifacts are in its
history as `artifact.created`, `artifact.version.created` and `artifact.deleted`. A subject
reaches only the artifacts of their own sessions (`artifacts/service.ts`).
_Avoid_: "media", "asset" or "attachment" for it; `MediaStore` (removed).

**Folder artifact**: An artifact of kind `folder` (F8.2, `artifacts/folders.ts`): each version is
a **manifest**, JSON `{ format: "nylorun.folder.v1", entries: [{ path, size, sha256, contentType }] }`
sorted by path, stored at the version's `blobKey`; each file's bytes are stored once,
content-addressed, at `blobs/sha256/<hex>` (a `head` that finds them skips the `put`). The
`artifact_content` table indexes which hashes each version names, so the Tenant total counts each
file once and deleting a folder removes only the files nothing else names. Content is deleted only
under the quota lock, and each such delete moves the **content epoch** (`artifacts.content_epoch`)
that a writer re-checks at commit. Read as a tree, one file by path with Range, a diff between
versions, or a streamed zip (`artifacts/zip.ts`); a version's `/content` is a `400`. Folders
come only from the turn-end export today; a client cannot upload one.

**Turn-end export**: When an agent's turn completes, the advance calls `exportOutputs`
(`artifacts/export.ts`) after `settle` commits, outside its transaction and still holding the
lease: core lists and reads `/workspace/outputs` of the session's sandbox through the
**`WorkspaceReader`** seam (`artifacts/workspace.ts`: `list(session, dir)` and
`readBytes(session, path)`, over the in-process `SandboxManager` today, over the Harness API's
`workspace.read` from F6.2, and for F7.2's pods) and writes a version of the session's folder
`outputs` (source `export`, `claimed: true` on its event: the listing and bytes are the
harness's claim). A turn whose outputs did not change adds no version; no sandbox, a sandbox never
created or no outputs export nothing. Bounded by 10,000 files and 1 GiB per export, the per-file
limit and the Tenant total; past one it records `artifact.export.skipped` with the reason, and a
failure records `artifact.export.failed`. Neither fails the turn.
_Avoid_: "reader pod" (dropped; D37).

**Capability link**: A short-lived URL that downloads one artifact version with no credential
and no `Nylorun-Protocol` (`GET /v1/artifact-links/<token>`, minted by `POST
/v1/artifacts/{id}/links`): an ES256 JWT (`typ: nylorun-artifact+jwt`, `aud: nylorun-artifact`,
`sub` the artifact, `ver` the version) signed by the keys service with the Tenant's signing key,
at most 15 minutes, opening nothing once the artifact is deleted (`artifacts/links.ts`). A
folder's link opens its zip, or with a `path` claim (`file` when minted) one of its files. The
Host's request log shows its path as `/v1/artifact-links/:token`.
_Avoid_: "presigned URL" (the Object store's own URLs never leave the Runtime).

**Message parts**: A user message's `parts` (protocol 6): `text`, and `file` naming an artifact
the caller may read, of the session or Tenant-wide, at a version or its latest. The commands
service pins each file to a version and gives the engine an opaque media part whose reference is
`{ artifactId, version, name, size }`; model-gate reads the bytes (`artifacts/files.ts`) only for the call's
session, the run token's on the gate's route, and reads none for a call without one, so the
transcript and the record hold only the reference. An agent session's message naming a file its
model does not read is refused at accept (`422 attachment_unsupported`, the type only, never the
size; skipped with no model in the vault), and the files a session's messages named are kept on
it (`Session.fileArtifacts`) for `read_artifact`. At the gate (`buildContext` in
`model/pi-model.ts`) an image the model reads becomes image input, a text file a `<file>` block,
a PDF, Office document, audio or video the model reads a **native block**, and anything else, or
a file it cannot read, a note: no file fails the call there.

**Native block**: A PDF, Office document, audio or video carried to the provider in its API's own
block (`model/native-blocks.ts`): Anthropic `document`, OpenAI Responses `input_file`, OpenAI
completions `file`, `input_audio` (WAV and MP3 only) or `video_url`, Google `inlineData`. pi-ai's
messages hold only text and images, so `buildContext` puts a marker text part in the file's place
(`NativeBlocks.add`) and the call's `onPayload` swaps each marker for its block in the request
pi-ai built (`rewrite`). A file the request cannot carry stops it before it is sent, and the call
fails `invalid_request`, never retried. The kinds each API carries (`NATIVE_FILE_KINDS`) are
`NATIVE_INPUTS` without images. The bytes are only in the provider request, never in the
reported call or the transcript.
_Avoid_: converting a file to text or images; a marker reaching a model.

**Model inputs**: What a model reads (protocol 12): `text`, `image`, `pdf`, `office`, `audio`
and `video` (`MODEL_INPUTS`). `capabilitiesOf(model, added)` (`model/capabilities.ts`) is its
pi-ai catalog's `input` plus what the operator added, only where its API carries the input
natively (`NATIVE_INPUTS`): images everywhere, PDFs on the Anthropic, OpenAI, Azure and Google
APIs, Office documents on the OpenAI Responses APIs, audio and video on Google's and
OpenAI-compatible completions. Added inputs are the Tenant setting `model.inputs` (`PUT
/v1/tenant/models/inputs`, `tenant/model-setting.ts`) for catalog models, and a custom
endpoint's `settings.inputs` (text only by default). One function serves the catalog, the accept
check (`currentModelInputs` in `model/catalog.ts`), the Model Gate (which gives pi-ai a model
with an added image, so it is not dropped) and `read_artifact`. A file's input is
`modelInputOf(mediaType)` (`artifacts/media-types.ts`).

**Reference line**: How a file stands in a prompt once its turn is over (protocol 12,
`mediaReferenceLine` in `@nylorun/core/define`): `[Uploaded artifact "name" · <artifactId> v<n> ·
read_artifact to view]`, or `[Tool <name> returned artifact …]` for a tool result's file. Our
harness projects every media part of the transcript as its line, and the media of the turn in
progress once more, in one trailing user message after the conversation and the context, so a
message projects the same in every later call and bytes reach a model only in their own turn
(`loop/model/project.ts`). Compaction keeps the summarized part's lines on its entry (`files`).

**`save_artifact`**: Our engine's built-in tool, which the Runtime pins in the `runtime` block of
a session with a sandbox, beside the sandbox tools: it saves a sandbox file (`path`) or text
(`content`) as a file artifact of its session, with its turn and tool call on the event
(`tenant/artifact-tool.ts`).

**Stored tool result**: What core makes of an agent's remote MCP or HTTP tool result before it
records the outcome (R2b C11, `tenant/tool-results.ts`), so no journal row, event or prompt holds
more of one result than the **inline cap** (32 KiB of JSON). An `image`, `audio` or blob
`resource` part becomes a file artifact of the session (`source: "engine"`), the part naming
`{artifactId, version, contentType, size}`; an image also goes to the model as a file of the result
(`ToolResult.files`), which model-gate shows to a model that reads images and replaces with a note
for one that does not. Text or JSON past the cap becomes an artifact, and the model gets
`{truncated: true, artifactId, version, contentType, size, preview}`, the first 4 KiB and the last
1 KiB; each part of a mixed result is shaped alone, the largest text first. A `resource_link` stays
a link. When the artifact cannot be stored (the Tenant's artifact limits, a failing Object store),
the preview stays and `dropped` says why. The gate keeps no answer past 8 MiB (`mcp.too-large`,
`http.too-large`). A flow's HTTP stage output is data, and is not shaped. One model step's results
are one transcript entry, so they share a **step budget** of 256 KiB: under the session lock, each
result past 1 KiB reserves its share on its effect row (`resultBytes`) and is capped at what its
step's other results left (`resultLimit`), down to a 512-byte stub naming its artifact.
_Avoid_: "offloaded result" or "spill file".

**`read_artifact`**: Our engine's built-in tool that reads a text artifact in pages of at most
32 KiB from a byte `offset`, returning `nextOffset` while more remains, at a `version` or the
latest, and shows another file the Tenant's model reads as a file of the result; one it does not
read fails `artifact.unsupported` (R2b C11, Q24, protocol 12; `tenant/artifact-tool.ts`). The
Runtime pins it in the `runtime` block of every agent of a session's tree, with or without a
sandbox (`sandbox/session-sandbox.ts`), so every agent session pins its definition with a
`runtime` block, and its `manifestHash` differs from the definition's; the session view's `definitionHash` names the definition it was opened from. It
reads the session's artifacts and the Tenant-wide ones its messages named, never another
session's.

**Definition file**: A file a definition names by the SHA-256 of its bytes (`sha256:<hex>`), today
each file of a skill's folder (`SkillManifest.files`, track R2 M4; `tenant/definition-files.ts`).
A client uploads it once with `PUT /v1/files/sha256:<hex>` (application key, at most 10 MiB, a
body of another hash is a `400`; `201` stored, `200` held already; `HEAD` says which); its bytes
go to the Object store at `definitions/sha256/<hex>` and a `definition_files` row says the Tenant
holds it. `PUT /v1/agents/{id}` refuses a definition naming a file the Tenant lacks
(`definition_files_missing`) and records each one it names in `definition_file_uses` (agent id,
manifest hash, file). Nothing deletes them yet: a later sweep removes the unused ones.
_Avoid_: calling it an artifact; artifacts are a session's or an application's files.

**Skill tools**: `load_skill` and `read_skill_resource`, which the Runtime pins, with the skill
catalog, in the `runtime` block of an agent with skills. Core runs them like `save_artifact` (`tenant/skill-tool.ts`), reading the
skill's definition files: nothing reaches the developer's process. A session with a sandbox
also has each skill's files read-only under `/skills/<name>/`: the SandboxManager mounts them on a
workspace before the first call that opens it (`sandbox/skills.ts`), with bytes from the Object
store, or in a harness from core (`definition.file`, for the run that made the call).

**Protocol**: Wire integer and feature set in `Nylorun-Protocol` /
`HOST_PROTOCOL` (`PROTOCOL_VERSION = 13`; the Host serves protocol 13 only and answers
older clients `426`; required features `studio-principal`, `artifacts`, `management-api`,
`resource-server`, `environments` and `model-inputs`; optional Host features `tenant-fixture-model`,
`transcript-events`, `subject-headers`, `ag-ui-endpoint`, `a2a-endpoint`, `sandbox-pods`,
`trusted-issuers`, `session-reads`, `calls-export`, `credential-coverage` and `traces`).
Protocol 13 made the manifest flat (manifest 7, `flat-manifest`): no `capabilities`, tools known
by name alone, and the Runtime's own tools in the pinned manifest's `runtime` block; `capabilityId`
left `tool.completed`, `mcp.discovered`, tool call rows and the Harness API (now 3). A fresh start
for sessions (migration 0024): every session opened before it is closed (`protocol_13`).
Protocol 12 added **model inputs**, the accept check (`422 attachment_unsupported`), **reference
lines** and `read_artifact` for every agent; it changes nothing a protocol 11 client sends.
Protocol 11 replaced sandbox resources, session vaults and user and installation vaults with
Environments (D55, D56): a fresh start (migration 0020) that closed every older session.
Protocol 10 removed MCP credential custody (D49).
Protocol 9 made the Runtime API an OAuth 2.1 resource server: credential failures are `401`
challenges instead of the opaque `404`, the protected resource metadata is served, and the
identity file lost `maxLifetime`.
Protocol 8 split the Runtime API from the Management API by key role, moved vaults and
signing keys under `/v1/tenant`, retired `tenant:settings`, and removed the Admin API, the
operator listener and the feature `operator-keys`; with track R2 it also removed Action
endpoints (`/v1/endpoints`, `/v1/actions/*`, delivery tokens and the feature
`action-endpoints`, which a client that requires it is refused for); the old paths answer
`404`, with no alias. Protocol 7 removed subject tokens, the access policy, revocations,
browser keys, the Runtime's CORS and derived principals; their routes answer `404`.
Independent of package semver. Incompatible clients receive `426` before
authentication, unless they send no credential either. A client that uses an optional feature checks `/health` first.
_Avoid_: treating package-version equality as the compatibility check.

**Studio principal**: Principal `studio` (role `studio`) that the Host registers when it
creates its Tenant. Its key is derived from the admin key alone (`nylorun/studio/v2`;
`deriveStudioToken`, `sdks/admin/src/derived-credentials.ts`; the Host's side is
`tenant/principals.ts`), and the Host replaces an older hash at each start; the Tenant stores
only its hash. Studio derives it to call both APIs, as itself (role `studio`); the admin
key is never a bearer.

**Derived principal**: Gone in protocol 7. Only the Studio principal's key is derived
from the admin key; every other key is issued by name (an application or management
key). Principals an earlier Host derived stay in the `principals` table and keep working
as ordinary application keys.
_Avoid_: deriving a key a client could hold.

**Transcript event**: A session event a chat UI renders (feature
`transcript-events`): `message.assistant` for each completed model step (text
and tool calls, keyed by the model's `invocationId` and each call's `callId`),
`tool.completed` for a tool the Runtime ran (HTTP, MCP, sandbox, built-in), and the
`callId` on `delegation.*` events and on a `turn.paused` interaction. Written in the transaction that completes
the effect, so a replay writes nothing (`tenant/transcript.ts`); payload
schemas and `parseTranscriptEvent` are in `@nylorun/core/contracts`.
The Runtime's AG-UI endpoint turns them into AG-UI events
(`runtime/server/src/api/ag-ui/`). Every model call has one outcome row (R7.1): a step that
said nothing writes `message.assistant` with `text: ""` and a partial summary writes
`context.compacted` with `partial: true`; readers that build a conversation (AG-UI, A2A) skip
them (`isEmptyAssistantMessage`).
_Avoid_: rebuilding a chat from `turn.completed` output or from effect id formats.

**Span-ready row**: An event that ends a crossing and carries its own timing (R7.1), so one row
is one span: `message.assistant`, `model.failed` and `context.compacted` (a model call),
`tool.completed` (a tool call), `node.completed` (a flow's HTTP stage) and `turn.completed`,
`turn.failed` and `turn.cancelled` (a turn). Each carries its effect id and `durationMs`, the
journal's window from the row's `startedAt` (set on every effect row as it is journaled, kept
on a rejoin) to the outcome. A gate's own start and end ride along as `gate` when it measured
the call: a model call's from its `model_usage` row (`started_at`, `ended_at`, with
`firstTokenMs` and `meteredUsage`, migration 0022), an MCP or HTTP tool call's from its
`tool_crossings` row; a sandbox or core-served tool, and a model call no gate metered, have
none. `tool.completed.policy` says what the tool policy did when it did more than allow. A
turn's end carries `durationMs` (from `turnStartedAt` on the session body to the end, waits for
a person included, so the turn's span holds every crossing), `pausedMs` (how much of it the turn
waited paused), `agentId` and `totals` (`steps`, `tokens`, `costUsd`: one
read of the usage ledger by turn, as `/v1/tenant/usage` totals it) (`tenant/turn-timing.ts`).
_Avoid_: computing a span from `effects` timestamps or event times.

**Trace**: One turn as an OpenTelemetry trace (track R7, Host feature `traces`), a projection of
the session log like SSE and AG-UI: one committed row maps to at most one span (`traces/map.ts`,
`spanOf`), and nothing is instrumented outside the log. The turn's end is the root span
`invoke_agent {agentId}`; each span-ready row of a model call (`chat`), tool call or flow stage
(`execute_tool`) and egress tunnel (`CONNECT {host}`) is its child, with gate times when a gate
measured the crossing; pauses and answers are markers. A turn whose `command.message` carried a
`traceparent` (R7.4, recorded as `trace`) is in the caller's trace, its root a child of the
caller's span. Content is left out unless the installation opts in per kind
(`NYLORUN_TRACE_CONTENT`). `GET /v1/sessions/{id}/turns/{turnId}/trace` answers a turn's spans
as OTLP JSON (R7.5). Core hands the turn's context to the harness (`TurnStart.trace`) and each
tool call's to the tool (`traceparent` on its journal row, which the Tool Gate reads and sends;
`TRACEPARENT` for a sandbox command).
_Avoid_: spans timed from live code, or an OpenTelemetry SDK in the Runtime.

**Trace projector**: The second reader of the session log (`traces/projector.ts`), beside the
stream relay: a `pgoutput` slot of its own, `nylorun_trace_export`, on the relay's publication,
started by a process running core only when an OTLP endpoint is set (`OTEL_EXPORTER_OTLP_*`). It
posts OTLP/HTTP JSON in batches (`traces/otlp.ts`), drops a batch after three retries
(`trace_export_dropped`) and acknowledges the slot in commit order either way, so a dead
collector keeps no WAL. It never reads S2 (D48).

**Trace key**: The Tenant setting `trace.key` (32 random bytes, `traces/key.ts`) under which trace
and span ids are HMACs of tenant, session, turn and effect ids (`traces/ids.ts`): the same on
every read of the log, and not computable from a session id. Created on first use under the
signing keys' lock and not sealed: it is no credential, and only core reads it.

**A2A endpoint**: The Runtime API routes `POST /v1/a2a/agents/:agent` (A2A 1.0
JSON-RPC) and `GET /v1/a2a/agents/:agent/card` (feature `a2a-endpoint`,
`api/a2a/routes.ts`, protocol in `api/a2a/`). A request acts for a subject with
`sessions:own`; an application key without one is `400 subject_required`. An
A2A **context** is one session per subject, agent and `contextId`; an A2A
**task** is one turn, named `t1.<base64url context>.<turnId>` and always
resolved within the caller's own sessions. `SendMessage`, `GetTask` and
`CancelTask` work; the rest answer with the A2A error for them. A message is
text, one data part, or text and `raw` files (**inbound files**); a reply to a
task takes text or data only. The card's `defaultInputModes` are text, JSON and
the media types the Tenant's model reads now (`inputModesFor` in `api/a2a/card.ts`).
_Avoid_: calling the task id a session id; trusting a task id to select a
session.

**Gateway mode**: A2A through the app server: `createA2aHandler`
(`@nylorun/agents/a2a`) authenticates partners, names each one's subject, and
forwards the JSON-RPC body to the A2A endpoint with the application key. It
publishes the Agent Card with its own URL and security schemes. The Runtime
stays private.
_Avoid_: "A2A proxy"; parsing A2A messages in the app server.

## Runtime architecture

One line each; the module named is where the term lives in code.

- **Route declaration**: A Runtime API or Management API route declared once with who may call it (`RouteAccess`: credentials, where `management` marks the Management API, and subject scopes), which serves it, checks subject scopes (`requireScopes`) and describes it (`api/http/define.ts`, `api/route.ts`). A path or method no route declares is `404 Route not found` once the caller is known.
- **OpenAPI document**: The Runtime API's and the Management API's OpenAPI 3.2 descriptions, generated from the route declarations (`api/openapi.ts`, `runtimeDocument()` and `managementDocument()`), with described tags in use order (the Runtime API's grouped by `x-tagGroups`): served without a key (`/openapi/runtime.json` with its alias `/openapi.json`, `/openapi/management.json`), packed (`@nylorun/runtime/openapi.json`, `/management-openapi.json`), attached to each release; `runtime/server/openapi/` is their committed snapshot.
- **Profile**: Who operates the Runtime's infrastructure, OSS or Cloud; not a code switch, since only endpoints (`host/stack-config.ts`) and the vault key differ.
- **Tenant handle**: The `TenantHandle` of the Host's open Tenant Runtime, bound to its database, basin and vault key (`tenant/types.ts`, opened by `tenant/store-pg.ts`, kept by `tenant/module.ts`).
- **Service**: What one Runtime process runs, chosen with `--service` (blueprint §19): `core` (the Runtime and Management APIs, SSE, the stream relay), `loop` (the agent loop and the Worker endpoint) or `gates` (the Model Gate); `--role api|worker|all` is its deprecated alias (`host/stack-config.ts`). A service is not a container. _Avoid_: "role", which means a Postgres or access-policy role.
- **Packing**: Which services share a container. A local Tenant's combined packing runs `core,loop` in the `runtime` container and `gates` in the `gateway` container; core and loop may share a process, gates never joins them (`NYLORUN_PACKING`, `cli/nylorun/src/stack/compose-file.ts`).
- **Gateway**: A local Tenant's container for the gates and keys services, and egress when sandboxes are enabled (`--service gates,keys,egress`). _Avoid_: confusing it with `gatewayModel`, an embedder's model provider, or with an MCP gateway.
- **MCP gateway**: A service outside Nylorun that holds people's sign-ins to their tools and refreshes them (Arcade, ToolHive, Obot, Nylorun Cloud), reached through a vault credential's `via` with the gateway's key and an identity header (R2b C2, D49). Gateways that mint something per person through an API (Composio, Klavis, Smithery, Pipedream) need the operator's own proxy in front. Nothing in OSS is specific to one. _Avoid_: "connector", "broker".
- **Keys service**: The `keys` service (F4.2), run in the gateway's process (`--service gates,keys`): the only process that reads the vault key (`<Host root>/keys/vault-kek`). It runs the vault writes that touch a secret, signs every token and runs MCP tool previews (R2b C12, they send a credential), behind the `Keys` seam (`keys/keys.ts`): in process, or over HTTP (`keys/client.ts`, `POST /nylorun/v1/keys/{operation}`, `NYLORUN_KEYS_URL`). With it, a Tenant runtime never reads, creates or holds the key.
- **Tool call delivery** (R5): Every tool call is a row of `nylorun.effects` and ends in one `tool.completed` with its `status` (`completed`: the tool answered; `failed`: the Runtime ended it, `tool.disabled`, `tool.unavailable` or `tool.interrupted`; `cancelled`), `kind` (`mcp`, `http`, `sandbox`, `platform`, or `harness` for a tool the turn's harness declared), `server`, the `skill` it ran and the `plugin` that brought its skill or server (protocol 13, `toolKindOf`, with core's `skillOfToolCall`: the skill tools name it, a sandbox tool whose input names `/skills/<name>/` ran it), `attempts` and `durationMs` (`harness-api/tool-journal.ts`), and, since R7.1, its `effectId`, the gate's `gate` times and the tool `policy` (see **Span-ready row**); a flow's HTTP stage ends in `node.completed`. `GET /v1/sessions/{id}/calls/tool` pages the rows (Host feature `tool-calls`). A call is sent at least once, its effect id the key on every send: an MCP or HTTP call a crash, a shutdown or a lost gate hop interrupted is sent again, up to 3 sends, then fails to the model as `tool.interrupted`; a sandbox or core-served call has no key to dedupe on, so it fails to the model at once and is not run again. A cancel ends a running call `cancelled`. No tool call parks its session `uncertain`; model calls keep their own rules.
- **Tool Gate**: The gates service's routes for remote MCP servers (`/nylorun/v1/mcp/*`, `/nylorun/v1/tool-calls`), and HTTP tools (`/nylorun/v1/http-calls`), and the `ToolGate` seam the Tenant calls (`gates/tool-gate.ts`): in process, or over HTTP (`gates/tool-client.ts`). Only it holds a remote MCP connection and its credential (`gates/mcp-handler.ts`), and it reaches the server under the Host's address policy (`guardedFetch`, `tenant/outbound.ts`: `localhost` is the Docker host in the local stack). A keyed MCP or HTTP tool call outlives its client (`gates/tool-calls.ts`, the `tool_crossings` table): a re-send joins it or gets its answer, and one lost with an earlier gateway runs again under the same key (R5.3). Under a run token it sends only a call the effect journal holds, running, as sent (R5.6, `gates/journal.ts`): `400 key_required` without the key, `409 effect_not_journaled` otherwise. Before it records or returns an answer, it replaces the credential values it sent that the answer echoes with `[redacted]` (R2b C8, `scrubValues` in `redact.ts`; `tool.completed.redacted` counts them). The sandbox tools never cross it.
- **MCP tool name**: What the model calls a remote MCP server's tool (R2b C6, `normalizeToolName` in `mcp/snapshot.ts`): `server__tool` with characters outside `[A-Za-z0-9_-]` replaced by `_`, shortened to 64 with a hash suffix, which a renamed name that collides also gets. The snapshot keeps the server's own name (`serverToolName`) for the call, and `mcp.discovered` lists the renamed ones. Server and declared tool names are checked at save against the same rule (`DELEGATE_NAME_PATTERN`).
- **MCP tool error**: A failed remote MCP tool call the model sees as a failed tool result with a code (R2b C7, `McpCallFailed` in `mcp/connect.ts`): `mcp.unreachable` (never sent, `retryable`), `credential_rejected` (`401`), `mcp.forbidden` (`403`), `mcp.error` (a JSON-RPC error), `mcp.status` (another HTTP status), `mcp.too-large` (an answer past 8 MiB, R2b C11), and `mcp.lost` (sent, answer lost: the tool may have run; the model decides, R5). The gate answers it as `error.failure`. `isError` results stay `mcp.tool`. A connection found stale before the tool saw the call (`McpConnectionStale`: a `404` to its `Mcp-Session-Id`, or a credential whose `via` moved) is dropped from the pool or the gate, opened again, and the call sent once more; a second failure is `mcp.unreachable`.
- **HTTP tool**: A tool whose manifest entry has `http` (`url`, `method` POST/PUT/PATCH, `credential`, `timeoutMs`; a sibling of `agent`, with `fn` and `command` reserved), built with `http()`: the Tool Gate sends the input as a JSON body with `Nylorun-Session-Id`, `Nylorun-Turn-Id`, `Nylorun-Agent-Id` and the effect id as `Idempotency-Key`, adding the vault credential bound to the URL that the `credential` selection names, sent to the credential's `via` when it has one, with its identity header (`gates/http-tool.ts`, `runHttpTool`; the request and answer alone are `callHttpTarget`). Its outcome is the answer, shaped as a stored tool result, or a failed outcome the model sees (`credential_rejected` on a `401`, `http.status`, `http.timeout`, `http.refused`, `http.unreachable`, `http.lost`, `http.too-large`, `http.credential`, `tool.invalid-output`). An HTTP tool is also a flow stage (a tool node with `http`), and `http({ url })` a Loop's HTTP verifier (`loop.verify: { http }`, POSTed `{ input, output, iteration }`, answering a verdict): their `tool` effects are journaled `invoking` and executed like an agent's (`harness-api/record.ts`), the gate finds the target in the pinned workflow manifest by stage key (`{ sessionId, stage }`, `flowHttpTarget`) and sends the flow agent's id as `Nylorun-Agent-Id`, and a failed outcome fails the stage (or the Loop, `loop.verify-failed`). An HTTP verifier's verdict is recorded as `loop.verified` (`recordVerdict`, `core/flow-host.ts`). _Avoid_: "webhook tool".
- **Tool policy** (R5 step 2): The Tenant's rules for every MCP and HTTP tool call of every harness (`GET`/`PUT /v1/tenant/tool-policy`, a management key; the `tool-policy` setting): each `{effect: allow|ask|deny, tool?, server?, kind?, agent?, when?, reason?}`, and the strictest matching rule decides; no match runs (`gates/policy.ts`). Core decides as it journals the call (`recordIntent`, `bypolicy` in `harness-api/record.ts`): `deny` settles it `tool.denied`, unsent; `ask` keeps the row `held`, the segment ends waiting, and settle pauses the turn with one `approval` interaction per held call (its id the effect id); `approve` makes the row `invoking` with its `approval` (the replay sends it) or settles it `tool.denied`. The Tool Gate runs only `invoking` rows, so no harness skips it. A pinned manifest's `approval: "always"` (saved before; new definitions are refused, `approvalRefusal`) is an ask. _Avoid_: "static approval".
- **MCP tool settings**: An MCP server's `tools` map (R2b C9), keyed by the server's own tool names with `"*"` for the rest, each `{enabled?, deferred?}` (and a pinned `approval`), beside the server's own `deferred`; a tool's settings resolve from its entry, then `"*"`, then the server, then the default (`mcpToolSettings`, core). Discovery leaves out a disabled tool before it takes a name, and `mcp.discovered` counts them (`disabled`) and names keys no listed tool has (`unknownTools`). A turn variant may only tighten them: `enabled: false` or `approval: "always"` (`isVariantOf`); `sessionToolsOf` and `mcpToolOf` read the turn's manifest. _Avoid_: "allowlist" for the map itself; `"*": {enabled: false}` makes one.
- **Deferred tool**: A remote MCP tool out of the model's tool list (R2b C10): the model finds it with `tool_search` and runs it with `tool_call`, session tools the run gives an agent with deferred tools (`sessionToolsOf`, `mcp/snapshot.ts`; never in the pinned manifest, and no tool of the agent's own may take their names), with a note naming each server, its deferred tools and its instructions. Core decides it once, when it records the session's MCP snapshot (`pinDeferral` in `mcp/snapshot.ts`): a tool's `deferred` setting, else whether the agent's listed MCP tools pass a tenth of the Tenant's model's context window at 4 characters a token (`contextWindowOf`, `model/catalog.ts`). `tool_search` is core's (BM25 over names and descriptions, `tenant/tool-search.ts`); `tool_call` is the engine's: it checks the arguments against the tool's `inputSchema`, asks for approval as a direct call would, and makes the tool's own effect, so routing, `tool.completed`, scrubbing and stored results are a direct call's (`deferredToolCall`, `harness/run/durable.ts`). _Avoid_: "lazy tools" or "tool RAG".
- **egress-gate**: The `egress` service (F7.2, D42), run in the gateway's process on 4200 (`NYLORUN_EGRESS_LISTEN_*`): pod Environments' only way out, a CONNECT proxy that verifies an egress token, checks its Environment's host epoch, and tunnels only to a host name in its applied recipe's `network.allowedHosts` (exact or `*.suffix`) on 443 or 80 that resolves to a public address, 64 tunnels per sandbox (`gates/egress.ts`). The one exception is a host an `environment_secret` is bound to (R2c, see **Shell credential**); every other connection is an opaque tunnel. Each connection is one event (see **Egress event**); refusals are also logged.
- **Egress event**: One connection through egress-gate on the record (track R7, Q6, Q7; `gates/egress.ts`): host, port, outcome (`allowed`, or `refused` with the gate's `reason` and `status`), `mode` (`tunnel`, or `credential` with the request count and the credential ids set), bytes up and down from the client socket, and `startedAt` (the gate's clock at CONNECT) with `durationMs`; never a header value, a path or a body. Written once, when the connection closes or at once when it is refused, by `egress-gate`, as `environment.egress` on the Environment's own stream (D67): the connection is the Environment's, since its egress token names the pod and turns run in parallel. `runningTurns` lists the turns active on the Environment as the connection opened (sessions on it with an `activeTurnId`, read as the name resolves, at most 16) as context, never as the owner; no session log and no turn trace holds it. A refusal before the Environment is known (no token, a stale one) stays a log line. A write never holds the tunnel up; a failed one is logged (`egress_record_failed`). _Avoid_: "egress log" for the gateway's log lines.
- **Shell credential**: An Environment's secret a skill's CLI uses in its pod (R2c, D50, D56): `environment_secret` (the variable is the secret's name; sealed value, `allowedHosts`, `inject` header and format) or `environment_variable` (a visible name and value). The lease's `routing.sandbox.environment` gives every command each secret's name with the sentinel `nylorun-managed` and each variable's value (`VaultService.environmentVariables`, `harness-api/start.ts`). For CONNECT to 443 of a bound host, egress-gate terminates TLS with a fresh leaf the egress CA signs (`keys/egress-ca.ts`, `keys/x509.ts`; the CA in the Tenant setting `egress.ca`, its key sealed) and sets the header on every request from the Environment's vault, uncached (`releaseEnvironmentSecret`, `gates/egress-credentials.ts`). A second secret for a host is refused at the write (`409 credential_conflict`). _Avoid_: "placeholder", "injection" for the variable itself.
- **Egress CA**: The installation's one long-lived CA for egress-gate's leaves (R2c, `keys/egress-ca.ts`): created on first use under the signing keys' lock, its certificate in every join answer (`caCertificate`) and the pod's trust bundle (`<harness root>/egress-ca-bundle.pem`, `harness/pod.ts`), its key never outside keys. No rotation yet.
- **Egress token**: The ES256 JWT (`typ: nylorun-egress+jwt`, `aud: nylorun-egress`) a pod's harness gets at join, naming its sandbox, host epoch and pod UID; minted with every host token (`mintEgressToken`, `tenant/host-token.ts`) and accepted only by egress-gate, as the proxy credential (`sandbox/egress-token.ts`).
- **MCP tool preview**: What a remote MCP server offers before an agent names it (R2b C12, `POST /v1/tenant/mcp/preview`, a management key; `admin.mcp.preview`, `nylorun mcp inspect`, Studio's **Preview tools**): the keys service (`Keys.previewMcp`, `mcp/preview.ts`) connects with the credential for the URL in the vault of `environmentId`, if given (its headers and `via`, never an identity header), under the Host's address policy and within 15 s, lists the tools with the model names a server called `name` would give them (default from the URL's host, `previewServerName`), and closes. It never calls a tool, and scrubs every credential value sent from its answer. A `401` answers `200` with `authRequired` and the server's RFC 9728 protected-resource metadata (the challenge's `resource_metadata`, else the well-known path); any other failure is `502 mcp_preview_failed` with `details.failure` (`mcp.unreachable`, …). _Avoid_: "probe", "connect" (removed in protocol 10).
- **Model Gate**: The gates service's endpoint for model calls, `POST /nylorun/v1/model-calls` (`api/gate/routes.ts`, `host/gates.ts`), and the `ModelGate` seam the loop calls (`gates/model-gate.ts`): in process (`gates/in-process.ts`) or over HTTP (`gates/http-client.ts`). Only it reads a model credential (`vault/host-model.ts`); a hop failure is a failure outcome, never an uncertain effect.
- **API node**: A Runtime process that runs the core service, serving the Runtime API, the Management API and SSE (`host/stack-config.ts`, `infra/workers.ts`).
- **Worker**: A Runtime process that runs the loop service, whose Restate endpoint runs advances and sweeps (`infra/workers.ts`, `tenant/worker.ts`).
- **Session Store**: The Tenant's durable state in the fixed schemas of its own Postgres database, behind the async `SessionStore`/`Tx` seam (`store/types.ts`, `store/postgres/`). Drizzle defines its tables (`store/postgres/schema.ts`), generates its migrations (`store/postgres/drizzle/`) and runs its queries; only `store/postgres/` imports Drizzle or the driver. It holds what happened to a session: the checkpoint, the effect journal, the Record, the lease and its epoch, and the outbox (the split with Durable Session Execution is under that term).
- **Migration**: One step of the Tenant database's schema: a SQL file drizzle-kit generated from `schema.ts`, or custom SQL for what it does not model (the schemas, `doc()`, the relay's publication). The Host applies the missing ones at startup under an advisory lock and records them in `nylorun.__drizzle_migrations`; a database holding one this Runtime does not ship is `schema-too-new`. The schema version is the number applied (`store/postgres/migrate.ts`).
- **Durable Session Execution**: Owns when a session runs; Restate (`execution/types.ts`, `adapters/execution/restate.ts`). This is the one place the split is stated. Restate delivers each wake at least once, deduped by its key for at least 24 hours; runs at most one advance per session (one invocation per key); retries an invocation whose attempt failed, so an advance whose Worker died runs again and takes the session over (§11.4); and keeps every timer: the busy re-wake, durable timers, pod sandbox reconciles and timers, and the Tenant sweep chain. It journals no effect and holds no session state. The Session Store owns what happened: the checkpoint, the effect journal (`harness-api/record.ts`), the Record, the lease, and the outbox that hands each committed request to Restate; an effect's intent and outcome commit with the session's events in one transaction under the advance's lease, written by remote harnesses and pod engines too, over the Harness API. Two Session Store mechanisms overlap Restate on purpose: the lease's epoch fences an advance, harness or pod engine that outlives its Restate attempt (one invocation per key holds for an attempt, not for the code it started), and `busy` answers the overlap; and the Worker's advance deadline bounds what Restate's abort timeout cannot stop (`tenant/worker.ts`).
- **Durable Streams**: One ordered, resumable stream per session; S2 (`streams/types.ts`, `adapters/streams/s2.ts`). It serves API listeners only (history, SSE, AG-UI, A2A); nothing inside the Runtime signals through it or waits on it (D48).
- **Control bus**: Signals between the processes with the Tenant open, on Postgres (blueprint D21, D48): `session.cancel` (abort the cancelled turn's advance), `sessions.reset` (move session streams to the new basin generation) and `host.revoked` (close a pod sandbox's host connections of an older epoch, wherever the host connected). A signal is a `nylorun.control_signals` row written in the transaction that commits what it announces (`Tx.signal`), notified with `pg_notify` on `nylorun_control` at commit. Each process follows it (`SessionStore.followSignals`, `tenant/control.ts`) on a `LISTEN` connection of its own, reading recent rows back on every notification, every 5 s and after reconnecting; the sweep prunes rows older than an hour (`store/postgres/control.ts`). Not events: never in a session's log or on S2.
- **Object store**: Where the Tenant's file bytes live, behind the `BlobStore` seam (`blob/types.ts`): the `s3` adapter over the plain S3 API (`blob/s3.ts`; RustFS in the local stack, `NYLORUN_OBJECT_STORE_*`), or the `fs` adapter under `TenantPaths.blobs` without one (`blob/fs.ts`). Tenant code reaches it as `ctx.blobs`; model-gate builds its own from the same configuration to read the files a prompt names. Postgres stays the record: a blob counts only once a committed row names its key (a file artifact's version).
- **SessionStreams**: A process's readers of Durable Streams for one open Tenant (`ctx.sessionStreams`): one `SessionStream` per observed session, and the streams wiring (`tenant/session-streams.ts`).
- **SessionStream**: The shared read of one observed session's stream in this process, followed by that session's SSE and in-process clients, each from its own next sequence (`tenant/session-streams.ts`).
- **Advance**: One run of a session's current segment under ownership: load the checkpoint, offer the segment to a harness as a run, settle what it reports (`tenant/advance.ts`). A run whose harness connection is lost keeps the lease until it lapses, so the next advance takes the session over.
- **Harness API**: The protocol between core and a harness (v3, `@nylorun/core/harness-api`, blueprint D37; v2 dropped held runs with track R2, v3 renamed `hello.capabilities` to `features` and dropped `capabilityId`): requests and messages over a channel, in process by reference (or through JSON in tests), or over WebSocket (F6.2: core's listener `harness-api/ws-server.ts`, `NYLORUN_HARNESS_LISTEN_*`; the client `harness/ws-client.ts`). A harness says `hello`, keeps a `lease` waiting, and per run sends `effect.intent`/`effect.outcome` (the Record seam), `lease.renew`, and one output (`turn.completed`, `turn.paused`, `turn.waiting`, `turn.failed`, `checkpoint` for a yield) or `lease.release`. Core sends `cancel` with the advance's abort reason. A harness readies the session's MCP servers itself (`session.mcp`) and claims its `environment.state` and `environment.exec` events (`event`). A public contract since track R4 (R4.5): every body has a schema in `@nylorun/core/harness-api`, the Runtime validates with the same schemas, and core refuses a `hello` whose `api` is not 3.
- **Harness id** (R4.1): What a harness names itself in `hello` (`^[a-z][a-z0-9-]{1,62}$`; ours is `nylorun`), an Environment's `harness`, and the key of placement. A session pins its harness when it opens (`Session.harness`: its Environment's applied harness, else `nylorun`; a flow always `nylorun`), and only a connection that said that id takes its runs (`RunOffer.harness`). A connection's credential binds its id: `NYLORUN_HARNESS_TOKEN` is `nylorun`'s, a custom harness's own token (`tenant/harness-tokens.ts`, Tenant setting `harness.tokens`, made with `nylorun-operate harness token put <id>`) is its own, and a pod's host must be its Environment's harness. Workspace requests go to a pod's host or to `nylorun` connections only. A turn on an Environment that now runs another harness is `409 harness_mismatch`; a pod applies a changed harness at its next wake, with its image.
- **Harness state** (R4.2): A harness's turn state (`TurnOutput.state`) is its own: core stores it and hands it back to the same harness, and never reads it. Our engine aligns its state's `manifestHash` with the turn's checkpoint itself; core strips only our engine's transcript from it (`leanState`). A custom harness's state is at most 256 KiB (else its turn fails), it cannot pause for approvals, and the tools it declares in `hello` (`features.tools`) are journaled like built-ins, known by name. A turn whose agents (their tools, `runtime` tools and session tools, `tool_search` and `tool_call` included) already use a declared tool's name, or one with `__` (an MCP tool's), is refused before the harness takes it, and fails (`nativeToolClashes`, `harness-api/server.ts`).
- **Event writer** (R4.9): Who wrote an event, set by the code that writes it (`Tx.event`'s `EventWriter`), not by its type: `client` for a command (with its `principal`, from the credential), `harness` with the harness id and `runId` for what a harness reported (evidence `claimed`), `core` for core's own logic (evidence `observed`; with the run's id during a run). `egress-gate` is a kind no session event uses since D67: its **Egress event** is on the Environment's stream. The Model Gate's usage row is the measured record of a model call a harness reported.
- **Harness**: One long-running client of the Harness API that runs the engine for the runs it leases, with injected executors for model, MCP and sandbox calls (`@nylorun/harness/api`, `harness/executors.ts`). Each Tenant runs one in process (`harness-api/in-process.ts`, the default outside Compose), or none with `NYLORUN_HARNESS=remote` (the Compose stack's default): harness services (`--service harness`, `harness/main.ts`, `harness/service.ts`), the **Harness container** and the engines in pod Environments, attach over WebSocket with their own MCP pool and SandboxManager. It reaches no store (`scripts/check-boundaries.mjs`).
- **Harness container**: A local Tenant's `harness` container: the Runtime image with `--service harness`, connected to core's Harness API with `NYLORUN_HARNESS_TOKEN` and mounting only the Tenant's `sandboxes/` (`cli/nylorun/src/stack/compose-file.ts`). It runs the turns and the virtual sandboxes of every session not on a pod Environment. `NYLORUN_HARNESS=in-process` in `.env` drops it and runs them in the `runtime` container.
- **Workspace feature**: What core does with sandbox workspaces outside a run (`ctx.sandbox`, a `WorkspacePort`, `harness-api/workspace.ts`): the sandbox tool routes, `save_artifact`'s reads, Tenant status, the sweep, an Environment's deletion and an Environments reset. In process it is the Tenant's SandboxManager; with remote harnesses it is the `workspace.*` requests to the harness that declared `workspace` in its `hello` (`503 request_rejected` when none is connected). The SandboxManager keeps its compute records through a `SandboxRecords` port (`sandbox/records.ts`: the `sandboxes` table, or `<root>/sandboxes/records.json` in a harness, mirrored into the table from its `environment.state` claims and sweep answers).
- **Run**: A lease on one session's segment, offered by an advance to the first waiting harness (`harness-api/server.ts`): a `runId` bound to the connection that leased it (any other gets `run_not_held`), the turn, the epoch and, from F5, a run token. Its `turn.start` carries the segment's checkpoint without the transcript, its completed outcomes and the transcript's cursor.
- **Transcript cursor**: The record `seq` of the last event that changed a session's transcript fold (`transcript.updated`, `turn.cancelled`, `turn.failed`). A harness that holds the transcript at the run's cursor resumes from its cache; otherwise it reads it once (`transcript.read`).
- **Wake**: A request, delivered at least once, that a session advance (`WakeReason` in `execution/types.ts`). A transaction asks for one with `Tx.wake`, which writes it to the outbox.
- **Outbox**: The Session Store's rows for what committed transactions asked of Durable Session Execution and it has not yet accepted: wakes (`nylorun.wakes`, `Tx.wake`) and pod sandbox reconciles and timers (`nylorun.sandbox_signals`, `Tx.signalSandbox`; a table of their own, so a Runtime that delivers only wakes never reads one). A row is written in the transaction that causes it, sent after commit with its idempotency key (a wake's `dedupeKey` or `wake:<row id>`, a reconcile's `signal:<row id>`) without the caller waiting for the send (`SessionStore.deliverTo`), and deleted once accepted. A row whose send failed is sent again by the Tenant sweep's next pass, and one that a crash cut off once it is older than `OUTBOX_GRACE_MS` on the database's clock, under the same key, so no commit loses its request and none runs twice. The sweep delivers each row on its own: one whose delivery fails is retried with backoff, and after ten failures it is parked (`parked_at`), logged once at error and kept for an operator, who sends it again by clearing `parked_at` (and `retry_at`) or deletes it. Nothing else runs after commit: there is no `afterCommit`. _Avoid_: "wake outbox" for the whole of it.
- **Ownership epoch**: The counter an advance takes with a session's lease; every write the advance makes checks it (`store/ownership.ts`).
- **Engine host**: The `DurableHost` the engine resolves effects through: over the Harness API (`@nylorun/harness/api` `apiHost`), which replays a run's recorded outcomes and asks core for the rest; core's journal is `harness-api/record.ts`, which journals each effect's intent (its request hash, a model call without its prompt) and outcome, runs flow work and its own built-in tools itself, tells the harness to execute model, MCP, HTTP and sandbox calls, and fails a tool that would run the developer's code (`tool.unavailable`).
- **Record**: Every session event, written in its state transaction to Postgres `nylorun_streams.session_events` (keyed by session and seq: the database holds one Tenant), with each session's log head; Durable Streams are fed from it (`Tx.event`, `store/postgres/schema.ts`, `store/postgres/record.ts`).
- **Record module**: The one write path into the Record (`record/`, blueprint D27): it builds each event on the `nylorun.event/2` envelope, checks it against the event catalog and holds the only insert into `session_events` and `session_log_heads`, whose two statements it runs through the store's `RecordWriter` (`store/postgres/record-writer.ts`, behind the driver boundary). The store calls it from `Tx.event` under the session lock; `scripts/check-boundaries.mjs` refuses an insert anywhere else.
- **Transcript fold**: The own loop's model-facing transcript, rebuilt from the session's `transcript.updated` events (internal, never served) at each segment start; `turn.cancelled` and `turn.failed` undo their turn's edits. The session row stores the engine state without it, folding from `Session.history.from` (`tenant/history.ts`, blueprint P0.3). Tests run in shadow mode (`test/setup/transcript-shadow.ts`), which also keeps the transcript on the row and checks the fold against it.
- **Stream relay**: Feeds Durable Streams from the record, exactly once and in order per session (`matchSeq`), acknowledging the replication slot only after S2 has the events; reconciles the record with S2 after a new or lost slot. On a Host with S2 one process-wide relay reads logical replication once the Tenant is open, filling in its id (`streams/relay/`, `adapters/replication/pgoutput.ts`); otherwise the Tenant relays its own commits (`tenant/streams.ts`). The only writer of session streams.
- **Basin generation**: The Tenant's current S2 basin, from 0; a sessions reset moves to the next, so ids it frees start in an empty basin, and the old basin is deleted after a grace period (`streams/basin.ts`, `tenant/streams.ts`).
- **Pod Environment** (F7.2, Host feature `sandbox-pods`, D32–D34, D36, D38, D42): an Environment of kind `pod`: an agent-sandbox Sandbox on the Tenant's cluster, driven only by the sandboxes service (`sandbox/pods/client.ts`, `NYLORUN_SANDBOXES_URL`). Its lifecycle is a pure decision (`sandbox/pods/lifecycle.ts`) carried out by the `Sandbox` object's reconcile (`sandbox/pods/reconcile.ts`; Restate `NylorunSandbox`, or `MemoryExecution`), serialized per Environment, with an `idle` timer; the row's `desired`/`observed`/`rev`/`host_epoch` columns are its state, and the pod is applied from the row's `applied` recipe. The pod runs the engine (`--service harness` with `NYLORUN_SANDBOX_KIND=pod`) copied from the Runtime image: it waits for its NetworkPolicy (`sandbox/pods/network-gate.ts`), exchanges its join token for a host token (`sandbox/join.ts`, `tenant/host-token.ts`, `POST /nylorun/harness/v1/host/join`), and connects to the Harness API as its Environment's host: it alone leases the turns of the sessions that name it and serves their workspace (`local` backend). Placement (`sandbox/placement.ts`) is checked at session open: `placement_refused`, `environment_unavailable`; turns refuse `environment_lost`.
_Avoid_: "scope" for who shares a sandbox; the Runtime has none.
- **Placement** (F7.2, D38): Where a session's harness may run, checked at session open and never downgraded (`sandbox/placement.ts`). The Tenant's `environments.config` `placement` maps harness ids (`nylorun`, a custom harness's id, or `*` for the rest) to hosts: `harness-container` (the in-process harness or the Harness container) and `sandbox` (the engine in a pod, or a custom harness's image); both by default, and `"*": {hosts: []}` refuses any harness not named. A session on a pod Environment runs on `sandbox`, any other (a virtual or `none` Environment, or none) on `harness-container` (D52); a host the Tenant does not allow is `409 placement_refused`.
- **Environment grant**: An Environment a trusted issuer's token reaches, rendered from the issuer's `environments` templates (identity file): an exact Environment id, or a prefix ending in `/*` (`users/alice/*` reaches `users/alice/web`, not `users/alice`). A token without one reaches no Environment; any other id is the 404 of a missing one. Application keys, with or without subject headers, reach every Environment; changing one through a subject needs `environments:write`. An identity file that still says `sandboxes:` is refused at start (protocol 11).
- **Pinned sandbox**: The sandbox spec of a session's Environment when the session opened (`Session.sandbox`, from the Environment's `applied` recipe, `sandboxSpecOf`), carried in an agent session's pinned manifest as its `runtime` block's `sandbox`, with the sandbox tools (`sandbox/session-sandbox.ts`). A flow's linked sessions inherit the workflow's Environment and spec (`tenant/effects.ts`). A virtual Environment's recipe change reaches the sessions opened after it.
- **Tenant sweep**: A per-Tenant durable timer that reconciles the Session Store with Durable Session Execution: it sends the outbox's undelivered requests, settles linked agent effects, re-wakes orphaned sessions and reconciles stalled pod sandboxes (on a process's first pass, then once a minute: a backstop for what the execution itself lost, never a request's delivery) and stops idle sandboxes (`tenant/sweep.ts`).

## Terms to avoid (appear nowhere in new copy)

| Avoid | Use instead |
| --- | --- |
| project scope / global scope | Host root + Tenant + Project link |
| scopeId (as Host identity) | `hostId` |
| `--global`, `--db`, a database path variable | Host root + Tenant (CLI) |
| `/v1/host/model*` (Tenant routes) | `/v1/tenant/model*` |
| `startRuntime` / `createRuntime` | `startEphemeralRuntime` (tests) / Host entry |
| `NYLORUN_EXECUTORS_JSON`, executors, `connectAgents`, Action endpoints, `createActionHandler`, `PUT /v1/endpoints` | HTTP tools (`http()`) and remote MCP servers; `saveAgent` |
| `nylorun serve` | `node dist/src/main.js`, which saves the app's agents |
| importing `@nylorun/runtime` from a client | call the Runtime API (`@nylorun/agents`) or the Management API (`@nylorun/admin`) |
| `nylorun-runtime`, the launcher, `nylorun runtime up` | the local Tenant: `nylorun start` |
| `nylorun dev`, `nylorun dev --ephemeral` | `nylorun start` once, then the project's `npm run dev` |
| `nylo tenant create\|use\|list\|current\|delete`, one installation for every project | `nylorun start` in the project: its own local Tenant and link |
| stack, `nylorun start --name`, `NYLORUN_STACK`, `~/.nylorun/stacks/`, `nylorun legacy` | local Tenant, `--tenant`, `NYLORUN_TENANT`, `~/.nylorun/tenants/` (`nylorun legacy` is removed) |
| `nylo tenant status\|reset\|endpoints`, `nylo endpoints` | `nylorun status` and `nylorun tenant reset` |
| `tenant.sqlite`, the SQLite store | the Tenant's Postgres database (Session Store) |
| `tenant_<id>` schemas, the Tenant catalog, quarantine | one Tenant per database; a readiness cause |
| `schema_version` tables, hand-written migrations, `lockSchema` | Drizzle migrations and their journal (`store/postgres/migrate.ts`) |
| `Nylorun-Tenant` on new clients, `/v1/admin/tenants` | nothing selects the Tenant; `GET /v1/tenant` (a management key) or `nylorun-operate status` names it |
| Hosted Studio, `local.nylorun.studio`, pairing | the local Tenant's Studio service and its login URL |
| Tenant API (for the whole surface) | the Runtime API or the Management API: say which |
| Admin API, `/v1/admin/*`, `admin.status()`, `NYLORUN_ADMIN_URL`, `NYLORUN_ADMIN_KEY`, `admin-openapi.json` (removed in protocol 8) | the Management API (`/v1/tenant/*`, `@nylorun/admin` with `NYLORUN_MANAGEMENT_KEY`, `/openapi/management.json`); Host work: `nylorun status`, `stop` and `key`, or `nylorun-operate status\|keys` in the runtime container |
| operator listener, operator port, `NYLORUN_ADMIN_PORT`, `NYLORUN_ADMIN_LISTEN_*`, `adminPort` (removed in protocol 8) | the Host's one listener; `nylorun-operate` for Host work |
| operator key, Host feature `operator-keys` | application key (`PUT /v1/tenant/keys/{keyId}`, `nylorun tenant keys put <id>`); management key for the Management API |
| `tenant:settings` (retired in protocol 8) | a management key on the Management API, as itself; Studio uses its own key |
| `/v1/vaults…`, `/v1/access/signing-keys…`, `client.createVault`, `client.access.signingKeys` | `/v1/tenant/signing-keys…`, `admin.signingKeys`; vaults: an Environment's secrets (protocol 11) |
| `/v1/sandboxes…`, `client.sandboxes`, `sandbox: { id }`, `vaultIds`, `credentialSelections`, `/v1/tenant/vaults…`, `admin.vaults`, user and installation vaults, `sandboxes:write`, `sandbox_*` error codes and events (protocol 10) | `/v1/environments…`, `client.environments`, `environment: <id>`, `PUT /v1/environments/{id}/secrets/{name}`, `environments:write`, `environment_*` codes and events (protocol 11) |
| required feature `admin-status` on new clients | `management-api` (the Host advertises `admin-status` only for protocol 5 to 7 clients) |
| `deriveStudioToken(adminKey, tenantId)` | `deriveStudioToken(adminKey)` (Studio key v2) |
