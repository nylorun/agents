# @nylorun/core

## 0.8.0-beta

### Minor Changes

- e537a82: **One `Agent` builder: named methods and flow agents.** Every capability has its own method, and deterministic workflows are written on the same builder. ReAct agent manifests are unchanged: the new syntax compiles to exactly what the old syntax produced.

  - ReAct agents: `.instructions()`, `.tools()`, `.subagents()`, `.mcp()` (a server's `name` defaults to its key; calls merge), `.skills()`, `.plugin()`, `.capability()`, `.sandbox()`, `.beforeTurn()`, `.beforeModel()`, `.afterModel()`, `.afterTurn()`, `.output()`. `capability({ id })` returns a builder with the same methods.
  - Flow agents: `.step()`, `.switch({ ...cases, default }, { on })`, `.parallel()`, `.map()` (runs over its input), `.loop(body, { verify, max | decide })`, plus `.input()`, `.output()`, `.sandbox()`, `flow()` for nested sequences and `.withId()`. Functions receive `{ input, results, flowInput }`, typed from each step's output schema. A flow agent compiles to a workflow manifest (v2, see the flow-manifest-v2 changeset).
  - Build diagnostics: `agent.mixed-body`, `flow.no-model`, `agent.single-value`, `flow.empty`, `loop.max-required`, `loop.invalid-max`, `mcp.duplicate-server`, `delegation.flow-unsupported`.
  - `sandbox()` and `mcp()` move to `@nylorun/core/define` (still exported from `@nylorun/agents`).
  - Deprecated, warning once each: options-form `instructions`/`tools`/`outputSchema` (`NYLORUN_DEP_AGENT_OPTIONS`), `.use(capability)` (`NYLORUN_DEP_USE`), `.before()`/`.after()` (`NYLORUN_DEP_HOOKS`), and `capability({ tools, instructions, … })` (`NYLORUN_DEP_CAPABILITY_OPTIONS`). See MIGRATION.md.

- 5278b4e: **Flow agents on workflow manifest v2.** A flow agent compiles to `workflowSchemaVersion: 2` and runs on the new `flow-2` engine; v1 workflows (`Chain`, `Switch`, `Parallel`, `Map`, `Loop`) keep running on `flow-1`, so in-flight runs finish as they began.

  - **Manifest (core).** Any node may carry `id` and `input`; there are no slots. `chain` and `parallel` are bare collections, a Map is `{ map: { each } }` over its input, and a Loop has `max?` and `decide?`. The header adds `name`, `description`, `metadata`, `inputSchema` and `outputSchema`, and `agents` embeds every agent the flow runs, so one manifest hash covers the whole flow. `Agent.from(json, { nodes, agents })` rebuilds a flow agent. Path and key helpers (`leafPath`, `stageKey`, `forEachFlowNode`, `embeddedAgent`, …) are exported from `@nylorun/core/define`.
  - **Paths (harness).** Linked agent sessions are named by the agent: its id, `[i]` per Map item, and a nested flow agent's id in front. Control stages add nothing, so wrapping a step in a Loop keeps its session. Functions are bound under stage keys (`route:on`, `@1.default.1:input`) and all receive `{ input, results, flowInput }`; `flowInput` works inside nested `flow()`. A Loop without `decide` retries with the verifier's feedback up to `max` and then fails with `loop.exhausted`. Nested flow agents run inline.
  - **Runtime.** Leaves of a v2 workflow resolve from its embedded `agents` (with the workflow's plugin roots, keyed `<agent>/<capability>`) instead of the registry. `loop.iteration` is emitted only for a Loop's own agent turns.
  - **Agents SDK.** `saveAgent(flowAgent)` PUTs one document; application mode registers the flow's executor with its manifest hash. An executor leaves `fn`, `verify` and tool actions of a v2 flow unclaimed when they belong to another manifest hash, because stage keys can shift between deploys; it reports each skipped action once through `onError`.
  - **Studio.** Draws v2 manifests: agents and tools at their session paths, control stages at their stage keys, nested flow agents inline, and lights a Map's agent from its item sessions.
  - Build diagnostics: `flow.duplicate-leaf`, `flow.duplicate-id`, `flow.agent-conflict`, `flow.v1-workflow`, `loop.invalid-verify`, `workflow.flow-agent-child`. Also fixes v1 flows passing an agent step's output to the next step still wrapped in the runtime's turn marker.

- 426fd27: **Flow agents as subagents.** `.subagents(flowAgent)` lets a ReAct agent delegate to a flow agent. The flow's workflow manifest v2 is inlined in the delegating tool (`ToolManifest.agent` may be a workflow manifest), so it is saved with the parent and served by the parent's executor, plugin roots included (`<flow>/<agent>/<capability>`).

  - **Engine (harness).** A call to a flow subagent is one durable `agent` effect (`role: "delegate"`) between the delegation's start and settle points; the flow's output is the tool result, and a failed flow is a failed tool result. Local `run()` refuses flow subagents, which need the Runtime.
  - **Runtime.** The effect starts a linked flow session from the parent's pinned manifest, fresh per call, and settles when the flow's turn ends. Cancelling any session now cascades to the linked sessions it started, not only a workflow's.
  - **Core.** `delegation.flow-unsupported` now only reports a workflow built with `Chain`, `Switch`, `Parallel`, `Map` or `Loop`. New helpers: `flowDelegatesOf`, `flowDelegateManifest`, `isFlowDelegate`; `delegatesOf` lists only the ReAct agents run in-process.

### Patch Changes

- 8cda500: **Workflow functions and tool steps reach the executor.** Several workflow nodes asked the executor for a key that core never registered, so the executor never found the function and the turn waited forever.

  - A Map's `over` and a slot's `input` now use the keys core registers (`<path>/over`, `<path>/input`), as Switch's `on` already did.
  - A slot `input` that wraps a Map or Switch gets its own effect id, so it no longer collides with the `over` or `on` effect on the same path.
  - A slot `id` that renames a nested workflow now renames the keys inside it too.
  - A verifier slot's `input` is keyed under the verifier's path (`<loop>/<part>/input`).
  - A tool step passes its output to the next step, not the `{ kind: "completed", output }` outcome around it. A denied tool call fails the flow with `tool.denied`.

## 0.7.0-beta

### Minor Changes

- a322696: **Derived principals** (optional Host feature `derived-principals`): a client that holds the admin key no longer needs to store an application key.

  - `admin.createTenant({ name, principals: ["babai"] })` registers each named principal by the hash of its derived key, and `admin.deriveTenantKey(tenantId, principalId)` (or `deriveTenantKey(adminKey, tenantId, principalId)`) recomputes the key when needed.
  - `POST /v1/admin/tenants` accepts `derivedPrincipals: [{ id, credentialHash }]`. Ids match `^[a-z][a-z0-9-]{0,31}$` and `studio` is reserved; duplicate ids or credentials answer `400`. A retried create must name the same principals.
  - `createTenant` with `principals` throws `incompatible_host` before sending anything to a Host without the feature.

- 844bff3: **Act for a person: `Nylorun-Subject` and `Nylorun-Scopes`.** An app server that holds the Tenant key can name the person each request is for, and the Runtime enforces it (optional Host feature `subject-headers`).

  - `client.as(subject, { scopes })` in `@nylorun/agents` sends both headers on every call, event streams included. Scopes: `agents:read`, `agents:write`, `sessions:own`, `vaults:own`, `tenant:settings`; default `["sessions:own"]`.
  - The Runtime limits a subject to the routes its scopes allow (`403 scope_required`) and to its own sessions and vaults: another owner's session, vault or sandbox is the same `404` as a missing one, including `PUT` on its session id (was `409`). Reset, config seed, executors, actions and the sandbox tool routes are open to no subject. Only application keys may send the headers.
  - The AG-UI handler calls the Runtime as each person and requires `subject-headers`; new optional `scopes` option. The host's `session()` parameters can no longer replace a session's id, agent or owner.
  - Core exports `SUBJECT_HEADER`, `SCOPES_HEADER`, `SUBJECT_SCOPES` and `parseSubjectHeaders`. Postgres Tenant schemas migrate to version 2 (an indexed session owner column).

  Requests without `Nylorun-Subject` are unchanged.

- a322696: **The session log now carries what a chat UI shows** (optional Host feature `transcript-events`).

  - `message.assistant` for each completed model step: `{ invocationId, text, toolCalls: [{ callId, name, input }], agent? }`.
  - `tool.completed` for an MCP or sandbox tool: `{ invocationId, callId, capabilityId, toolName, output }`, or `error: { code, message }` for a tool error.
  - Tool `action.pending` and `action.completed` events, and `delegation.started` / `delegation.completed`, carry the model's `callId` (and `invocationId` on actions).
  - Events are written in the transaction that completes the effect, so a replay writes none.
  - `@nylorun/core/contracts` adds payload schemas and `parseTranscriptEvent(event)`; `LiveEvent.payload` stays `unknown`.

  Fix: a tool with both `approval` and an `output` schema now pauses for approval. The Runtime validated its `interaction-required` result against the output schema and failed the tool with `tool.invalid-output`; `denied`, `interaction-required` and `deferred` results are no longer validated.

## 0.6.0-beta

### Minor Changes

- bf1c2da: **`nylorun dev --ephemeral` runs on the Docker stack, with a Tenant-level fixture model (breaking beta).**

  - `nylorun dev --ephemeral` creates a temporary Tenant through `@nylorun/admin` (no Project link written), seeds it from `.env` with the fixture model, opens Studio on it and runs the watcher; the Tenant is deleted with its active work cancelled when the watcher ends, Ctrl-C included. It needs a Runtime that advertises `tenant-fixture-model`.
  - `PUT /v1/tenant/config/seed` accepts `fixtureModel: true`, stored as Tenant setting `model.fixture`: that Tenant's model calls use the Runtime's fixture model while other Tenants on the Host keep theirs. `HOST_PROTOCOL` advertises the new optional feature `tenant-fixture-model` (`OPTIONAL_HOST_FEATURES` in `@nylorun/core/compatibility`); clients do not require it.
  - `startEphemeralRuntime()` keeps its signature but its Tenants live in memory instead of SQLite under the Host root; nothing survives `close()`.
  - Closing a Tenant waits for running advances at most the advance grace period (30 s by default) and then abandons them; their lease lapses and the next advance takes over.
  - A Worker stop, Tenant close or ended Restate attempt no longer fails or cancels the turn it interrupts: outcomes already returned are recorded, nothing is settled, and the next advance resumes the turn from its checkpoint. Only a user cancel settles `cancelled`; an advance deadline fails the turn with the deadline's message.

- bf1c2da: **The microsandbox backend is removed; the Runtime runs sandbox tools on the virtual backend only.** The optional `microsandbox` dependency is gone. `sandbox.backend` and `NYLORUN_SANDBOX` accept `auto` or `virtual`, and `auto` selects `virtual`. A Tenant that stored `microsandbox` reads it as `auto`. `nylorun doctor sandbox` and the `nylorun dev` banner report only the virtual shell.
- bf1c2da: **Tenants are Postgres schemas only; SQLite and the `nylorun-runtime` launcher are removed (breaking beta).**

  - The Runtime runs on Postgres (the Session Store, one schema per Tenant), Restate (Durable Session Execution: one advance per session, fenced by an ownership epoch, and a per-Tenant sweep) and S2 (Durable Streams: every event is written to a Postgres outbox and relayed to the session's stream, which history and SSE read). `--role api|worker|all` selects the process role; `/ready` covers Postgres, Restate and S2.
  - SQLite Tenants are not migrated. On first start the Runtime moves every `tenants/<id>/` directory that holds a `tenant.sqlite` to `trash/<id>-sqlite-<time>/` and logs `sqlite_tenant_moved_to_trash`; recreate those Tenants.
  - `@nylorun/runtime` has no bin: the `nylorun-runtime` launcher and `host-state.json` are gone. The Runtime runs as the `ghcr.io/nylorun/runtime` image (`nylorun start`); its Host entry requires `NYLORUN_DATABASE_URL`.
  - `openTenantRuntime(config, hooks)` requires the Tenant's opened `store` and `envelope`; `OpenTenantRuntime` receives them from the Tenant store. `HostStateFile` is no longer exported.
  - `@nylorun/core`: `LAUNCHER_PROTOCOL` and the launcher error codes are removed; `QuarantineSchema` drops `locked`, `lockPath` and `lockPid`; `TenantStatusSchema.checks.sqlite` is now `checks.store`. `TenantStatusSchema` gains optional `execution` (stuck invocations) and `streams` (basin, outbox depth, relay lag); `HostAggregateSchema` gains optional `outboxDepth` and `relayLagMs`.

- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.

### Patch Changes

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

## 0.5.0-beta

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

## 0.4.0-beta

### Minor Changes

- 1cd7dc7: Add subagents: put an agent in another agent's `tools` (`Agent({ tools: [lookupOrder, researcher] })` or `.use({ tools: [researcher] })`) and the model can delegate to it. The tool is named after the agent's id, takes `{ task: string }`, and its description is the agent's `description`, which is now required for an agent used as a tool. The engine runs the child inside the parent's turn as a durable branch: fresh context, its own tools and hooks served by the root agent's executor, its own MCP servers, the session's sandbox, and only its final output (or `outputSchema` result) returned. Empty output, failures (with partial output marked as evidence), and requests for input or approval inside a child reach the parent as failed tool results. Parallel delegation calls run concurrently, completed child work is never re-run on replay, and cancelling the session cancels every child.

  v1 is one level deep and non-interactive. Nested delegation, child tools that declare `approval`, and differing sandboxes across the tree fail the build with a named diagnostic. The manifest adds an optional `agent` body on a tool (schema version unchanged), actions and effects carry `agent: { id, path, delegationId }`, tool context gains `ctx.agent`, the durable host resolves a new `delegation` effect kind, and the Runtime emits `delegation.started` / `delegation.completed` events and filters history with `?agent=` (`session.history({ agent })`). Studio shows delegations, labels child actions with their agent, and filters events by agent.

## 0.3.0-beta

### Minor Changes

- b8d822a: Studio Model Settings lists multiple vault-stored providers, adds credentials through a sheet, and switches the active provider/model via Runtime host vault APIs.
- b8d822a: Let a running Runtime learn its executors instead of receiving them all at startup.
  `PUT /v1/executors` registers or rotates scoped executor credentials with the application
  credential, `DELETE /v1/executors/:agentId` removes one, and `GET /v1/executors` lists them
  without disclosing secrets. Registrations persist in SQLite with the token hashed at rest and
  are restored on the next start; scopes supplied through `NYLORUN_EXECUTORS_JSON` still apply
  to that process, take precedence for their agent, and are never written to the database. An
  unchanged registration is idempotent and keeps open streams, while a rotation ends the
  replaced token's work stream and stops it authorizing. Unauthenticated `/health` now also
  reports the Runtime version, a non-reversible scope digest of the database path, and the
  process id; all three are optional in the contract so an older host still parses. Token
  hashing is adequate only because these credentials are high-entropy values minted by the
  host; it is not a password derivation.
- b8d822a: Add `sandbox()`: one `.use(sandbox())` gives an agent Runtime-executed `bash`, `read`, `write`, `edit`, `grep` and `glob` tools on an isolated machine with a persistent `/workspace`. The Runtime selects a microsandbox microVM where available, otherwise an in-process virtual shell, enforces deny-by-default egress presets, owns sandbox lifecycle, and reports its choice through `GET /v1/host/sandbox`, the `nylorun dev` banner and `nylorun doctor sandbox`.
- b8d822a: Breaking beta: replace `beforeModelCall` / `afterModelCall` with scoped hooks. Register `before("turn" | "step", fn)` and `after("step" | "turn", fn)` on the agent, or `before: { turn, step }` / `after: { step, turn }` on a capability. `before("turn")` runs once per turn and its `Patch` applies to every model call in the turn; the new `after("turn")` returns a `TurnDecision` for the final answer. `after` hooks take one argument and receive `attempt`, and `retry` now retries instead of failing the run. The manifest moves to `manifestSchemaVersion: 4` with `capabilities[].hooks`, and `BeforeModelCallFn`, `AfterModelCallFn` and the `beforeModelCall` / `afterModelCall` action kinds are removed. Every capability registered at a hook point now runs in one `hook` executor action, an expired hook claim is offered again instead of becoming uncertain, and the durable engine version is `hosted-2`. Hook toggles now hide a capability's tools, or one tool of a multi-tool capability, instead of having no effect or failing. Studio lists each capability's hooks with how often they run and labels hook actions. See MIGRATION.md.

## 0.2.0-beta

### Minor Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.

## 0.1.1-beta

### Patch Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.

## 0.1.0-beta.1

Initial package extraction.
