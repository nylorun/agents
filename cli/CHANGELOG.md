# @nylorun/cli

## 0.4.1-beta

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [42272f8]
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.8.0-beta
  - @nylorun/admin@0.4.0-beta

## 0.4.0-beta

### Minor Changes

- bf1c2da: **The local Runtime and Studio run as a Docker Compose stack that the CLI manages; Studio ships only as its image (breaking beta).**

  - `nylorun start` writes `<Host root>/stack/compose.yaml` and `.env` (mode 0600) and starts Postgres, Restate, s2-lite, the Runtime and Studio on loopback ports, with the Runtime and Studio images this CLI pins (`nylorun.runtime`, `nylorun.studio`; `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them). `nylorun stop` keeps the volumes; `nylorun status [--json] [--env]` reports services and health; `nylorun reset [--yes]` deletes the volumes and every Tenant.
  - `nylorun dev` starts the stack if it is not running, creates the Project's Tenant on first run, opens Studio on that Tenant through a single-use login URL (`next=/tenants/<id>`), and runs the application with `NYLORUN_RUNTIME_URL=http://localhost:<port>`. `--no-open` prints the URL only; `--no-studio` skips Studio. `--local-ui` is removed (exit 2).
  - `nylorun logs` and `nylorun studio` are the stack commands (`nylorun stack <command>` still works). `nylorun studio` lands on the linked Project's Tenant.
  - `nylorun runtime up|down|restart|run|status|logs` and the `up`/`down` aliases are removed; they exit 2 and name `nylorun start|stop|status|logs`. `nylorun runtime status --env` is now `nylorun status --env`.
  - `nylorun doctor` checks Node 24+, Docker, Compose v2 and the stack's health; `doctor runtime` is an alias of it.
  - `@nylorun/studio` is private and ships only as `ghcr.io/nylorun/studio`: `startStudio`, the hosted (`local.nylorun.studio`) and local UI modes, pairing, the `nylorun-studio` bin and the UI bundle download are removed.
  - `npm create @nylorun/agent` no longer adds `@nylorun/studio` or a `studio` script, checks for Docker with Compose v2 instead of a global `@nylorun/runtime`, and accepts `--no-studio` only as a deprecated no-op.

- bf1c2da: **`nylorun dev --ephemeral` runs on the Docker stack, with a Tenant-level fixture model (breaking beta).**

  - `nylorun dev --ephemeral` creates a temporary Tenant through `@nylorun/admin` (no Project link written), seeds it from `.env` with the fixture model, opens Studio on it and runs the watcher; the Tenant is deleted with its active work cancelled when the watcher ends, Ctrl-C included. It needs a Runtime that advertises `tenant-fixture-model`.
  - `PUT /v1/tenant/config/seed` accepts `fixtureModel: true`, stored as Tenant setting `model.fixture`: that Tenant's model calls use the Runtime's fixture model while other Tenants on the Host keep theirs. `HOST_PROTOCOL` advertises the new optional feature `tenant-fixture-model` (`OPTIONAL_HOST_FEATURES` in `@nylorun/core/compatibility`); clients do not require it.
  - `startEphemeralRuntime()` keeps its signature but its Tenants live in memory instead of SQLite under the Host root; nothing survives `close()`.
  - Closing a Tenant waits for running advances at most the advance grace period (30 s by default) and then abandons them; their lease lapses and the next advance takes over.
  - A Worker stop, Tenant close or ended Restate attempt no longer fails or cancels the turn it interrupts: outcomes already returned are recorded, nothing is settled, and the next advance resumes the turn from its checkpoint. Only a user cancel settles `cancelled`; an advance deadline fails the turn with the deadline's message.

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

- bf1c2da: **The microsandbox backend is removed; the Runtime runs sandbox tools on the virtual backend only.** The optional `microsandbox` dependency is gone. `sandbox.backend` and `NYLORUN_SANDBOX` accept `auto` or `virtual`, and `auto` selects `virtual`. A Tenant that stored `microsandbox` reads it as `auto`. `nylorun doctor sandbox` and the `nylorun dev` banner report only the virtual shell.
- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.
- 1d84b3e: **Native Windows is no longer supported; Windows developers use WSL2.** Nylorun runs on macOS and Linux. On native Windows, `nylorun` and `npm create @nylorun/agent` stop with WSL2 guidance. Install Node 24 and Docker (Docker Desktop's WSL integration) inside your WSL distribution and keep projects in its Linux filesystem. The Windows-only process handling (`taskkill`, `.cmd` shims, `npm.cmd`) is removed. `nylorun doctor` reports WSL as `Linux (WSL: <distribution>)`.

### Patch Changes

- 1d84b3e: Opening the browser no longer crashes the CLI when no opener is installed (no `xdg-open` on a minimal Linux or WSL): it reports that and leaves the printed Studio URL to open by hand. Inside WSL, the CLI opens the Windows browser with `wslview`.
- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.7.0-beta
  - @nylorun/admin@0.3.0-beta

## 0.3.0-beta

### Minor Changes

- c49efed: **Breaking (pre-1.0 minor):** CLI reaches the local Runtime only through the installed Runtime's launcher.

  - Dependencies: `@nylorun/agents` and `@nylorun/admin` only (no `@nylorun/runtime`, no `@nylorun/studio`).
  - `nylorun runtime …` finds `nylorun-runtime` on PATH and checks its launcher and Host protocol; a missing or incompatible Runtime exits 1 with the install command for the recommended version (`package.json` `nylorun.runtime`). Nothing is downloaded. `nylorun doctor runtime` checks the prerequisites.
  - `nylorun dev` runs the application entry under `tsx watch`; creates Tenants through `@nylorun/admin`.
  - **Removed:** `nylorun serve` and the in-process Project runner. `nylorun studio`
    remains the Project-aware Studio command, and `nylorun dev --no-studio`
    remains the headless development path.
  - Install as a **devDependency**; production `start` is `node dist/src/main.js`.

- c49efed: **Breaking (pre-1.0 minor):** Replace a single SQLite Runtime per Project or home directory with a **Runtime Host** that serves isolated **Tenants**, selected by `Nylorun-Tenant` and negotiated with `Nylorun-Protocol` (protocol `2`, feature `runtime-tenants`). Vocabulary: Host root + Tenant + Project link.

  - **core:** `PROTOCOL_VERSION = 2`, `HOST_PROTOCOL`, `TENANT_HEADER`, `PROTOCOL_HEADER`, `newTenantId` / `isTenantId`, `checkCompatibility`; health schema gains `hostId` + `protocol` (`service: "nylorun-runtime"`); Tenant/admin wire schemas; Tenant model routes under `/v1/tenant/*`.
  - **runtime:** Host process + Tenant module; Tenant model routes under `/v1/tenant/*`; `startEphemeralRuntime` for tests/embeds; executors via `PUT /v1/executors`; sandbox prefix `nylorun-<tenant-id>-`.
  - **agents:** `createClient({ url, key, tenant })`; Transport sends Tenant + protocol headers; `/health` compatibility cache; `IncompatibleRuntimeError` with upgrade remedies.
  - **cli:** Host root lifecycle (`runtime up|down|status|logs|restart|run`); Project link (`.nylorun/link.json` + `credentials.json`); `tenant` commands; `runtime status --env` exports `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, `NYLORUN_TENANT`; removed Project/home SQLite selectors.
  - **studio:** `startStudio({ …, tenant: { id, name } })`; proxy forwards Tenant + protocol headers; UI shows Tenant name/short id.

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.6.0-beta
  - @nylorun/admin@0.2.0-beta

## 0.2.1-beta

### Patch Changes

- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [1cd7dc7]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.5.0-beta
  - @nylorun/runtime@0.9.0-beta

## 0.2.0-beta

### Minor Changes

- b8d822a: Remove `nylorun start`. The compiled agent process is now `nylorun serve [entry]`, with the
  same `dist/agents/index.js` default, and generated projects must change `scripts.start` to
  `nylorun serve`. The local Runtime becomes a persistent process of its own under
  `nylorun runtime start|stop|status|logs`, with `nylorun up` and `nylorun down` as aliases.
  `dev` and `serve` attach to that Runtime, start one when nothing is listening, and leave it
  running, so a watch restart re-registers agents and reconnects executors instead of
  destroying in-flight sessions; `--no-autostart` fails instead and is what continuous
  integration should use. Scope is per project by default in `.nylorun/`, created on first use,
  with `--global` and `NYLORUN_HOME` for a shared Runtime in the home directory. Commands
  report a resolved scope in every message, accept `--port` and `--db` alongside the existing
  environment variables, expose `nylorun runtime status --output json`, and use documented exit
  codes for usage errors, port conflicts, version skew, refused autostart and failed starts.
- b8d822a: Add `sandbox()`: one `.use(sandbox())` gives an agent Runtime-executed `bash`, `read`, `write`, `edit`, `grep` and `glob` tools on an isolated machine with a persistent `/workspace`. The Runtime selects a microsandbox microVM where available, otherwise an in-process virtual shell, enforces deny-by-default egress presets, owns sandbox lifecycle, and reports its choice through `GET /v1/host/sandbox`, the `nylorun dev` banner and `nylorun doctor sandbox`.

### Patch Changes

- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.4.0-beta
  - @nylorun/runtime@0.8.0-beta

## 0.1.2-beta

### Patch Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.
- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [3a88f51]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.3.0-beta
  - @nylorun/runtime@0.7.0-beta

## 0.1.1-beta

### Patch Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.
- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [41e613c]
- Updated dependencies [2898d02]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.2.0-beta
  - @nylorun/runtime@0.6.0-beta

## 0.1.0-beta.1

Initial package extraction.
