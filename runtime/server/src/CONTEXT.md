# Runtime Clients vocabulary

Terms follow the Runtime Tenants model, Runtime Clients, the Runtime and
Management APIs (protocol 8), and the Runtime architecture (Postgres, Restate,
S2). Every agent uses these terms in code, comments, errors and CLI output.

An agent is defined by its **agent manifest** (v8, protocol 16): a `harness` section (what runs
inside the loop) and a `runtime` section (what the Runtime provides around it). An **Agent** is the
live instance of one version of it. The harness engine advances execution.
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
reset, models, usage and budgets, credential coverage, MCP server previews, signing keys, sandbox backend, Environment,
artifact and skill settings, **Runtime limits**, application keys) (protocol 8; its routes' credentials are `management`, `RouteAccess` in
`api/http/define.ts`). It takes management
keys only: an application key,
alone or acting for a subject, is `403 key_role_mismatch`. Client package: `@nylorun/admin`.
Reference: `/openapi/management.json`.
_Avoid_: "Admin API" (removed), "Tenant settings API".

**Runtime limits**: The sizes, counts and deadlines the Runtime holds what crosses it to, one
Tenant setting (`limits.config`, `GET`/`PUT /v1/tenant/limits`, `admin.settings.limits`,
`nylorun tenant settings limits`; `RuntimeLimitsSchema` in `@nylorun/core`,
`tenant/runtime-limits.ts`). The **harness limits** (`HarnessLimitsSchema`, the part
`turn.start.limits` carries, `harnessLimitsOf`): `recordEntryBytes` (one event's payload or one
effect outcome; default and ceiling 960 KiB: S2's 1 MiB record less 64 KiB for the event's
envelope; a transcript edit fills events up to it), `modelCallBytes` (a Model Gate call's body,
32 MiB), `modelFileBytes` (one file the Model Gate sends a model, 8 MiB), `toolAnswerBytes` (an
MCP or HTTP tool's answer the Tool Gate keeps, and the tool bodies it reads, 8 MiB),
`harnessStateBytes` (a custom harness's state, 256 KiB), `chunkBytes` (one `definition.file`
range, artifact chunk or disk copy range, 16 MiB) and `folderEntries` (the files of one folder
version a harness writes, 10,000). The rest only the Runtime checks (B15), by area: requests
(`requestBodyBytes`, read by `api/http/body.ts` for every Tenant route; `inlineFileBytes` and the
inline body it derives, `inlineBodyBytes`; `a2aWaitMs`; `errorExcerptChars`, what an MCP or HTTP
tool error and a preview failure quote; `traceContentBytes`), Environments (`environmentLabels`,
checked whenever labels are set; `environmentSetupCommands`, `environmentFiles`,
`environmentFilesPerEntry`, `environmentSecretSlots` and `setupCommandMs`, checked when an
Environment is made or a manifest saved, `manifestShapeIssues` in `tenant/limits.ts`, and the
timeout again when a setup plan is made; `setupOutputChars`), disk versions
(`diskVersionEntries` and `diskVersionBytes`, which a manifest's `limits.disk` may lower;
`diskLeaseMs`, `diskPodWaitMs`), model calls (`modelRequestMs`, `modelIdleMs`, `modelAttempts`,
`modelRetryDelayMs`, `modelProviderRetries`, `modelRetryDelayMaxMs`: the gates read them for each
call, `modelCallSettings`) and tools (`toolAttempts`; `httpToolTimeoutMs`, checked at deploy and
held at each call; `mcpSnapshotBytes`, what a session pins of its MCP servers, past which a server
is left out with a diagnostic, `fitSnapshot`; `mcpPreviewMs`, `mcpMetadataBytes`). B15c added:
`messageParts` (`artifacts/parts.ts`, `api/inbound-files.ts`), the page sizes `pageItems`,
`exportPageItems` (`pageSize` in `api/http/routes/reads.ts`: a page asked larger holds that many)
and `environmentEventItems`; labels' `artifactLabels`, `labelKeyChars`, `labelValueChars`
(`labelIssues`); a manifest's `setupCommandChars`, `manifestDescriptionChars`,
`secretDescriptionChars` and `secretHosts` (`manifestShapeIssues`), a failed pod's
`setupReasonChars` and `setupCommandExcerptChars` (`sandbox/setup.ts`); a secret write's
`secretValueChars` and `secretHosts` (`secretRequestIssues`); the tool policy's `toolRules`,
`toolRuleFieldChars`, `toolRuleTextChars` (`toolPolicyIssues`) and `modelBudgets`
(`budgetIssues`); and the flow limits `flowConcurrency` (core's effect dispatch,
`core/limits.ts`), `flowMapItems` and `flowLoopIterations` (a flow's
`turn.start.options.flowLimits`, `flowLimitsOf`). A limit left
out is its default (`RUNTIME_LIMIT_DEFAULTS`); one above its **ceiling**
(`RUNTIME_LIMIT_CEILINGS`, `{value, unit, why}`, from a dependency: S2's record, the Harness
API's 64 MiB frame, the longest JavaScript string and timer, a request read as one string, a
JavaScript number) is `400` naming the ceiling. Nothing keeps them: each is read from Postgres
where it is checked (a route's body, the store's event write, the Record seam, the gates, a
segment's start), and a harness gets its own in `turn.start.limits`. Past one, a write is
refused with `limit_exceeded` (`413` to an API client, `RecordEntryTooLargeError` in
`record/append.ts`; the Harness API error code to a harness), a body with `413`, a manifest with
`400`, or a tool answer is `mcp.too-large`/`http.too-large`. Dependency ceilings and constants a
standard fixes are not settings: a token's size (`http.maxHeaderSize`, `tenant/jwt.ts`), and a
page cursor's (`reads/cursor.ts`), an artifact name's and a folder path's length
(`FILE_NAME_MAX`, `FILE_PATH_MAX` in `@nylorun/core`), a link target's (`LINK_TARGET_MAX`,
Linux's `PATH_MAX`), a model-facing tool name's 64 (`MODEL_TOOL_NAME_MAX`), a `Content-Type`'s
255 (RFC 6838), W3C `tracestate`'s 512 characters. An identifier's grammar is the protocol's,
so its length is a constant too (an Environment's id, a subject, a manifest's or credential's
name, a harness id, a key id, an issuer's name, an A2A id, a token id, the Harness API's ids). Host process timings (retries, pollers,
leases of the host's own) are host configuration, not Runtime limits.
_Avoid_: "quota" for them (quotas are the artifact and skill totals), "max sizes".

**Host tuning** (B15): The Runtime processes' own timings, retries, poll intervals and internal
sizes, one typed schema with a default each (`HostTuningSchema`, `tuning.ts`), grouped by
area: `keys`, `harnessApi`, `api`, `host`, `objectStore`, `tenant`, `sweep`, `execution`,
`restate`, `postgres`, `streams`, `gates`, `egress`, `pods`, `harness`, `traces`, and `engine`
(our harness's `createHarness` options, defaults in `@nylorun/harness`). An operator sets any part
in `NYLORUN_TUNING` (JSON), parsed with the stack configuration (`StackConfig.tuning`) and set
once at start (`useHostTuning` in `host/main.ts`); code reads `hostTuning()` where a value is used,
and an option a test passes still wins. Defaults are the values the Runtime used before; an
unknown key or a value past its ceiling stops the process naming the key. Core hands a pod's
engine the `harness` and `engine` groups the operator set (`podTuningEnv`, in the pod's
`NYLORUN_TUNING`). Ceilings fixed by a standard or a dependency stay constants checked against:
`MAX_TIMER_MS` (core's `TIMER_MAX_MS`), `S3_MIN_PART_BYTES`/`S3_MAX_PART_BYTES`,
`S2_BATCH_MAX_RECORDS`/`_BYTES`, `SANDBOXES_MAX_WAIT_MS`, `DEDUPE_RETENTION_MIN_MS`,
`POSTGRES_MAX_PARAMETERS` (which bounds `postgres.contentBatchRows`); and settings that only work
against another are refused together (token lifetimes within `keys.tokenTtlMaxSeconds`,
`execution.advanceDeadlineMs` below `restate.inactivityMs`). `nylorun-operate` reads the
container's `NYLORUN_TUNING` itself (`host.operateReadyTimeoutMs`, `postgres.closeTimeoutSeconds`). Not Tenant-facing: those are Runtime limits
and Tenant settings. Listed whole in `guides/DEPLOYMENT.md` (a test checks).
_Avoid_: "config" alone, which means a Tenant's settings or an agent's manifest.

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
`kubectl exec … -- nylorun-operate …`; `nylorun status` and `nylorun tenant keys` run it on a
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

**Agent manifest**: A named, versioned document (protocol 16, track T2,
`tenant/agent-manifests.ts`, the `agent_manifests` table) with a `harness` section (the loop: the
harness's id, instructions, tools, skills with the `secrets` they read, MCP servers with the
`credential` slot they use, plugins, `outputSchema`, `loop`; or a flow, `kind: "workflow"`) and a
`runtime` section (`kind` virtual, pod or none, and what an environment manifest said; absent:
kind `none`). Saved with `PUT /v1/agent-manifests/{name}`: a save whose hash equals the latest's
answers it `unchanged`, any other writes the next version, under `If-Match`
(`412 manifest_changed`) and with a plan by section on `?dryRun=true`. Because both sections are
there, the save checks them against each other (`sectionGaps` in core: a custom harness needs a pod
with an image, every credential the harness names is a declared slot of the right type, the
runtime's kind gives the loop the sandbox it needs): `422 manifest_inconsistent` with
`details.gaps`, in place of `requires` at session open. Each section's own checks run too (no code
tools or approvals, HTTP tool timeouts, skill files; the Tenant's limits, input files). A version
records `savedBy` and is never changed; a save changes no Agent. `DELETE` removes every version,
refused while an Agent names one (`409 manifest_in_use`). The engine runs a version's **loop
manifest** (`loopManifestOf`: the harness section with the manifest's name as its id, in agent
manifest v7's shape or workflow manifest v3's), which a session pins.
_Avoid_: "definition" for the manifest (definitions left in protocol 16), "template".

**Agent**: The live instance of one version of an agent manifest (protocol 16; an Environment from
protocol 11, D55; `tenant/agents.ts`, the `agents` table): a stable id, its manifest reference
(`manifest`: `name` tracks it, `name@n` pins it) resolved once into `resolvedVersion`, labels, the
owner guard, and its **environment**: one sandbox of kind `virtual` (a just-bash workspace in the
harness container), `pod` (an agent-sandbox pod with its own volume; see **Pod Environment**) or
`none` (no compute), with what it runs (its `recipe`, the view's `runtime`: the version's runtime
section resolved against the Tenant's limits) and one **vault** (D56). The store's row type and
most of the sandbox, vault and disk code call this part the Agent's environment
(`Environment`, `environmentId`, `t.environment(id)`), keyed by the Agent's id. `PUT`/`GET`/`DELETE
/v1/agents/{id}`, `GET /v1/agents?label=k=v&state=&manifest=`, `POST .../stop|reset|fork`; ids are
`/`-separated segments, sent percent-encoded as one path segment. Made from a saved manifest only;
it never changes what it runs after that: a `PUT` on an existing id may change labels and the owner
guard, a manifest naming what it runs is accepted, and any other is
`409 agent_upgrade_unavailable` (track T3 moves a tracking Agent on). Creating one opens no session:
no session is special (D71), and the app opens sessions on it with ids it picks. When its manifest
declares secret **slots** (`recipe.secrets`, D64), a secret write sends only the value
(`secretRequestFor`) and a name it does not declare is `409 secret_not_in_manifest`. A session
names one with `agent` (`Session.agentId`, and `environmentId` for its environment, always the
same id), pins its manifest version (`Session.definition`) and its sandbox spec then
(`Session.sandbox`, `sandbox/resolve.ts` `sandboxSpecOf`), and a turn's first segment pins
again the version the Agent runs then (`repinTurn` in `tenant/agent-versions.ts`, track T3);
its workspace is keyed by the Agent's
id, so its sessions share files, and deleting a session only detaches it. Its sessions run their
turns at the same time (D66; one turn per session stays); a turn start checks a token caller's
grants, a disk copy in progress and the **owner guard** (`owner`: only that owner's sessions may
run on it; `403 agent_owner_mismatch`, the opaque `404` to a caller acting for a person) in
`checkAgentTurn`. Its **state** is derived on read (`stateOf`): `paused` (desired `off`, track
T6), `failing` (its compute failed or was lost, or a session's last turn failed), `input_required`
(a session paused or uncertain), `working` (a turn runs), `sleeping`; `attention` names the
sessions behind each state that holds; the compute's own word is `compute.state`.
`lifecycle.idle` (at most the Tenant's) stops a pod; `lifecycle.deleteAfter` deletes an Agent
unused that long, counted from `lastUsedAt` (a turn's end, a `PUT`, a secret write, a stop or reset)
by the Tenant sweep (`sweepUnusedAgents`). The Tenant holds at most `limits.environments` (default
100). Lifecycle events (`agent.created`, `.attached`, `.detached`, `.deleted` and a pod's) go to its
own stream in the record (`nylorun_streams.agent_events`, `record/agent.ts`), not relayed to S2;
the session's log records `agent.attached`. Every egress connection goes there too
(`agent.egress`, see **Egress event**); `GET .../events` filters by `types`, `since` and `until`.
_Avoid_: "scope" for who uses an Agent (the app maps people to ids, D70), "main session" (D71),
"space", "Environment" on the API (protocol 15 and before).

**Fork**: How an Agent gets a new manifest version before track T3 (Q15, `forkAgent` in
`tenant/agents.ts`), since none ever changes what it runs: `POST /v1/agents/{id}/fork` makes a new
Agent from the version (default the source's manifest name at its latest), its disk
seeded from a version of the source's (`latest` snapshots first) and its secrets copied inside the
Runtime (`Keys.sealEnvironmentSecretCopies`: unsealed and sealed again under the new vault's ids
where the vault key lives, before the fork's transaction, only the names its slots declare, with
the slots' bindings; that transaction inserts the copies, `VaultService.insertEnvironmentSecretCopies`). The view's `forkedFrom` names the
source; the source gets `agent.forked` and keeps what it runs, its disk and its sessions. A
pod fork onto other setup (Q17) keeps its `disk_seed` (`setup`, then `written`) until the engine,
which connects first (`afterSeed` in the join answer), has run that setup on the written disk;
turns wait for both.
_Avoid_: "upgrade" or "update" for a fork (the source does not change).

**Image digest**: The workload image a pod Environment runs, by digest (Q14,
`SandboxPodState.imageDigest`, `sandbox/pods/lifecycle.ts`): recorded from the sandboxes service's
`imageID` the first time a pod is ready, and sent instead of the recipe's `image` on every later
apply (`podSpecOf`), so a stop, relaunch or reset runs the same bits. An image id without a
repository, or a name a node made up for an image loaded onto it (kind's `import-<date>`), pins nothing: only a digest of the requested image's repository is pinned (`imageDigestOf`).

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
`environment_id` names its Agent (unique, deleted with it), created in the transaction that
creates the Agent. Its credentials are written on the Runtime API with
`PUT /v1/agents/{id}/secrets/{name}` (an application key, or `agents:write`; through
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
EdDSA, no longer than a request's headers may be (Node's `http.maxHeaderSize`, 16 KiB), `aud` matching, `exp` present (its lifetime is the issuer's), a key
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
with nothing stored). An artifact of an Environment (its sessions', its disk versions) is also
held to the Environment's manifest `limits.artifacts` (at most the Tenant's, `tenant/limits.ts`):
its `fileBytes`, and its `totalBytes` over that Environment's artifacts, counted by
`artifactBytes({ environmentId })` (`artifacts/quota.ts`). Downloads stream through core with Range. A session's artifacts are in its
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
versions, or a streamed zip (`artifacts/zip.ts`); a version's `/content` is a `400`. A harness
writes a folder version over the artifact seam (`artifact.write` with `kind: "folder"`,
`artifacts/folder-upload.ts`, protocol 15); a client cannot upload one.

**Outputs folder**: Our engine's convention, not the Runtime's (Q5, protocol 15): when an
agent's turn completes in a session with a sandbox, our engine lists and reads its outputs
directory (`/workspace/outputs` by default, harness configuration) with `executors.files` and
saves it, before `turn.completed`, as a version of the session's folder `outputs` over the
artifact seam (`artifact.write` with `kind: "folder"`, key `outputs:<turnId>`, source `engine`,
`claimed: true` on its event). The seam takes every byte of every file (a file whose content the
store holds is hashed and dropped; any other is streamed to a key of its own and copied to its
content key once its hash is checked), refuses a file whose bytes do not match its hash, adds no
version when the files equal the folder's latest (`unchanged`), and answers `refused` past the
Tenant's or the Environment's total. Bounded by the Runtime limit `folderEntries`, the per-file
limit, the totals and the harness's `outputs.maxBytes`; past one our engine claims
`artifact.export.skipped` with the reason, and a failure `artifact.export.failed`. Neither fails
the turn. A harness of your own saves no outputs folder unless it writes one; core exports
nothing.
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
session, the run token's on the gate's route, and only by the **read rule**, and reads none for a call without one, so the
transcript and the record hold only the reference. Accept checks only that the caller may read
the file, that it is not another session's, that it is a file and that its version exists: any
type is accepted, whatever the model reads (protocol 15), and its size was held to the artifact
limits at upload. The files a session's messages named are kept on it (`Session.fileArtifacts`)
for the read rule. How the model sees each file is the harness's decision (its **file view**,
from the **model descriptor**). The gate (`buildContext` in `model/pi-model.ts`) decides nothing:
it fetches the artifact a media part names and translates it, an image to image input and a PDF,
Office document, audio or video to a **native block**, and refuses what the provider cannot take
before anything is sent: a text file as a media part (the harness inlines text), or a kind the
model or its API does not read, is `unsupported_input`; a reference it cannot fetch (not the
session's, missing, a folder, past `limits.modelFileBytes`) is `invalid_request`. Neither is
retried, and the gate writes no notes, schema instructions or JSON repair: a structured answer
passes through as the model's text.

**Native block**: A PDF, Office document, audio or video carried to the provider in its API's own
block (`model/native-blocks.ts`): Anthropic `document`, OpenAI Responses `input_file`, OpenAI
completions `file`, `input_audio` (WAV and MP3 only) or `video_url`, Google `inlineData`. pi-ai's
messages hold only text and images, so `buildContext` puts a marker text part in the file's place
(`NativeBlocks.add`) and the call's `onPayload` swaps each marker for its block in the request
pi-ai built (`rewrite`). A kind the API does not carry is refused before the request is built
(`unsupported_input`); a file the request cannot carry (an audio format the API lacks) stops it
before it is sent, and the call fails `invalid_request`. Neither is retried. The kinds each API carries (`NATIVE_FILE_KINDS`) are
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
endpoint's `settings.inputs` (text only by default). One resolution serves the catalog, the
provider list, `turn.start.model` and the Model Gate (which gives pi-ai a model with an added
image, so it is not dropped): `selectionOf` and `describeModel` (`model/descriptor.ts`), so what a
harness is told and what the gate takes cannot disagree. A file's input is `modelInputOf(mediaType)`
(`core/src/utils/media-types.ts`, in `@nylorun/core/contracts` since protocol 15, so the Runtime
and a harness type a file alike).

**Model descriptor**: The model a turn's calls use when they name none (protocol 15,
`turn.start.model`, `ModelDescriptorSchema`): `{provider, id, inputs, contextWindow,
maxOutputTokens, reasoning?}`. `currentModelDescriptor` (`model/descriptor.ts`) reads the
Tenant's active vault model with its added inputs, through `modelsFor` as the gate does (a custom
endpoint's settings apply), or the fixture model's (`provider: "fixture"`, every input, the small
custom window) when the Tenant uses it; none when no model is configured. `startSegment` reads it
outside the session's transaction for an agent's turn, never a flow's; it is a snapshot, so a
model switched mid-turn may refuse a part the harness chose for the old one (`unsupported_input`).
The A2A card's input modes and MCP deferral's window read it too.
_Avoid_: a harness guessing what the model reads.

The **reference line**, the **file view** and the structured answer are the harness's
(`runtime/harness/src/CONTEXT.md`).

**Read rule**: What a session may read of the Tenant's artifacts (`sessionMayRead`,
`artifacts/files.ts`): its own, and the Tenant-wide ones its messages named
(`Session.fileArtifacts`); never another session's, nor an Environment's disk versions. The Model
Gate and the **artifact seam** read by it, so a model call and a harness reach the same files.
Agents used as tools share their session's reach; a linked session (a flow's agent step, a flow
agent used as a tool) has its own.

**Artifact seam**: The Harness API's `artifact.read` and `artifact.write` (protocol 15, Harness
API 4; `harness-api/artifacts.ts`): a harness reads and writes the artifacts of the run it holds,
its session's by the read rule, never one a parameter names. A read answers the version's
metadata and its bytes from an `offset`, at most the run's Runtime limit `chunkBytes` (clamped);
a folder answers its metadata only. A write (`begin`, `chunk`, `commit`, `abort`) makes a file
artifact of the session or a new version of one of its own, streamed into `uploadArtifact` with
backpressure (a chunk is answered once the store took it; a chunk past `chunkBytes` is
`limit_exceeded`), and commits as any upload does, within the Tenant's and the Environment's
artifact limits. Its `key` makes it idempotent within the session (`artifact_versions.write_key`,
the SHA-256 of session and key, migration 0028): a key written before answers that version,
`created: false`. Its `effectId` names a tool call of the run's turn, whose call id core reads
from the journal for `artifact.created`. An upload the run leaves open ends with it, and commits
nothing. Refusals are `not_found` (one message for missing and not the session's), `limit_exceeded`
(with `limitBytes`) and `invalid`.

**`save_artifact`**: Our engine's tool (protocol 15: our harness's, no longer the Runtime's) that
saves a sandbox file (`path`) or text (`content`) as a file artifact of its session over the
artifact seam, keyed by its effect id, with its turn and tool call on the event; our harness
offers it to an agent with a sandbox. Its call is a `tool` effect of kind `harness` (the harness
declares it in `hello`), so a crash between the commit and the outcome fails it as
`tool.interrupted` and the key keeps a repeat from storing it twice.

**Record entry limit**: What one entry of the record may hold: an event's payload, an effect
outcome, a transcript entry, at most the Tenant's Runtime limit `recordEntryBytes` as JSON (S0).
The record refuses a larger one with `limit_exceeded` and writes nothing (`checkEntry`;
`recordOutcome` in `harness-api/record.ts` says to store the rest with `artifact.write`), so a
tool result is the harness's to make fit (protocol 15): our harness spills what does not fit to
file artifacts of the session keyed per effect and reports a preview (**spilled tool result**,
`runtime/harness/src/CONTEXT.md`); a custom harness does the same, or reuses `shapeToolOutcome`
and `StepBudget` from `@nylorun/harness`. Core no longer shapes results (`tenant/tool-results.ts`
is gone). The Tool Gate still scrubs the credential values an answer echoes (R2b C8) and keeps
no answer past `toolAnswerBytes` (8 MiB by default; `mcp.too-large`, `http.too-large`), and
`tool_crossings` keeps its raw scrubbed answer, so a rejoin returns the same bytes and the spill
key makes the same artifact. A flow's HTTP stage output is data, and is not shaped: past the
limit, its outcome is refused.
_Avoid_: "stored tool result" for core's part (core stores nothing of a result now).

**`read_artifact`**: Our engine's tool (protocol 15: our harness's, no longer the Runtime's) that
reads a text artifact in pages (32 KiB by default, the harness's `artifactPageBytes`) from a byte
`offset`, returning `nextOffset` while more remains, at a `version` or the latest, over the
artifact seam, and hands any other file to the model as a file of the result (the Model Gate
shows it or writes a note). With a sandbox, `path` copies the whole artifact into it instead.
Our harness offers it to every agent of a session's tree; the Runtime pins nothing for it. It
reads by the read rule. An agent session opened before protocol 15 pinned it, and is closed
(`protocol_15`, migration 0029).

**Definition file**: A file a definition names by the SHA-256 of its bytes (`sha256:<hex>`), today
each file of a skill's folder (`SkillManifest.files`, track R2 M4; `tenant/definition-files.ts`).
A client uploads it once with `PUT /v1/files/sha256:<hex>` (application key, at most the
Tenant's skill limit, a
body of another hash is a `400`; `201` stored, `200` held already; `HEAD` says which); the body
streams to a staging key (`definitions/uploads/<uuid>`), and only bytes of the named hash are
copied to `definitions/sha256/<hex>`, where a `definition_files` row says the Tenant holds them.
`PUT /v1/agent-manifests/{name}` refuses a manifest naming a file the Tenant lacks
(`definition_files_missing`) or a skill whose files hold more than the Tenant's skill limit
together (`skills.config`, `GET`/`PUT /v1/tenant/skills`, default `SKILL_TOTAL_BYTES_DEFAULT`,
2 GiB), counted by path from the rows' sizes (`413 limit_exceeded`); no file and no count of
files has a limit of its own; the manifest's own `runtime.limits.skills.totalBytes` may set less.
A session opens on an Agent only while its skills still fit the Agent's limit (the Tenant's may
have been lowered since; else `413 limit_exceeded`). A save records each file a version names, its
skills' and its runtime section's, in `definition_file_uses` (`agent-manifest:<name>`, manifest
hash, file). Nothing deletes them yet: a later sweep removes the unused ones.
_Avoid_: calling it an artifact; artifacts are a session's or an application's files.

**Skill tools**: `load_skill` and `read_skill_resource`, our engine's tools (protocol 15: our
harness's, no longer the Runtime's), which it offers an agent with skills with the skill catalog
and runs itself, reading the skill's definition files over `definition.file` (`harness`
calls): nothing reaches the developer's process, and core serves only the bytes a run's
definition names. A session with a sandbox also has each skill's files read-only in a folder per
version, `/skills/<name>@<hash>/` (`skillFolderOf`, D66), never replaced, so sessions whose
agents carry different versions share an Environment. Our engine decides the folders and when
(protocol 15): before each `sandbox` call it mounts each skill version of the turn's tree with
`executors.files.mount`, reading the bytes over `definition.file` (the run's `chunkBytes` at a
time), in process too; the host's SandboxManager only writes them (`mountFolder`,
`sandbox/skills.ts`), once per open handle (a repeat is `present`). A stop clears them; the next
sandbox call mounts them again. The operator sandbox route mounts none. Each session's calls on a
workspace run in order and different sessions' at once; opening, stopping and removing run
alone (`sandbox/manager.ts`).

**Protocol**: Wire integer and feature set in `Nylorun-Protocol` /
`HOST_PROTOCOL` (`PROTOCOL_VERSION = 15`; the Host serves protocol 15 only and answers
older clients `426`; required features `studio-principal`, `artifacts`, `management-api`,
`resource-server`, `environments`, `model-inputs`, `flat-manifest`, `environment-manifests` and
`harness-boundary`;
optional Host features `tenant-fixture-model`, `transcript-events`, `subject-headers`,
`ag-ui-endpoint`, `a2a-endpoint`, `sandbox-pods`, `trusted-issuers`, `session-reads`,
`calls-export`, `credential-coverage`, `tool-calls`, `environment-setup`,
`environment-disk-versions`, `tool-policy`, `traces` and `artifact-reads`).
Protocol 16 made agents one manifest (track T2, `agents`, Harness API 5): an **agent manifest** v8
with a harness and a runtime section, checked against each other at save, replaced agent
definitions and environment manifests, and **Agents** (`/v1/agents/{id}`, made from a manifest
version, with a derived state) replaced Environments; every session runs on an Agent and pins its
manifest version; `turn.start.agent` replaced `turn.start.environment`. A fresh start (migration
0032): every open session is closed (`protocol_16`), and Environments with their disks and vaults
are dropped.
Protocol 15 began the harness boundary (`harness-boundary`, Harness API 4): model-facing work
belongs to the harness. `read_artifact` and `save_artifact` are our harness's tools, run over the
**artifact seam**. Inputs went to the harness too: a message may name any file (no
`422 attachment_unsupported`), `turn.start.model` is the **model descriptor**, the gate only
fetches and translates (`unsupported_input`), and `ModelCall` has no `outputSchema`. Then the
instructions and the remaining built-in tools: the manifest has no `runtime` block (the schema
refuses it, `REMOVED_MANIFEST_FIELDS`), a session pins its definition as registered (its
`manifestHash` is its `definitionHash`), `turn.start` states facts (`environment`,
`routing.sandbox.spec`, the agent's `skills`) from which our harness writes the skill catalog
and the sandbox notes and defines the sandbox and skill tools, and the record routes each tool
call by its **effect target**, so no tool name is reserved. A fresh start for agent sessions:
each that pinned the artifact tools, or a `runtime` block at all, is closed (`protocol_15`,
migrations 0029 and 0030).
Protocol 14 added environment manifests (D63 to D65, `environment-manifests`): named, versioned
definitions under `/v1/environment-manifests/{name}`, saved like agents (`If-Match`,
`?dryRun=true`); an Environment is made from one version (or inline fields) and never changes
what it runs (`409 environment_immutable`: a `PUT` changes only its labels and owner guard), so a
new version reaches it through a fork (`POST /v1/environments/{id}/fork`); its view's `recipe` is
now `manifest`; a manifest's `secrets` declare slots (`409 secret_not_in_manifest`); an agent
manifest's `requires` is checked when a session opens (`409 environment_unsuitable`). Sessions
on one Environment run their turns in parallel (D66), and every egress connection is an
`environment.egress` event on the Environment's stream; `egress.connection` left session logs
and traces (D67).
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
said nothing writes `message.assistant` with `text: ""`, which readers that build a conversation
(AG-UI, A2A) skip (`isEmptyAssistantMessage`). A summary call (`purpose: "summary"`) writes no
row of its own: **compaction** is an explicit transcript edit (Q4, protocol 15), whose first
chunk says `kind: "compaction"` with the harness's facts and the summary calls it names; the
record checks those calls and writes one `context.compacted` with the edit, from the facts and
the last summary call (`tenant/transcript.ts contextCompacted`). It never parses the entries.
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
`invoke_agent {name}`, named for the agent manifest the session runs (`gen_ai.agent.name`; `gen_ai.agent.id` is its Agent; `nylorun.manifest.version` the version the turn ran, T3); each span-ready row of a model call (`chat`), tool call or flow stage
(`execute_tool`) is its child, with gate times when a gate measured the crossing (egress
connections are the Agent's, as `agent.egress` events, and in no trace, D67); pauses and answers are markers. A turn whose `command.message` carried a
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
- **Tool call delivery** (R5): Every tool call is a row of `nylorun.effects` and ends in one `tool.completed` with its `status` (`completed`: the tool answered; `failed`: the Runtime ended it, `tool.unknown`, `tool.disabled`, `tool.unavailable` or `tool.interrupted`; `cancelled`), `kind` (its **effect target**'s: `mcp`, `http`, `sandbox`, or `harness` for a tool the turn's harness runs itself, our harness's skill and artifact tools and `tool_search` among them; absent for a call with no target; `platform` is gone, protocol 15), `server`, `tool` (the target's identity: an MCP tool's own name on `server`, an HTTP tool's declared name; `toolName` stays the model's name, for display; protocol 15), the `skill` it ran (the one its intent names, when the agent has it: our engine names a skill tool's and a sandbox call's in a skill's folder) and the `plugin` that brought its skill or server (protocol 13, `toolKindOf`), `attempts` and `durationMs` (`harness-api/tool-journal.ts`), and, since R7.1, its `effectId`, the gate's `gate` times and the tool `policy` (see **Span-ready row**); a flow's HTTP stage ends in `node.completed`. `GET /v1/sessions/{id}/calls/tool` pages the rows (Host feature `tool-calls`), each with its `tool` (null on a row with no identity). A trace's tool span adds `nylorun.tool.identity`; `gen_ai.tool.name` stays the model's name. A call is sent at least once, its effect id the key on every send: an MCP or HTTP call a crash, a shutdown or a lost gate hop interrupted is sent again, up to 3 sends, then fails to the model as `tool.interrupted`; a sandbox or harness call has no key to dedupe on, so it fails to the model at once and is not run again. A cancel ends a running call `cancelled`. No tool call parks its session `uncertain`; model calls keep their own rules.
- **Effect target** (protocol 15): What a tool call names as what runs it, by identity (`EffectIntent.target`, `EffectTargetSchema`): `{kind: "mcp", server, tool}` (`tool` the server's own raw tool name), `{kind: "http", tool}` (the HTTP tool's declared name), `{kind: "sandbox"}` or `{kind: "harness"}`; beside it the name the model used (`toolName`, for display only). The target is in the request hash (`effectRequestHash`), so a replay with another identity is `effect_drift`. The record routes by the target alone (`harness-api/record.ts`, `refusal`): `mcp` runs when a server of that name is one the call's agent (`effect.agent?.id`) declares and the session's pinned MCP snapshot discovered the tool (`mcpToolIn`; else `tool.unknown`), and the turn's manifest leaves it enabled (R2b C9, `isEnabledIn`; else `tool.disabled`); `http` when the agent declares an HTTP tool named `target.tool` (else `tool.unavailable`); `sandbox` when the session has a sandbox (`Session.sandbox`) and the name is one of the six sandbox operations; `harness` always (the harness's own process; its egress gate is its only control). Core runs no tool itself (`platform`, `runInCore` and core's `tool_search` are gone). A call with no target (an author's code tool) or one the session lacks fails to the model, `tool.unavailable`, and nothing runs; the harness host routes the same way (`harness/executors.ts`; `callMcpTool` sends `{agentId: effect.agent?.id, serverName: target.server, serverToolName: target.tool}`). No tool name is reserved: a name two of the model's tools share is the engine's to refuse (`agentFrom`, `agent.build-failed`). _Avoid_: "native tool", "Runtime tool".
- **Tool Gate**: The gates service's routes for remote MCP servers (`/nylorun/v1/mcp/*`, `/nylorun/v1/tool-calls`), and HTTP tools (`/nylorun/v1/http-calls`), and the `ToolGate` seam the Tenant calls (`gates/tool-gate.ts`): in process, or over HTTP (`gates/tool-client.ts`). Only it holds a remote MCP connection and its credential (`gates/mcp-handler.ts`), and it reaches the server under the Host's address policy (`guardedFetch`, `tenant/outbound.ts`: `localhost` is the Docker host in the local stack). A keyed MCP or HTTP tool call outlives its client (`gates/tool-calls.ts`, the `tool_crossings` table): a re-send joins it or gets its answer, and one lost with an earlier gateway runs again under the same key (R5.3). Under a run token it sends only a call the effect journal holds, running, as sent (R5.6, `gates/journal.ts`): an MCP call's row must target the same agent, server (`body.server.serverName`) and tool (`body.name`, the raw name), read from the row with no session read (protocol 15); an HTTP call's `httpToolRefOf` (from `target.tool`) must match; `400 key_required` without the key, `409 effect_not_journaled` otherwise. Before it records or returns an answer, it replaces the credential values it sent that the answer echoes with `[redacted]` (R2b C8, `scrubValues` in `redact.ts`; `tool.completed.redacted` counts them), and keeps no answer past `toolAnswerBytes`; it shapes nothing (see **Record entry limit**). The sandbox tools never cross it.
- **MCP snapshot** (protocol 15, v2): What a session's remote MCP servers listed at discovery, raw (`McpSnapshotSchema`, `@nylorun/core/harness-api`; `mcp/snapshot.ts`): `{snapshotSchemaVersion: 2, manifestHash, servers: [{agentId?, name, instructions?, tools: [{name, description?, inputSchema, outputSchema?, annotations?}]}]}`, each tool by its server's own name, with every listed tool whose `inputSchema` is an object, disabled ones included, and the server's instructions scrubbed and uncut (the pool leaves out instructions past `recordEntryBytes` with a diagnostic note, `McpPool.discover`'s `maxInstructionBytes`). A harness records it once per session (`session.mcp`; the first recorded wins) and the session keeps it pinned, until a turn re-pins the session to another agent manifest version (T3, `repinTurn`), which drops it. Each turn gets it as **facts** (`McpFactsSchema`, `turn.start.mcp` and the `session.mcp` answer; `mcpFactsOf(snapshot, turnManifest)`): each tool with `enabled` and the manifest's `deferred` hint, and a server the turn's manifest no longer declares left out. `TurnStart.sessionTools` and `routing.mcpSnapshot` are gone. Our harness discovers when the turn has no facts (`prepareMcp`) and reconnects `start.mcp.servers` after (`McpPool.reconnect`). A session pinned with a v1 snapshot was closed (`protocol_15`, migration 0031). _Avoid_: "session tools" for the facts (the harness makes tools of them).
- **MCP tool name**: What the model calls a remote MCP server's tool: the harness's to choose (protocol 15). The Runtime never names one: the snapshot, the facts, the target, the Tool Gate's body and the tool policy carry the server's own raw name. Our engine's names (`mcpToolName`/`mcpToolNames` in `@nylorun/harness`, `runtime/harness/src/CONTEXT.md`) are `server__tool` with characters outside `[A-Za-z0-9_-]` replaced by `_`, shortened to 64 with a hash suffix, which a renamed name that collides also gets; the **MCP tool preview** shows them, and `mcp.discovered` no longer lists `renamed`. Server and declared tool names are checked at save against the same rule (`DELEGATE_NAME_PATTERN`).
- **MCP tool error**: A failed remote MCP tool call the model sees as a failed tool result with a code (R2b C7, `McpCallFailed` in `mcp/connect.ts`): `mcp.unreachable` (never sent, `retryable`), `credential_rejected` (`401`), `mcp.forbidden` (`403`), `mcp.error` (a JSON-RPC error), `mcp.status` (another HTTP status), `mcp.too-large` (an answer past 8 MiB, R2b C11), and `mcp.lost` (sent, answer lost: the tool may have run; the model decides, R5). The gate answers it as `error.failure`. `isError` results stay `mcp.tool`. A connection found stale before the tool saw the call (`McpConnectionStale`: a `404` to its `Mcp-Session-Id`, or a credential whose `via` moved) is dropped from the pool or the gate, opened again, and the call sent once more; a second failure is `mcp.unreachable`.
- **HTTP tool**: A tool whose manifest entry has `http` (`url`, `method` GET/POST/PUT/PATCH/DELETE, `credential`, `timeoutMs`; a sibling of `agent`, with `fn` and `command` reserved), built with `http()`: the Tool Gate sends the input as core's `httpToolRequest` maps it (the fields the URL's path names as `{field}` fill it, percent-encoded, and the rest are a JSON body for POST/PUT/PATCH or the query string for GET/DELETE, which send no body; a value that cannot fill its place is `tool.invalid-input`, never sent) with `Nylorun-Session-Id`, `Nylorun-Turn-Id`, `Nylorun-Agent-Id` and the effect id as `Idempotency-Key`, adding the vault credential bound to the URL that the `credential` selection names, sent to the credential's `via` when it has one, with its identity header (`gates/http-tool.ts`, `runHttpTool`; the request and answer alone are `callHttpTarget`). Its outcome is the answer, which the harness shapes to fit the record (see **Record entry limit**), or a failed outcome the model sees (`credential_rejected` on a `401`, `http.status`, `http.timeout`, `http.refused`, `http.unreachable`, `http.lost`, `http.too-large`, `http.credential`, `tool.invalid-output`). An HTTP tool is also a flow stage (a tool node with `http`), and `http({ url })` a Loop's HTTP verifier (`loop.verify: { http }`, POSTed `{ input, output, iteration }`, answering a verdict): their `tool` effects are journaled `invoking` and executed like an agent's (`harness-api/record.ts`), the gate finds the target in the pinned workflow manifest by stage key (`{ sessionId, stage }`, `flowHttpTarget`) and sends the flow agent's id as `Nylorun-Agent-Id`, and a failed outcome fails the stage (or the Loop, `loop.verify-failed`). An HTTP verifier's verdict is recorded as `loop.verified` (`recordVerdict`, `core/flow-host.ts`). _Avoid_: "webhook tool".
- **Tool policy** (R5 step 2): The Tenant's rules for every MCP and HTTP tool call of every harness (`GET`/`PUT /v1/tenant/tool-policy`, a management key; the `tool-policy` setting): each `{effect: allow|ask|deny, tool?, server?, kind?, agent?, when?, reason?}`, and the strictest matching rule decides; no match runs (`gates/policy.ts`). A rule matches the call's identity (protocol 15, `policyCallOf`: `PolicyCall {kind, tool, server?, agent, input, name?}`): `agent` is the calling agent's manifest id (an agent used as a tool's id, else the session's loop manifest's, which protocol 16 makes the agent manifest's name), never the Agent the session runs on; `tool` is an MCP tool's own name on `server` or an HTTP tool's declared name, and the model's name (`name`) never matches. A rule `tool` with `__` in it is refused at `PUT` (`ToolRuleSchema`: name an MCP tool by `server` and `tool`); a stored one makes the policy unreadable (`ToolPolicyUnreadable`): every call is denied with that reason, and `GET` answers `409 request_rejected` until the policy is `PUT` again, so a rule never silently stops matching. Core decides as it journals the call (`recordIntent`, `bypolicy` in `harness-api/record.ts`): `deny` settles it `tool.denied`, unsent; `ask` keeps the row `held`, the segment ends waiting, and settle pauses the turn with one `approval` interaction per held call (its id the effect id); `approve` makes the row `invoking` with its `approval` (the replay sends it) or settles it `tool.denied`. The Tool Gate runs only `invoking` rows, so no harness skips it. A pinned manifest's `approval: "always"` (saved before; new definitions are refused, `approvalRefusal`) is an ask (`pinnedApproval`, by `mcpToolSettings(server, target.tool)`). An MCP call's approval interaction carries `server` and `tool` (`heldCalls`, `tenant/advance.ts`), its prompt `Approve <server> / <tool>?`, and `toolName` stays the model's name. _Avoid_: "static approval".
- **MCP tool settings**: An MCP server's `tools` map (R2b C9), keyed by the server's own tool names with `"*"` for the rest, each `{enabled?, deferred?}` (and a pinned `approval`), beside the server's own `deferred`; a tool's settings resolve from its entry, then `"*"`, then the server, then the default (`mcpToolSettings`, core). `mcp.discovered` counts the disabled tools (`disabled`) and names keys no listed tool has (`unknownTools`). A turn variant may only tighten them: `enabled: false` or `approval: "always"` (`isVariantOf`). The snapshot keeps every listed tool, disabled ones included; each turn's facts say whether its manifest leaves a tool `enabled` (`mcpFactsOf`), and the record enforces it: a call of a tool the turn disables is `tool.disabled` (`isEnabledIn`), whatever the harness offered. _Avoid_: "allowlist" for the map itself; `"*": {enabled: false}` makes one.
- **Deferred tool**: A remote MCP tool out of the model's tool list (R2b C10), which the model finds with `tool_search` and runs with `tool_call`: the harness's to decide (protocol 15). A tool's or a server's `deferred` setting reaches it as a hint (`McpToolFact.deferred`, absent when the manifest says nothing); core decides nothing and runs no `tool_search` (`pinDeferral`, `sessionToolsOf` and `tenant/tool-search.ts` are gone). Our engine decides once per session's facts and keeps it in its state (`mcpLayout`, see **Harness state**); `tool_search` is a `harness` call, and `tool_call` makes the deferred tool's own effect with its identity target, so routing, policy, `tool.completed` and scrubbing are a direct call's (`runtime/harness/src/CONTEXT.md`). _Avoid_: "lazy tools" or "tool RAG".
- **egress-gate**: The `egress` service (F7.2, D42), run in the gateway's process on 4200 (`NYLORUN_EGRESS_LISTEN_*`): pod Environments' only way out, a CONNECT proxy that verifies an egress token, checks its Environment's host epoch, and tunnels only to a host name in its applied recipe's `network.allowedHosts` (exact or `*.suffix`) on 443 or 80 that resolves to a public address, 64 tunnels per sandbox (`gates/egress.ts`). The one exception is a host an `environment_secret` is bound to (R2c, see **Shell credential**); every other connection is an opaque tunnel. Each connection is one event (see **Egress event**); refusals are also logged.
- **Egress event**: One connection through egress-gate on the record (track R7, Q6, Q7; `gates/egress.ts`): host, port, outcome (`allowed`, or `refused` with the gate's `reason` and `status`), `mode` (`tunnel`, or `credential` with the request count and the credential ids set), bytes up and down from the client socket, and `startedAt` (the gate's clock at CONNECT) with `durationMs`; never a header value, a path or a body. Written once, when the connection closes or at once when it is refused, by `egress-gate`, as `environment.egress` on the Environment's own stream (D67): the connection is the Environment's, since its egress token names the pod and turns run in parallel. `runningTurns` lists the turns active on the Environment as the connection opened (sessions on it with an `activeTurnId`, at most 16) as context, never as the owner: one read, started as the name resolves and never waited for, so a turn that moves while it is in flight may show either way; no session log and no turn trace holds it. A refusal before the Environment is known (no token, a stale one) stays a log line. A write never holds the tunnel up; a failed one is logged (`egress_record_failed`). _Avoid_: "egress log" for the gateway's log lines.
- **Shell credential**: An Environment's secret a skill's CLI uses in its pod (R2c, D50, D56): `environment_secret` (the variable is the secret's name; sealed value, `allowedHosts`, `inject` header and format) or `environment_variable` (a visible name and value). The lease's `routing.sandbox.environment` gives every command each secret's name with the sentinel `nylorun_managed` and each variable's value (`VaultService.environmentVariables`, `harness-api/start.ts`). For CONNECT to 443 of a bound host, egress-gate terminates TLS with a fresh leaf the egress CA signs (`keys/egress-ca.ts`, `keys/x509.ts`; the CA in the Tenant setting `egress.ca`, its key sealed) and sets the header on every request from the Environment's vault, uncached (`releaseEnvironmentSecret`, `gates/egress-credentials.ts`). A second secret for a host is refused at the write (`409 credential_conflict`). _Avoid_: "placeholder", "injection" for the variable itself.
- **Egress CA**: The installation's one long-lived CA for egress-gate's leaves (R2c, `keys/egress-ca.ts`): created on first use under the signing keys' lock, its certificate in every join answer (`caCertificate`) and the pod's trust bundle (`<harness root>/egress-ca-bundle.pem`, `harness/pod.ts`), its key never outside keys. No rotation yet.
- **Egress token**: The ES256 JWT (`typ: nylorun-egress+jwt`, `aud: nylorun-egress`) a pod's harness gets at join, naming its sandbox, host epoch and pod UID; minted with every host token (`mintEgressToken`, `tenant/host-token.ts`) and accepted only by egress-gate, as the proxy credential (`sandbox/egress-token.ts`).
- **MCP tool preview**: What a remote MCP server offers before an agent names it (R2b C12, `POST /v1/tenant/mcp/preview`, a management key; `admin.mcp.preview`, `nylorun tenant mcp inspect`, Studio's **Preview tools**): the keys service (`Keys.previewMcp`, `mcp/preview.ts`) connects with the credential for the URL in the vault of `environmentId`, if given (its headers and `via`, never an identity header), under the Host's address policy and within 15 s, lists the tools with the model names a server called `name` would get from Nylorun's engine (`modelName` and `renamed`, from `mcpToolNames` in `@nylorun/harness`; a custom harness names its own; default from the URL's host, `previewServerName`) and the server's `instructions`, uncut, and closes. It never calls a tool, and scrubs every credential value sent from its answer. A `401` answers `200` with `authRequired` and the server's RFC 9728 protected-resource metadata (the challenge's `resource_metadata`, else the well-known path); any other failure is `502 mcp_preview_failed` with `details.failure` (`mcp.unreachable`, …). _Avoid_: "probe", "connect" (removed in protocol 10).
- **Model Gate**: The gates service's endpoint for model calls, `POST /nylorun/v1/model-calls` (`api/gate/routes.ts`, `host/gates.ts`), and the `ModelGate` seam every harness calls (`gates/model-gate.ts`): in process (`gates/in-process.ts`), over HTTP (`gates/http-client.ts`), or over a scripted model (`gates/provider-gate.ts providerModelGate`: tests, `model: {kind: "scripted"}`, metered like any). No harness calls a provider directly, the in-process one included (protocol 15). Only the gate reads a model credential (`vault/host-model.ts`); a hop failure is a failure outcome, never an uncertain effect.
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
- **Harness API**: The protocol between core and a harness (v4, `@nylorun/core/harness-api`, blueprint D37; v2 dropped held runs with track R2, v3 renamed `hello.capabilities` to `features` and dropped `capabilityId`, v4 is the harness boundary of protocol 15: effect targets, the artifact seam, `turn.start` facts): requests and messages over a channel, in process by reference (or through JSON in tests), or over WebSocket (F6.2: core's listener `harness-api/ws-server.ts`, `NYLORUN_HARNESS_LISTEN_*`; the client `harness/ws-client.ts`). A harness says `hello`, keeps a `lease` waiting, and per run sends `effect.intent`/`effect.outcome` (the Record seam), `lease.renew`, and one output (`turn.completed`, `turn.paused`, `turn.waiting`, `turn.failed`, `checkpoint` for a yield) or `lease.release`. Core sends `cancel` with the advance's abort reason. A harness readies the session's MCP servers itself (`session.mcp`) and claims its `environment.state`, `environment.exec` and `artifact.export.*` events (`event`). A public contract since track R4 (R4.5): every body has a schema in `@nylorun/core/harness-api`, the Runtime validates with the same schemas, and core refuses a `hello` whose `api` is not 4.
- **Harness id** (R4.1): What a harness names itself in `hello` (`^[a-z][a-z0-9-]{1,62}$`; ours is `nylorun`), an Environment's `harness`, and the key of placement. A session pins its harness when it opens (`Session.harness`: its Environment's applied harness, else `nylorun`; a flow always `nylorun`), and only a connection that said that id takes its runs (`RunOffer.harness`). A connection's credential binds its id: `NYLORUN_HARNESS_TOKEN` is `nylorun`'s, a custom harness's own token (`tenant/harness-tokens.ts`, Tenant setting `harness.tokens`, made with `nylorun-operate harness token put <id>`) is its own, and a pod's host must be its Environment's harness. Workspace requests go to a pod's host or to `nylorun` connections only. An Environment's harness is fixed for its life (protocol 14; a fork runs another). A turn whose Environment runs another harness than the session pinned is `409 harness_mismatch`: its id was deleted and made again with another harness, or an Environment changed in place before protocol 14 applies that change (a pod at its next wake, with its image).
- **Harness state** (R4.2): A harness's turn state (`TurnOutput.state`) is its own: core stores it and hands it back to the same harness, and never reads it. Our engine aligns its state's `manifestHash` with the turn's checkpoint itself; core strips only our engine's transcript from it (`leanState`). A custom harness's state is at most the Tenant's Runtime limit `harnessStateBytes` (256 KiB by default; else its turn fails, `limit_exceeded`), it cannot pause for approvals, and a tool it runs itself is a `harness` call (its **effect target**), journaled like ours. It declares no tools (protocol 15: `hello.features.tools` is gone). Our engine's state holds its **MCP layout** (`ExecutionState.mcpLayout = {factsHash, deferred}`): which of the session's MCP tools it defers, decided once and kept while the facts' hash matches, so a model switch does not change the tool list; core never reads it.
- **Event writer** (R4.9): Who wrote an event, set by the code that writes it (`Tx.event`'s `EventWriter`), not by its type: `client` for a command (with its `principal`, from the credential), `harness` with the harness id and `runId` for what a harness reported (evidence `claimed`), `core` for core's own logic (evidence `observed`; with the run's id during a run). `egress-gate` is a kind no session event uses since D67: its **Egress event** is on the Environment's stream. The Model Gate's usage row is the measured record of a model call a harness reported.
- **Harness**: One long-running client of the Harness API that runs the engine for the runs it leases, with injected executors for model, MCP and sandbox calls and the sandbox files our engine decides about (`files`: read, write, list, mount; `@nylorun/harness/api`, `harness/executors.ts`). Placement changes nothing of what it reaches (protocol 15): in process or not, its model calls go through the Model Gate, its MCP pool opens servers only through the Tool Gate (`ToolGate.openMcp`, `openMcpThrough`; the in-process gate finds the server in the session's pinned manifest and authorizes it with the vault), and skill bytes come over `definition.file`. Each Tenant runs one in process (`harness-api/in-process.ts`, the default outside Compose), or none with `NYLORUN_HARNESS=remote` (the Compose stack's default): harness services (`--service harness`, `harness/main.ts`, `harness/service.ts`), the **Harness container** and the engines in pod Environments, attach over WebSocket with their own MCP pool and SandboxManager. It reaches no store (`scripts/check-boundaries.mjs`).
- **Harness container**: A local Tenant's `harness` container: the Runtime image with `--service harness`, connected to core's Harness API with `NYLORUN_HARNESS_TOKEN` and mounting only the Tenant's `sandboxes/` (`cli/nylorun/src/stack/compose-file.ts`). It runs the turns and the virtual sandboxes of every session not on a pod Environment. `NYLORUN_HARNESS=in-process` in `.env` drops it and runs them in the `runtime` container.
- **Workspace feature**: What core does with sandbox workspaces outside a run (`ctx.sandbox`, a `WorkspacePort`, `harness-api/workspace.ts`): the sandbox tool routes, disk versions, Tenant status, the sweep, an Environment's deletion and an Environments reset. In process it is the Tenant's SandboxManager; with remote harnesses it is the `workspace.*` requests to the harness that declared `workspace` in its `hello` (`503 request_rejected` when none is connected). The SandboxManager keeps its compute records through a `SandboxRecords` port (`sandbox/records.ts`: the `sandboxes` table, or `<root>/sandboxes/records.json` in a harness, mirrored into the table from its `environment.state` claims and sweep answers).
- **Run**: A lease on one session's segment, offered by an advance to the first waiting harness (`harness-api/server.ts`): a `runId` bound to the connection that leased it (any other gets `run_not_held`), the turn, the epoch and, from F5, a run token. Its `turn.start` carries the segment's checkpoint without the transcript, its completed outcomes and the transcript's cursor.
- **Transcript cursor**: The record `seq` of the last event that changed a session's transcript fold (`transcript.updated`, `turn.cancelled`, `turn.failed`). A harness that holds the transcript at the run's cursor resumes from its cache; otherwise it reads it once (`transcript.read`).
- **Wake**: A request, delivered at least once, that a session advance (`WakeReason` in `execution/types.ts`). A transaction asks for one with `Tx.wake`, which writes it to the outbox.
- **Outbox**: The Session Store's rows for what committed transactions asked of Durable Session Execution and it has not yet accepted: wakes (`nylorun.wakes`, `Tx.wake`) and pod sandbox reconciles and timers (`nylorun.sandbox_signals`, `Tx.signalSandbox`; a table of their own, so a Runtime that delivers only wakes never reads one). A row is written in the transaction that causes it, sent after commit with its idempotency key (a wake's `dedupeKey` or `wake:<row id>`, a reconcile's `signal:<row id>`) without the caller waiting for the send (`SessionStore.deliverTo`), and deleted once accepted. A row whose send failed is sent again by the Tenant sweep's next pass, and one that a crash cut off once it is older than `sweep.outboxGraceMs` (Host tuning) on the database's clock, under the same key, so no commit loses its request and none runs twice. The sweep delivers each row on its own: one whose delivery fails is retried with backoff, and after `sweep.outboxAttempts` failures (ten) it is parked (`parked_at`), logged once at error and kept for an operator, who sends it again by clearing `parked_at` (and `retry_at`) or deletes it. Nothing else runs after commit: there is no `afterCommit`. _Avoid_: "wake outbox" for the whole of it.
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
- **Pinned sandbox**: The sandbox spec of a session's Environment when the session opened (`Session.sandbox`, from the Environment's `applied` recipe, `sandboxSpecOf`), the one place it is kept (protocol 15: the manifest has no `runtime` block): `turn.start` hands it to the harness as `routing.sandbox.spec`, with `environment.sandbox.workspace`, and the harness's sandbox calls run in it (`sessionSandboxSpec`, `sandbox/share.ts`). A flow's linked sessions inherit the workflow's Environment and spec (`tenant/effects.ts`). A virtual Environment's recipe change reaches the sessions opened after it.
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
| `/v1/vaults…`, `/v1/access/signing-keys…`, `client.createVault`, `client.access.signingKeys` | `/v1/tenant/signing-keys…`, `admin.signingKeys`; vaults: an Agent's secrets (protocol 16; an Environment's from protocol 11) |
| `/v1/sandboxes…`, `client.sandboxes`, `sandbox: { id }`, `vaultIds`, `credentialSelections`, `/v1/tenant/vaults…`, `admin.vaults`, user and installation vaults, `sandboxes:write`, `sandbox_*` error codes and events (protocol 10) | Agents (protocol 16; Environments from protocol 11) |
| agent definitions, `PUT /v1/agents/{id}` with a v7 manifest, `saveAgent`, `implementationVersion`, environment manifests, `/v1/environments…`, `client.environments`, `environment: <id>` on a session, `environments:write`, `environment_*` codes and events, `requires` (protocol 15) | agent manifests (`/v1/agent-manifests/{name}`, `client.agentManifests`, `nylorun apply`), Agents (`/v1/agents/{id}`, `client.agents`), `agent: <id>` on a session, `agents:write` and `agent-manifests:write`, `agent_*` codes and `agent.*` events, the checks between the sections at save (protocol 16) |
| required feature `admin-status` on new clients | `management-api` (the Host advertises `admin-status` only for protocol 5 to 7 clients) |
| `deriveStudioToken(adminKey, tenantId)` | `deriveStudioToken(adminKey)` (Studio key v2) |
