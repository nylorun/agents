# Changelog

## 0.17.0-beta

### Minor Changes

- 0cbd5c9: **Breaking (`nylorun`): readable Docker names, several Tenants on one machine, and Studio at `http://<name>.localhost:4160`.** See MIGRATION.md.

  - **Breaking (`nylorun`): names.** Every container, the network and every volume carries the Tenant's Compose project: containers `nylorun-<name>-postgres`, `-restate`, `-s2-lite`, `-gateway`, `-runtime`, `-studio` (were `…-1`), network `nylorun-<name>` (was `nylorun-<name>_default`), volumes `nylorun-<name>-postgres`, `-restate`, `-s2-lite`, `-workspaces` (were `nylorun-<name>_postgres`, …), each labelled `dev.nylorun.tenant: <name>`. The Compose service `s2` is now `s2-lite` (`nylorun logs s2-lite`).
  - **Breaking (`nylorun`): Tenants created by 0.5 start fresh.** `start` on a Tenant whose data is in the old volumes exits 3 without starting it and names them; `nylorun reset --tenant <name>` starts it anew. `reset` and `delete` also remove the old volumes and the old network.
  - **Studio proxy.** One Caddy container per machine (`nylorun-proxy`, files in `~/.nylorun/proxy/`) gives each Tenant's Studio the address `http://<name>.localhost:<port>` (`NYLORUN_PROXY_PORT`, 4160 or a free port chosen once), on `127.0.0.1` and `[::1]` (IPv4 only, saying so, when Docker refuses `::1`). It holds no Tenant data and routes browsers only. `start` brings it up when Studio starts, prints Studio's proxy URL and signs in there (on Studio's own port when the proxy does not answer); a proxy failure never fails `start`. `status` shows both URLs, `ls` and `nylorun studio` the proxy's. `NYLORUN_PROXY_DISABLED=1` turns it off; a Tenant under `NYLORUN_HOME` or `NYLORUN_COMPOSE_PROJECT` does not use it. `doctor` has a `proxy` row.
  - **Several Tenants.** Restate's RocksDB memory is capped at 256 MiB, so a Tenant uses about 600–700 MB (was about 1.3 GB). `nylorun ls` has a `MEMORY` column (`memoryBytes` in `--json`). `start` names the other running Tenants and their memory. `nylorun stop --all` stops every running Tenant and the proxy, keeping their volumes.
  - **`@nylorun/studio`.** `NYLORUN_STUDIO_PUBLIC_ORIGINS` lists exact `http:` origins Studio also serves (Host and `Origin` checks); a login token's URL is on the origin it was minted on; `NYLORUN_STUDIO_SESSION_COOKIE` names the session cookie (default `nylorun_studio_session`; `nylorun` sets `nylorun_studio_<name>`, so Studios on one host keep their own sessions); the `421` answer lists the served origins.

## 0.16.0-beta

### Minor Changes

- f96fe32: **Studio reports anonymous page views, unless you opt out.** Studio sends page views to Google Analytics with every Tenant, agent and session id replaced by `:id` and the query dropped; nothing sent to agents is collected. `nylorun start` says so once, and passes the measurement id to the Studio container as `NYLORUN_STUDIO_ANALYTICS_ID`. Turn it off with `nylorun telemetry disable`, `NYLORUN_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`; it is always off in CI, inside an embedding app, and when the browser sends Do Not Track or Global Privacy Control.
- 4b9906f: **Breaking: "Tenant" replaces "stack", and `nylorun start` works anywhere.** Each local installation holds one Tenant, and its name is the Tenant's name, so help, output, errors and docs say Tenant. See MIGRATION.md.

  - **Breaking (`nylorun`): selection.** Every command acts on the Tenant `--tenant <name>` names (replaces `--name`, which is removed), else `NYLORUN_TENANT` (replaces `NYLORUN_STACK`), else the Project link's `tenant`; `start` in a project names a new one after the project directory. Outside a project, or with `start --no-link`, commands act on the Tenant `default`. In a project without a link, commands other than `start` exit 2 and list the machine's Tenants. A name starting with `tn_` (a Tenant id) is refused.
  - **Breaking (`nylorun`): files.** Host roots are under `~/.nylorun/tenants/<name>/` (was `~/.nylorun/stacks/<name>/`) with `tenant.json` (was `stack.json`); the `.env` key is `NYLORUN_TENANT_NAME` (was `NYLORUN_STACK_NAME`); `NYLORUN_COMPOSE_PROJECT` replaces `NYLORUN_STACK_PROJECT`. Compose projects stay `nylorun-<name>`. Every command first moves 0.4 Host roots from `~/.nylorun/stacks/` to `~/.nylorun/tenants/` (renaming `stack.json` and the `.env` key), so they keep their volumes and keys. `nylorun ls` lists only directories with `tenant.json`.
  - **Breaking (`nylorun`): removed.** `nylorun legacy` and all handling of the single stack of releases before 0.4; the hidden `nylorun stack <cmd>` alias; `nylorun doctor stack|runtime`. Output says Tenant: `ls` prints `TENANT` and JSON `{ "tenants": [...] }`, `status` prints the Tenant id on its own line, and `doctor`'s row is `tenant`.
  - **Breaking: Project link format 3.** `.nylorun/link.json` is `{ "format": 3, "tenant", "tenantId", "hostUrl", "hostId" }`; `tenant` replaces `stack`. `@nylorun/agents`, `@nylorun/cli` and `@nylorun/admin` refuse an older link and name `npx nylorun start`, which rewrites it. `@nylorun/core`'s `ProjectLinkFileSchema` parses formats 0–3 with `tenant`.
  - **Breaking (`@nylorun/admin`):** `createAdmin({ tenant })` replaces `{ stack }`, `tenantHostRoot(name)` replaces `stackHostRoot(name)`, and local resolution reads `NYLORUN_TENANT` and the link's `tenant`.
  - `@nylorun/cli`: `status` and `endpoints` drop the `stack` line and JSON key; messages say Tenant. `@nylorun/agents`: a Runtime too old for the client says "update the Runtime (npx nylorun@latest start)". `@nylorun/studio`: setup hints say Tenant. `@nylorun/create-agent`: the next steps describe `npx nylorun@beta start` as this project's Tenant and its link.

### Patch Changes

- Pin agents to the tested release.
- Updated dependencies [4b9906f]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.12.0-beta
  - @nylorun/admin@0.8.0-beta

## 0.15.0-beta

### Major Changes

- 5ca1923: **Clients for one Tenant per installation: a stack per project, nothing selects a Tenant.** Upgrade these with the Runtime; they speak protocol 5. Existing stacks are left as they are: see MIGRATION.md.

  - **Breaking (`nylorun`): one stack per project.** `nylorun start` in a project creates the project's stack (named after the project directory, or `--name`; Host root `~/.nylorun/stacks/<name>/`, Compose project `nylorun-<name>`, its own free ports and volumes), waits for its Runtime to create the stack's Tenant, writes the Project link (`.nylorun/link.json` format 2: `stack`, `hostUrl`, `hostId`, `tenantId`) and `.nylorun/credentials.json` (the key of the derived principal `project`, derived from the stack's admin key), and seeds the model provider from the project's `.env`. `nylorun ls` lists the machine's stacks and `nylorun delete <name>` removes one with its volumes and Host root. `nylorun status` shows the stack's Tenant; `nylorun studio` opens it. The old single stack under `~/.nylorun` is never touched: `start` notes it, and `nylorun legacy stop|delete` handles it. Every stack command takes `--name <stack>` (or `NYLORUN_STACK`, or the Project link's stack); `start --no-link` starts a stack without linking the directory; `nylorun reset` resets the selected stack only. The runtime container's healthcheck is now `/health`, so a Tenant that cannot open is reported by `start` from the Admin status at once instead of after a 300 s wait. `NYLORUN_HOME` still overrides the Host root. Stacks start and stop only when you say so.
  - **Breaking (`@nylorun/cli`): no Tenant commands.** `nylo tenant create|use|list|current|delete` are removed; `nylo status`, `nylo reset` and `nylo endpoints` replace `nylo tenant status|reset|endpoints` on the linked installation. `nylo env` prints `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY` only. `nylo` no longer writes Project links.
  - **Breaking (`@nylorun/agents`): no Tenant to name.** The `tenant` option (`createClient`, `Transport`, `resolveConnection`, `createActionHandler({ runtime })`, `JwksCache`) and `NYLORUN_TENANT` are gone, and no request sends `Nylorun-Tenant`; a connection is a URL and a key. A Project link of format 0 or 1 is refused with `connection_missing`, naming `npx nylorun start`. `verifyDeliveryToken`'s `tenantId` is optional: without it any Tenant issuer is accepted, since the installation's keys bind it. `TENANT_HEADER` is no longer re-exported.
  - **Breaking (`@nylorun/admin`): status only.** `createTenant`, `listTenants`, `getTenant` and `deleteTenant` are removed; `status().tenant` names the Host's Tenant, and `deriveTenantKey` / `deriveStudioToken` derive its keys. Local Host resolution reads the stack's Host root (`stack` option, `NYLORUN_STACK`, or the Project link's `stack`); `NYLORUN_HOME` and `home` still override it. `stackHostRoot(name)` is exported.
  - **Breaking (`@nylorun/studio`): Studio serves its installation's Tenant.** The Tenant picker, list and create are gone, with `/_studio/tenants`; `/` opens `/tenants/<id>`. The `/tenants/:tenant` routes and the login token's `tenant` claim stay for embedders and must name that Tenant. The proxy sends no `Nylorun-Tenant`.
  - **`@nylorun/create-agent`:** the next steps are `npx nylorun start`, then `npm run dev`.
  - `@nylorun/core`: `ProjectLinkFileSchema` accepts format 2 with `stack`, and `tenantId` is optional; `ERROR_CODES` loses `tenant_conflict` and `active_work`.

### Patch Changes

- Pin agents to the tested release.
- Updated dependencies [5ca1923]
- Updated dependencies [5ca1923]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.11.0-beta
  - @nylorun/admin@0.7.0-beta

## 0.14.0-beta

### Minor Changes

- 82d95ef: **Action endpoints: background tools, CLI and Studio.**

  - **Background tools (core, agents).** `tool({ …, background: true })` marks a tool that runs longer than an endpoint's timeout. The option is code-only and never serialized into the manifest. `createActionHandler` answers its delivery at once with `202`, runs the tool, heartbeats on the deadline the Runtime returns (each time with the newest delivery token), and posts the outcome. A heartbeat answered `409` (cancelled, lost or sent again) aborts the tool's `ctx.signal`, and nothing is posted. The new `waitUntil` option hands the background work to platforms that end a request's work with its response.
  - **CLI.** `nylo tenant endpoints [--json]` lists each agent's Action endpoint and how it is doing, and `nylo tenant endpoints ping <agent>` pings one through the Runtime.
  - **Studio.** Shows `action.delivered` ("Action delivered") and `action.delivery_failed` ("Delivery failed", with the endpoint's error and when it retries).

- 6ab4c59: **Long sessions on any model: compaction.** A session whose history outgrows the model's context window keeps going, on a 16k local model as on a 1M hosted one.

  - **Compaction.**
    - **When.** Before each model call the engine estimates the prompt: the last reported usage, plus about four characters per token for what came after. If the estimate would not leave room for the reply, the engine first compacts: it asks the model to summarize the older history, then keeps about the newest 20,000 tokens (at most 30% of the window) verbatim.
    - **What it keeps.** The cut never separates a tool call from its result. The current turn's request is always kept. A later compaction merges with the earlier summary.
    - **Overflow.** If a provider still reports a context overflow, the engine compacts once and asks again.
    - **Storage.** The summary is a `compaction` transcript entry that replaces the older entries in the session state; the event log keeps the full history. The summary call is a journaled model effect, so replays are deterministic.
    - **New event.** `context.compacted` (`trigger`, `tokensBefore`, `tokensAfter`).
  - **Custom endpoints.**
    - **Settings.** Model Settings take `settings: { contextWindow, maxTokens, reasoning, compat }` for a custom OpenAI-compatible provider (vLLM, SGLang, llama.cpp, Ollama, LM Studio). `compat` is passed to pi-ai: `thinkingFormat`, `thinkingTokenBudgetField`, `chatTemplateKwargs` and the rest.
    - **Defaults.** Without settings, a custom endpoint is assumed to have a 32k window and an 8k output limit. They used to be 128k and 16k.
    - **Where to set them.** `nylo configure` asks for the window and output limit. Studio's Model Settings shows all four fields.
  - **Storage.**
    - Model effects no longer journal the model request next to the call, so each call's prompt is stored once.
    - When a turn ends, its model effects are slimmed to their identity and status; the transcript holds the answers.
    - Session storage now grows with the window, not with the square of the session's length.
  - **Core.**
    - `TranscriptEntry` adds `compaction` (`TranscriptCompactionEntry`).
    - `ModelAdapterContext.compaction` marks a summary call.
    - `CustomModelSettings` / `CustomModelSettingsSchema` describe the custom endpoint settings.

- 9d52189: **Embedding Studio in a desktop app.** Studio can be shown inside a desktop app such as Babai Desktop, in an iframe loaded from its URL and signed in by `postMessage` with a token limited to one Tenant.

  - **`nylorun`.** The local stack lets Babai's origins frame Studio: `NYLORUN_STUDIO_FRAME_ANCESTORS` in `stack/.env` defaults to `nylorun://localhost http://nylorun.localhost` and is passed to the Studio container. `nylorun start --studio-embed-origin <origin>` (repeatable) adds an exact origin, such as a desktop app's dev server, and keeps it across starts until `--studio-embed-origin-reset`. Wildcards are refused. `nylorun status` lists the origins under `Embeds`, and `status --json` as `studio.embedOrigins`.
  - **`@nylorun/admin`.** `mintStudioLoginToken({ studioUrl, adminKey, tenant?, subject? })` mints a single-use Studio login token from an app's backend. With `tenant`, the session it leads to reaches only that Tenant.
  - **Studio.** `POST /_studio/sessions` exchanges such a token for a one-hour bearer session kept in the frame's memory; dashboard pages send `frame-ancestors` from the allowlist instead of `X-Frame-Options: DENY`; `?embed=1` hides Studio's branding, follows the app's theme and routes, and reports its own; `/tenants/:tenant/sessions/:session` opens a session by id. The cookie login of `nylorun studio` is unchanged.

    The dashboard routes `/tenants/:tenant`, `/tenants/:tenant/agents/:agent`, `/tenants/:tenant/agents/:agent/sessions/:session`, `/tenants/:tenant/sessions/:session`, `/tenants/:tenant/vault` and `/tenants/:tenant/settings` are now a public contract for embedders: removing or changing one is a breaking change.

### Patch Changes

- 9546ac7: **Protocol 4: every session event is typed, on the `nylorun.event/2` envelope.**

  - **The catalog.** `EVENT_CATALOG` in `@nylorun/core/contracts` lists every event type the Runtime writes, with its payload schema, its schema version and its source. `SessionEventSchema` is their union, discriminated on `type`; `parseSessionEvent` types a known event and returns an unknown one as the bare envelope.
  - **The envelope.** Events carry `schema`, `seq`, `epoch`, `runId`, `incarnation`, `schemaVersion`, `source`, `evidence`, `visibility`, `retention` and an optional `trace`. `createdAt` is renamed `time`. The envelope is no longer strict, so later fields never break a client.
  - **Validated writes.** `Tx.event` is typed by the catalog, and both Session Stores check each event against it before it commits (`InvalidEventError`). Workflow `action.pending` payloads may carry `path` and `key`.
  - **OpenAPI.** Each event type is a component (`MessageAssistantEvent`, …), `SessionEvent` is their union, and the session SSE and history responses refer to them.
  - **Clients.** `@nylorun/agents` reads events with `parseSessionEvent`, so a newer Runtime's event types reach your code instead of failing the stream. Studio reads `time`.

  See `MIGRATION.md`.

- Pin agents to the tested release.
- Updated dependencies [c7614a4]
- Updated dependencies [5f23047]
- Updated dependencies [4282d5f]
- Updated dependencies [82d95ef]
- Updated dependencies [e28b8a9]
- Updated dependencies [50d0fb5]
- Updated dependencies [50d0fb5]
- Updated dependencies [c121144]
- Updated dependencies [50d0fb5]
- Updated dependencies [c121144]
- Updated dependencies [9546ac7]
- Updated dependencies [9d52189]
- Updated dependencies [9d52189]
- Updated dependencies [50d0fb5]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.10.0-beta
  - @nylorun/admin@0.6.0-beta

## 0.13.0-beta

### Minor Changes

- db956bc: Studio creates Tenants. While the Host has none, Studio asks for a name and creates the first one. A Tenant with no agents shows **Connect your code**: its model provider, the `npx @nylorun/cli tenant use <id>` command, and `npm run dev`. It switches to the agent list when the first agent registers.

  Every Tenant Studio creates registers the derived principal `project` (`PROJECT_PRINCIPAL_ID` in `@nylorun/admin`). `nylo tenant use` now falls back to that key, derived from the local admin key, so a Project links a Studio-created Tenant with no stored key. When it replaces a one-time application key, it keeps that key as `.nylorun/credentials.<tenantId>.json`, and `nylo tenant use <that id>` switches back. `nylorun up` again offers Studio for creating the first Tenant.

### Patch Changes

- Updated dependencies [db956bc]
  - @nylorun/admin@0.5.0-beta

## 0.12.0-beta

### Minor Changes

- c82aa6f: `nylorun up` prints Studio as `http://localhost:<port>`, with no login token in it, and in a terminal opens Studio in the browser already signed in (`--no-open` keeps the browser closed). The Studio sign-in lasts 30 days and survives Studio restarts: the session cookie is signed with a key derived from the admin key instead of being held in memory. `nylorun studio` prints the plain URL when it opens the browser; `nylorun studio --no-open` still prints the single-use login URL.

## 0.11.0-beta

### Minor Changes

- 5278b4e: **Flow agents on workflow manifest v2.** A flow agent compiles to `workflowSchemaVersion: 2` and runs on the new `flow-2` engine; v1 workflows (`Chain`, `Switch`, `Parallel`, `Map`, `Loop`) keep running on `flow-1`, so in-flight runs finish as they began.

  - **Manifest (core).** Any node may carry `id` and `input`; there are no slots. `chain` and `parallel` are bare collections, a Map is `{ map: { each } }` over its input, and a Loop has `max?` and `decide?`. The header adds `name`, `description`, `metadata`, `inputSchema` and `outputSchema`, and `agents` embeds every agent the flow runs, so one manifest hash covers the whole flow. `Agent.from(json, { nodes, agents })` rebuilds a flow agent. Path and key helpers (`leafPath`, `stageKey`, `forEachFlowNode`, `embeddedAgent`, …) are exported from `@nylorun/core/define`.
  - **Paths (harness).** Linked agent sessions are named by the agent: its id, `[i]` per Map item, and a nested flow agent's id in front. Control stages add nothing, so wrapping a step in a Loop keeps its session. Functions are bound under stage keys (`route:on`, `@1.default.1:input`) and all receive `{ input, results, flowInput }`; `flowInput` works inside nested `flow()`. A Loop without `decide` retries with the verifier's feedback up to `max` and then fails with `loop.exhausted`. Nested flow agents run inline.
  - **Runtime.** Leaves of a v2 workflow resolve from its embedded `agents` (with the workflow's plugin roots, keyed `<agent>/<capability>`) instead of the registry. `loop.iteration` is emitted only for a Loop's own agent turns.
  - **Agents SDK.** `saveAgent(flowAgent)` PUTs one document; application mode registers the flow's executor with its manifest hash. An executor leaves `fn`, `verify` and tool actions of a v2 flow unclaimed when they belong to another manifest hash, because stage keys can shift between deploys; it reports each skipped action once through `onError`.
  - **Studio.** Draws v2 manifests: agents and tools at their session paths, control stages at their stage keys, nested flow agents inline, and lights a Map's agent from its item sessions.
  - Build diagnostics: `flow.duplicate-leaf`, `flow.duplicate-id`, `flow.agent-conflict`, `flow.v1-workflow`, `loop.invalid-verify`, `workflow.flow-agent-child`. Also fixes v1 flows passing an agent step's output to the next step still wrapped in the runtime's turn marker.

### Patch Changes

- Pin agents to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.9.0-beta
  - @nylorun/admin@0.4.1-beta

## 0.10.1-beta

### Patch Changes

- Pin agents to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [42272f8]
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.8.0-beta
  - @nylorun/admin@0.4.0-beta

## 0.10.0-beta

### Minor Changes

- bf1c2da: **The local Runtime and Studio run as a Docker Compose stack that the CLI manages; Studio ships only as its image (breaking beta).**

  - `nylorun start` writes `<Host root>/stack/compose.yaml` and `.env` (mode 0600) and starts Postgres, Restate, s2-lite, the Runtime and Studio on loopback ports, with the Runtime and Studio images this CLI pins (`nylorun.runtime`, `nylorun.studio`; `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them). `nylorun stop` keeps the volumes; `nylorun status [--json] [--env]` reports services and health; `nylorun reset [--yes]` deletes the volumes and every Tenant.
  - `nylorun dev` starts the stack if it is not running, creates the Project's Tenant on first run, opens Studio on that Tenant through a single-use login URL (`next=/tenants/<id>`), and runs the application with `NYLORUN_RUNTIME_URL=http://localhost:<port>`. `--no-open` prints the URL only; `--no-studio` skips Studio. `--local-ui` is removed (exit 2).
  - `nylorun logs` and `nylorun studio` are the stack commands (`nylorun stack <command>` still works). `nylorun studio` lands on the linked Project's Tenant.
  - `nylorun runtime up|down|restart|run|status|logs` and the `up`/`down` aliases are removed; they exit 2 and name `nylorun start|stop|status|logs`. `nylorun runtime status --env` is now `nylorun status --env`.
  - `nylorun doctor` checks Node 24+, Docker, Compose v2 and the stack's health; `doctor runtime` is an alias of it.
  - `@nylorun/studio` is private and ships only as `ghcr.io/nylorun/studio`: `startStudio`, the hosted (`local.nylorun.studio`) and local UI modes, pairing, the `nylorun-studio` bin and the UI bundle download are removed.
  - `npm create @nylorun/agent` no longer adds `@nylorun/studio` or a `studio` script, checks for Docker with Compose v2 instead of a global `@nylorun/runtime`, and accepts `--no-studio` only as a deprecated no-op.

- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.

### Patch Changes

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

- Pin agents to the tested release.
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.7.0-beta
  - @nylorun/admin@0.3.0-beta

## 0.9.0-beta

### Minor Changes

- c49efed: **Runtime Clients and Admin API (supporting packages).**

  - **core:** `AdminStatusSchema`, Project-link schemas, `ERROR_CODES` (launcher codes include `platform_unsupported`, `launcher_failed`, `downgrade_refused`), `admin-status` feature, `newPrincipalId`, `compareVersions`.
  - **runtime:** `/v1/admin/status` (alias `/v1/admin/host`), loopback/`Origin`/content-type checks; the launcher ships as this package's `nylorun-runtime` bin (source under `src/launcher/`, not in `exports`) and runs the Host on the Node it runs on.
  - **studio:** `nylorun-studio` binary; connects via `resolveConnection`; waits for `dev`; never calls Admin API or writes `.nylorun/`.

  **Prerequisites:** developers install Node 24+ and `@nylorun/runtime` (`npm install --global @nylorun/runtime`) themselves; no package downloads Node or the Runtime, and there are no per-platform Runtime packages. Launcher commands: `version`, `up`, `down`, `restart`, `run`, `status`, `logs` (launcher protocol 1).

- c49efed: **Breaking (pre-1.0 minor):** Replace a single SQLite Runtime per Project or home directory with a **Runtime Host** that serves isolated **Tenants**, selected by `Nylorun-Tenant` and negotiated with `Nylorun-Protocol` (protocol `2`, feature `runtime-tenants`). Vocabulary: Host root + Tenant + Project link.

  - **core:** `PROTOCOL_VERSION = 2`, `HOST_PROTOCOL`, `TENANT_HEADER`, `PROTOCOL_HEADER`, `newTenantId` / `isTenantId`, `checkCompatibility`; health schema gains `hostId` + `protocol` (`service: "nylorun-runtime"`); Tenant/admin wire schemas; Tenant model routes under `/v1/tenant/*`.
  - **runtime:** Host process + Tenant module; Tenant model routes under `/v1/tenant/*`; `startEphemeralRuntime` for tests/embeds; executors via `PUT /v1/executors`; sandbox prefix `nylorun-<tenant-id>-`.
  - **agents:** `createClient({ url, key, tenant })`; Transport sends Tenant + protocol headers; `/health` compatibility cache; `IncompatibleRuntimeError` with upgrade remedies.
  - **cli:** Host root lifecycle (`runtime up|down|status|logs|restart|run`); Project link (`.nylorun/link.json` + `credentials.json`); `tenant` commands; `runtime status --env` exports `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, `NYLORUN_TENANT`; removed Project/home SQLite selectors.
  - **studio:** `startStudio({ …, tenant: { id, name } })`; proxy forwards Tenant + protocol headers; UI shows Tenant name/short id.

- fd9fd87: Add workflows: compose agents and `tool()` with `Chain`, `Switch`, `Parallel`, `Map`, and `Loop`. A workflow is a registered runnable (`kind: "workflow"`) with the same session API as an agent — `export const agents`, `saveAgent` (saves referenced agents first), `createSession`, `input` (`content` or `data`), `observe({ follow })`, `pending`, `approve`, `cancel`. Slots (`{ run, id?, input? }`) reshape data between nodes. The flow engine (`runFlowDurable`) returns effects only; `harness/src/loop/` and `runDurable` are unchanged.

  HostEffect gains flow kinds `agent`, `tool` (node), `fn`, and `verify`, each with `path`, `key`, and `iterations`. The Runtime drives agent nodes through the public session contract (linked sessions, shared sandbox via `PutSession.sandbox`), offers `fn` / `verify` again on lease expiry, and routes executor Actions by `(workflowId, key)` with claim-scoped `ctx.sandbox`. Optional `message.manifest` is a turn-only variant of the session pin (turn manifests). Studio shows the manifest tree, live node status, and session links. Examples under `examples/agents/{chain,switch,parallel,map,loop,ship-feature}/`.

### Patch Changes

- Pin agents to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
- Updated dependencies
  - @nylorun/agents@0.6.0-beta

## 0.8.0-beta

### Minor Changes

- 1cd7dc7: Add subagents: put an agent in another agent's `tools` (`Agent({ tools: [lookupOrder, researcher] })` or `.use({ tools: [researcher] })`) and the model can delegate to it. The tool is named after the agent's id, takes `{ task: string }`, and its description is the agent's `description`, which is now required for an agent used as a tool. The engine runs the child inside the parent's turn as a durable branch: fresh context, its own tools and hooks served by the root agent's executor, its own MCP servers, the session's sandbox, and only its final output (or `outputSchema` result) returned. Empty output, failures (with partial output marked as evidence), and requests for input or approval inside a child reach the parent as failed tool results. Parallel delegation calls run concurrently, completed child work is never re-run on replay, and cancelling the session cancels every child.

  v1 is one level deep and non-interactive. Nested delegation, child tools that declare `approval`, and differing sandboxes across the tree fail the build with a named diagnostic. The manifest adds an optional `agent` body on a tool (schema version unchanged), actions and effects carry `agent: { id, path, delegationId }`, tool context gains `ctx.agent`, the durable host resolves a new `delegation` effect kind, and the Runtime emits `delegation.started` / `delegation.completed` events and filters history with `?agent=` (`session.history({ agent })`). Studio shows delegations, labels child actions with their agent, and filters events by agent.

### Patch Changes

- Pin agents to the tested release.
- Updated dependencies [1cd7dc7]
- Updated dependencies
  - @nylorun/agents@0.5.0-beta

## 0.7.0-beta

### Minor Changes

- b8d822a: Studio session chat includes a searchable model+provider selector backed by connected Runtime vault providers.
- b8d822a: Studio Model Settings lists multiple vault-stored providers, adds credentials through a sheet, and switches the active provider/model via Runtime host vault APIs.
- b8d822a: Studio Vault module lists, adds, updates, and deletes Runtime user-vault credentials through the agents SDK proxy; secrets stay in Runtime.
- b8d822a: Breaking beta: replace `beforeModelCall` / `afterModelCall` with scoped hooks. Register `before("turn" | "step", fn)` and `after("step" | "turn", fn)` on the agent, or `before: { turn, step }` / `after: { step, turn }` on a capability. `before("turn")` runs once per turn and its `Patch` applies to every model call in the turn; the new `after("turn")` returns a `TurnDecision` for the final answer. `after` hooks take one argument and receive `attempt`, and `retry` now retries instead of failing the run. The manifest moves to `manifestSchemaVersion: 4` with `capabilities[].hooks`, and `BeforeModelCallFn`, `AfterModelCallFn` and the `beforeModelCall` / `afterModelCall` action kinds are removed. Every capability registered at a hook point now runs in one `hook` executor action, an expired hook claim is offered again instead of becoming uncertain, and the durable engine version is `hosted-2`. Hook toggles now hide a capability's tools, or one tool of a multi-tool capability, instead of having no effect or failing. Studio lists each capability's hooks with how often they run and labels hook actions. See MIGRATION.md.

### Patch Changes

- Pin agents to the tested release.
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies
  - @nylorun/agents@0.4.0-beta

## 0.6.1-beta

### Patch Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.
- Pin agents to the tested release.
- Updated dependencies [3a88f51]
- Updated dependencies
  - @nylorun/agents@0.3.0-beta

## 0.6.0-beta

### Minor Changes

- 41e613c: Ship the local SDK registry workflow with an independent SQLite Runtime, connected tool executor, authenticated Studio proxy, and a text-and-tool starter. Replace the legacy Hono starter and AG-UI transport. Require Node 24 and include the SDK in exact release compatibility pins.

  Break the Harness execution import from `/engine` to `/run` and rename hosted execution APIs to durable execution APIs, including RunBinding, BoundRunOptions, and createRunState. Update all consumers without compatibility aliases; retain persisted checkpoint fields and version pins.

### Patch Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.
- Pin agents to the tested release.
- Updated dependencies [41e613c]
- Updated dependencies [2898d02]
- Updated dependencies
  - @nylorun/agents@0.2.0-beta

## 0.5.0-beta

### Minor Changes

- Breaking: Studio reads `manifest.capabilities` (capability id, `kind`, `hasMiddleware`, tool
  schemas). `manifestCapabilities()` still accepts legacy `middleware` / `harness.manifest`
  documents. `StudioMiddlewareManifest` is now `StudioCapabilityManifest`.
- c5bbb1a: Breaking beta: make Harness `run()` a direct async state-in/state-out executor with
  serializable pauses, application `info`, cancellation signals, awaited recording, and
  agent-level output schemas. Runtime owns session scheduling with memory-default or exclusive
  local storage and imports Harness contracts. Isolate Node adapters under `runtime/node`, stream
  observations incrementally, and add opt-in bounded token previews with Studio reconciliation.
  Migrate consumers and deployment guidance together; legacy event records remain archived, not
  automatically replayed.

## 0.4.2-beta

### Patch Changes

- 4badb5b: Move model execution to session startup, provide Runtime as a mountable Hono router, and generate Hono-first projects with supervised application and Studio development. Studio now resolves root-relative Runtime endpoints correctly for custom mount paths.

## 0.4.1-beta

### Patch Changes

- d27242c: Show stopped guardrail and failed model requests as errors in Studio. Runtime now emits a terminal AG-UI error instead of marking failed requests successful, and Studio displays the reported message. The guardrails example also checks text content parts sent by Studio, including mixed media input, before invoking the model.

## 0.4.0-beta

### Minor Changes

- 54ab304: Support portable Runtime protocol version 2 while retaining legacy Studio
  manifest support. Move the Studio CLI into Runtime: use `nylorun studio
--agent-url <url>` instead of `nylo studio`. Applications should install Runtime
  directly and keep Studio as a development dependency.

  Retain session lists and media across development reloads, and recognize agent
  file changes on Windows. Validate noninteractive creator startup during release
  verification with deferred provider configuration.

  Include Harness in this release so the creator does not rely on an unpublished
  compatibility pin. Ship and verify all four packages together.

Release notes are maintained with Changesets.
