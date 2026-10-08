# Changelog

## 0.25.0-beta

### Major Changes

- 417f336: **The harness has no provider adapters.** The harness makes no model call: it builds the provider-neutral `ModelCall` and reads back a `ModelCandidate`, and the Runtime's Model Gate makes the provider call. MIGRATION.md ("The harness has no provider adapters") has the details.

  - **Breaking (`@nylorun/harness`): the `./model/adapters` subpath is removed**, with the OpenAI Chat Completions, OpenAI Responses and Anthropic Messages translators in it (`toChatCompletions`, `fromChatCompletions`, `chatCompletionsAdapter`, `toResponses`, `fromResponses`, `responsesAdapter`, `toMessages`, `fromMessages`, `anthropicAdapter`, their request and message types, `AnthropicAdapterOptions`, `AdapterSend`) and `preparedModel`. The package root no longer exports `PreparedModelOptions`. A host that runs the engine in process passes its own `onModelCall` (the Runtime's `piModel`, or its own provider mapping) and reports the provider request with `context.reportPreparedCall({ adapter, call })`, as `preparedModel()` did. Nothing changes on the wire, in manifests or in checkpoints.

### Patch Changes

- 6fecd4c: **Docs: who journals effects.** `HOST_CONTRACT.md` no longer says Restate journals effect boundaries. The Runtime journals each effect in the Session Store under the advance's lease, and Durable Session Execution (Restate) only runs one advance per session at a time and delivers wakes and timers.
- 070674d: **One source of truth for the manifest and Harness API schemas.**

  - `@nylorun/core`: `Agent.from` (`agentFrom`) checks a manifest with `AgentManifestSchema`, the Runtime's own check, instead of a validator of its own, and refuses with `agent.build-failed` and the schema's messages (each prefixed with its path, such as `capabilities.0.tools.0.name: …`). It now refuses what the Runtime refuses at registration and it let through, such as unknown fields (it dropped them) or a tool or MCP server name that not every model provider accepts. The schema names a top-level `model` or `schemaVersion` and a capability's `model` as before, and the skill whose `files` are wrong (`Skill 'triage' files must include SKILL.md`). The rebuilt manifest is a frozen copy; the object passed in is no longer frozen. `AgentManifestSchema` and `WorkflowManifestSchema` are no longer force-cast to their types: the build checks that each accepts exactly `AgentManifest` and `WorkflowManifest`. `@nylorun/core/contracts` exports `McpServerManifestSchema`, `HEADER_NAME_PATTERN` and `LOOPBACK_HOSTS`. The Harness API's types (`@nylorun/core/harness-api`) are inferred from the schemas that validate its frames, so they match them: `TurnStart.manifest`, `TurnStart.checkpoint` and `RunRouting.rootManifest` are `object`, `WorkspaceCall.tool` is a sandbox tool name, `ABORT_REASONS` is a tuple, and properties are no longer `readonly` (arrays that were stay so).
  - `@nylorun/harness`: `runDurable` checks the manifest once, when it rebuilds the agent, instead of twice. The unpublished, stale `schemas/manifest.schema.json` (manifest `schemaVersion` 2) is gone; `z.toJSONSchema(AgentManifestSchema)` is the manifest's JSON Schema.
  - `@nylorun/agents`: a plugin's MCP servers are checked with core's `McpServerManifestSchema`, header-name pattern and loopback hosts. A server whose key is not a name every model provider accepts is skipped with a `plugin.mcp-server-skipped` warning, since the Runtime would refuse the manifest declaring it.
  - `@nylorun/runtime`: the stack configuration reads its four listeners (`NYLORUN_LISTEN_*`, `NYLORUN_GATES_LISTEN_*`, `NYLORUN_HARNESS_LISTEN_*`, `NYLORUN_EGRESS_LISTEN_*`) with one parser; the variables and their errors are unchanged.

- Pin core to the tested release.
- Updated dependencies [7780b2f]
- Updated dependencies [070674d]
  - @nylorun/core@0.18.0-beta

## 0.24.0-beta

### Minor Changes

- 18f9a2f: **Model-safe MCP tool names, coded MCP tool errors and credential scrubbing** (R2b C6, C7, C8). MIGRATION.md (protocol 10, "Tool and MCP server names" and "Tool errors the model sees") has the details.

  - `@nylorun/core`: a declared tool's name and an MCP server's name must match `^[A-Za-z0-9_-]{1,64}$` (`AgentManifestSchema`, so `PUT /v1/agents/{id}` refuses others). `mcp.discovered`'s server outcomes gain `renamed: [{ serverToolName, name }]`; `tool.completed` gains `redacted` and its `error` gains `retryable`. A failed `ToolOutcome` and `ToolResult` may carry `retryable`.
  - `@nylorun/harness`: a failed tool result keeps the outcome's `retryable`, and the model sees it beside `code` and `message`.
  - `@nylorun/runtime`: the model knows an MCP tool by `server__tool` with characters outside `[A-Za-z0-9_-]` replaced by `_`, shortened to 64 with an 8-hex SHA-256 suffix (also given to a renamed tool that collides); the server is still called by its own name. A failed MCP tool call is a failed tool result the model sees, with code `mcp.unreachable` (never sent; retryable), `credential_rejected` (`401`), `mcp.forbidden` (`403`), `mcp.error` (a JSON-RPC error) or `mcp.status` (another HTTP status); a call whose answer was lost after it was sent is `mcp.lost` for a `readOnlyHint` or `idempotentHint` tool and stays `uncertain` otherwise, as does a call lost with a gateway restart. A pooled connection whose server ended its session (`404` to its `Mcp-Session-Id`) or whose credential's `via` moved is dropped, opened again, and the call sent once more, since the tool never saw it. The credential values sent on a call (at least 8 characters, and a `Bearer` value's token) are replaced with `[redacted]` in MCP and HTTP tool results and errors before the gate records or returns them; no other field is touched.

- 90a817d: **MCP and HTTP tool results that fit** (R2b C11). MIGRATION.md (protocol 10, "Tool results that fit") has the details.

  - `@nylorun/core`: a completed `ToolOutcome` may carry `files` (`ToolResultFile`: a media type and the host's reference) and `truncated`; a completed `ToolResult` carries the `files`. `artifactsCapabilityManifest({ save, read })` adds the built-in `read_artifact` (`READ_ARTIFACT_TOOL`, `READ_ARTIFACT_MAX_BYTES`), and `codeToolsOf` leaves it alone. `SessionView` gains `definitionHash`, the definition the session was opened from. Transcript edits are split at 48 KiB, down from 256 KiB, so each `transcript.updated` event stays under 64 KiB when no entry is larger.
  - `@nylorun/harness`: a tool result's files go to the model after its output, as media parts; an outcome marked `truncated` is not checked against the tool's output schema.
  - `@nylorun/runtime`: an agent's remote MCP or HTTP tool result past 32 KiB is stored as a file artifact of the session, and the model gets `{ truncated: true, artifactId, size, preview }` (the first 4 KiB and the last 1 KiB). Image, audio and blob resource parts become artifacts too, an image also shown to a model that reads images (a note for one that does not); each part of a mixed result is shaped alone, and a `resource_link` stays a link. One step's results share a 256 KiB budget, so many parallel results never make an event near S2's 1 MiB record: past it, a result is a stub naming its artifact. When an artifact cannot be stored, the preview stays and `dropped` says why. An MCP answer past 8 MiB is `mcp.too-large`. `read_artifact { artifactId, offset?, length? }` reads 32 KiB of the session's own artifact a call, with or without a sandbox: a session gets it for each agent with an MCP server or an HTTP tool. The session view names its `definitionHash`.
  - `@nylorun/studio`: a session is shown as running an older manifest only when the definition it was opened from is not the registered one, not because the Runtime pinned its own tools (a sandbox's, `save_artifact`, `read_artifact`) beside it.

- b8d10cb: **Per-tool MCP settings (manifest v6) and deferred tools** (R2b C9, C10). MIGRATION.md (protocol 10, "Per-tool settings and manifest v6" and "Deferred tools") has the details.

  - `@nylorun/core`: an MCP server takes `tools` (`McpToolSettings` by the server's own tool name, `"*"` for the rest: `enabled`, `approval`, `deferred`) and `deferred`, in manifest v6. `mcp()` and `Agent.mcp()` accept them, and the builder writes v6 only for a manifest that uses them, so other manifests keep their hashes; `AgentManifestSchema` accepts v5 unchanged and refuses the fields in v5. `mcpToolSettings` resolves a tool's settings, `manifestVersionFor` says which version a definition needs. `isVariantOf` lets a turn variant disable an MCP tool or require its approval, and nothing else. `TOOLS_CAPABILITY_ID`, `TOOL_SEARCH_TOOL`, `TOOL_CALL_TOOL`, `deferredToolsTools` and `deferredToolsInstructions` describe `tool_search` and `tool_call`. A session tool may carry instructions, read with its capability's. `mcp.discovered` gains `deferred`, `disabled` and `unknownTools` per server.
  - `@nylorun/harness`: a session tool marked `deferred` stays out of the model's tool list; `tool_call` runs it as its own call, after checking the arguments against its `inputSchema`, and asks for approval when it needs it.
  - `@nylorun/runtime`: discovery leaves out the tools a server's settings disable and names keys that match no tool. A session of an agent with a remote MCP server pins an empty `nylorun.tools` capability; when the agent's MCP tools pass a tenth of the model's context window (or settings say so), they are deferred for the session's life, and the model gets `tool_search` (BM25 over the deferred tools' names and descriptions, served by core) and `tool_call`, with a note naming each server and its instructions. Approval resolves per tool, and a turn variant's tightening applies to its turn. The gate's `mcp/connect` answers the server's instructions.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [50e2f7e]
- Updated dependencies [e0e39ff]
- Updated dependencies [fed5e58]
- Updated dependencies [18f9a2f]
- Updated dependencies [da93711]
- Updated dependencies [90a817d]
- Updated dependencies [b8d10cb]
  - @nylorun/core@0.17.0-beta

## 0.23.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [cf5eb9c]
- Updated dependencies [2ed5fe0]
  - @nylorun/core@0.16.0-beta

## 0.23.0-beta

### Major Changes

- 4bd2a0b: **Flows run no code: workflow manifest v3 (manifest-only agents, step M2).** A flow agent is data: each stage gets the previous stage's output, a switch reads it, a map runs over it and a loop asks a verifier agent. See MIGRATION.md for what replaces each function.

  - **Breaking (`@nylorun/core`, `@nylorun/agents`):** stage `input` functions, `switch` `on`, loop `verify` functions and `decide` are removed; a builder option that names one is refused with what replaces it. `.loop()` takes a verifier agent and a required `max`. New `.pipe(...children)` adds one stage per child; `.step()` is a deprecated alias (`NYLORUN_DEP_STEP`). `Chain`, `Switch`, `Parallel`, `Map`, `Loop`, `withInstructions`, `withoutTools`, `isSlot`, `functionKey` and the `StageArgs`, `LoopVerifyFn`, `LoopDecideArgs`, `LoopChoice` and v1 workflow types are removed. `Agent.from` for a flow takes tool nodes only.
  - **Breaking (`@nylorun/core`):** workflow manifests are `workflowSchemaVersion: 3`; no node carries `input`, a switch has no `on`, a loop's `verify` is an agent and `max` is required. A v1 or v2 manifest is refused with a message naming the change. The `fn` and `verify` Actions and effect kinds, and the `loop.decided` event, are removed. `WorkflowManifestV2` / `WorkflowNodeV2` / `isWorkflowManifestV2` are now `WorkflowManifest` / `WorkflowNode` / `isWorkflowManifest`.
  - **Breaking (`@nylorun/harness`):** the flow engine is `flow-3` and runs only v3 manifests; v1 and v2 engines, `agentTurnValue` and the `fn` / `verify` effect kinds are removed. A switch picks the case named by the previous output or its `route` field, a map runs over an array or an `items` array, and a loop retries with its verifier's feedback until `max`. An `agent` effect carries the flow's input as `flowInput` when the stage's input differs.
  - **Breaking (`@nylorun/runtime`):** no `fn` or `verify` Actions are offered or delivered. An agent stage's message shows the flow's input as the original request before its own input, and each verifier verdict is recorded as `loop.verified`.
  - `@nylorun/studio`: the workflow tree draws v3 manifests (a loop shows its verifier agent and `max`); the loop timeline drops decide outcomes, and `loop.verified` shows the feedback.

- 40b7648: **HTTP tools and static approval (manifest-only agents, M3).** A tool can be one HTTP request the Runtime makes through its Tool Gate, with no Action endpoint; code tools keep working.

  - `@nylorun/core`: `ToolManifest` gains `http` (`url`, `method` `POST`/`PUT`/`PATCH`, `credential`, `timeoutMs` up to 300000) and `approval` (`never`/`always`, HTTP tools only); a tool is never both an agent and an HTTP request, and `fn` and `command` are refused ("Functions are not available yet"). Remote MCP servers take `approval`. `http()` builds an HTTP tool, `httpToolOf()` reads one; `SESSION_ID_HEADER`, `TURN_ID_HEADER` and `AGENT_ID_HEADER` name the headers it sends. `Agent.from` rebuilds HTTP tools without an implementation; an HTTP tool is refused as a flow stage.
  - `@nylorun/harness`: hosted HTTP tools keep their target, and `approval: "always"` (an HTTP tool's, or `DurableSessionTool.approval` for a remote MCP server's tools) pauses each call for approval. **Breaking:** `HarnessExecutors.recovers.remoteMcp` is renamed `recovers.tool`.
  - `@nylorun/agents`: exports `http` and the identity header constants.
  - `@nylorun/runtime`: the Tool Gate runs HTTP tool calls (`POST /nylorun/v1/http-calls` at the gates service, or in process): the input as JSON under the Host's address policy, the session's vault credential bound to the URL, `Nylorun-Session-Id`/`-Turn-Id`/`-Agent-Id` and the effect id as `Idempotency-Key`. A keyed call runs once (`tool_crossings`), so a re-send after a takeover joins it and one lost with the gateway is `uncertain`. Non-2xx answers, timeouts, refused addresses, missing credentials and output mismatches are tool errors the model sees. The credential resolver is asked with `target.kind: "http"` and the tool's `credential` name.
  - `@nylorun/studio`: the Agent Manifest tab lists HTTP tools with their method and URL, and marks tools and MCP servers that wait for approval.

- c135267: **Action endpoints are removed (manifest-only agents, M6).** The Runtime runs no code of yours during a session: an agent's tools are HTTP tools, remote MCP servers, agents used as tools and the Runtime's built-ins. Protocol stays 8; the `action-endpoints` feature is gone, so a client that requires it is refused. See MIGRATION.md, "Action endpoints are removed".

  - **Breaking (`@nylorun/core`):** the `Action`, endpoint (`PutEndpointsRequest`, `Endpoint`, `EndpointHealth`, …) and delivery schemas, `SIGNATURE_HEADER`, `OUTCOME_HEADER`, `DELIVERY_TOKEN_TYPE` and the `action.*` events (`action.pending`, `.delivered`, `.delivery_failed`, `.completed`, `.uncertain`) are removed, and `ToolDefinition.background` with them. `ActionOutcome` is renamed `EffectOutcome`. Tenant status loses `checks.endpoints`, `agents[].registered` and `agents[].endpoint`, and `counts.pendingActions`; the session view loses `actions`. A `turn.paused` interaction carries the tool call's `callId`. New `codeToolsOf` and `codeToolRefusal` name a definition's tools that would run your code. The Harness API is v2 (`HARNESS_API_VERSION = 2`): `TurnStart.options.holdMs` and `effect.resolved` are removed.
  - **Breaking (`@nylorun/harness`):** held runs are gone: `createHarness` loses `holdMs`, and `apiHost` its `hold` option.
  - **Breaking (`@nylorun/agents`):** `createActionHandler`, `executeAction`, `createActionSandbox`, `definitionDeclaresSandbox`, `isActionSandboxTool` and the `Action`, `ActionOutcome`, `ActionHandler`, `ActionHandlerOptions`, `RegisterOptions`, `ExecuteActionOptions` and `ExecutableDefinition` types are removed. `saveAgent` refuses a code tool (`tool({ run })`) or a flow tool stage before sending; its `implementationVersion` is optional (`NYLORUN_IMPLEMENTATION_VERSION`, else `dev`).
  - **Breaking (`@nylorun/runtime`):** `/v1/endpoints` and `/v1/actions/*` answer `404`; delivery tokens, the deliverer, background tools, held runs (`TenantConfig.actionHoldMs`), `DurableExecution.deliver`, the Restate `NylorunAction` object, the `action_result` wake and the gates service's `/nylorun/v1/deliveries` are removed, and a migration drops the `actions` and `endpoints` tables. `PUT /v1/agents/:id` refuses a definition with a code tool or a flow tool stage (`400`); a tool the Runtime cannot run fails with `tool.unavailable`. The fixture model answers in text when the agent offers no `lookup_order` tool.
  - **Breaking (`@nylorun/cli`):** `nylo endpoints` is removed (a usage error that says why); `nylo status` shows uncertain effects instead of pending Actions.
  - **Breaking (`@nylorun/create-agent`):** the starter saves its agent with `saveAgent` and runs no server: no Action endpoint, `PORT` or `NYLORUN_ACTIONS_URL`. Its assistant has no tools, with a commented `http()` tool to start from.
  - `nylorun`: the local stack's comments speak of MCP servers and HTTP tools on this machine, not Action endpoints.
  - `@nylorun/studio`: the `action.*` event views and delivery status are removed; the chat shows `tool.completed`, and the Agent Manifest tab lists tools without a target as code tools.

- d36f0d9: **Hooks are removed; manifests are v5 (manifest-only agents, step M1).** The Runtime no longer calls the developer's code before or after a turn or a model call. See MIGRATION.md for what replaces each use.

  - **Breaking (`@nylorun/core`, `@nylorun/agents`):** `.beforeTurn()`, `.beforeModel()`, `.afterModel()`, `.afterTurn()`, the deprecated `.before()` / `.after()`, a capability's `before` / `after`, and the `Patch`, `Decision`, `TurnDecision`, `BeforeHook`, `AfterHook`, `HookScope` types and `runHookPoint` / `hooksFrom` helpers are removed. A capability that still passes `before` or `after` is refused with `hooks were removed: …`.
  - **Breaking (`@nylorun/core`):** `manifestSchemaVersion` is 5. `capabilities[].hooks` is gone; a manifest that names it, or a v3/v4 manifest, is refused with a message naming the change. The `hook` Action and the `hook` effect kind of the Harness API are removed.
  - **Breaking (`@nylorun/harness`):** the turn loop runs no hooks; the turn state a checkpoint carries is `{ turnId }`, and the engine version is `hosted-4`, so checkpoints of earlier engines are refused.
  - `@nylorun/runtime`: no `hook` Actions are offered or delivered.
  - `@nylorun/studio`: the Agent Manifest tab drops the Hooks count and the turn lifecycle.

### Minor Changes

- a64aaca: **HTTP in flows (manifest-only agents, after M2 and M3).** An `http()` tool is a flow stage, and `http({ url })` is a Loop's HTTP verifier; the Runtime makes both requests through its Tool Gate, with no Action endpoint.

  - `@nylorun/core`: an HTTP tool may be a stage in `.pipe()`, a switch case, a Map item or a Loop body; its tool node carries its `http` target and binds nothing. The build refuses an HTTP stage whose input is known to be the wrong type (`flow.input-mismatch`, e.g. after an agent with no `.output()`) and `approval: "always"` on one (`flow.approval-unsupported`). `http()` without a name and an input returns an `HttpTarget`, an HTTP verifier: `.loop(body, { verify: http({ url, method?, credential?, timeoutMs? }), max })`, in the manifest `loop.verify: { http }`. `fn` and `command` verify targets are refused ("Functions are not available yet"). New `flowHttpTarget()` finds an HTTP stage or verifier by stage key; `isHttpTarget()`, `WorkflowHttpVerify` and `WorkflowLoopVerify` are exported.
  - `@nylorun/harness`: the flow engine checks an HTTP stage's input against its schema (`tool.invalid-input`), runs it as a `tool` effect and fails the stage on a failed outcome (`http.status`, `http.timeout`, `tool.invalid-output`, …). An HTTP verifier is a `tool` effect with `{ input, output, iteration }` and `context.role: "verify-http"`; a non-verdict or a failed request is `loop.verify-failed`. A Loop body that starts with an HTTP stage is retried with the Loop's input.
  - `@nylorun/agents`: `http()` builds HTTP verifiers too.
  - `@nylorun/runtime`: a flow's HTTP stages and verifiers are executed like an agent's HTTP tool: address policy, the flow session's vault credential, `Nylorun-Session-Id`/`-Turn-Id`/`-Agent-Id` (the flow agent's id) and the flow effect id as `Idempotency-Key`, run once at the gates service (`POST /nylorun/v1/http-calls` takes `tool: { sessionId?, stage }`) and `uncertain` when the answer is lost. An HTTP verifier's verdict is recorded as `loop.verified`.
  - `@nylorun/studio`: the workflow tree shows HTTP stages and HTTP verifiers with their method and URL.

### Patch Changes

- 107b07d: **Skills are files the Runtime holds and serves itself (track R2 M4).** Breaking: a skill's manifest names every file of its folder, and the skill tools no longer run in the developer's process. The protocol stays at 8 until the track ships.

  - `@nylorun/core`: `SkillManifest` gains `files`, each path of the skill's folder (`SKILL.md` required, `/`-separated, no `..`, at most 500 files) mapped to `sha256:<hex>`, so the manifest hash pins them. `skillRecords` and `SkillRecord` are gone; a declaration's `skillFiles` holds the bytes to upload (`SkillFileSource`). `load_skill` and `read_skill_resource` keep their names and input schemas but fail with `skills.runtime-only` outside a Runtime. New `DefinitionFileViewSchema`, error code `definition_files_missing`, Harness API request `definition.file`, and `definitionFilesOf`, `isSkillTool` and the definition-file limits. A top-level `functions` key is reserved and refused ("Functions are not available yet").
  - `@nylorun/runtime`: `PUT /v1/files/sha256:<hex>` stores a definition file (application key; at most 10 MiB; a body of another hash is `400`; `201` stored, `200` held already) in the Object store at `definitions/sha256/<hex>`, and `HEAD` says whether the Tenant holds one. New tables `definition_files` and `definition_file_uses` (migration `0013_definition_files`). `PUT /v1/agents/{id}` refuses a definition, nested agents and flow agents included, that names a file the Tenant lacks (`400 definition_files_missing`). Core serves `load_skill` (the `SKILL.md` body, the other files' paths, and `sandboxPath` with a sandbox) and `read_skill_resource` (text files only) from those files, with no Action. A session's sandbox gets each skill's files read-only under `/skills/<name>/` before the first call that opens it, and the sandbox's instructions name them; pod sandboxes mount an `emptyDir` at `/skills`. Unused files are not deleted yet.
  - `@nylorun/agents`: `.skills()`, `skills()` and `.plugin()` read every file of a skill's folder, binary included (not `.git/`, `node_modules/`, OS files or `.env` files), and hash it; a file over 10 MiB or more than 500 files fail the build. `saveAgent` uploads the files the Runtime lacks before the definition; `client.files` (`has`, `upload`, `ensure`) does it by hand.
  - `@nylorun/harness`: tests only.
  - `@nylorun/studio`: the agent's manifest lists each skill's files.

- Pin core to the tested release.
- Updated dependencies [4bd2a0b]
- Updated dependencies [a64aaca]
- Updated dependencies [40b7648]
- Updated dependencies [713e676]
- Updated dependencies [c135267]
- Updated dependencies [d36f0d9]
- Updated dependencies [107b07d]
  - @nylorun/core@0.15.0-beta

## 0.22.2-beta

### Patch Changes

- b387620: **A flow agent's tool step that asks now pauses the flow.** A tool step calling `ctx.approve(...)` or `ctx.ask(...)` used to settle its `interaction-required` outcome as the step's output, so the flow moved on and `turn.completed` carried that object, resume token and all. Now the flow session pauses with `turn.paused` and a wait (with the tool node's `path` and `toolName`); `session.approve(...)` or `session.respond(...)` on the flow's own session runs the tool again with the answer and its resume token, and the steps before it replay from the journal. A rejected approval settles the step `denied` without running the tool again, as in an agent's turn, so the turn fails with `tool.denied`. A flow's resume stays in its checkpoint segment (`FlowCheckpoint.resumes`), so its wake is keyed by the interaction. Waits a workflow copied from its linked sessions are no longer read back as its own.
- Pin core to the tested release.
- Updated dependencies [3b3bdc6]
- Updated dependencies [6576e12]
- Updated dependencies [b28bdd7]
- Updated dependencies [cc107b1]
- Updated dependencies [7f763c3]
- Updated dependencies [98b0d37]
- Updated dependencies [c66d8ed]
  - @nylorun/core@0.14.0-beta

## 0.22.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [8773586]
- Updated dependencies [e1bfb4b]
- Updated dependencies [5cfaed9]
- Updated dependencies [bd478ee]
- Updated dependencies [c0b604e]
  - @nylorun/core@0.13.0-beta

## 0.22.0-beta

### Minor Changes

- b6bf1f5: **Harness API v1, in process (F6.1).** Every segment now runs in a harness: the advance takes the session's lease and offers the segment as a run, and the Tenant's own harness, in the same process, runs the engine and reports how it ended. Core settles it exactly as before. Nothing changes on the wire: protocol 5, durable checkpoint 1, engine `hosted-3` and the Action endpoint wire are the same.

  - `@nylorun/core/harness-api`: the protocol (messages, Zod schemas, the effect request hash, transcript edits, an RPC channel with an in-process memory transport).
  - `@nylorun/harness/api`: `createHarness({ channel, executors })`, a harness that leases runs, renews their leases, replays a run's recorded outcomes without asking, keeps transcripts by record cursor, and runs model, MCP and sandbox calls through the executors it is given.
  - `@nylorun/runtime`: the Harness API server per Tenant (`TenantHandle.attachHarness`), the in-process harness, and the journal as the Record seam. A model call's journal row now stores the request's hash without its prompt, so a replay never sends a prompt twice. `NYLORUN_HARNESS_API=0` runs the engine in the advance as before, until F6.2 removes it. A Runtime older than this one may fail a turn that was in flight across a downgrade with drift.

- 8ed4ea6: **Harness service over WebSocket, with the workspace capability (F6.2).** A Runtime started with `NYLORUN_HARNESS=remote` runs no harness of its own: it opens the Harness API listener (`NYLORUN_HARNESS_LISTEN_HOST`/`_PORT`, default port 4200, `NYLORUN_HARNESS_ALLOWED_HOSTS`), which accepts only the harness credential (`NYLORUN_HARNESS_TOKEN`) on `/nylorun/harness/v1`. The runtime image's `--service harness` connects to it (`NYLORUN_HARNESS_URL`, `NYLORUN_HARNESS_TOKEN`, `NYLORUN_GATES_URL`, `NYLORUN_HARNESS_ROOT`) and runs the Tenant's segments, MCP servers and sandboxes with no store; it refuses to start with a database, the gates' or keys' credential, or Restate settings, and presents only run tokens at the gates. The in-process harness stays the default.

  - `@nylorun/core/harness-api`: the `workspace.*` requests core sends to a harness that serves workspaces, `tenantId` in the `hello` answer, a workspace record on `sandbox.state` claims, and `TurnStart.options.holdMs`. Tenant and admin status report the Tenant's harnesses (`harness`).
  - `@nylorun/harness/api`: `createHarness` declares capabilities, reports grants (`onGrant`) and the `hello` answer, readies MCP through `executors.prepare` (`session.mcp`), and holds a run while its Action is pending until core sends the outcome (`effect.resolved`).
  - `@nylorun/runtime`: the WebSocket listener and client, `--service harness`, the workspace capability (`ctx.sandbox` is a `WorkspacePort`; sandbox tool routes, `save_artifact`, sweep and reset reach the harness's workspaces), the SandboxManager's records port, and held runs (`actionHoldMs`, default 5 minutes). `save_artifact` runs in core. `NYLORUN_HARNESS_API` and the engine run in the advance are removed; tests run with `NYLORUN_TEST_HARNESS=memory|json|ws`.

### Patch Changes

- 167d01a: **A run core stops while it asks about a pending Action is no longer held.** When core cancelled a run, or stopped it for a shutdown, while the harness waited for core's answer to an Action's `effect.intent`, the harness then held the run for the whole `holdMs` (5 minutes by default): it listened for an abort that had already happened. The run kept its lease, and closing the Tenant waited for it. The harness now gives such a run back at once.
- Pin core to the tested release.
- Updated dependencies [b352feb]
- Updated dependencies [6077272]
- Updated dependencies [b6bf1f5]
- Updated dependencies [8ed4ea6]
- Updated dependencies [678e085]
- Updated dependencies [926711b]
  - @nylorun/core@0.12.0-beta

## 0.21.2-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [4b9906f]
  - @nylorun/core@0.11.0-beta

## 0.21.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [fed780d]
- Updated dependencies [fed780d]
- Updated dependencies [7f4c3f1]
- Updated dependencies [5ca1923]
- Updated dependencies [5ca1923]
  - @nylorun/core@0.10.0-beta

## 0.21.0-beta

### Minor Changes

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

- 6ab4c59: **Long turns roll over.** A turn no longer fails when it runs past the 50-minute advance deadline.

  - **How it works.** At a step boundary with no open work, a long turn ends its segment and continues in the next one: same turn, a new checkpoint, woken at once. By default this happens after 50 steps or 20 minutes in a segment; `TenantConfig.rollover` changes both.
  - **What clients see.** A rolled-over turn emits no `turn.*` event, and clients still see one turn.
  - **Storage.** Each finished segment's model effects are slimmed.
  - **Harness.** `runDurable` takes `yieldAfter: { steps, ms }` and can return `yielded`, and `RunResult` adds `yielded`. The durable host writes the next checkpoint at `segment + 1` with `{ kind: "continue" }`. Agents used as tools never roll over.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [c7614a4]
- Updated dependencies [679c488]
- Updated dependencies [c85cd9e]
- Updated dependencies [4282d5f]
- Updated dependencies [82d95ef]
- Updated dependencies [f48f12f]
- Updated dependencies [50d0fb5]
- Updated dependencies [50d0fb5]
- Updated dependencies [c121144]
- Updated dependencies [6ab4c59]
- Updated dependencies [6ab4c59]
- Updated dependencies [2ab8ed1]
- Updated dependencies [c121144]
- Updated dependencies [9546ac7]
- Updated dependencies [9546ac7]
- Updated dependencies [9d52189]
- Updated dependencies [50d0fb5]
- Updated dependencies [18468d9]
  - @nylorun/core@0.9.0-beta

## 0.20.0-beta

### Minor Changes

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

- Pin core to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies [8cda500]
  - @nylorun/core@0.8.0-beta

## 0.19.2-beta

### Patch Changes

- a322696: **The session log now carries what a chat UI shows** (optional Host feature `transcript-events`).

  - `message.assistant` for each completed model step: `{ invocationId, text, toolCalls: [{ callId, name, input }], agent? }`.
  - `tool.completed` for an MCP or sandbox tool: `{ invocationId, callId, capabilityId, toolName, output }`, or `error: { code, message }` for a tool error.
  - Tool `action.pending` and `action.completed` events, and `delegation.started` / `delegation.completed`, carry the model's `callId` (and `invocationId` on actions).
  - Events are written in the transaction that completes the effect, so a replay writes none.
  - `@nylorun/core/contracts` adds payload schemas and `parseTranscriptEvent(event)`; `LiveEvent.payload` stays `unknown`.

  Fix: a tool with both `approval` and an `output` schema now pauses for approval. The Runtime validated its `interaction-required` result against the output schema and failed the tool with `tool.invalid-output`; `denied`, `interaction-required` and `deferred` results are no longer validated.

- Pin core to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies [a322696]
  - @nylorun/core@0.7.0-beta

## 0.19.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [bf1c2da]
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
  - @nylorun/core@0.6.0-beta

## 0.19.0-beta

### Minor Changes

- fd9fd87: Add workflows: compose agents and `tool()` with `Chain`, `Switch`, `Parallel`, `Map`, and `Loop`. A workflow is a registered runnable (`kind: "workflow"`) with the same session API as an agent — `export const agents`, `saveAgent` (saves referenced agents first), `createSession`, `input` (`content` or `data`), `observe({ follow })`, `pending`, `approve`, `cancel`. Slots (`{ run, id?, input? }`) reshape data between nodes. The flow engine (`runFlowDurable`) returns effects only; `harness/src/loop/` and `runDurable` are unchanged.

  HostEffect gains flow kinds `agent`, `tool` (node), `fn`, and `verify`, each with `path`, `key`, and `iterations`. The Runtime drives agent nodes through the public session contract (linked sessions, shared sandbox via `PutSession.sandbox`), offers `fn` / `verify` again on lease expiry, and routes executor Actions by `(workflowId, key)` with claim-scoped `ctx.sandbox`. Optional `message.manifest` is a turn-only variant of the session pin (turn manifests). Studio shows the manifest tree, live node status, and session links. Examples under `examples/agents/{chain,switch,parallel,map,loop,ship-feature}/`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
  - @nylorun/core@0.5.0-beta

## 0.18.0-beta

### Minor Changes

- 1cd7dc7: Add subagents: put an agent in another agent's `tools` (`Agent({ tools: [lookupOrder, researcher] })` or `.use({ tools: [researcher] })`) and the model can delegate to it. The tool is named after the agent's id, takes `{ task: string }`, and its description is the agent's `description`, which is now required for an agent used as a tool. The engine runs the child inside the parent's turn as a durable branch: fresh context, its own tools and hooks served by the root agent's executor, its own MCP servers, the session's sandbox, and only its final output (or `outputSchema` result) returned. Empty output, failures (with partial output marked as evidence), and requests for input or approval inside a child reach the parent as failed tool results. Parallel delegation calls run concurrently, completed child work is never re-run on replay, and cancelling the session cancels every child.

  v1 is one level deep and non-interactive. Nested delegation, child tools that declare `approval`, and differing sandboxes across the tree fail the build with a named diagnostic. The manifest adds an optional `agent` body on a tool (schema version unchanged), actions and effects carry `agent: { id, path, delegationId }`, tool context gains `ctx.agent`, the durable host resolves a new `delegation` effect kind, and the Runtime emits `delegation.started` / `delegation.completed` events and filters history with `?agent=` (`session.history({ agent })`). Studio shows delegations, labels child actions with their agent, and filters events by agent.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [1cd7dc7]
  - @nylorun/core@0.4.0-beta

## 0.17.0-beta

### Minor Changes

- b8d822a: Breaking beta: replace `beforeModelCall` / `afterModelCall` with scoped hooks. Register `before("turn" | "step", fn)` and `after("step" | "turn", fn)` on the agent, or `before: { turn, step }` / `after: { step, turn }` on a capability. `before("turn")` runs once per turn and its `Patch` applies to every model call in the turn; the new `after("turn")` returns a `TurnDecision` for the final answer. `after` hooks take one argument and receive `attempt`, and `retry` now retries instead of failing the run. The manifest moves to `manifestSchemaVersion: 4` with `capabilities[].hooks`, and `BeforeModelCallFn`, `AfterModelCallFn` and the `beforeModelCall` / `afterModelCall` action kinds are removed. Every capability registered at a hook point now runs in one `hook` executor action, an expired hook claim is offered again instead of becoming uncertain, and the durable engine version is `hosted-2`. Hook toggles now hide a capability's tools, or one tool of a multi-tool capability, instead of having no effect or failing. Studio lists each capability's hooks with how often they run and labels hook actions. See MIGRATION.md.

### Patch Changes

- b8d822a: Studio Model Settings lists multiple vault-stored providers, adds credentials through a sheet, and switches the active provider/model via Runtime host vault APIs.
- Pin core to the tested release.
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
  - @nylorun/core@0.3.0-beta

## 0.16.0-beta

### Minor Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [3a88f51]
  - @nylorun/core@0.2.0-beta

## 0.15.0-beta

### Major Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.

### Minor Changes

- 41e613c: Ship the local SDK registry workflow with an independent SQLite Runtime, connected tool executor, authenticated Studio proxy, and a text-and-tool starter. Replace the legacy Hono starter and AG-UI transport. Require Node 24 and include the SDK in exact release compatibility pins.

  Break the Harness execution import from `/engine` to `/run` and rename hosted execution APIs to durable execution APIs, including RunBinding, BoundRunOptions, and createRunState. Update all consumers without compatibility aliases; retain persisted checkpoint fields and version pins.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [2898d02]
  - @nylorun/core@0.1.1-beta

## Unreleased

### Minor Changes

- Breaking beta: replace `/engine` with `/run`; rename hosted execution to durable execution.
  Use `runDurable`, `createDurableCheckpoint`, `DurableCheckpoint`, `DurableResult`,
  `DurableHost`, `RunBinding`, `BoundRunOptions`, and `createRunState`. No aliases remain.
  Persisted checkpoint fields and the `hosted-1` compatibility pin are unchanged.

- Breaking beta: the package root is now an alias of `/define`. Import
  `createExecutionState` / `validateExecutionState` from `@nylorun/harness/run` and
  `preparedModel` from `@nylorun/harness/model/adapters`. Authoring and wire-contract specifiers remain unchanged.
- Internal source folder `execution/` is now `loop/` (one `run()` invocation). The
  `/model/adapters` specifier is unchanged.
- DX v5.6: Agent usable without `.build()`; `.use()` returns a new agent; top-level `tools` /
  `instructions` (no `model` on `Agent({})`). `tool()` accepts `input` / `output` / `run`; plain
  returns complete; export `ToolError`; tool `approval` / `effects`; `ctx.idempotencyKey`,
  `redelivery`, `state`, `session`, `progress`, and durable waits (`ask` / `approve` / `sleep` /
  `waitFor` / `step`).
- Agent-as-JSON: versioned manifest (`schemaVersion: 2`), `toJSON` / `Agent.from`, `hashManifest`,
  `checkCompatibility`; identity by manifest hash (not WeakMap-only). Session memory on
  `ExecutionState.state`. Capability `model` is no longer projected into the published manifest.
- Dynamics: `beforeModelCall` / `afterModelCall` with `Patch` / `Decision`; middleware deprecated
  but kept through 1.0. Export `@nylorun/harness/run` for run-from-checkpoint; `agent.run` is a
  1.0 alias. Export type-only `Session` / `Turn` / `Event` / `Result`.

## 0.13.0-beta

### Minor Changes

- Breaking beta: replace `AgentManifest.middleware` with a capability catalog. The published
  snapshot is `id`, `name`, optional `outputSchema`, and `capabilities` (`kind`,
  `hasMiddleware`, declared instructions / tool JSON schemas / model controls). Join traces by
  capability id. `MiddlewareManifest` is removed; import `CapabilityManifest`.
- Breaking beta: expose `BuiltAgent` as a type-only facade from `Agent(...).use(...).build()`.
  Hide compiled middleware, tool registries, and output validators. `AgentBuilder` accepts public
  agent options. `createExecutionState` requires the original built agent. Drop agent-level
  `executionVersion`; `ExecutionState.version` stays `1` and leftover keys are ignored. Model
  adapters receive immutable `ToolDescriptor` metadata only. Remove `defineToolFamily` /
  `ToolFamily` / `capability.toolFamilies` and the internal Bound\* / `SealedToolCall` root
  exports. Rename the per-run bag from `scope` to `info`.
- c5bbb1a: Breaking beta: make Harness `run()` a direct async state-in/state-out executor with
  serializable pauses, application `info`, cancellation signals, awaited recording, and
  agent-level output schemas. Runtime owns session scheduling with memory-default or exclusive
  local storage and imports Harness contracts. Isolate Node adapters under `runtime/node`, stream
  observations incrementally, and add opt-in bounded token previews with Studio reconciliation.
  Migrate consumers and deployment guidance together; legacy event records remain archived, not
  automatically replayed.

## 0.12.0-beta

### Minor Changes

- 4badb5b: Move model execution to session startup, provide Runtime as a mountable Hono router, and generate Hono-first projects with supervised application and Studio development. Studio now resolves root-relative Runtime endpoints correctly for custom mount paths.

## 0.11.1-beta

### Patch Changes

- d27242c: Preserve opaque provider continuation metadata through assistant conversation history. Gemini tool calls now retain thought signatures when sending tool results back to the model, including signed empty text and reasoning blocks. Only the originating provider and model receive their signatures.

## 0.11.0-beta

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

All notable changes to `@nylorun/harness` are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Before 1.0, the public API is experimental: breaking changes may occur in minor releases, while patch releases are reserved for compatible fixes.

## Unreleased

## [0.10.0-beta.1] - 2026-09-03

### Added

- Portable ordered media input parts with opaque JSON references preserved through sessions,
  transcripts, middleware, model calls, and observations.
- `preparedModel()` for adapters that need to materialize a provider request while exposing the
  JSON-safe derived call through the new `model.prepared` observation.
- Direct `inputSchema` and optional `outputSchema` tool contracts. Harness accepts Zod v4,
  synchronous Standard Schema values with JSON Schema conversion, and explicit validator-backed
  `defineSchema()` contracts.
- Structured input and output validation diagnostics on failed tool results.
- Per-turn `session.input({ ... }, { outputSchema })` contracts for locally validated terminal JSON
  results, including canonical model-call projection, JSON candidates, immutable final persistence,
  and `output.invalid` tripwires.

### Changed

- Bundled provider translators map direct URL image references and fail unsupported media with the
  stable `model.unsupported-content` error rather than dropping or stringifying it.
- Chat Completions and Responses translators project terminal output schemas without choosing
  provider strictness; Anthropic Messages reports `model.unsupported-output-schema` until an
  application supplies a custom prepared adapter.
- Tool definitions use `inputSchema` instead of `parameters`. Completed output is validated when an
  `outputSchema` is supplied; the resulting JSON is the same value recorded, observed, and sent to
  the model. Model configuration and `model.requested` observations expose optional output schemas.

### Breaking changes

- Replace every tool `parameters` field with `inputSchema`. `outputSchema` is now an optional tool
  contract and completed tool output may be any JSON value, not only a string.
- Terminal results, final events, and stream projections may now be JSON values. Consumers that
  assumed string output must render or serialize `JsonValue` safely.
- Custom model adapters receive the `reportPreparedCall` context method. Adapters that materialize
  provider requests should use it (or `preparedModel()`) to emit one JSON-safe derived request.

## [0.9.0-beta.1] - 2026-09-02

### Added

- Public provider translator helpers under `@nylorun/harness/model/adapters` for OpenAI-compatible
  Chat Completions, OpenAI Responses, and Anthropic Messages model loops.
- `MiddlewareManifest` and declared middleware contributions in `AgentManifest`, including static
  instructions, tool metadata, and model controls for host tooling such as Studio.

## [0.8.0-beta.1] - 2026-08-31

### Breaking changes

- `Agent()` now takes identity options instead of a model adapter. Migrate
  `Agent(adapter).use(...).build()` to
  `Agent({ id, name, instructions }).use(...).with(adapter).build()`.
- `.build()` exists only on `BoundAgentBuilder`, the type returned by a single `.with(onModelCall)`.
  `AgentBuilder` has `.use()` and `.with()` only.
- `AgentManifest` now includes `id` and `name`. Built agents expose the same fields as `agent.id`
  and `agent.name`.

### Added

- Optional constructor `instructions` compile as reserved `agent` middleware. A string is
  normalized to one instruction. Capability-specific instructions still go through `.use()`.

## [0.7.0-beta.1] - 2026-08-30

### Breaking changes

- Removed the bind-time directive argument: migrate `Agent(adapter, directive)` to
  `Agent(adapter).use({ id: "model", model: directive })`. `AgentManifest.model` is removed.
- Added `CapabilityDeclaration` support to `.use()`. A declaration owns one capability id, static
  tool/instruction/model contributions, and optional inline middleware.
- `ToolExecutionContext` now includes session, turn, step, and call identities.

### Added

- Declarations may own typed lazy session state through `CapabilityState`. State is shared only by
  that declaration's middleware and tools, is cold after seed recovery, and is disposed on
  `session.stop()` or recording failure.
- Added `capability.state.dispose.failed` observations for best-effort disposal failures.
- Added `capability.state.undeclared`, raised when session state is requested for a capability that
  declared none.

### Documentation

- Added concise package guidance for direct agent composition and the capability/service/host/core model.

## [0.6.0-beta.1] - 2026-08-29

### Breaking changes since 0.5.0-beta.1

- Removed tool adapters, `.with()`, `executeWith`, preflight, adapter concurrency controls, custom scheduling, adapter manifest fields, and adapter observations/errors.
- Tools now own their implementation through `execute(args, context)`. Harness centrally executes eligible siblings concurrently and commits normalized results in model-call order.
- Tool results are explicit `completed`, `denied`, and `failed` discriminated unions. Tool and model implementations may return `deferred` for a runtime handoff.

### Added

- Structural `SessionSeed` import through `agent.run({ seed })` and no-input `session.continue()`. Core validates typed JSON but deliberately leaves historical semantics and provider protocol validation to the host and model adapter.
- Optional awaited `SessionRecorder`, immutable full-state `SessionRecord` values, monotonic revisions, and effect barriers around input, model requests, candidates, tool results, waiting, final, and stop transitions.
- JSON-safe active model/tool/interaction records with stable invocation identities, tool ownership provenance, settled/deferred state, and opaque handoff tokens.
- `model.deferred`, `tool.started`, `tool.completed`, `tool.deferred`, `session.seeded`, `session.continued`, and `session.record.failed` observations.

### Reliability

- Recorder failure now fences later model/tool effects, quarantines late results, stops queued work, preserves the last successfully recorded revision, and exposes `session.record-failed` with the storage error as its cause.
- Deferred sibling batches settle fully without committing a partial model-facing `tool-results` entry.

## [0.5.0-beta.1] - 2026-08-28

### Breaking changes since 0.4.0-rc.1

- Replaced persistent `prefix` configuration with per-step `configuration`. Instructions, tools, model selection, and runtime context are assembled afresh for every model call; slot removal, context lifetimes, strict prefix policy, and Harness-owned drift auditing were removed. Middleware receives `turnId` and `stepId` to coordinate application-owned state.
- `model.prefix` and `model.started` were replaced by `model.requested`, emitted immediately before adapter invocation with the exact immutable `ModelCall` and JSON-safe attributed configuration/context snapshots.
- `tool()` now validates and normalizes its synchronous Zod object schema eagerly; raw tool literals retain first-bind preparation.

- Model adapters now receive the projected `ModelCall` as their first argument and `{ request, signal }` as their second. Implementations that consumed the prior request-shaped input must migrate to the projection and use `request` for the structured escape hatch.
- `InputHandle.consume()` and `AgentRunInput` were removed. Submit messages and interaction replies through the Session input API and await the returned completion handle instead.
- `session.observe()` now returns an idempotent unsubscribe function rather than the previous observer result. Observers remain live-only and do not replay history.
- Tool adapters and the tool facade removed the prior route-validation and route metadata methods. Tool definitions use `parameters` and `executeWith`; dispatch validation happens at the sealed Harness boundary.
- Harness-owned failures now use `HarnessError` with stable machine-readable codes. The prior outcome-code model has been replaced; see the migration table in the README for renamed and split codes. Foreign application, model, and adapter errors remain available as causes.

### Added

- `ModelCall` projection, including canonical system text, transcript messages, provider tool contracts, model directive, and session id.
- Explicit abort propagation through the Model adapter context.
- Stable structured Harness errors via `HarnessError`, `HarnessErrorCode`, and `isHarnessError`.
- Parallel sibling tool execution by default, with an optional shared per-adapter `maxConcurrentCalls` limit on `.with(adapter, options)`.

### Fixed

- Observe attributes are materialized only when a listener is registered. Transcript snapshots on `step.started` share the already-frozen step transcript rather than deep-copying it on every step.

[0.5.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.6.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.7.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.8.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.9.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
