# @nylorun/runtime

The independent OSS **Runtime Host** consumes `@nylorun/harness/run` and
`@nylorun/core/contracts`. Cloud installs published `@nylorun/harness` from npm
and does not import this package. Every Tenant serves two APIs on one URL: the
**Runtime API** for developers (agents, sessions with AG-UI and
A2A, sandboxes, artifacts), whose client is `@nylorun/agents`, and the
**Management API** for operators (`/v1/tenant/*`), whose client is `@nylorun/admin`.
Vocabulary: [src/CONTEXT.md](./src/CONTEXT.md).

Requires Node 24+. Build from the repository root:

```sh
npm install
npm run build --workspace @nylorun/core
npm run build --workspace @nylorun/harness
npm run build --workspace @nylorun/runtime
```

## Running the Runtime

The Runtime runs as the `ghcr.io/nylorun/runtime` image, next to Postgres,
Restate and S2: `nylorun start` runs them, as a local Tenant, on a developer machine. The
package is a library with no bin; its Host entry is `@nylorun/runtime/server`
(`dist/host/main.js`), which requires `NYLORUN_DATABASE_URL`. For tests and
ephemeral embeds, use `startEphemeralRuntime()` from `@nylorun/runtime/core`.
See [MIGRATION.md](../MIGRATION.md).

A Runtime serves one **Tenant**: an installation is one Runtime with its own
Postgres database, Restate and S2 basin, and two Tenants are two installations. No
Tenant state lives only in the Runtime process. The Tenant's data is its Postgres
database, in the fixed schemas `nylorun` (its state: the Session Store) and
`nylorun_streams` (the record of its session events). Drizzle defines the tables
(`src/store/postgres/schema.ts`) and generates the migrations, which ship in the package
(`dist/store/postgres/drizzle/`). At startup the Host applies the missing ones in one
transaction under an advisory lock, records them in `nylorun.__drizzle_migrations`, and
refuses a database holding a migration it does not ship (`schema-too-new`); then, on
first start, it creates the Tenant there: its id (`NYLORUN_TENANT_ID`, default a
new one), its name (`NYLORUN_TENANT_NAME`, default `default`) and its Studio principal,
whose key the admin key derives (the only derived key). Management keys come from
`nylorun-operate` or `NYLORUN_MANAGEMENT_KEY_FILE` (below), and a management key adds,
rotates and deletes the Tenant's application keys (`PUT /v1/tenant/keys/{keyId}`); a rotated
or deleted key stops authenticating at once. A database written by a Runtime that kept several Tenants in one
database (`tenant_<id>` schemas), or by a pre-release build of one Tenant per database
(`schema_version` tables), is refused: this release starts fresh on a new database. Restate runs one advance of a session at a time and holds the Tenant's sweep
timer (Durable Session Execution); every session's events are relayed from the record to
its own S2 stream, which history and SSE read (Durable Streams). One image runs every **service**,
and `--service` picks what a process runs: `core` serves the Runtime API, the
Management API and SSE and runs the stream relay, `loop` runs advances (the Worker), and
`gates` is the Model Gate, the only process that reads a model credential and
calls providers. `core` and `loop` may share a process; `gates` never joins
them. A local Tenant packs `core,loop` into the `runtime` container and
`gates` into the `gateway` container (the combined packing). `--role
api|worker|all` is the deprecated name of `--service core`, `loop` and
`core,loop`.

`harness` runs alone: agent turns and workspaces, apart from core. With `NYLORUN_HARNESS=remote`, core runs no turn itself and opens the
Harness API listener (`NYLORUN_HARNESS_LISTEN_HOST`, `NYLORUN_HARNESS_LISTEN_PORT`,
default 4200, `NYLORUN_HARNESS_ALLOWED_HOSTS`), which accepts only
`NYLORUN_HARNESS_TOKEN`; `in-process` (the default outside Compose) runs turns in
core's process. A `harness` process needs `NYLORUN_HARNESS_URL`,
`NYLORUN_HARNESS_TOKEN`, `NYLORUN_GATES_URL` and `NYLORUN_HARNESS_ROOT` (default
`/harness`), answers `/health` on `127.0.0.1:4300`, and refuses to start with a
database, Restate, keys or gates credential in its environment. A local Tenant
runs it in the `harness` container, on a network with only the runtime and the
gateway ([DEPLOYMENT.md](../DEPLOYMENT.md#the-harness-agent-turns-mcp-servers-and-workspaces)).

The container is configured by its environment, which a local Tenant's Compose file
sets: `NYLORUN_DATABASE_URL` (required), `NYLORUN_RESTATE_INGRESS_URL`,
`NYLORUN_RESTATE_ADMIN_URL`, `NYLORUN_WORKER_URL` and
`NYLORUN_RESTATE_IDENTITY_KEY` (Restate), `NYLORUN_S2_ENDPOINT` and
`NYLORUN_S2_TOKEN`, and in container mode `NYLORUN_LISTEN_HOST`,
`NYLORUN_LISTEN_PORT`, `NYLORUN_ALLOWED_HOSTS` and `NYLORUN_PUBLIC_URL`.
`NYLORUN_MANAGEMENT_KEY_FILE` names the bootstrap secret (below).
`NYLORUN_IDENTITY_FILE` names the identity
file, a YAML list of the trusted issuers whose JWTs the Runtime API accepts
(Host feature `trusted-issuers`), read once at boot; a malformed file stops the
boot ([DEPLOYMENT.md](../DEPLOYMENT.md#trusted-issuers)). A process that runs `loop` sends its model
calls to the gate at `NYLORUN_GATES_URL`; in a container it refuses to start
without it and `NYLORUN_GATES_TOKEN`. That token is core's credential: the gate
accepts only it for vault writes and token signing. Model, HTTP tool and
remote MCP calls carry a run token instead, which the loop mints for each
session it advances, and the gate takes the call's session, turn and agent from
it; a token whose turn was cancelled or whose session another process took over
is refused with `409 run_stale`. A `gates` process needs only
`NYLORUN_DATABASE_URL`, `NYLORUN_GATES_TOKEN`, its listener
(`NYLORUN_GATES_LISTEN_HOST`, `NYLORUN_GATES_LISTEN_PORT`, default 4100, and
`NYLORUN_GATES_ALLOWED_HOSTS`) and the Host's `tenant/` directory, which it
never writes; it serves the database's one Tenant. A session's MCP servers and
HTTP tools get their credentials from its attached vaults only
([DEPLOYMENT.md](../DEPLOYMENT.md#credentials)); the credential resolver is gone
(protocol 10), and a process that still sets a `NYLORUN_RESOLVER_*` variable logs
`resolver_removed` and ignores it. With `egress`
(`--service gates,keys,egress`, for pod sandboxes) the same process runs
egress-gate on `NYLORUN_EGRESS_LISTEN_HOST`:`NYLORUN_EGRESS_LISTEN_PORT`
(default `0.0.0.0:4200`): a CONNECT proxy that admits a pod's egress token and
tunnels only to the hosts its sandbox spec allows, on 443 or 80, never to a
private address. `NYLORUN_PACKING` (`combined` or `split`) is logged at startup.

The Host has one listener, which serves both APIs. Host work runs on the machine
instead, with `nylorun-operate`, the image's operator command, inside the runtime
container (`docker compose exec runtime nylorun-operate …`, or
`kubectl exec … -- nylorun-operate …`). It reads the Tenant's database from
`NYLORUN_DATABASE_URL`, does one job and exits: being able to run it is the
authorization.

```sh
nylorun-operate status [--json]      # version, protocol, the Tenant's id, name, state and cause; exit 2 when not open
nylorun-operate keys list [--json]   # every key: id, role, when issued
nylorun-operate keys put <id> [--role application|management] [--json]   # prints the key once
nylorun-operate keys rm <id> [--json]
```

`status` needs no key, so it reports why a Tenant cannot open. Where no one can run
`nylorun-operate`, `NYLORUN_MANAGEMENT_KEY_FILE` names a file holding a management key
(64 hex characters), the **bootstrap secret**: the Host registers it as the key
`bootstrap` at every start, and replaces it when the file changes. Stop the Host with
SIGTERM.

The Host root is `NYLORUN_HOME` or `~/.nylorun` (for a local Tenant,
`~/.nylorun/tenants/<name>/`, bind-mounted at `/nylorun` in its containers). What stays on the Host is under `tenant/`.

## Layout

```text
<host root>/
  host.json                 # format 1: hostId, host, port, runtimeVersion, …
  host-credentials.json     # adminKey (0600): the root secret Studio's key derives from
  identity.yaml             # optional: trusted issuers (NYLORUN_IDENTITY_FILE)
  docker/                   # compose.yaml, .env (0600), Restate identity key
  tenant/                   # logs, home, sandboxes
```

## HTTP surface

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /health` | none | `service: "nylorun-runtime"`, `hostId`, protocol `{min,max,features}`, pid |
| `GET /ready` | none | Listener up, the Tenant open, and Postgres and Restate answer (`checks`). S2 is not checked: its health is in `GET /v1/tenant` (`streams.reachable`); `harness: { mode, connected }` while the Tenant is open |
| `GET /openapi/runtime.json` | none | The Runtime API's OpenAPI 3.2 document (below); alias `GET /openapi.json`. Refuses an `Origin` |
| `GET /openapi/management.json` | none | The Management API's OpenAPI 3.2 document. Refuses an `Origin` |
| `/v1/*` Runtime API routes (all but `/v1/tenant/*`) | application key or trusted issuer's token | Require `Nylorun-Protocol`; nothing names the Tenant. A management key is `403 key_role_mismatch`, except on `/v1/me` and the public `GET /v1/access/jwks` |
| `/v1/tenant/*` Management API routes | management key | Require `Nylorun-Protocol`. An application key, alone or acting for a subject, is `403 key_role_mismatch`; a management key with `Nylorun-Subject` or `Nylorun-Scopes` is `403 subject_invalid` |
| `PUT /v1/tenant/keys/{keyId}` | management key | Creates application key `keyId` or rotates it, and returns it once; `GET /v1/tenant/keys` lists every key (id, role, when issued, never the keys) and `DELETE` deletes one. `studio`, `bootstrap` and management keys are refused |
| `GET /v1/artifact-links/{token}` | the link itself | A capability link to one artifact version (protocol 6): no credential, no `Nylorun-Protocol`, Range supported; a folder's link opens its zip, or one of its files |

Every route checks `Host` first (`421 host_rejected`) and rejects non-JSON bodies
with `415 unsupported_media_type`, except an artifact upload (`POST /v1/artifacts`,
`POST /v1/artifacts/{id}/versions`), whose body is the file in any media type. An `Origin` is `403 origin_rejected` on
`/health`, `/ready` and the OpenAPI documents. On `/v1` routes a browser
presents a trusted issuer's token; keys (application and management)
are refused from browsers before they are looked up. The Runtime sends no CORS headers, and answers
`OPTIONS` with `204` and `Allow` only: the operator's reverse proxy answers preflights
([DEPLOYMENT.md](../DEPLOYMENT.md#calling-the-runtime-from-browsers-and-apps)). Missing or
unsupported protocol → `426` before authentication, unless the request sends neither
`Nylorun-Protocol` nor `Authorization` (the Host serves protocols 4 to 10; protocol 10 removes
the MCP OAuth connect, the vault's `oauth` credentials and the credential resolver; protocol 9 makes the
Runtime API an OAuth 2.1 resource server: a missing or rejected credential is `401
credential_required` or `credential_invalid` with a `WWW-Authenticate: Bearer` challenge, a
token without a route's scope gets `error="insufficient_scope"`, and
`/.well-known/oauth-protected-resource` lists the trusted issuers (RFC 9728); protocol 8 gives keys roles, moves vaults and signing keys under `/v1/tenant` and removes
the Admin API, and those old paths answer `404` with no alias; protocol 7 removes subject tokens, the access policy, revocations, browser keys and
derived principals, whose routes answer `404`; protocol 6 adds file and folder artifacts and message `parts`; at each turn's end the
Runtime exports `/workspace/outputs` of the session's sandbox as a version of its
`outputs` folder, read at `/v1/artifacts/{id}/versions/{n|latest}/tree`, `/files/{path}`,
`/diff?from=` and `/zip`). Protocol 5 and later clients name no Tenant. A protocol 4 client's `Nylorun-Tenant` naming
another Tenant (or malformed) and a Tenant that
could not be opened → opaque `404` with identical body. A path or method no route serves is `404 Route not found`
once the caller is known.

## API reference (OpenAPI)

The Runtime describes its APIs as OpenAPI 3.2 documents, generated from the routes it serves,
so they cannot drift from its answers:

| Document | In the package | Served (no key) | On each release |
| --- | --- | --- | --- |
| Runtime API | `@nylorun/runtime/openapi.json` | `GET /openapi/runtime.json` (alias `GET /openapi.json`) | `openapi.json` |
| Management API | `@nylorun/runtime/management-openapi.json` | `GET /openapi/management.json` | `management-openapi.json` |

The release assets are on the `@nylorun/runtime@<version>` GitHub Release. Point any OpenAPI 3.2
tool at one of them; for [Scalar](https://scalar.com), the package file of a version works as is:

```text
https://cdn.jsdelivr.net/npm/@nylorun/runtime@<version>/dist/openapi.json
https://cdn.jsdelivr.net/npm/@nylorun/runtime@<version>/dist/management-openapi.json
```

Each document has described tags, in the order a developer uses them. The Runtime API's are
grouped (`x-tagGroups`): Agents (Agents, Definition files), Sessions (Sessions API, AG-UI,
A2A), Sandboxes, Artifacts and Service (health, readiness, `/v1/me`, the JWKS and the
document; the `/openapi.json` alias is served but not listed). The Management API's are
Tenant, Application keys, Models, Vaults, Signing keys and Settings. Each operation's
`security` says which credentials it takes (application key and trusted issuer's token in
the Runtime API; management key in the Management API), and its
`x-nylorun-credentials` and `x-nylorun-scopes` (the subject scopes that reach it) fields say
who may call it. Event streams are `text/event-stream` with an `itemSchema`. `runtime/openapi/` holds the committed snapshots: a change to a route changes
them (`node scripts/build-openapi.mjs --write`), and `check-package` fails until they are
updated.

## HTTP layer

Routes are Hono routes (`@hono/zod-openapi`), each declared once with who may call it
(`api/http/define.ts`): that declaration serves the route, checks subject scopes and makes
the OpenAPI document. `host/` holds the listeners, the `Host`
check (in Node, before Hono) and the Host pipeline (`host/app.ts`); `api/` the routes of
both APIs (`api/http/routes/`, `api/ag-ui/`, `api/a2a/`). Only `host/` and `api/` import
Hono. `nylorun-operate` is `host/operate.ts`.

## Embedding and tests

Tests and ephemeral embeds use `startEphemeralRuntime()` from
`@nylorun/runtime/core`: private Host on port 0, temporary Host root, one Tenant,
returns `{ url, tenantId, applicationKey, managementKey, adminKey, close() }`
(`managementKey` is the key `bootstrap`, for the Management API). Its Tenant is the
one Tenant of the Postgres database you pass as `database` (required): a pool, which
you end, or a URL, for which it opens a pool and ends it on `close()`. It creates the
Tenant there on first start, as a Host does (with `tenantId`, `name` and an application
principal for `applicationKey`), and serves the Tenant a database already holds. The
data stays after `close()`; give each test Tenant its own database and drop it
afterwards. Its
streams and scheduling are in process and gone after `close()`. The smoke checks do
not use it; they reset and seed a temporary local Tenant
(`scripts/lib/stack-tenant.mjs`).

```ts
const runtime = await startEphemeralRuntime({
  hostRoot, // a temporary directory
  database: "postgres://nylorun:nylorun@127.0.0.1:55432/my_test_db",
});
```

The package's own tests run every Session Store on Postgres: `npm test` gives each
test file a database on the Docker test stack (`test/stack/compose.yaml`) and starts
the stack when it is down; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Save agents with `PUT /v1/agents/{agentId}` using the application principal (`saveAgent`
in `@nylorun/agents`). The Runtime runs the agent from its manifest and never calls your
code during a session: a definition with a tool that would (`tool({ run })`, a flow's tool
stage) is refused. Your services are reached as tools: HTTP tools, POSTed from the Runtime,
so their URLs must be reachable from it, and remote MCP servers. Model gateway
and sandbox backend are Tenant configuration (vault / seed), not Host process
env.

## Session behaviour

The session-first `/v1` API is specified in
[HOST_CONTRACT.md](../harness/HOST_CONTRACT.md). Application tokens authorize
definition/session APIs.

Postgres transactions persist session checkpoints, command receipts, individual
effects, waits and the record of session events — in the Tenant's database; history is
read from Durable Streams (S2). An advance owns its session through a lease with
an epoch; a Worker that takes over after a crash marks in-flight effects
`uncertain`. Vault ciphertext needs that Tenant's own KEK.

Agents that declare `.use(sandbox())` get Runtime-executed sandbox tools. The
Tenant owns each sandbox; backend names are prefixed `nylorun-<tenant-id>-`.

## Local Project workflow

A project depends on `@nylorun/agents` only. `npx nylorun start` in the project
runs its local Tenant (Docker), named after the project directory, and writes
the Project link (outside a project it runs the Tenant `default`); the project's `npm run dev` runs `src/main.ts` under
`tsx watch`; `npx nylorun studio` opens Studio on that Tenant.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `kek-missing` | Restore `vault-kek` in the Tenant directory |
| `GET /ready` is 503 with `checks.tenant: false` | The Tenant could not be opened; every `/v1` request is the opaque `404`. `nylorun status` on a local Tenant, or `nylorun-operate status` in the runtime container, names the cause and its repair. Follow it, then restart the Runtime; otherwise the Runtime's log names the cause |
| `corrupt` / `migration-failed` / `envelope-invalid` / `open-failed` / `open-timeout` | Follow the cause's `repair` string |
| `schema-too-new` | Run a Runtime at least as new as the one that migrated the database |
| `database-layout-old` | The database holds `tenant_<id>` schemas of an older Runtime, or the `schema_version` tables of a pre-release one: point the Runtime at a new database (locally, a new Tenant: `nylorun start --tenant <new name>`); the old one is left as it is |
| `426 protocol_unsupported` | Upgrade clients or Host to a compatible set |
| `421 host_rejected` / `403 origin_rejected` | In a container, list the `Host` in `NYLORUN_ALLOWED_HOSTS`. From a browser, send a trusted issuer's token, never a key |
| `403 key_role_mismatch` | The key belongs to the other API: use a management key on `/v1/tenant/*` (`@nylorun/admin`) and an application key everywhere else (`@nylorun/agents`) |
| `503` for a Tenant | Postgres or Restate is unreachable; `GET /ready` names which |
| Port in use | Change `NYLORUN_PORT` in `~/.nylorun/tenants/<name>/docker/.env` and run `nylorun start` |
| Logs | `nylorun logs runtime` |

Definitions have no `agent.run()`; applications use `@nylorun/agents`.

## Session reads

Hosts advertising `session-reads` serve pinned session manifests, recorded usage, model-call
pages and opt-in session/history/sandbox pagination. `calls-export` adds the Management API's
unfiltered, resumable model ledger export (`GET /v1/tenant/calls/model`, a management key) in
safe transaction order. Existing list/history
requests without `limit` retain their response shapes. These are public APIs for Studio,
CLI and custom clients; clients never need database access. See the
[API contracts, authorization, SDK examples and Studio handoff](https://github.com/nylorun/agents/blob/main/runtime/docs/session-reads.md).
