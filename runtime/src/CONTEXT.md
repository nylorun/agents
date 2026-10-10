# Runtime Clients vocabulary

Terms follow the Runtime Tenants model, Runtime Clients, the Runtime and
Management APIs (protocol 8), and the Runtime architecture (Postgres, Restate,
S2). Every agent uses these terms in code, comments, errors and CLI output.

Agent definitions describe capabilities. The harness engine advances execution.
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
AG-UI and A2A, sandboxes, artifacts, `/v1/me` and the public JWKS (`/v1/access/jwks`). It
takes application keys and trusted issuers' tokens; a management key here is `403
key_role_mismatch` (except `/v1/me` and the JWKS).
Nothing in a request selects the Tenant (protocol 5). Client package: `@nylorun/agents`.
Reference: `/openapi/runtime.json` (alias `/openapi.json`).
_Avoid_: "Tenant API" for the whole surface (say which API), "SDK API" or "application API".

**Management API**: The Tenant's routes for operators, `/v1/tenant/*` (status, seed and
reset, models, usage and budgets, vaults and credential coverage, MCP server previews, signing keys, sandbox and
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
package, `nylorun/src/stack/`) runs on a developer machine: the Runtime image with
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

**Tenant**: One isolated unit of sessions, principals, vault, sandboxes and
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
`admin.keys.put`), or on the machine (`nylorun key put <id>`, `nylorun-operate keys
put`); the key is returned once and only its hash is kept, and a rotated or deleted key
stops authenticating on its next request (`tenant/operator-keys.ts`). App servers hold
them (`NYLORUN_SERVER_KEY`).
_Avoid_: "operator key" (the protocol 7 name), "server token" / `serverToken` as the
public name (legacy API).

**Management key**: A key with role `management`. It reaches the Management API
(`/v1/tenant/*`) and `/v1/me` only, as itself: with `Nylorun-Subject` or
`Nylorun-Scopes` it is `403 subject_invalid`, with an `Origin` `403 origin_rejected`.
`/v1/me` reports it as `via: management:<id>`, with no scopes and no agents. Issued only
on the Tenant's machine (`nylorun key put <id> --management`, `nylorun-operate keys put
<id> --role management`) or from the **bootstrap secret** (`NYLORUN_MANAGEMENT_KEY_FILE`,
64 hex characters, registered as the key `bootstrap` at every start and replaced when the
file changes). No API call creates, rotates or deletes one, so a leaked key cannot mint
another. `nylorun start` keeps `project-management` for a Project and `cli-management`
outside one; `@nylorun/admin` reads it from `NYLORUN_MANAGEMENT_KEY` or those files.
_Avoid_: using one for an app server or a browser; "admin key" for it.

**Subject**: The person an application principal acts for, named with
`Nylorun-Subject` (feature `subject-headers`, `tenant/auth.ts`). Chosen by the
integrator (`app:42`); 1–200 visible ASCII characters, `host` and `installation`
reserved (they own the host model's vault and the installation vaults). A subject reaches only sessions whose
`ownerUserId` is the subject; another owner's resource is the same `404` as a
missing one. No subject reaches the Management API (protocol 8). Only
application keys may send it; with a management key it is `403`.
A **trusted issuer**'s token names its subject itself.
_Avoid_: "user" for the header value (the Runtime has no user accounts).

**Installation vault**: A vault with `scope: "installation"`, owned by the reserved
subject `installation` (F9 C1, `vault/service.ts`): the installation's own
credentials (shared tool keys, MCP gateway keys). Only a management key
creates, lists or changes one (as every vault: vault routes are the Management API's,
`/v1/tenant/vaults…`, since protocol 8; `admin.vaults` in `@nylorun/admin`); any session
may attach one by id (`vaultIds`, through the Runtime API) and select its
credentials. Studio's Credentials page (Tenant settings) manages them. A person's vault (`scope: "user"`,
created by a management key for `ownerUserId`) attaches only to that person's
sessions. The `host` model vault is neither: it
is never listed or attached.
_Avoid_: "shared vault", "org vault".

**Session credentials**: Where a session's MCP servers and HTTP tools get their credentials:
the session's attached vaults, matched by the URL the manifest names (`vault/sources.ts`,
`sessionCredentials` over `VaultService.authorize`), in the gateway or in process. OSS holds
no OAuth client and asks no credential resolver (protocol 10, D49): a person's own keys go in
their user vault, the installation's in its vaults. A credential is a `bearer` token or a
`headers` map; its **via** sends the server's requests elsewhere (an MCP gateway) while the manifest's
URL still picks it, and its **identity header** carries the session owner's subject (none for an
`installation` session). A `401` is the tool error `credential_rejected` (R2b C1, C2). **Credential
coverage** (`POST /v1/tenant/credential-coverage`, `VaultService.coverage`, `vault/coverage.ts`)
answers ahead of a session what each URL an agent names would get from given vaults, decided as a
call decides it, with no secret read. A server
that takes only a person's OAuth sign-in is reached through an **MCP gateway**; the operator's
guide, with recipes, is "MCP servers and HTTP tools" in DEPLOYMENT.md (R2b C5).
_Avoid_: "MCP OAuth connect" and "credential resolver" (both removed in protocol 10), "broker"
(Cloud's).

**Scope**: What a subject may do, sent with the subject in `Nylorun-Scopes`
(required, no default): `agents:read`, `agents:write`, `sessions:own`,
`sandboxes:write` (`SUBJECT_SCOPES`). `vaults:own` (retired in protocol 7) and
`tenant:settings` (retired in protocol 8, when the Tenant's settings moved to the
Management API) are still accepted and grant nothing. Each route declares the scopes that
allow it (`RouteAccess`, `api/http/define.ts`), decided from the route alone before any
lookup (`403 scope_required`); the sandbox tool routes are open to no subject, and no subject reaches the Management API.
A trusted issuer's token carries only `TOKEN_SCOPES` (`agents:read`, `sessions:own`,
`sandboxes:write`) and `studio`.

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
requires), the issuer's agent allowlist and rendered sandbox grants; only its expiry
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
`forwardedProps.nylorun.session` and never changed by a later run.
_Avoid_: re-`PUT`ting a thread's session (it would replace its vaults).

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
`{ artifactId, version }`; model-gate reads the bytes (`artifacts/files.ts`) only for the call's
session, the run token's on the gate's route, and reads none for a call without one, so the
transcript and the record hold only the reference. An image becomes image input, a text file text, and
another file a refused call (`invalid_request`).

**`save_artifact`**: Our engine's built-in tool (`nylorun.artifacts` capability, added beside the
sandbox capability to a session with a sandbox): it saves a sandbox file (`path`) or text
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

**`read_artifact`**: Our engine's built-in tool that reads a text artifact of its own session in
pages of at most 32 KiB from a byte `offset`, returning `nextOffset` while more remains, and shows
an image artifact as a file (R2b C11, Q24; `tenant/artifact-tool.ts`). The `nylorun.artifacts`
capability gives it to each agent of a session's tree with a remote MCP server or an HTTP tool,
with or without a sandbox, unless the agent declares a tool of that name
(`sandbox/session-sandbox.ts`), so such a session pins its definition with it added, and its
`manifestHash` differs from the definition's; the session view's `definitionHash` names the
definition it was opened from. It never reads a Tenant-wide artifact or another
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

**Skill tools**: `load_skill` and `read_skill_resource`, which the build gives the first
capability with skills. Core runs them like `save_artifact` (`tenant/skill-tool.ts`), reading the
skill's definition files: nothing reaches the developer's process. A session with a sandbox
also has each skill's files read-only under `/skills/<name>/`: the SandboxManager mounts them on a
workspace before the first call that opens it (`sandbox/skills.ts`), with bytes from the Object
store, or in a harness from core (`definition.file`, for the run that made the call).

**Protocol**: Wire integer and feature set in `Nylorun-Protocol` /
`HOST_PROTOCOL` (`PROTOCOL_VERSION = 9`; the Host serves 4 to 9; required features
`studio-principal`, `artifacts`, `management-api` and `resource-server`. The Host still
advertises `runtime-tenants` for protocol 4 clients and `admin-status` for protocol 5 to 7
clients, which require it, though the Admin API is gone; optional Host features
`tenant-fixture-model`, `transcript-events`, `subject-headers`, `ag-ui-endpoint`,
`a2a-endpoint`, `sandboxes`, `sandbox-pods` and `trusted-issuers`).
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
`deriveStudioToken`, `admin/src/derived-credentials.ts`; the Host's side is
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
(`runtime/src/api/ag-ui/`).
_Avoid_: rebuilding a chat from `turn.completed` output or from effect id formats.

**A2A endpoint**: The Runtime API routes `POST /v1/a2a/agents/:agent` (A2A 1.0
JSON-RPC) and `GET /v1/a2a/agents/:agent/card` (feature `a2a-endpoint`,
`api/a2a/routes.ts`, protocol in `api/a2a/`). A request acts for a subject with
`sessions:own`; an application key without one is `400 subject_required`. An
A2A **context** is one session per subject, agent and `contextId`; an A2A
**task** is one turn, named `t1.<base64url context>.<turnId>` and always
resolved within the caller's own sessions. `SendMessage`, `GetTask` and
`CancelTask` work; the rest answer with the A2A error for them.
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
- **OpenAPI document**: The Runtime API's and the Management API's OpenAPI 3.2 descriptions, generated from the route declarations (`api/openapi.ts`, `runtimeDocument()` and `managementDocument()`), with described tags in use order (the Runtime API's grouped by `x-tagGroups`): served without a key (`/openapi/runtime.json` with its alias `/openapi.json`, `/openapi/management.json`), packed (`@nylorun/runtime/openapi.json`, `/management-openapi.json`), attached to each release; `runtime/openapi/` is their committed snapshot.
- **Profile**: Who operates the Runtime's infrastructure, OSS or Cloud; not a code switch, since only endpoints (`host/stack-config.ts`) and the vault key differ.
- **Tenant handle**: The `TenantHandle` of the Host's open Tenant Runtime, bound to its database, basin and vault key (`tenant/types.ts`, opened by `tenant/store-pg.ts`, kept by `tenant/module.ts`).
- **Service**: What one Runtime process runs, chosen with `--service` (blueprint §19): `core` (the Runtime and Management APIs, SSE, the stream relay), `loop` (the agent loop and the Worker endpoint) or `gates` (the Model Gate); `--role api|worker|all` is its deprecated alias (`host/stack-config.ts`). A service is not a container. _Avoid_: "role", which means a Postgres or access-policy role.
- **Packing**: Which services share a container. A local Tenant's combined packing runs `core,loop` in the `runtime` container and `gates` in the `gateway` container; core and loop may share a process, gates never joins them (`NYLORUN_PACKING`, `nylorun/src/stack/compose-file.ts`).
- **Gateway**: A local Tenant's container for the gates and keys services, and egress when sandboxes are enabled (`--service gates,keys,egress`). _Avoid_: confusing it with `gatewayModel`, an embedder's model provider, or with an MCP gateway.
- **MCP gateway**: A service outside Nylorun that holds people's sign-ins to their tools and refreshes them (Arcade, ToolHive, Obot, Nylorun Cloud), reached through a vault credential's `via` with the gateway's key and an identity header (R2b C2, D49). Gateways that mint something per person through an API (Composio, Klavis, Smithery, Pipedream) need the operator's own proxy in front. Nothing in OSS is specific to one. _Avoid_: "connector", "broker".
- **Keys service**: The `keys` service (F4.2), run in the gateway's process (`--service gates,keys`): the only process that reads the vault key (`<Host root>/keys/vault-kek`). It runs the vault writes that touch a secret, signs every token and runs MCP tool previews (R2b C12, they send a credential), behind the `Keys` seam (`keys/keys.ts`): in process, or over HTTP (`keys/client.ts`, `POST /nylorun/v1/keys/{operation}`, `NYLORUN_KEYS_URL`). With it, a Tenant runtime never reads, creates or holds the key.
- **Tool Gate**: The gates service's routes for remote MCP servers (`/nylorun/v1/mcp/*`, `/nylorun/v1/tool-calls`), and HTTP tools (`/nylorun/v1/http-calls`), and the `ToolGate` seam the Tenant calls (`gates/tool-gate.ts`): in process, or over HTTP (`gates/tool-client.ts`). Only it holds a remote MCP connection and its credential (`gates/mcp-handler.ts`), and it reaches the server under the Host's address policy (`guardedFetch`, `tenant/outbound.ts`: `localhost` is the Docker host in the local stack). A keyed MCP or HTTP tool call runs once (`gates/tool-calls.ts`, the `tool_crossings` table): a re-send joins it or gets its answer, and one lost with an earlier gateway is `uncertain`. Before it records or returns an answer, it replaces the credential values it sent that the answer echoes with `[redacted]` (R2b C8, `scrubValues` in `redact.ts`; `tool.completed.redacted` counts them). The sandbox tools never cross it.
- **MCP tool name**: What the model calls a remote MCP server's tool (R2b C6, `normalizeToolName` in `mcp/snapshot.ts`): `server__tool` with characters outside `[A-Za-z0-9_-]` replaced by `_`, shortened to 64 with a hash suffix, which a renamed name that collides also gets. The snapshot keeps the server's own name (`serverToolName`) for the call, and `mcp.discovered` lists the renamed ones. Server and declared tool names are checked at save against the same rule (`DELEGATE_NAME_PATTERN`).
- **MCP tool error**: A failed remote MCP tool call the model sees as a failed tool result with a code (R2b C7, `McpCallFailed` in `mcp/connect.ts`): `mcp.unreachable` (never sent, `retryable`), `credential_rejected` (`401`), `mcp.forbidden` (`403`), `mcp.error` (a JSON-RPC error), `mcp.status` (another HTTP status), `mcp.too-large` (an answer past 8 MiB, R2b C11), and `mcp.lost` (sent, answer lost) only for a tool annotated `readOnlyHint` or `idempotentHint`; any other lost call, and one lost with the gateway, stays `uncertain`. The gate answers it as `error.failure`. `isError` results stay `mcp.tool`. A connection found stale before the tool saw the call (`McpConnectionStale`: a `404` to its `Mcp-Session-Id`, or a credential whose `via` moved) is dropped from the pool or the gate, opened again, and the call sent once more; a second failure is `mcp.unreachable`.
- **HTTP tool**: A tool whose manifest entry has `http` (`url`, `method` POST/PUT/PATCH, `credential`, `timeoutMs`; a sibling of `agent`, with `fn` and `command` reserved), built with `http()`: the Tool Gate sends the input as a JSON body with `Nylorun-Session-Id`, `Nylorun-Turn-Id`, `Nylorun-Agent-Id` and the effect id as `Idempotency-Key`, adding the vault credential bound to the URL that the `credential` selection names, sent to the credential's `via` when it has one, with its identity header (`gates/http-tool.ts`, `runHttpTool`; the request and answer alone are `callHttpTarget`). Its outcome is the answer, shaped as a stored tool result, or a failed outcome the model sees (`credential_rejected` on a `401`, `http.status`, `http.timeout`, `http.refused`, `http.unreachable`, `http.lost`, `http.too-large`, `http.credential`, `tool.invalid-output`). An HTTP tool is also a flow stage (a tool node with `http`), and `http({ url })` a Loop's HTTP verifier (`loop.verify: { http }`, POSTed `{ input, output, iteration }`, answering a verdict): their `tool` effects are journaled `invoking` and executed like an agent's (`harness-api/record.ts`), the gate finds the target in the pinned workflow manifest by stage key (`{ sessionId, stage }`, `flowHttpTarget`) and sends the flow agent's id as `Nylorun-Agent-Id`, and a failed outcome fails the stage (or the Loop, `loop.verify-failed`). An HTTP verifier's verdict is recorded as `loop.verified` (`recordVerdict`, `core/flow-host.ts`). _Avoid_: "webhook tool".
- **Static approval**: `approval: "always"` on an HTTP tool, or on a remote MCP server for all its tools, or on one of its tools (R2b C9): the engine pauses each call for the session's `approve` before it becomes an effect, and a denied call is `denied` without running (`DurableSessionTool.approval`, `harness/run/durable.ts`).
- **MCP tool settings**: An MCP server's `tools` map (manifest v6, R2b C9), keyed by the server's own tool names with `"*"` for the rest, each `{enabled?, approval?, deferred?}`, beside the server's own `approval` and `deferred`; a tool's settings resolve from its entry, then `"*"`, then the server, then the default (`mcpToolSettings`, core). Discovery leaves out a disabled tool before it takes a name, and `mcp.discovered` counts them (`disabled`) and names keys no listed tool has (`unknownTools`). A turn variant may only tighten them: `enabled: false` or `approval: "always"` (`isVariantOf`); `sessionToolsOf` and `mcpToolOf` read the turn's manifest. A manifest that sets neither field stays v5. _Avoid_: "allowlist" for the map itself; `"*": {enabled: false}` makes one.
- **Deferred tool**: A remote MCP tool out of the model's tool list (R2b C10): the model finds it with `tool_search` and runs it with `tool_call`, which the session gives the agent in its `nylorun.tools` capability (empty in the pinned manifest; `sandbox/session-sandbox.ts`), with a note naming each server, its deferred tools and its instructions. Core decides it once, when it records the session's MCP snapshot (`pinDeferral` in `mcp/snapshot.ts`): a tool's `deferred` setting, else whether the agent's listed MCP tools pass a tenth of the Tenant's model's context window at 4 characters a token (`contextWindowOf`, `model/catalog.ts`). `tool_search` is core's (BM25 over names and descriptions, `tenant/tool-search.ts`); `tool_call` is the engine's: it checks the arguments against the tool's `inputSchema`, asks for approval as a direct call would, and makes the tool's own effect, so routing, `tool.completed`, scrubbing and stored results are a direct call's (`deferredToolCall`, `harness/run/durable.ts`). _Avoid_: "lazy tools" or "tool RAG".
- **egress-gate**: The `egress` service (F7.2, D42), run in the gateway's process on 4200 (`NYLORUN_EGRESS_LISTEN_*`): pod sandboxes' only way out, a CONNECT proxy that verifies an egress token, checks its sandbox's host epoch, and tunnels only to a host name in the spec's `network.allow` (exact or `*.suffix`) on 443 or 80 that resolves to a public address, 64 tunnels per sandbox (`gates/egress.ts`). No TLS interception, no credential injection, no events; refusals are logged.
- **Egress token**: The ES256 JWT (`typ: nylorun-egress+jwt`, `aud: nylorun-egress`) a pod's harness gets at join, naming its sandbox, host epoch and pod UID; minted with every host token (`mintEgressToken`, `tenant/host-token.ts`) and accepted only by egress-gate, as the proxy credential (`sandbox/egress-token.ts`).
- **MCP tool preview**: What a remote MCP server offers before an agent names it (R2b C12, `POST /v1/tenant/mcp/preview`, a management key; `admin.mcp.preview`, `nylorun mcp inspect`, Studio's **Preview tools**): the keys service (`Keys.previewMcp`, `mcp/preview.ts`) connects with the installation vault's credential for the URL (one across the installation vaults, or the one `vaultId` names; its headers and `via`, never an identity header), under the Host's address policy and within 15 s, lists the tools with the model names a server called `name` would give them (default from the URL's host, `previewServerName`), and closes. It never calls a tool, and scrubs every credential value sent from its answer. A `401` answers `200` with `authRequired` and the server's RFC 9728 protected-resource metadata (the challenge's `resource_metadata`, else the well-known path); any other failure is `502 mcp_preview_failed` with `details.failure` (`mcp.unreachable`, …). _Avoid_: "probe", "connect" (removed in protocol 10).
- **Model Gate**: The gates service's endpoint for model calls, `POST /nylorun/v1/model-calls` (`api/gate/routes.ts`, `host/gates.ts`), and the `ModelGate` seam the loop calls (`gates/model-gate.ts`): in process (`gates/in-process.ts`) or over HTTP (`gates/http-client.ts`). Only it reads a model credential (`vault/host-model.ts`); a hop failure is a failure outcome, never an uncertain effect.
- **API node**: A Runtime process that runs the core service, serving the Runtime API, the Management API and SSE (`host/stack-config.ts`, `infra/workers.ts`).
- **Worker**: A Runtime process that runs the loop service, whose Restate endpoint runs advances and sweeps (`infra/workers.ts`, `tenant/worker.ts`).
- **Session Store**: The Tenant's durable state in the fixed schemas of its own Postgres database, behind the async `SessionStore`/`Tx` seam (`store/types.ts`, `store/postgres/`). Drizzle defines its tables (`store/postgres/schema.ts`), generates its migrations (`store/postgres/drizzle/`) and runs its queries; only `store/postgres/` imports Drizzle or the driver. It owns what happened to a session: the checkpoint, the effect journal, the Record, the lease and its epoch, and the wake outbox; Durable Session Execution owns only when the session runs.
- **Migration**: One step of the Tenant database's schema: a SQL file drizzle-kit generated from `schema.ts`, or custom SQL for what it does not model (the schemas, `doc()`, the relay's publication). The Host applies the missing ones at startup under an advisory lock and records them in `nylorun.__drizzle_migrations`; a database holding one this Runtime does not ship is `schema-too-new`. The schema version is the number applied (`store/postgres/migrate.ts`).
- **Durable Session Execution**: Owns when a session runs: delivers wakes (deduped by their key), runs at most one advance per session, retries an advance whose attempt failed, and keeps the timers and the Tenant sweep chain; Restate (`execution/types.ts`, `adapters/execution/restate.ts`). It journals no effect and holds no session state: what happened is the Session Store's. Two Session Store mechanisms overlap it on purpose: the lease's epoch fences an advance, harness or pod engine that outlives its Restate attempt, and the Worker's advance deadline bounds what Restate's abort timeout cannot stop (`tenant/worker.ts`).
- **Durable Streams**: One ordered, resumable stream per session; S2 (`streams/types.ts`, `adapters/streams/s2.ts`). It serves API listeners only (history, SSE, AG-UI, A2A); nothing inside the Runtime signals through it or waits on it (D48).
- **Control bus**: Signals between the processes with the Tenant open, on Postgres (blueprint D21, D48): `session.cancel` (abort the cancelled turn's advance) and `sessions.reset` (move session streams to the new basin generation). A signal is a `nylorun.control_signals` row written in the transaction that commits what it announces (`Tx.signal`), notified with `pg_notify` on `nylorun_control` at commit. Each process follows it (`SessionStore.followSignals`, `tenant/control.ts`) on a `LISTEN` connection of its own, reading recent rows back on every notification, every 5 s and after reconnecting; the sweep prunes rows older than an hour (`store/postgres/control.ts`). Not events: never in a session's log or on S2.
- **Object store**: Where the Tenant's file bytes live, behind the `BlobStore` seam (`blob/types.ts`): the `s3` adapter over the plain S3 API (`blob/s3.ts`; RustFS in the local stack, `NYLORUN_OBJECT_STORE_*`), or the `fs` adapter under `TenantPaths.blobs` without one (`blob/fs.ts`). Tenant code reaches it as `ctx.blobs`; model-gate builds its own from the same configuration to read the files a prompt names. Postgres stays the record: a blob counts only once a committed row names its key (a file artifact's version).
- **SessionStreams**: A process's readers of Durable Streams for one open Tenant (`ctx.sessionStreams`): one `SessionStream` per observed session, and the streams wiring (`tenant/session-streams.ts`).
- **SessionStream**: The shared read of one observed session's stream in this process, followed by that session's SSE and in-process clients, each from its own next sequence (`tenant/session-streams.ts`).
- **Advance**: One run of a session's current segment under ownership: load the checkpoint, offer the segment to a harness as a run, settle what it reports (`tenant/advance.ts`). A run whose harness connection is lost keeps the lease until it lapses, so the next advance takes the session over.
- **Harness API**: The protocol between core and a harness (v2, `@nylorun/core/harness-api`, blueprint D37; v2 dropped held runs with track R2): requests and messages over a channel, in process by reference (or through JSON in tests), or over WebSocket (F6.2: core's listener `harness-api/ws-server.ts`, `NYLORUN_HARNESS_LISTEN_*`, accepting only `NYLORUN_HARNESS_TOKEN`; the client `harness/ws-client.ts`). A harness says `hello`, keeps a `lease` waiting, and per run sends `effect.intent`/`effect.outcome` (the Record seam), `lease.renew`, and one output (`turn.completed`, `turn.paused`, `turn.waiting`, `turn.failed`, `checkpoint` for a yield) or `lease.release`. Core sends `cancel` with the advance's abort reason. A harness readies the session's MCP servers itself (`session.mcp`) and claims its `sandbox.*` events (`event`). Not a public API: protocol 5 does not cover it.
- **Harness**: One long-running client of the Harness API that runs the engine for the runs it leases, with injected executors for model, MCP and sandbox calls (`@nylorun/harness/api`, `harness/executors.ts`). Each Tenant runs one in process (`harness-api/in-process.ts`), or none with `NYLORUN_HARNESS=remote`: harness services (`--service harness`, `harness/main.ts`, `harness/service.ts`) attach over WebSocket with their own MCP pool and SandboxManager. It reaches no store (`scripts/check-boundaries.mjs`).
- **Workspace capability**: What core does with sandbox workspaces outside a run (`ctx.sandbox`, a `WorkspacePort`, `harness-api/workspace.ts`): the sandbox tool routes, `save_artifact`'s reads, Tenant status, the sweep, a sandbox resource's deletion and a sandboxes reset. In process it is the Tenant's SandboxManager; with remote harnesses it is the `workspace.*` requests to the harness that declared `workspace` in its `hello` (`503 request_rejected` when none is connected). The SandboxManager keeps its compute records through a `SandboxRecords` port (`sandbox/records.ts`: the `sandboxes` table, or `<root>/sandboxes/records.json` in a harness, mirrored into the table from its `sandbox.state` claims and sweep answers).
- **Run**: A lease on one session's segment, offered by an advance to the first waiting harness (`harness-api/server.ts`): a `runId` bound to the connection that leased it (any other gets `run_not_held`), the turn, the epoch and, from F5, a run token. Its `turn.start` carries the segment's checkpoint without the transcript, its completed outcomes and the transcript's cursor.
- **Transcript cursor**: The record `seq` of the last event that changed a session's transcript fold (`transcript.updated`, `turn.cancelled`, `turn.failed`). A harness that holds the transcript at the run's cursor resumes from its cache; otherwise it reads it once (`transcript.read`).
- **Wake**: A request, delivered at least once, that a session advance (`WakeReason` in `execution/types.ts`). A transaction asks for one with `Tx.wake`, which writes it to the wake outbox.
- **Wake outbox**: The Session Store's table of committed wakes not yet handed to Durable Session Execution (`nylorun.wakes`, `Tx.wake`): a wake's row is written in the transaction that causes it, sent after commit with its idempotency key (its `dedupeKey`, or `wake:<row id>`) and deleted once accepted. A row whose send failed, or that a crash cut off, is sent again by the Tenant sweep under the same key, so no commit loses its wake and none advances twice. _Avoid_: sending a wake from `afterCommit`.
- **Ownership epoch**: The counter an advance takes with a session's lease; every write the advance makes checks it (`store/ownership.ts`).
- **Engine host**: The `DurableHost` the engine resolves effects through: over the Harness API (`@nylorun/harness/api` `apiHost`), which replays a run's recorded outcomes and asks core for the rest; core's journal is `harness-api/record.ts`, which journals each effect's intent (its request hash, a model call without its prompt) and outcome, runs flow work and its own built-in tools itself, tells the harness to execute model, MCP, HTTP and sandbox calls, and fails a tool that would run the developer's code (`tool.unavailable`).
- **Record**: Every session event, written in its state transaction to Postgres `nylorun_streams.session_events` (keyed by session and seq: the database holds one Tenant), with each session's log head; Durable Streams are fed from it (`Tx.event`, `store/postgres/schema.ts`, `store/postgres/record.ts`).
- **Record module**: The one write path into the Record (`record/`, blueprint D27): it builds each event on the `nylorun.event/2` envelope, checks it against the event catalog and holds the only insert into `session_events` and `session_log_heads`, whose two statements it runs through the store's `RecordWriter` (`store/postgres/record-writer.ts`, behind the driver boundary). The store calls it from `Tx.event` under the session lock; `scripts/check-boundaries.mjs` refuses an insert anywhere else.
- **Transcript fold**: The own loop's model-facing transcript, rebuilt from the session's `transcript.updated` events (internal, never served) at each segment start; `turn.cancelled` and `turn.failed` undo their turn's edits. The session row stores the engine state without it, folding from `Session.history.from` (`tenant/history.ts`, blueprint P0.3). Tests run in shadow mode (`test/setup/transcript-shadow.ts`), which also keeps the transcript on the row and checks the fold against it.
- **Stream relay**: Feeds Durable Streams from the record, exactly once and in order per session (`matchSeq`), acknowledging the replication slot only after S2 has the events; reconciles the record with S2 after a new or lost slot. On a Host with S2 one process-wide relay reads logical replication once the Tenant is open, filling in its id (`streams/relay/`, `adapters/replication/pgoutput.ts`); otherwise the Tenant relays its own commits (`tenant/streams.ts`). The only writer of session streams.
- **Basin generation**: The Tenant's current S2 basin, from 0; a sessions reset moves to the next, so ids it frees start in an empty basin, and the old basin is deleted after a grace period (`streams/basin.ts`, `tenant/streams.ts`).
- **Sandbox resource**: A sandbox with its own id, kind (`virtual`, or `pod` with sandbox pods; see **Pod sandbox**), spec and labels (`PUT`/`GET`/`DELETE /v1/sandboxes/{id}`, `GET /v1/sandboxes?label=k=v`, the `sandbox_resources` table, `tenant/sandboxes.ts`; Host feature `sandboxes`, blueprint D39). Ids are `/`-separated segments, sent percent-encoded as one path segment. A session attaches with `PutSessionRequest.sandbox = { id }` (`Session.sandboxId`) and pins the sandbox's spec; its workspace is keyed by the sandbox id (`SandboxManager.sandboxKeyOf`), so attached sessions share files, and deleting a session (a sessions reset) only detaches it. Turns are serial per sandbox (`409 sandbox_busy`), checked with a token caller's sandbox grants at every turn start (`checkSandboxTurn`). The Tenant holds at most `limits.sandboxes` (default 100). Lifecycle events (`sandbox.created`, `.attached`, `.detached`, `.deleted`) go to the sandbox's own stream in the record (`nylorun_streams.sandbox_events`, `record/sandbox.ts`), not relayed to S2; the session's log records `sandbox.attached`.
- **Pod sandbox** (F7.2, Host feature `sandbox-pods`, D32–D34, D36, D38, D42): a sandbox resource of kind `pod`: an agent-sandbox Sandbox on the Tenant's cluster, driven only by the sandboxes service (`sandbox/pods/client.ts`, `NYLORUN_SANDBOXES_URL`). Its lifecycle is a pure decision (`sandbox/pods/lifecycle.ts`) carried out by the `Sandbox` object's reconcile (`sandbox/pods/reconcile.ts`; Restate `NylorunSandbox`, or `MemoryExecution`), serialized per sandbox, with `idle` and `ttl` timers; the row's `desired`/`observed`/`rev`/`host_epoch` columns are its state. The pod runs the engine (`--service harness` with `NYLORUN_SANDBOX_KIND=pod`) copied from the Runtime image: it waits for its NetworkPolicy (`sandbox/pods/network-gate.ts`), exchanges its join token for a host token (`sandbox/join.ts`, `tenant/host-token.ts`, `POST /nylorun/harness/v1/host/join`), and connects to the Harness API as its sandbox's host: it alone leases the turns of sessions attached to it and serves their workspace (`local` backend). Placement (`sandbox/placement.ts`) is checked at session open: `placement_refused`, `sandbox_unavailable`; turns refuse `sandbox_lost` and `sandbox_expired`.
_Avoid_: "scope" for who shares a sandbox; the Runtime has none.
- **Sandbox grant**: A sandbox a trusted issuer's token reaches, rendered from the issuer's `sandboxes` templates (identity file): an exact sandbox id, or a prefix ending in `/*` (`team-a/*` reaches `team-a/proj-42`, not `team-a`). A token without one reaches no sandbox; any other id is the 404 of a missing one. Application keys, with or without subject headers, reach every sandbox; changing one through a subject needs `sandboxes:write`.
- **Pinned sandbox**: The sandbox a session was opened with (`PutSessionRequest.sandbox`, or the Tenant default), resolved against the Tenant's `sandbox.config` limits and stored on the session (`Session.sandbox`). An agent session carries it as the `nylorun.sandbox` capability in its pinned manifest; sessions that share or inherit it point at the owner with `sandboxOwnerId` (`sandbox/resolve.ts`, `sandbox/session-sandbox.ts`). Sharing through `{ session }` is deprecated for clients: they share a sandbox resource; linked sessions of a flow still inherit through `sandboxOwnerId`, and a tree whose owner is attached to a sandbox resource works in that sandbox.
- **Tenant sweep**: A per-Tenant durable timer that reconciles the Session Store with Durable Session Execution: it sends the wake outbox's undelivered wakes, settles linked agent effects, re-wakes orphaned sessions (on a process's first pass, then once a minute: a backstop for what the execution lost, never a wake's delivery) and stops idle sandboxes (`tenant/sweep.ts`).

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
| `nylo tenant status\|reset\|endpoints`, `nylo endpoints` | `nylo status\|reset` on the linked installation |
| `tenant.sqlite`, the SQLite store | the Tenant's Postgres database (Session Store) |
| `tenant_<id>` schemas, the Tenant catalog, quarantine | one Tenant per database; a readiness cause |
| `schema_version` tables, hand-written migrations, `lockSchema` | Drizzle migrations and their journal (`store/postgres/migrate.ts`) |
| `Nylorun-Tenant` on new clients, `/v1/admin/tenants` | nothing selects the Tenant; `GET /v1/tenant` (a management key) or `nylorun-operate status` names it |
| Hosted Studio, `local.nylorun.studio`, pairing | the local Tenant's Studio service and its login URL |
| Tenant API (for the whole surface) | the Runtime API or the Management API: say which |
| Admin API, `/v1/admin/*`, `admin.status()`, `NYLORUN_ADMIN_URL`, `NYLORUN_ADMIN_KEY`, `admin-openapi.json` (removed in protocol 8) | the Management API (`/v1/tenant/*`, `@nylorun/admin` with `NYLORUN_MANAGEMENT_KEY`, `/openapi/management.json`); Host work: `nylorun status`, `stop` and `key`, or `nylorun-operate status\|keys` in the runtime container |
| operator listener, operator port, `NYLORUN_ADMIN_PORT`, `NYLORUN_ADMIN_LISTEN_*`, `adminPort` (removed in protocol 8) | the Host's one listener; `nylorun-operate` for Host work |
| operator key, Host feature `operator-keys` | application key (`PUT /v1/tenant/keys/{keyId}`, `nylorun key put <id>`); management key for the Management API |
| `tenant:settings` (retired in protocol 8) | a management key on the Management API, as itself; Studio uses its own key |
| `/v1/vaults…`, `/v1/access/signing-keys…`, `client.createVault`, `client.access.signingKeys` | `/v1/tenant/vaults…`, `/v1/tenant/signing-keys…`; `admin.vaults`, `admin.signingKeys` |
| required feature `admin-status` on new clients | `management-api` (the Host advertises `admin-status` only for protocol 5 to 7 clients) |
| `deriveStudioToken(adminKey, tenantId)` | `deriveStudioToken(adminKey)` (Studio key v2) |
