# Local stack: Docker Compose (breaking beta)

The local Runtime and Studio now run as a Docker Compose stack that `nylorun`
manages (Postgres, Restate, S2, the Runtime and Studio). The prerequisites are
Node 24 or newer and Docker with Compose v2 (Docker Desktop, OrbStack or
Colima); a global `@nylorun/runtime` is no longer needed. `nylorun doctor`
checks them.

### Commands

| Before | After |
| --- | --- |
| `nylorun runtime up`, `nylorun up`, `nylorun runtime run` | `nylorun start` |
| `nylorun runtime down`, `nylorun down` | `nylorun stop` |
| `nylorun runtime restart` | `nylorun stop`, then `nylorun start` |
| `nylorun runtime status [--json]` | `nylorun status [--json]` |
| `nylorun runtime status --env` | `nylorun status --env` |
| `nylorun runtime logs`, `nylorun logs` (launcher) | `nylorun logs [service] [-f] [--tail <n>]` |
| `nylorun stack logs`, `nylorun stack studio` | `nylorun logs`, `nylorun studio` (the `stack` spelling still works) |
| `nylorun studio [--local-ui] [--port <n>]` (in-process proxy) | `nylorun studio [--no-open]`: a fresh login URL for the stack's Studio, on the linked Project's Tenant |
| `nylorun dev --local-ui` | `nylorun dev` (opens Studio on the Project's Tenant) |
| `nylorun dev --ephemeral` | Not available on the Docker stack yet (exit 2); it returns later in this release |
| `nylorun doctor runtime` | `nylorun doctor` (Node, Docker, Compose v2, stack health) |
| — | `nylorun reset [--yes]` deletes the stack's volumes and every Tenant |

The removed commands exit 2 and name their replacement.

### Studio

`@nylorun/studio` is no longer published to npm; it ships only as the
`ghcr.io/nylorun/studio` image, which the stack runs on
`http://localhost:4161`. The hosted dashboard at `local.nylorun.studio`, the
local UI mode (`--local-ui`, `ui: "local" | "hosted"`), the pairing fragment,
the `nylorun-studio` bin and `startStudio()` are removed. The CLI asks the
Studio container for a single-use login token (valid for two minutes) and opens
`/login?token=…`; `nylorun studio` mints a fresh one.

In a generated project, remove the Studio dependency and script:

```diff
   "scripts": {
     "dev": "nylorun dev",
-    "studio": "nylorun-studio",
     "start": "node dist/src/main.js"
   },
   "devDependencies": {
     "@nylorun/cli": "…",
-    "@nylorun/studio": "…",
```

Then run `npm install` and use `npx nylorun studio` (or just `npm run dev`).

`npm create @nylorun/agent` no longer adds Studio, checks for Docker with
Compose v2 instead of `nylorun-runtime`, and accepts `--no-studio` only as a
deprecated no-op.

### Project links

`nylorun dev` keeps an existing Project link when the stack's Host has the same
Host id (the stack reuses `host.json`'s id and rewrites its URL to
`http://localhost:<port>`). Tenants created by the old launcher-managed Runtime
are not supported on the stack: when `nylorun dev` reports the linked Tenant as
unknown, let it create a new one (in a terminal), or remove
`.nylorun/link.json` and `.nylorun/credentials.json` and run it again.

# Runtime Clients and Admin API (breaking beta)

Vocabulary: [runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

Every process that talks to a Runtime is a **client**. Two client packages
cover the two surfaces: `@nylorun/agents` (Tenant API) and `@nylorun/admin`
(Admin API). A local OSS Runtime is the npm package `@nylorun/runtime`, which
developers install as a prerequisite, and it is started by its **launcher**
(`nylorun-runtime`). The CLI and desktop apps find that launcher on PATH and
run it as a process; nothing imports `@nylorun/runtime`, and nothing downloads
it.

Before upgrading, install the prerequisites. Native Windows is no longer
supported: on Windows, install them inside WSL2 and move projects there.

```sh
node --version                            # 24 or newer
npm install --global @nylorun/runtime     # provides nylorun-runtime
```

### Upgrade a generated application (steps 1–4)

#### 1. Add `src/main.ts`; `serve` → `dev` / `start`

Replace `nylorun serve` with one development entry (`nylorun dev`) and one
production entry (`node dist/src/main.js`).

Before (Tenants-era starter):

```json
{
  "scripts": {
    "dev": "nylorun dev",
    "start": "nylorun serve"
  },
  "dependencies": {
    "@nylorun/agents": "…",
    "@nylorun/cli": "…"
  }
}
```

After:

```ts
// src/main.ts
import { connectAgents } from "@nylorun/agents";
import { agents } from "../agents/index.js";

await connectAgents({ agents }).ready;
```

```json
{
  "scripts": {
    "dev": "nylorun dev",
    "build": "…unchanged…",
    "start": "node dist/src/main.js",
    "check": "tsc --noEmit"
  }
}
```

`connectAgents` in application mode saves definitions, registers executor
credentials **derived** from the application key, and connects. The same entry
runs under `nylorun dev` (with `tsx watch`) and in production (`npm start`).
Stored executor tokens in `.nylorun/credentials.json` are ignored and dropped
on the next write.

#### 2. Studio is a separate package binary

Move `@nylorun/cli` and `@nylorun/studio` to `devDependencies`. Point the npm
`studio` script at Studio's own binary (`nylorun-studio`). The Project-aware
`nylorun studio` command remains available from the CLI for direct use.

Before:

```json
{
  "dependencies": {
    "@nylorun/agents": "…",
    "@nylorun/cli": "…"
  },
  "devDependencies": {
    "@nylorun/studio": "…"
  },
  "scripts": {
    "studio": "nylorun studio"
  }
}
```

After:

```json
{
  "dependencies": {
    "@nylorun/agents": "…",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@nylorun/cli": "…",
    "@nylorun/studio": "…",
    "tsx": "…",
    "typescript": "…"
  },
  "scripts": {
    "studio": "nylorun-studio"
  }
}
```

Production `npm ls --omit=dev` must list only `@nylorun/agents` and
`@nylorun/core` from Nylorun. Studio never depends on the CLI (or the reverse).

#### 3. Deployments use three environment variables

Do not ship executor tokens. Set the Tenant API trio; `createClient()` /
`connectAgents({ agents })` resolve from options, then these variables, then
the Project link.

Before (executor tokens or Project-only credentials in production):

```sh
# ❌ do not ship derived or stored executor tokens
export NYLORUN_EXECUTOR_KEY=…
# or rely on a checked-in .nylorun/credentials.json executors map
```

After:

```sh
export NYLORUN_RUNTIME_URL=https://runtime.example
export NYLORUN_TENANT=tn_…
export NYLORUN_SERVER_KEY=…   # application key only
node dist/src/main.js
```

#### 4. Removed commands; Admin package; launcher

| Removed | Replacement |
| --- | --- |
| `nylorun serve` | `nylorun dev` (watch) / `node dist/src/main.js` (`npm start`) against a running Host |
| `nylorun studio` | `nylorun-studio` (Studio's own binary) |
| `--no-studio` on `dev` | Omit the `studio` script / `@nylorun/studio` if unused |
| CLI depending on `@nylorun/runtime` | CLI runs the installed Runtime's **launcher** (`nylorun-runtime` on PATH) |
| In-process CLI Host install/lifecycle | `nylorun runtime …` → `nylorun-runtime`; install the Runtime with npm first |
| Ad-hoc Host admin HTTP from the CLI | `@nylorun/admin` (`createAdmin`, `createTenant`, `status`, …) |

Managing clients (CLI, desktop Runtime panel, CI) add `@nylorun/admin` for the
Admin API. Developer applications do **not** depend on it — only
`@nylorun/agents`. Local Host start/stop/upgrade goes through the launcher,
never through an import of `@nylorun/runtime`.

### Sandbox: microsandbox backend removed

The Runtime has one sandbox backend, `virtual` (an emulated shell in the
Runtime process; not a VM boundary). The optional `microsandbox` dependency is
gone.

- `sandbox.backend` (`PUT /v1/tenant/config/seed`) and `NYLORUN_SANDBOX` accept
  `auto` or `virtual`; `microsandbox` is rejected. `auto` selects `virtual`.
- A Tenant that stored `sandbox.backend=microsandbox` reads it as `auto`.
- Sandbox reports (`GET /v1/tenant/sandbox`, `nylorun doctor sandbox`) list only
  `virtual` with `process` isolation.
- Remove leftover microVMs with the `msb` commands under
  [Microsandbox cleanup](#microsandbox-cleanup-old-nylorun-scopeid--prefixes),
  or `msb rm --force` on names starting with `nylorun-`, then uninstall `msb`.

### Studio principal

`POST /v1/admin/tenants` accepts an optional `studioCredentialHash` (protocol
feature `studio-principal`). When present, the Tenant also stores application
principal `studio` with that hash. `@nylorun/admin`'s `createTenant` always
sends it: the SHA-256 of `deriveStudioToken(adminKey, tenantId)`, an
HMAC-SHA256 keyed by the admin key. Studio derives the same key to call the
Tenant API; the admin key itself is never a Tenant bearer. Tenants created
before this release have no Studio principal; recreate them during the beta.

### Existing Host roots

- A Host started by the Tenants-era CLI is reused while it runs.
- Its next restart moves it onto the installed `@nylorun/runtime`.
- `host.json` gains `format` and `runtimeVersion` on the first launcher write.
- Project link and credentials accept format `0` (missing `format`) and write
  format `1`.

Upgrade `@nylorun/core`, `@nylorun/agents`, `@nylorun/admin`, `@nylorun/cli`,
`@nylorun/studio` and the installed `@nylorun/runtime` together (breaking beta
set). Protocol features `admin-status` and `studio-principal` are additive on
protocol `2`; clients require both, so an older Host is reported as
`incompatible_host`.

# Scoped hooks and manifest schema 4

`beforeModelCall` and `afterModelCall` are replaced by two verbs with an explicit scope.
There are no compatibility aliases.

| Previous                                               | Replacement                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `.beforeModelCall(fn)`                                 | `.before("step", fn)`, or `.before("turn", fn)` when the decision holds for the whole turn |
| `.afterModelCall((args, ctx) => …)`                    | `.after("step", ({ text, toolCalls, info, state, step, attempt }) => …)` (one argument)    |
| `capability({ beforeModelCall, afterModelCall })`      | `capability({ before: { turn?, step? }, after: { step?, turn? } })`                        |
| —                                                      | `after("turn", ({ text, output, attempt }) => TurnDecision)` for the final answer          |
| Manifest `beforeModelCall` / `afterModelCall` booleans | `capabilities[].hooks: { at, scope }[]` in `manifestSchemaVersion: 4`                      |
| Action kinds `beforeModelCall` / `afterModelCall`      | Action kind `hook` with `hook: { at, scope, capabilityIds }`                               |
| `BeforeModelCallFn` / `AfterModelCallFn`               | `BeforeHook<scope>` / `AfterHook<scope>`                                                   |

`before("turn")` runs once per turn and its `Patch` applies to every model call in that
turn; `before("step")` and `after("step")` run on every model call. In a Runtime, every
capability registered at one hook point runs in a single executor action, so a hook point
costs one round trip per turn or per model call.

Hooks may run more than once when a delivery is retried: an expired hook claim is offered
again instead of becoming uncertain. Keep side effects in tools.

`retry` now retries. From `after("step")` it denies the proposed tool calls with the feedback,
or sends a text answer back with the feedback as a message; from `after("turn")` it sends the
final answer back. The engine does not cap retries: bound them with the `attempt` argument,
for example `attempt < 2 ? { retry: "…" } : { block: "…" }`.

Rebuild agents to publish schema 4 manifests. `Agent.from` rejects schema 3. On startup the
Runtime cancels pending `beforeModelCall` / `afterModelCall` actions and fails any turn that
was in flight under a schema 3 manifest; start new sessions after upgrading. The durable
engine version is now `hosted-2`, because hook effect ids changed.
Later Runtimes no longer run this startup cleanup, so upgrade through this release first
if a Tenant still has schema 3 turns in flight.

# Runtime Tenants (breaking beta)

Vocabulary: [runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

One **Runtime Host** process serves many isolated **Tenants**. A Project
attaches through a **Project link** (`.nylorun/link.json` + `credentials.json`),
not by owning a SQLite file beside the Project or under the home directory.

### Pre-Tenant layout → Host + Tenant + Project link

| Previous                                                                                                  | Replacement                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| SQLite beside the Project (`.nylorun/`) or a shared home-directory database selected by removed CLI flags | Host root (`NYLORUN_HOME` or `~/.nylorun`) + Tenant under `tenants/<id>/` + Project link         |
| Removed CLI / env selectors for shared home or explicit SQLite path                                       | Host root / Tenant paths only                                                                    |
| `.nylorun/local-credentials.json`                                                                         | `.nylorun/credentials.json` (0600) + `.nylorun/link.json`                                        |
| Unauthenticated health field naming the SQLite path digest                                                | `/health.hostId` + `/health.protocol` (`min` / `max` / `features`); `service: "nylorun-runtime"` |
| Exact package-version equality for CLI ↔ Runtime                                                          | `Nylorun-Protocol` + `checkCompatibility` (protocol `2`, feature `runtime-tenants`)              |
| `createClient({ url, key })`                                                                              | `createClient({ url, key, tenant })` (or `NYLORUN_TENANT`)                                       |
| Tenant model routes under `/v1/host/…`                                                                    | `/v1/tenant/…`                                                                                   |
| Executor registration via Host process env at startup                                                     | Removed; `PUT /v1/executors` with the application principal only                                 |
| In-process embed helpers that started a single SQLite host                                                | `startEphemeralRuntime()` for tests/embeds; CLI starts `@nylorun/runtime/server`                 |
| Env overrides for vault KEK, sandbox backend, model gateway on the Host process                           | Tenant paths / `TenantConfig` / `PUT /v1/tenant/config/seed`                                     |
| Sandbox name prefix `nylorun-<scopeId>-` (16-hex digest of a former SQLite path)                          | `nylorun-<tenant-id>-` (`tn_` + 26 Crockford chars)                                              |

### What to do when upgrading

1. Upgrade `@nylorun/core`, `@nylorun/runtime`, `@nylorun/agents`, `@nylorun/cli`,
   and `@nylorun/studio` together (breaking beta set). Protocol `2` with feature
   `runtime-tenants` is required.
2. Stop every old Runtime process that still owns a Project-local or
   home-directory SQLite file. Start the new Host once: `nylorun runtime up`.
3. From each Project, run `nylorun dev` (or the Project link flow) so a Tenant
   is created and `.nylorun/link.json` / `credentials.json` are written. Do not
   reuse an old Tenant id from another checkout.
4. Point custom clients at `createClient({ url, key, tenant })` and send
   `Nylorun-Tenant` / `Nylorun-Protocol` on every request. Update Studio callers
   to `startStudio({ runtimeUrl, serverKey, tenant: { id, name } })`.
5. Replace Tenant model routes under `/v1/host/*` with `/v1/tenant/*`. Move any
   embedding tests to `startEphemeralRuntime`.
6. Export linked env with:
   `eval "$(npx nylorun runtime status --env)"`.

Existing Project-local SQLite files and KEKs are **not** auto-imported into
Tenants. Prefer new Tenants and new sessions after upgrading; session
export/import remains deferred.

### Microsandbox cleanup (old `nylorun-<scopeId>-` prefixes)

After upgrade, leftover microsandbox entries may still use the old prefix
`nylorun-<scopeId>-`, where `<scopeId>` was the first 16 hex characters of the
SHA-256 of a former SQLite path. New sandboxes use `nylorun-<tenant-id>-` and
must not be deleted.

One cleanup command (matches only the old 16-hex digest prefix):

```sh
msb ls -q | grep -E '^nylorun-[0-9a-f]{16}-' | xargs -r msb rm --force
```

Never delete names that start with `nylorun-tn_`.

# Package architecture beta migration

> **Superseded for dependency rules and application production trees:** the
> [Runtime Clients section](#runtime-clients-and-admin-api-breaking-beta)
> requires production apps to depend on `@nylorun/agents` only (CLI/Studio are
> `devDependencies`). Keep this section for the earlier define/contracts move.

Cloud upgrades published packages from npm independently. Upgrade the tested
package combination in `create-agent/compatibility.json`.

| Previous                                             | Replacement                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@nylorun/harness/define` or authoring from its root | `@nylorun/agents/define` (applications), `@nylorun/core/define` (infrastructure) |
| `@nylorun/harness/contracts`                         | `@nylorun/core/contracts`                                                        |
| Harness hash/protocol metadata                       | `@nylorun/core/compatibility`                                                    |
| Harness checkpoint compatibility                     | `@nylorun/harness/compatibility`                                                 |
| Runtime-owned `nylorun`                              | Install `@nylorun/cli` as a **devDependency**; see Runtime Clients steps 1–4     |

SDK root imports remain supported. Studio imports `agents/client`. Runtime has no
SDK dependency. SDK has no engine dependency. Bindings use `getBinding()` rather
than shared module object identity; only manifests serialize. The package split
does not change wire formats, canonical manifest hashes, or stored checkpoints.

Generated applications keep `@nylorun/agents` (and transitive `@nylorun/core`)
in production dependencies; CLI and Studio are development tooling. Custom
runtime host code keeps a direct runtime and core dependency. Do not copy
private compiled definition objects: use `bindingFromAgent()` from `harness/run`
for explicit execution.

No npm release or deployment is performed by this migration.

## Earlier session-first migration

# Local Runtime beta migration

> **Superseded for application scripts and Studio:** the [Runtime Clients
> section](#runtime-clients-and-admin-api-breaking-beta) replaces `nylorun
> serve` with `npm start` (`node dist/src/main.js`) and points the generated
> npm script at `nylorun-studio`. Keep the rest of this section only for
> historical session-first / Tenants-era upgrades that already applied it.

Upgrade the harness, SDK, Runtime, Studio, and creator as the tested compatible set in `create-agent/compatibility.json`. This migration changes public entry points and the session protocol.

1. Import `Agent` and `tool` from `@nylorun/agents`. Export `agents` from `agents/index.ts`. Keep model selection in Runtime configuration.
2. Remove the starter's Hono application and old `Runtime` / `serveAgents` / `openSession` imports. Definitions no longer expose `agent.run()`.
3. `nylorun start` was removed in favor of `nylorun serve [entry]` for the compiled build. **That `serve` command is itself removed** in Runtime Clients — use `node dist/src/main.js` / `nylorun dev` (see steps 1–4 above). The Runtime Host remains its own persistent process: `nylorun runtime up` / `down` / `status`, with Host root `NYLORUN_HOME` / `~/.nylorun` and a Project link under `.nylorun/`.
4. Update custom applications to SDK `createClient` and session commands with stable idempotency keys. Trusted servers supply `ownerUserId`; input text uses `content`. Pass `tenant` (see Runtime Tenants section above).
5. Custom connected executors use `connectAgents({ agents, runtime: { url, key, tenant } })`. Prefer application-mode `connectAgents({ agents })` with derived tokens (Runtime Clients). The local CLI no longer writes executor tokens into Project credentials.
6. Studio uses canonical history and authenticated SSE through its local proxy. Attach with the generated `nylorun-studio` npm script or the Project-aware `nylorun studio` CLI command; both resolve the Project link. Remove AG-UI and legacy manifest endpoint configuration.

Keep credentials in gitignored `.nylorun/`; provider configuration uses `.env` only as a one-time seed into the Tenant vault. Keep backups of old SessionRecord/event files. They are not automatically converted to new SQLite checkpoints. Session export/import and migration tooling are deferred. Start new sessions after changing definitions or implementations. Because the Host now outlives `dev`, a source change re-registers agents and reconnects executors rather than restarting the Host.

Explicit in-process engine execution remains available to host authors through `@nylorun/harness/run`; it is not loaded by the application SDK. OSS and Cloud consume the harness independently.

The release workflow covers local text and ordinary tools. Advanced examples remain source references outside the default registry. Media, approvals UI, deployment recipes, and broad recovery/conformance gates remain for later releases. Subagents (agents used as tools, one level deep) ship with this branch; see [the SDK](agents/README.md).

## Execution API rename

Replace `@nylorun/harness/engine` imports with `@nylorun/harness/run`. Rename `runHosted` to `runDurable`, `createHostedCheckpoint` to `createDurableCheckpoint`, `HostedCheckpoint` / `HostedResult` to `DurableCheckpoint` / `DurableResult`, and `EngineHost` to `DurableHost`. Rename `EngineBinding`, `EngineRunOptions`, and `createEngineState` to `RunBinding`, `BoundRunOptions`, and `createRunState`. There are no compatibility aliases.

Durable execution reconstructs progress from a checkpoint and individually journaled effect outcomes; the host must persist both. Existing checkpoint fields and `ENGINE_VERSION = "hosted-1"` remained compatible at the time of this rename; scoped hooks later moved the engine to `hosted-2`.
