# @nylorun/runtime

The independent OSS **Runtime Host** consumes `@nylorun/harness/run` and
`@nylorun/core/contracts`. Cloud installs published `@nylorun/harness` from npm
and does not import this package. Client authoring and sessions belong to
`@nylorun/agents`; Tenant lifecycle management belongs to `@nylorun/admin`.
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
Restate and S2: `nylorun start` runs that stack on a developer machine. The
package is a library with no bin; its Host entry is `@nylorun/runtime/server`
(`dist/host/main.js`), which requires `NYLORUN_DATABASE_URL`. For tests and
ephemeral embeds, use `startEphemeralRuntime()` from `@nylorun/runtime/core`.
See [MIGRATION.md](../MIGRATION.md).

No Tenant state lives only in the Runtime process. Each Tenant's data is the
Postgres schema `tenant_<id>` (the Session Store); Restate runs one advance of a session at a
time and holds the Tenant's sweep timer (Durable Session Execution); every
session's events are relayed from the schema's outbox to its own S2 stream,
which history and SSE read (Durable Streams). One image runs every **service**,
and `--service` picks what a process runs: `core` serves the Tenant API, Admin
API and SSE and runs the stream relay, `loop` runs advances (the Worker), and
`gates` is the Model Gate, the only process that reads a model credential and
calls providers. `core` and `loop` may share a process; `gates` never joins
them. The local stack packs `core,loop` into the `runtime` container and
`gates` into the `gateway` container (the combined packing). `--role
api|worker|all` is the deprecated name of `--service core`, `loop` and
`core,loop`.

The container is configured by its environment, which the stack's Compose file
sets: `NYLORUN_DATABASE_URL` (required), `NYLORUN_RESTATE_INGRESS_URL`,
`NYLORUN_RESTATE_ADMIN_URL`, `NYLORUN_WORKER_URL` and
`NYLORUN_RESTATE_IDENTITY_KEY` (Restate), `NYLORUN_S2_ENDPOINT` and
`NYLORUN_S2_TOKEN`, and in container mode `NYLORUN_LISTEN_HOST`,
`NYLORUN_LISTEN_PORT`, `NYLORUN_ALLOWED_HOSTS` and `NYLORUN_PUBLIC_URL`, plus
`NYLORUN_BROWSER_ACCESS` (`on` or `off`) and the operator listener
(`NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`,
`NYLORUN_ADMIN_ALLOWED_HOSTS`). A process that runs `loop` sends its model
calls to the gate at `NYLORUN_GATES_URL` with `NYLORUN_GATES_TOKEN`; in a
container it refuses to start without them. A `gates` process needs only
`NYLORUN_DATABASE_URL`, `NYLORUN_GATES_TOKEN`, its listener
(`NYLORUN_GATES_LISTEN_HOST`, `NYLORUN_GATES_LISTEN_PORT`, default 4100, and
`NYLORUN_GATES_ALLOWED_HOSTS`) and the Host's `tenants/` directory, which it
never writes. `NYLORUN_PACKING` (`combined` or `split`) is logged at startup.

With an operator listener (the stack's default: container port 4001), the Host
serves two ports. The public one serves the Tenant API, to browsers too when
browser access is on, and answers admin routes with the opaque `404`. The
operator one serves the Admin API, Host shutdown and the Tenant API, never to
browsers; keep it on loopback or a private network and never proxy it. Outside
a container, `adminPort` in `host.json` does the same on loopback.

The Host root is `NYLORUN_HOME` or `~/.nylorun` (bind-mounted at `/nylorun` in
the stack). What stays on the Host is under `tenants/<tenantId>/`.

## Layout

```text
<host root>/
  host.json                 # format 1: hostId, host, port, adminPort?, runtimeVersion, …
  host-credentials.json     # adminKey (0600)
  stack/                    # compose.yaml, .env (0600), Restate identity key
  tenants/<tenantId>/       # vault-kek, plugin-data, logs, home, tmp, sandboxes
  trash/                    # SQLite Tenants from before the Postgres switch
```

## HTTP surface

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /health` | none | `service: "nylorun-runtime"`, `hostId`, protocol `{min,max,features}`, pid |
| `GET /ready` | none | Listener up, Tenants discovered, and Postgres, Restate and S2 answer (`checks`) |
| `GET /openapi.json` | none | The Tenant API's OpenAPI 3.2 document (below); refuses an `Origin` |
| `GET /v1/admin/status` | admin key | `AdminStatusSchema`; alias `GET /v1/admin/host`. On the operator listener when there is one |
| `/v1/admin/tenants*` | admin key | Create / list / get / delete Tenants |
| `POST /v1/admin/host/shutdown` | admin key | Host-private; not in `@nylorun/admin` |
| `GET /v1/admin/openapi.json` | admin key | The Admin API's OpenAPI 3.2 document |
| `/v1/*` Tenant routes | application key, subject token or delivery token | Require `Nylorun-Tenant` (or `Nylorun-Key`) + `Nylorun-Protocol` |

Every route checks `Host` first (`421 host_rejected`) and rejects non-JSON bodies
with `415 unsupported_media_type`. An `Origin` is `403 origin_rejected` on
`/health`, `/ready`, admin routes, and everywhere when browser access is off.
With browser access on (feature `browser-access`: the stack's default, or
`browserAccess` in `host.json`), the Host answers preflights for browser routes
from the route alone, and the Tenant admits an `Origin` only with a publishable
key (`Nylorun-Key`) that lists it, adding CORS headers only then; Tenant keys
and delivery tokens are refused from browsers before they are looked up. A
publishable key also names the Tenant, so `Nylorun-Tenant` may be left out. Missing or unsupported protocol → `426` before
authentication. Unknown, quarantined or rejected Tenant credentials → opaque
`404` with identical body. A path or method no route serves is `404 Route not found`
once the caller is known.

## API reference (OpenAPI)

The Runtime describes its APIs as OpenAPI 3.2 documents, generated from the routes it serves,
so they cannot drift from its answers:

| Document | In the package | Served | On each release |
| --- | --- | --- | --- |
| Tenant API | `@nylorun/runtime/openapi.json` | `GET /openapi.json` | `openapi.json` |
| Admin API | `@nylorun/runtime/admin-openapi.json` | `GET /v1/admin/openapi.json` (admin key) | `admin-openapi.json` |

The release assets are on the `@nylorun/runtime@<version>` GitHub Release. Point any OpenAPI 3.2
tool at one of them; for [Scalar](https://scalar.com), the package file of a version works as is:

```text
https://cdn.jsdelivr.net/npm/@nylorun/runtime@<version>/dist/openapi.json
```

Each operation's `security` says which credentials it takes (application key, subject token,
publishable key, delivery token, admin key), and its `x-nylorun-credentials`,
`x-nylorun-scopes` (the subject scopes that reach it) and `x-nylorun-browser` fields say who
may call it. Event streams are `text/event-stream` with an `itemSchema`. `runtime/openapi/` holds the committed snapshots: a change to a route changes
them (`node scripts/build-openapi.mjs --write`), and `check-package` fails until they are
updated.

## HTTP layer

Routes are Hono routes (`@hono/zod-openapi`), each declared once with who may call it
(`api/http/define.ts`): that declaration serves the route, checks subject scopes, answers
browser preflights and makes the OpenAPI document. `host/` holds the listeners, the `Host`
check (in Node, before Hono) and the Host pipeline (`host/app.ts`); `api/` the Tenant and
Admin routes (`api/http/routes/`, `api/ag-ui/`, `api/a2a/`, `host/admin-api.ts`). Only `host/`
and `api/` import Hono.

## Embedding and tests

Tests and ephemeral embeds use `startEphemeralRuntime()` from
`@nylorun/runtime/core`: private Host on port 0, temporary Host root, one Tenant,
returns `{ url, tenantId, applicationKey, adminKey, close() }`. Its Tenants are
schemas in the Postgres database you pass as `database` (required): a pool, which
you end, or a URL, for which it opens a pool and ends it on `close()`. The schemas
stay after `close()`; give each test its own database and drop it afterwards. Its
streams and scheduling are in process and gone after `close()`. The smoke checks'
temporary Tenants (`scripts/lib/temporary-tenant.mjs`) do not use it; they are
created on the Docker stack.

```ts
const runtime = await startEphemeralRuntime({
  hostRoot, // a temporary directory
  database: "postgres://nylorun:nylorun@127.0.0.1:55432/my_test_db",
});
```

The package's own tests run every Session Store on Postgres: `npm test` gives each
test file a database on the Docker test stack (`test/stack/compose.yaml`) and starts
the stack when it is down; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Register Action endpoints with `PUT /v1/endpoints` using the application principal
(`createActionHandler(...).register({ url })` in `@nylorun/agents` does this). The
Runtime delivers each Action there with an `http` or `https` POST, so the URL must be
reachable from the Runtime. Model gateway
and sandbox backend are Tenant configuration (vault / seed), not Host process
env.

## Session behaviour

The session-first `/v1` API is specified in
[HOST_CONTRACT.md](../harness/HOST_CONTRACT.md). Application tokens authorize
definition/session APIs. The Runtime delivers Actions to Action endpoints, and a
delivery token authorizes only its own Action's heartbeat, result and sandbox calls.
Session observers cannot submit action results.

Postgres transactions persist session checkpoints, command receipts, individual
effects/actions, waits and the event outbox — **per Tenant schema**; history is
read from Durable Streams (S2). An advance owns its session through a lease with
an epoch; a Worker that takes over after a crash marks in-flight effects
`uncertain`. Vault ciphertext needs that Tenant's own KEK.

Agents that declare `.use(sandbox())` get Runtime-executed sandbox tools. The
Tenant owns each sandbox; backend names are prefixed `nylorun-<tenant-id>-`.

## Local Project workflow

A project depends on `@nylorun/agents` only. `npx nylorun up` runs the local
stack (Docker); `npx @nylorun/cli tenant create` (`nylo`) creates the
project's Tenant and writes its Project link; the project's `npm run dev` runs
`src/main.ts` under `tsx watch`; `npx nylorun studio` opens Studio.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `kek-missing` | Restore `vault-kek` in the Tenant directory |
| `corrupt` / `migration-failed` / `envelope-invalid` / `open-failed` / `open-timeout` | Follow the `nylo tenant status` repair string |
| `schema-too-new` | Run a Runtime at least as new as the one that migrated the schema |
| `426 protocol_unsupported` | Upgrade clients or Host to a compatible set |
| `421 host_rejected` / `403 origin_rejected` | In a container, list the `Host` in `NYLORUN_ALLOWED_HOSTS`. From a browser, use a subject token and a publishable key that lists the page's origin, never a Tenant key |
| `503` for a Tenant | Postgres or Restate is unreachable; `GET /ready` names which |
| Port in use | Change `NYLORUN_PORT` in `<Host root>/stack/.env` and run `nylorun up` |
| Logs | `nylorun logs runtime` |

Definitions have no `agent.run()`; applications use `@nylorun/agents`.
