# @nylorun/cli

## 0.6.0-beta

### Minor Changes

- 4282d5f: **Breaking: executors are removed; protocol 3.** The Runtime delivers every Action (tool, hook, `fn`, `verify`) to the Action endpoint an agent registers. It no longer offers Actions for executors to claim. See `MIGRATION.md`, "Action endpoints replace executors".

  - **Core.** `PROTOCOL_VERSION` is 3 and a Host serves only protocol 3. `action-endpoints` is a protocol feature instead of an optional Host feature. Removed:

    - the executor, claim and Action-list schemas;
    - `action_result` from `SessionCommandSchema`;
    - the `claimed` Action status, `claimId` and `leaseExpiresAt`.

    New: `ActionResultReceiptSchema`, the receipt of `POST /v1/actions/:id/result`, which is `AcceptedResponse` without `requestId`.

  - **Runtime.** Removed:

    - `PUT`/`GET /v1/executors`, `DELETE /v1/executors/:agentId`, `GET /v1/executors/connect`;
    - `GET /v1/actions`, `POST /v1/actions/:id/claim`, and the executor form of `POST /v1/actions/:id/heartbeat`;
    - the `tenant/work` stream;
    - claim expiry;
    - executor credentials.

    `POST /v1/actions/:id/sandbox/:tool` takes the delivery token only. Tenant summaries report `inFlightDeliveries` instead of `connectedExecutors`. Tenant status lists each agent's endpoint and has an `endpoints` check instead of `executors`.

    Postgres migration 6 drops the `executors` table. Actions an executor had claimed are handled like lost deliveries: a tool becomes `uncertain`, and a hook, `fn` or `verify` is delivered again.

  - **Agents.** Removed: `connectAgents`, the `@nylorun/agents/executor` subpath, derived executor keys and `NYLORUN_EXECUTOR_KEY`. Serve agents with `createActionHandler` and call `register({ url })`.
  - **CLI.** Executor keys are gone from Project credentials. `nylo tenant endpoints` shows each endpoint and its health.

- 82d95ef: **Action endpoints: background tools, CLI and Studio.**

  - **Background tools (core, agents).** `tool({ …, background: true })` marks a tool that runs longer than an endpoint's timeout. The option is code-only and never serialized into the manifest. `createActionHandler` answers its delivery at once with `202`, runs the tool, heartbeats on the deadline the Runtime returns (each time with the newest delivery token), and posts the outcome. A heartbeat answered `409` (cancelled, lost or sent again) aborts the tool's `ctx.signal`, and nothing is posted. The new `waitUntil` option hands the background work to platforms that end a request's work with its response.
  - **CLI.** `nylo tenant endpoints [--json]` lists each agent's Action endpoint and how it is doing, and `nylo tenant endpoints ping <agent>` pings one through the Runtime.
  - **Studio.** Shows `action.delivered` ("Action delivered") and `action.delivery_failed` ("Delivery failed", with the endpoint's error and when it retries).

- 50d0fb5: **Browser access: web pages and apps call the Runtime with a publishable key.** A page ships a publishable key and gets subject tokens from its app server; the Runtime answers it directly, with CORS (optional Host feature `browser-access`).

  - **Publishable keys.** `nr_pub_<tenantId>_…`, sent in `Nylorun-Key`, name the Tenant and one app, with an origin allowlist (exact origins, or `http://localhost:*` and `http://127.0.0.1:*` for development; none for native apps). `GET`/`POST /v1/access/publishable-keys`, `PUT`/`DELETE …/:id`. A key alone grants the policy's `anon` role, at most the public agent list, and reaches no session or vault. Postgres migration 4.
  - **Host.** With browser access on, requests with an `Origin` reach Tenant routes; `/health`, `/ready` and admin routes still refuse them. Preflights for browser routes (agents, sessions, vaults, AG-UI, JWKS) are answered from the route alone and grant no credentials; the actual request must carry a publishable key whose allowlist names the origin, and only then do responses (JSON, errors, `401`, `429`, event streams) carry CORS headers. A disallowed origin or unknown key gets the opaque `404`. Tenant and executor keys sent with an `Origin` are refused before they are looked up. `Nylorun-Tenant` may be left out when `Nylorun-Key` names the Tenant; both must agree when both are sent. Browser access is on in the stack (`NYLORUN_BROWSER_ACCESS=off` turns it off) and off for a Host started from `host.json` unless `browserAccess` is true.
  - **JWKS.** `GET /v1/access/jwks` is readable by any caller that reaches the Tenant.
  - **Agents SDK.** `@nylorun/agents/browser`: `createBrowserClient({ url, publishableKey, token })` keeps subject tokens in memory, refreshes them a minute before expiry or after `401 token_expired`, one fetch at a time, and creates sessions and vaults owned by the token's subject; it loads no Node module. `createTokenEndpoint()` is the app server's token route. `client.access.publishableKeys` manages keys. The transport accepts a `token` source and a `publishableKey`, and event streams the Runtime ends at token expiry reconnect at once. The Tenant API client classes move to a module with no Node imports; `@nylorun/agents` and `/client` export the same names.
  - **CLI.** `nylo access keys list|create|set-origins|revoke`.

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

- 50d0fb5: **Subject tokens: a person's own credential for the Runtime.** An app server mints a short-lived token for one signed-in person, and their app calls the Runtime directly (optional Host feature `subject-tokens`). Requests with application keys and subject headers are unchanged.

  - **Runtime.** `POST /v1/tokens` (application key only) mints an ES256 JWT for a subject and a role, valid 60–900 seconds. The Tenant API accepts it as a bearer and resolves its scopes and agents from the role on every request. Forged, foreign or malformed tokens get the opaque `404`; an expired token, a revoked subject, a revoked key or a removed role gets `401 token_expired` with `WWW-Authenticate`. Tokens carry only `agents:read`, `sessions:own` and `vaults:own`; they may not set session `info`, send `message.manifest` or store OAuth refresh credentials, and `GET /v1/agents` shows them `{ agentId, name, description }` of their role's agents only.
  - **Access policy.** `GET`/`PUT /v1/access/policy`: roles with token scopes, an agent allowlist and limits (`turnsPerHour`, `concurrentTurns`, answered with `429 limit_exceeded` and `Retry-After`). Without roles nothing is minted.
  - **Signing keys.** Per Tenant, the private key sealed with the vault KEK: `GET /v1/access/signing-keys`, `POST …/rotate` (refused while the previous key may still verify live tokens; `force` for incidents), `POST …/:kid/revoke`, `GET /v1/access/jwks`. A Tenant with signing keys and no KEK is quarantined `kek-missing`.
  - **Revocation.** `POST /v1/access/revocations` ends a subject's tokens; their open event streams end with `event: nylorun.closed` on every process. A stream opened with a token also ends when the token expires.
  - Postgres migration 3 adds `signing_keys`, `subject_epochs`, `subject_usage` and an index on the session owner and status. New error codes `token_expired` and `limit_exceeded`.
  - **Agents SDK.** `client.tokens.create()`, `client.access.getPolicy()`/`putPolicy()`/`revokeSubject()`/`jwks()` and `client.access.signingKeys.list()`/`rotate()`/`revoke()`, each checking the Host feature first.
  - **CLI.** `nylo access policy get|set|init`, `nylo access signing-keys list|rotate|revoke`, `nylo access revoke <subject>` and `nylo access token` for trying the API.

### Patch Changes

- f39b79f: **`nylo doctor sandbox` shows the Tenant's default sandbox**: `none`, `virtual`, or a Tenant sandbox that sessions naming no sandbox get.
- 6ab4c59: **Model calls don't strand sessions.** A model provider failure is now a known outcome, not a lost call. The Runtime retries what can be retried, and otherwise fails the turn with `model.<code>`, so the session accepts the next message instead of sitting `uncertain` until it is cancelled.

  - **Runtime.**

    - **Upgrade.** The model adapter moves to pi-ai 0.99.1 and always streams.
    - **Per-call settings.**
      - Every call carries the session id, so OpenAI and other providers reuse the prompt cache and route to the same backend.
      - Provider auth no longer reads the process environment.
      - Rate limits, overloads, timeouts and transient errors are retried: 3 attempts with backoff, honouring `Retry-After`.
      - A stream that produces nothing for 300 s is aborted and retried. `TenantConfig.modelCall` sets attempts, backoff, the idle timeout and the request timeout.
    - **Failures.** Anything else fails the turn with one of these codes:

      - `model.context_overflow`, `model.rate_limited`, `model.overloaded`, `model.timeout`, `model.transient`
      - `model.content_policy`, `model.auth` (whose message says where to fix the credential)
      - `model.invalid_request`, `model.invalid_output`

      Only a call whose outcome was lost, such as a Worker dying mid-call, is still `uncertain`.

    - **Structured output.** A structured final answer is repaired (control characters, a Markdown code fence) before it is parsed.
    - **Model history.** Replayed history keeps the model that produced each message, so a model switch no longer sends one model's signatures or tool-call ids to another. Reasoning from OpenAI-compatible servers (`reasoning_content`, `reasoning`) is sent back only within the turn that produced it.

  - **Events.**
    - `message.assistant` adds `model` (`provider`, `model`), `finishReason` and `usage`.
    - A new `model.failed` transcript event (`code`, `message`, `retryable`) is written instead of `message.assistant` when a call fails.
  - **Core and harness.**
    - New types and helpers: `ModelFailureOutcome`, `ModelFailureCode`, `MODEL_FAILURE_CODES`, `isModelFailureOutcome`, `ModelProducer`.
    - `PromptItem` assistant messages may carry `producer`.
    - `ModelUsage` adds `cacheWriteTokens`.
    - A model adapter may return a failure outcome.
    - The durable engine version is `hosted-3`: a turn that is running when the Runtime is upgraded fails once with `execution.incompatible`, and the next message works.
  - **CLI.**
    - `nylo configure` passes a stable installation id to OAuth logins that need one (OpenAI "Sign in with ChatGPT"), stored as `cli-installation-id` in the Host root.
    - A custom OpenAI-compatible provider now prompts for its API key instead of failing.

- Pin agents to the tested release.
- Pin admin to the tested release.
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

## 0.5.0-beta

### Minor Changes

- db956bc: Studio creates Tenants. While the Host has none, Studio asks for a name and creates the first one. A Tenant with no agents shows **Connect your code**: its model provider, the `npx @nylorun/cli tenant use <id>` command, and `npm run dev`. It switches to the agent list when the first agent registers.

  Every Tenant Studio creates registers the derived principal `project` (`PROJECT_PRINCIPAL_ID` in `@nylorun/admin`). `nylo tenant use` now falls back to that key, derived from the local admin key, so a Project links a Studio-created Tenant with no stored key. When it replaces a one-time application key, it keeps that key as `.nylorun/credentials.<tenantId>.json`, and `nylo tenant use <that id>` switches back. `nylorun up` again offers Studio for creating the first Tenant.

### Patch Changes

- Pin admin to the tested release.
- Updated dependencies [db956bc]
  - @nylorun/admin@0.5.0-beta

## 0.4.2-beta

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.9.0-beta
  - @nylorun/admin@0.4.1-beta

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
