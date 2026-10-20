# Changelog

## 0.29.3-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [9ba6634]
- Updated dependencies [aaa079f]
  - @nylorun/core@0.27.0-beta

## 0.29.2-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [fce0c9b]
- Updated dependencies [ab7c08a]
- Updated dependencies [4a563e7]
  - @nylorun/core@0.26.0-beta

## 0.29.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [ed08ba8]
- Updated dependencies [ed08ba8]
- Updated dependencies [ed08ba8]
- Updated dependencies [eeb6294]
- Updated dependencies [ed08ba8]
  - @nylorun/core@0.25.0-beta

## 0.29.0-beta

### Minor Changes

- 22c61ce: Protocol 16, Agents from one manifest (track T2), a fresh start. An agent manifest (v8) is one versioned document at `/v1/agent-manifests/{name}` with a `harness` section (what runs inside the loop, including the harness's id) and a `runtime` section (what an environment manifest said). The Runtime checks the two against each other when it is saved (`422 manifest_inconsistent` with `details.gaps`), in place of `requires` at session open. Agent definitions and environment manifests are gone.

  Environments are Agents: `/v1/agents/{id}` and its sub-routes, made from a saved manifest only (`manifest: "name"` tracks it, `"name@n"` pins a version; either resolves once, into `resolvedVersion`), with a derived `state` (`working`, `sleeping`, `input_required`, `failing`, `paused`) and `attention`. Every session runs on one Agent (`PUT /v1/sessions/{id} { agent, ownerUserId }`) and pins its manifest version. No session is special (D71). Error codes, events (`agent.*`), scopes (`agents:write`, `agent-manifests:write`) and identity-file grants (`agents`) say Agent; model budget scope `agent` is `manifest`. Harness API 5: `turn.start.agent` replaces `turn.start.environment`, with `definition` and `loop`. Migration 0032 closes older sessions (`protocol_16`) and drops Environments with their disks and vaults.

  The SDK has `client.agentManifests`, `client.agents` and `composeManifest(dir)` for three-file authoring; the CLI has `nylorun apply`, `nylorun agent-manifests`, `nylorun agents` and `nylorun migrate v8`; Studio has an Agents screen, an Agent page and an Agent manifests screen. See MIGRATION.md.

- bf942ed: Our engine offers the `memory` tool (track T5, D72). An agent whose version sets `harness.memory` gets one `memory` tool with Anthropic's memory tool schema (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`; `view` only for a `read_only` agent and an agent used as a tool), our memory rules followed by the agent's `instructions`, and its memory index pinned after the instructions as user-role context: kept for the session so the prompt prefix stays cacheable (`ExecutionState.pinned`), and re-pinned after a compaction. Each command's parameters are checked before a call is sent (`checkMemoryCall` in `@nylorun/core/contracts`, which the Runtime also uses), and a call named `memory.<command>` or `memory/<command>` runs as `memory` with that command (`memoryAliasOf`). `ModelRequest.pinned` carries the pinned text; `memoryTool` and `memoryIndexBlock` are exported for your own harness.
- ffeb3bb: `schedule_wake` (track T4, D77). An agent manifest's `runtime.selfWake: true` offers the agent `schedule_wake`: `{in | at, note}` books its session's next turn, replacing the booking before, and `{cancel: true}` removes it. The Runtime serves the call in its own transaction (a new effect target, `{kind: "runtime", operation: "schedule_wake"}`, additive on Harness API 5; `turn.start.agent.selfWake` tells a harness to offer it), so a replayed turn books once. The booking fires as a trigger run of kind `wake`, its note the turn's message with `cause.kind: "self"`. New session events `wake.booked` and `wake.cancelled`, tool call kind `runtime`, and Runtime limits `wakeMaxAheadMs` and `wakeNoteChars`.
- 9e60e40: Protocol 17, a queue per session (track T4, D76). A message sent while the session's turn runs or waits is queued (`{status: "queued", queuedMessageId, position}`, `message.queued`) and starts the next turn when this one ends, with every queued message, each its own user message (`queue.taken`); a cancel ends the turn, not the queue. `delivery: "reject"` keeps the refusal, now `409 session_busy`, and a protocol 16 client's messages default to it, so the Host serves protocol 16 and 17. The queue holds at most the Runtime limit `sessionQueuedMessages` (`429 queue_full`), and session reads count `queuedMessages`. Our engine takes `{kind: "messages", messages}` as a turn's input. The SDK's `input` and `inputParts` take `delivery`, and the CLI's `sessions send` takes `--reject-if-busy`. See MIGRATION.md.

### Patch Changes

- 3a575d7: Track T3, versions per turn: a turn's first segment takes the manifest version its session's Agent runs then, so a session moves with its Agent between turns and keeps one version through every segment, approval and rollover of a turn. A turn whose message named a variant, and a flow's sessions, keep the version they pinned; a changed loop manifest drops the session's MCP snapshot. The turn span names the version (`nylorun.manifest.version`). Our engine takes a new version's output schema at the next turn.
- Pin core to the tested release.
- Updated dependencies [218b078]
- Updated dependencies [22c61ce]
- Updated dependencies [1ded443]
- Updated dependencies [76dcd11]
- Updated dependencies [bf942ed]
- Updated dependencies [4fa160d]
- Updated dependencies [9fed948]
- Updated dependencies [ffeb3bb]
- Updated dependencies [9e60e40]
- Updated dependencies [f85483d]
- Updated dependencies [ae54de7]
  - @nylorun/core@0.24.0-beta

## 0.28.0-beta

### Minor Changes

- 0a2fbc5: **Artifacts reach the harness through the Harness API; `read_artifact` and `save_artifact` run in the harness (protocol 15, Harness API 4).** The first step of the harness boundary: model-facing work belongs to the harness, and the Runtime offers primitives and holds limits and access. A fresh start for agent sessions: the Runtime speaks protocol 15 only. See MIGRATION.md.

  - **The artifact seam.** A harness reads and writes the artifacts of the run it holds: `artifact.read {artifactId, version?, offset?, length?}` answers the version's metadata (`ArtifactMetaSchema`) and its bytes from `offset`, at most `turn.start.limits.chunkBytes`; `artifact.write` (`begin`, `chunk`, `commit`, `abort`) makes a file artifact of the session or a new version of one of its own, streamed with backpressure into the Object store and committed in Postgres within the Tenant's and the Environment's artifact limits. The scope is always the run's session: its own artifacts, and the Tenant-wide ones its messages named; anything else is the new error code `not_found`, alike. A write's `key` makes it idempotent within the session (`artifact_versions.write_key`, migration 0028), and its `effectId` links the artifact to a tool call of the turn, whose call id `artifact.created` carries. An upload the run leaves open commits nothing. Client helpers: `readArtifact`, `openArtifactWrite`, `writeArtifactBytes`, `toBase64` and `fromBase64` in `@nylorun/core/harness-api`.
  - **Our harness runs the artifact tools.** `read_artifact` (every agent) and `save_artifact` (with a sandbox) are our engine's tools, defined in `@nylorun/harness` (`artifactToolsFor`, `runArtifactTool`) and run over the seam and the run's sandbox files (`HarnessExecutors.files`, `SandboxManager.writeBytes`); their calls are kind `harness`. `save_artifact` keys its write by its effect id. `read_artifact` takes `path` with a sandbox, which copies the whole artifact into it, and hands a file of any other type to the model as a file of the result (the Model Gate writes the note for one the model does not read; `artifact.unsupported` is gone). Its page is harness configuration, `createHarness({ artifactPageBytes })` (32 KiB by default), and now always ends on a whole character. `runDurable` takes `engineTools`; `apiHost` takes the engine's configuration.
  - **The Runtime pins no artifact tools.** `runtimeManifestFor` has no `save` or `read`; `RUNTIME_TOOL_NAMES` no longer holds the two names, so an author tool may take one (our harness then refuses the turn). A session without a sandbox or skills pins its definition unchanged. Core no longer runs either tool (`tenant/artifact-tool.ts` is gone). Migration 0029 closes every agent session that pinned them (`closedReason: "protocol_15"`, `409 session_closed`); workflow sessions carry over.
  - **Media types are core's.** `contentTypeFor`, `essence`, `normalizeContentType`, `isText`, `isModelImage`, `modelInputOf`, `inputLabel`, `extensionFor`, `unreadableReason`, `MODEL_IMAGE_TYPES` and `DEFAULT_CONTENT_TYPE` are exported from `@nylorun/core/contracts`, for the Runtime and harnesses alike.
  - `PROTOCOL_VERSION` 15 with required feature `harness-boundary`; `HARNESS_API_VERSION` 4. The SDKs and the CLI send protocol 15.

- ebe7348: **The harness decides how files reach the model; the Model Gate only fetches and translates (protocol 15).** The second step of the harness boundary, still protocol 15 and Harness API 4. See MIGRATION.md.

  - **Any file may be sent.** A message naming a file the model does not read is accepted: `422 attachment_unsupported` and its error code are gone, and AG-UI and A2A accept such files too. Files are still held to the artifact size limits at upload.
  - **`turn.start.model`** is the model descriptor (`ModelDescriptorSchema`): the provider, id, inputs, context window and output limit of the model the turn's calls use, absent for flows and without a model. One resolution (`model/descriptor.ts`) serves it, the catalog's inputs and the gate.
  - **Our engine shows each file.** An image or document the model reads goes as its artifact reference, a text file is read over the artifact seam and inlined as a `<file>` block, and anything else (past `modelFileBytes`, a kind the model does not read) is a note it writes. `fileView`, `representFiles`, `fileBlock`, `fileNote` and `mediaReferenceLine` (moved from `@nylorun/core/define`) are exported from `@nylorun/harness`. A budget from the descriptor bounds the prompt before the first answer, and compaction counts files as the model gets them.
  - **The Model Gate refuses instead of writing notes.** A text file as a media part, or a kind the model or its API does not read, fails the call with the new model failure code `unsupported_input`; a reference it cannot fetch fails `invalid_request`. Nothing is sent, and neither is retried.
  - **Structured answers are the engine's.** `ModelCall.outputSchema` is removed: our engine writes the JSON instruction and parses the answer (fenced, with control characters repaired; `parseJsonWithRepair` ported from pi-ai). `message.assistant` for a structured answer now carries its JSON text.
  - **`read_artifact`** refuses a file the turn's model does not read (`artifact.unsupported`, with the reason).
  - `unreadableReason` is removed; `isOffice` joins the media type helpers in `@nylorun/core/contracts`.
  - Studio's file picker accepts every file, and the refusal chips are gone.

- ff6470e: **The harness writes the model's instructions and defines the sandbox and skill tools; no `runtime` block (protocol 15).** The third step of the harness boundary, still protocol 15 and Harness API 4. See MIGRATION.md.

  - **No `runtime` block.** The Runtime no longer pins model-facing text or tools on a session's manifest: a session pins its definition as registered (`manifestHash` equals `definitionHash`) and keeps its sandbox spec on the session. The manifest schema refuses `runtime` with what replaces it (`REMOVED_MANIFEST_FIELDS`). `runtimeManifestFor`, `runtimeToolOf`, `RuntimeManifest`, `RUNTIME_TOOL_NAMES`, `isRuntimeToolName`, `createSandboxTools`, `SANDBOX_INSTRUCTIONS`, the skill tool names, `isSkillTool`, `SKILLS_USAGE`, `formatSkillCatalog` and `skillOfToolCall` leave `@nylorun/core/define`; `RUNTIME_PART_ID` is `SESSION_PART_ID` (`"session"`), and `agentFrom` takes `sessionInstructions`. `@nylorun/agents` no longer re-exports the skill catalog helpers. Migration 0030 closes the agent sessions that still pinned a `runtime` block (`closedReason: "protocol_15"`).
  - **`turn.start` states facts.** `environment` (`TurnEnvironmentSchema`: `{id, kind, sandbox?: {workspace}}`) and `routing.sandbox.spec` (the pinned spec) join the agent's `skills`.
  - **Our engine words them.** `@nylorun/harness` writes the skill catalog, the sandbox note and the skills' folder note, and defines the six sandbox tools, `load_skill` and `read_skill_resource`, in the order and bytes the `runtime` block had, so the prompt's prefix is unchanged (`engineToolsFor`, `sandboxTools`, `sandboxInstructions`, `skillCatalogText`, `skillFolderNote`, `skillTools`, all exported for a harness of your own). The skill tools run in the harness over `definition.file` (`runSkillTool`), and core no longer runs them (`tenant/skill-tool.ts` is gone). The sandbox tools' limits are harness configuration (`createHarness({ sandboxTools })`, `harnessExecutors({ sandboxTools })`, `DEFAULT_SANDBOX_TOOL_LIMITS`), as is the most a skill read takes into the context (`createHarness({ skillReadBytes })`, 10 MiB by default), held to the run's `limits.recordEntryBytes`.
  - **Effects name their target.** A tool effect carries `target: {kind: "mcp" | "http" | "sandbox" | "harness" | "platform"}` (`EffectTargetSchema`) and may carry `skill`; the record routes by the kind, never by the tool's name, and a call without a target or one the session lacks is `tool.unavailable`. `hello.features.tools` and `NativeToolSchema` are removed, no tool name is reserved, and the record keeps the skill the intent names when the agent has it. A skill tool's `tool.completed` is `kind: "harness"` (it was `platform`).
  - **Studio** drops the manifest panel's Runtime section: it shows the sandbox tools when the session's Environment has a sandbox.

- f443475: **The harness builds the MCP tool list and shapes tool results; tools are identified by server and tool (protocol 15).** The fourth step of the harness boundary, still protocol 15 and Harness API 4. See MIGRATION.md.

  - **Tools have an identity.** An MCP tool call's target is `{kind: "mcp", server, tool}` (the server's own name for the tool) and an HTTP tool call's `{kind: "http", tool}` (its declared name); `platform` is gone. `toolName` is the model's name, for display. The record checks an MCP call against the session's discovery (`tool.unknown`) and the turn's tool settings (`tool.disabled`), and `tool.completed`, tool-call rows (`tool`), approvals (`Approve server / tool?`, `interaction.tool`) and traces (`nylorun.tool.identity`) carry the identity. The Tool Gate matches a call to its journaled target.
  - **Tool policy keys on identity.** A rule's `tool` is the tool's identity, never the model's name. A rule whose `tool` has `__` in it is refused at `PUT /v1/tenant/tool-policy`; a stored one makes the policy unreadable, so every call is denied (and `GET` answers `409`) until the policy names the tool by `server` and `tool`.
  - **`turn.start.mcp` states facts.** The session pins what its servers listed, raw (`McpSnapshot` v2: servers, scrubbed instructions, tools as named); each turn gets `mcp` (`McpFactsSchema`: every tool with `enabled` and the manifest's `deferred` hint) in place of `sessionTools` and `routing.mcpSnapshot`, and `session.mcp` answers `{mcp}`. `mcp.discovered` has no `renamed` or `deferred`. Migration 0031 closes the sessions that pinned the former snapshot (`closedReason: "protocol_15"`).
  - **Our engine names, defers and searches.** `@nylorun/harness` names MCP tools (`mcpToolName`, `mcpToolNames`, within the 64-character provider ceiling), defers them by the manifest's setting or the model's window and pins that layout in its state (`mcpToolSet`, `McpLayout`), and runs `tool_search` (BM25) itself; core's `tool_search`, `deferredToolsTools`, `TOOL_SEARCH_TOOL` and `TOOL_CALL_TOOL` leave `@nylorun/core/define`, and `runDurable` takes `mcp` instead of `sessionTools`.
  - **Our engine shapes tool results.** Core no longer stores large or binary tool results: the record refuses an outcome past `limits.recordEntryBytes` (`limit_exceeded`). Our engine spills them with `artifact.write`, keyed by the call and its bytes (`spillKey`), with a preview, an image as a file for a model that reads images, and one budget per step (`shapeToolOutcome`, `StepBudget`, exported for a harness of your own). The Tool Gate still scrubs credentials and refuses answers past `limits.toolAnswerBytes`.
  - **Harness configuration.** `createHarness({ mcpTools, toolResults })` sets the deferral share, characters per token, fallback window, the note's instruction length, `tool_search`'s limits, the inline cap, preview head and tail, step budget, stub, small size and entry envelope (`DEFAULT_MCP_TOOL_CONFIG`, `DEFAULT_TOOL_RESULT_CONFIG`).
  - **The MCP preview** names tools as Nylorun's engine would (`modelName`, `renamed`) and shows a server's instructions uncut.
  - **Studio** shows an MCP tool as `server / tool` in tool and approval cards, with the model's name, and links the artifacts a tool's result was stored in.
  - **`examples/harness-minimal`** spills a large `bash` output with `artifact.write` and keeps a preview; its README shows how a harness of your own offers MCP tools.

- cf425c6: **The harness mounts skills and saves outputs; the in-process harness uses the gates; compaction is a transcript edit (protocol 15).** The fifth step of the harness boundary, still protocol 15 and Harness API 4. See MIGRATION.md.

  - **Skill folders are our engine's.** Before each sandbox call our engine mounts each skill version of the turn's tree at `/skills/<name>@<hash>/` with `executors.files.mount`, reading the bytes over `definition.file`; the SandboxManager only writes them (`mountFolder`), once per open sandbox (`present` after). `SandboxManager.mountSkills`, its `definitionFile` port and `SandboxSessionRef.manifest` are gone, and the operator sandbox route mounts nothing.
  - **The outputs folder is our engine's (Q5).** At a completed turn's end in a sandbox our engine saves `/workspace/outputs` as the session's `outputs` folder before `turn.completed`, over the new folder mode of `artifact.write` (`kind: "folder"`, `file`, chunks named by hash, `unchanged`, `refused`). Core takes every byte, checks each file's hash before content is stored under it, dedupes, and keeps the content epoch and quotas. Versions say `source: "engine"`; `artifact.export.skipped` and `artifact.export.failed` are harness claims. Core's export (`artifacts/export.ts`, the `WorkspaceReader`, `workspace.read` listing and bytes calls) is removed.
  - **No limit literals.** The new Runtime limit `folderEntries` (10,000; a count, its ceiling from the manifest's one string) replaces `EXPORT_MAX_FILES`, and `createHarness({ outputs: { dir, maxBytes } })` (`/workspace/outputs`, 1 GiB) replaces `EXPORT_MAX_BYTES`. `RUNTIME_LIMIT_CEILINGS` entries are `{value, unit, why}`.
  - **In-process parity.** Every model call goes through the Model Gate: a scripted model is served by `providerModelGate`, metered like any. The MCP pool opens every server through the Tool Gate (`openRemote` is required; the in-process gate's `openMcp` finds the server in the session's pinned manifest and authorizes it with the vault). `ModelRoute` is `{tenantId, modelGate}`; `TenantContext.modelProvider`, `useVaultModel` and `workspaces` are gone.
  - **Compaction is a transcript edit (Q4).** Summary calls say `purpose: "summary"` (no `message.assistant`), and the segment's edit that replaced the history says `kind: "compaction"` with its facts and summary calls (`CompactionFactsSchema`, `transcriptUpdates(..., compaction)`). Core checks the calls and writes one `context.compacted`, which loses `partial`.

- dc75e58: **Host timings, retries and engine settings are configuration with defaults (B15).** Still protocol 15 and Harness API 4. See MIGRATION.md and DEPLOYMENT.md ("Host tuning").

  - **Host tuning.** The Runtime processes' timeouts, retries, poll intervals and internal sizes are one typed schema with a default each (`HostTuningSchema`, `runtime/server/src/tuning.ts`): keys, the Harness API, the API's streams, the Host, the Object store, the Tenant, its sweep, Durable Session Execution, Restate, Postgres, Durable Streams and the relay, the gates, egress-gate, sandbox pods, harnesses and traces. An operator sets any part in `NYLORUN_TUNING` (JSON), parsed with the stack configuration and read once at start; every default is the value before. An unknown key or a value past its ceiling (Node's longest timer, S3's part sizes, S2's batch, the sandboxes service's wait) stops the process naming the key. Core hands a sandbox pod's engine the `harness` and `engine` groups the operator set. `nylorun start` passes `NYLORUN_TUNING` to the runtime, gateway and harness containers.
  - **Our engine's loop is configuration.** `createHarness` takes `compaction` (`CompactionConfig`, `DEFAULT_COMPACTION_CONFIG`: the kept tail, the reply's reserve, the estimate), `partialOutputChars` (a failed agent-as-tool's output its parent sees), `resendDelaysMs` and `leaseRetryMs`; `runDurable` takes `loop` (`LoopConfig`), which an invocation hands its agents used as tools. `EngineToolConfig` is `EngineConfig`. The Runtime's harness host passes the tuning's `engine` group to `createHarness`.
  - **Kept as constants**, each justified where it is defined: Node's longest timer, S3's part sizes and object key, S2's batch, the sandboxes service's longest wait and pod variable, the `environment.egress` event's 16 running turns, W3C's 512-character `tracestate`, and the 24-hour floor of a wake's dedupe key.

- 23774c4: **The last hard-coded limits are configuration (harness boundary B15c).** Still protocol 15 and Harness API 4. Every default is the value before. See MIGRATION.md, and DEPLOYMENT.md's Runtime limits and Host tuning.

  - **21 more Runtime limits** (`GET`/`PUT /v1/tenant/limits`): a message's parts (`messageParts`), page sizes (`pageItems`, `exportPageItems`, `environmentEventItems`; a page asked larger holds that many), labels (`artifactLabels`, `labelKeyChars`, `labelValueChars`), a manifest's setup command, descriptions and secret hosts (`setupCommandChars`, `manifestDescriptionChars`, `secretDescriptionChars`, `secretHosts`), a failed pod's reason (`setupReasonChars`, `setupCommandExcerptChars`), secret values (`secretValueChars`), the tool policy and budgets (`toolRules`, `toolRuleFieldChars`, `toolRuleTextChars`, `modelBudgets`) and flows (`flowConcurrency`, `flowMapItems`, `flowLoopIterations`, replacing the `NYLORUN_FLOW_*` variables no Host read). Request schemas lose these maxima; the Runtime checks the Tenant's.
  - **More Host tuning** (`NYLORUN_TUNING`): token lifetimes and clock tolerance (`keys.*`), the advance deadline and grace (`execution.*`), `nylorun-operate`'s waits, the credential store's lock, sweep arming, Postgres batches and the replication pool, a basin repair's log cadence, egress sockets, the engine poll and sandbox memory floor, MCP listing pages and diagnostics, sandbox helper commands, the scrub threshold, exec event and local stream sizes; and in the engine, `flowValueChars` and `toolResults.minPreviewBytes`.
  - **The CLI's own waits are `NYLORUN_CLI_TUNING`**: `nylorun start`'s waits and polls, the Compose healthchecks and WAL cap, and `nylorun local sandbox`'s waits.
  - **Studio follows the Runtime's limits**: no upload cap of its own, the Tenant's `requestBodyBytes` read for a write it parses past the default (`@nylorun/agents` exports `RUNTIME_LIMIT_DEFAULTS`), no CPU cap in its form.
  - **Kept, each justified where it is defined**: Linux's `MAX_ARG_STRLEN` (a setup command's ceiling) and `PATH_MAX` (a link target), a model-facing tool name's 64 characters, RFC 6838's media type length, Postgres's 65,535 bind parameters, a tmpfs page, and identifier grammars (the protocol's).

- b1e815d: **Runtime limits are a Tenant setting, and harnesses get them in `turn.start.limits`.**

  - What one record entry, model call, model file, tool answer, custom harness state and Harness API chunk may hold is the new Management API setting `GET`/`PUT /v1/tenant/limits` (`{ limits: { recordEntryBytes, modelCallBytes, modelFileBytes, toolAnswerBytes, harnessStateBytes, chunkBytes } }`), also `admin.settings.limits` and `nylorun tenant settings limits [get | put <file|->]`.
    - The defaults are today's sizes (`RUNTIME_LIMIT_DEFAULTS`): 960 KiB, 32 MiB, 8 MiB, 8 MiB, 256 KiB and 16 MiB. A limit left out of a `PUT` takes its default.
    - Each limit has a ceiling a dependency sets (`RUNTIME_LIMIT_CEILINGS`): S2's 1 MiB record less 64 KiB for the event's envelope, the 64 MiB Harness API frame, the longest JavaScript string. A limit above its ceiling is `400`, naming the ceiling.
    - Each is read from the Tenant's database where it is checked; nothing keeps it.
  - **The record holds every write to `recordEntryBytes`.** An event whose payload, or an effect outcome whose value, is larger, whoever wrote it, is refused with `limit_exceeded`: `413` (`details.limit: "recordEntryBytes"`) to an API client, the new Harness API error code `limit_exceeded` to a harness. A harness's claimed event past it is refused rather than dropped. Before, such an event reached a record S2 could not take.
  - **The gates read the setting.** The Model Gate refuses a body past `modelCallBytes` and a file past `modelFileBytes`; the Tool Gate keeps no MCP or HTTP answer past `toolAnswerBytes` (`mcp.too-large`, `http.too-large`) and reads no tool body past it. A custom harness's state past `harnessStateBytes` fails its turn with `limit_exceeded` (it was `invalid`), and a `definition.file` range longer than `chunkBytes` is `limit_exceeded`. Core's step budget for tool results is unchanged (256 KiB), or half `recordEntryBytes` when that is less.
  - **`turn.start` carries `limits`** (`RuntimeLimitsSchema`), the limits in force when the segment started. Harness API 3 and protocol 14 are unchanged, but `TurnStartSchema` is strict: a harness built against an older `@nylorun/core` refuses a `turn.start` with `limits`, so upgrade a custom harness with the Runtime. Our harness asks for skill files `limits.chunkBytes` at a time, and holds MCP answers on its own connections to `limits.toolAnswerBytes`. `createHarness` takes `onStart(grant, start)`.
  - **Removed exports:** `MAX_MODEL_CALL_BYTES`, `MAX_TOOL_BODY_BYTES`, `MAX_HARNESS_STATE_BYTES` and `DEFINITION_FILE_CHUNK_BYTES` from `@nylorun/core`. Added: `RuntimeLimitsSchema`, `RUNTIME_LIMIT_DEFAULTS`, `RUNTIME_LIMIT_CEILINGS`, `runtimeLimitsOf`, `runtimeLimitIssues`, `limitExceededMessage`, `S2_RECORD_MAX_BYTES`, `RECORD_ENVELOPE_RESERVE_BYTES`, `JS_STRING_MAX_LENGTH` and the `TenantLimits*` schemas.

- 6772612: **The remaining request, upload, token and sandbox limits are Tenant settings (harness boundary B15).** Still protocol 15 and Harness API 4. See MIGRATION.md and DEPLOYMENT.md's Runtime limits.

  - **27 more Runtime limits** in `GET`/`PUT /v1/tenant/limits`, each with today's value as its default and a ceiling from a dependency (a JavaScript string or timer, a request read as one string, a Harness API frame, a JavaScript number): request bodies and inline files (`requestBodyBytes`, `inlineFileBytes`), `a2aWaitMs`, `errorExcerptChars`, `traceContentBytes`, an Environment's labels, setup and input files (`environmentLabels`, `environmentSetupCommands`, `environmentFiles`, `environmentFilesPerEntry`, `environmentSecretSlots`, `setupCommandMs`, `setupOutputChars`), disk versions (`diskVersionEntries`, `diskVersionBytes`, `diskLeaseMs`, `diskPodWaitMs`; an Environment's manifest may lower the first two with `limits.disk`), model calls (`modelRequestMs`, `modelIdleMs`, `modelAttempts`, `modelRetryDelayMs`, `modelProviderRetries`, `modelRetryDelayMaxMs`, read by the gates for each call) and tools (`toolAttempts`, `httpToolTimeoutMs`, `mcpPreviewMs`, `mcpMetadataBytes`, and the new `mcpSnapshotBytes`: what a session pins of its MCP servers' tools and instructions, past which a server is left out with a diagnostic).
  - **Schema maxima are checked against the Tenant's limits**: an Environment's labels, setup commands, input files, files per entry, secret slots and setup timeout, and an HTTP tool's `timeoutMs` (at deploy and at each call). `limits.environments` and `lifecycle.stopGrace` lose their arbitrary caps; an identity file's issuer takes any number of grants and `jwksFetch` settings.
  - **`turn.start.limits` carries only a harness's limits** (`HarnessLimitsSchema`, `harnessLimitsOf`), and a harness drops one it does not know. `transcriptUpdates` takes `recordEntryBytes` and fills each event up to it; `CHUNK_BYTES` is gone.
  - **Constants a dependency or a standard fixes stay, named for it**: a token is read up to Node's `http.maxHeaderSize`; artifact names and folder paths keep `FILE_NAME_MAX` (255) and `FILE_PATH_MAX` (1,024); a skill file's path is what `FILE_PATH_MAX` leaves under its mount folder; `tracestate` keeps W3C's 512.
  - **Removed**: `ENVIRONMENT_LABELS_MAX`, `ENVIRONMENT_SETUP_MAX`, `ENVIRONMENT_SETUP_TIMEOUT_MAX_MS` (now `ENVIRONMENT_SETUP_TIMEOUT_DEFAULT`), `ENVIRONMENT_FILES_MAX`, `ENVIRONMENT_SECRET_SLOTS_MAX`, `TOKEN_ENVIRONMENT_GRANTS_MAX`, `HTTP_TOOL_MAX_TIMEOUT_MS`, `READ_ARTIFACT_MAX_BYTES` and `CHUNK_BYTES` from `@nylorun/core`; the image checks (`decodeImageBase64`, `validateImageBytes`, `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`), the Tenant configuration's `modelCall` and `TrustedIssuersOptions`' `refetchMs`/`maxAgeMs` from `@nylorun/runtime`. Studio's Environment form no longer caps setup commands and input files at 16: the Runtime checks the Tenant's limit.

### Patch Changes

- 8715ad8: The fixture model reads its `fixture:*` script in a turn that carries a file. Our harness ends such a turn with a user message listing the files (`FILES_MESSAGE_HEADER`, now exported by `@nylorun/harness`), and the fixture model read that message instead: it answered "I remember: …" and called no tool. It now skips that message, for the script and for the tool result it answers after.
- Pin core to the tested release.
- Updated dependencies [0a2fbc5]
- Updated dependencies [ebe7348]
- Updated dependencies [ff6470e]
- Updated dependencies [f443475]
- Updated dependencies [cf425c6]
- Updated dependencies [23774c4]
- Updated dependencies [b1e815d]
- Updated dependencies [2459430]
- Updated dependencies [f2e9b0a]
- Updated dependencies [6772612]
  - @nylorun/core@0.23.0-beta

## 0.27.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [620072d]
- Updated dependencies [a0cf8b2]
  - @nylorun/core@0.22.0-beta

## 0.27.0-beta

### Minor Changes

- c96b9a8: **An agent manifest is flat: manifest v7, a `runtime` block the Runtime writes, and tools known by name (protocol 13, Harness API 3).** A manifest listed capabilities, each with its own instructions, tools, skills and servers, and the Runtime added its own as more capabilities. Now the agent's parts sit at the top level, a plugin's skills and servers say which plugin brought them, and what the Runtime adds to a session's agent is one `runtime` block. A fresh start: the Runtime speaks protocol 13 only, so save your agents again; sessions from protocol 12 do not carry over. See MIGRATION.md.

  - **Manifest v7.** `{ manifestSchemaVersion: 7, id, name?, description?, metadata?, outputSchema?, instructions?, tools?, skills?, mcpServers?, runtime? }`. Versions 3 to 6 and a `capabilities` field are refused with a message to rebuild. `SkillManifest.plugin` and `McpServerManifest.plugin` are `{ name, version? }`, set by `.plugin(dir)` from `plugin.json`.
  - **The `runtime` block.** `{ sandbox?, tools?, instructions? }`, written only by the Runtime when a session pins the agent: the sandbox spec and tools, `save_artifact`, `read_artifact`, `load_skill` and `read_skill_resource`, the skill catalog and the notes that go with them. A definition or a turn variant that sets it is refused. `runtimeManifestFor` in `@nylorun/core/define` replaces `sandboxCapabilityManifest`, `artifactsCapabilityManifest` and `toolsCapabilityManifest`. `.skills()` and `.plugin()` no longer add the skill tools or the catalog.
  - **Names.** An agent's tool may not take a Runtime tool's name (`RUNTIME_TOOL_NAMES`) or contain `__`, and names are unique across tools, skills and servers.
  - **Turn variants** may remove tools, tighten MCP servers and change instructions, name, description and metadata. Skills are fixed, and a variant never sets `runtime` or changes `outputSchema`.
  - **Tools by name.** `capabilityId` is gone from `tool.completed`, `mcp.discovered`, tool call rows, `EffectIntent`, gate requests, checkpoints and `SessionToolRef`. An HTTP tool's `server` is its URL's host. `Implementations` is `{ tools }`, keyed by tool name (`Agent.from(json, { tools })`), `AgentBinding.declarations` is `parts`, and observe events say `partId`.
  - **Harness API 3.** `hello.capabilities` is `features`, and the `harness` pseudo-capability is gone: a native tool is known by its name, and one whose name is taken fails the turn at its start. `createHarness({ features })` in `@nylorun/harness`. `examples/harness-minimal` speaks it.
  - **Studio.** The Agent tab shows instructions, tools (HTTP and agent badges), skills and MCP servers, each skill and server with its plugin's badge and a filter by plugin, and a session's Runtime section: its sandbox, tools and instructions.
  - `@nylorun/core`: `PROTOCOL_VERSION` 13, `HOST_PROTOCOL` `{ min: 13, max: 13 }`, required feature `flat-manifest`, `HARNESS_API_VERSION` 3; `PluginLabel`, `RuntimeManifest`, `RUNTIME_TOOL_NAMES`, `isRuntimeToolName`, `runtimeToolOf`, `isSkillTool`, `SKILLS_USAGE` and `formatSkillCatalog` in `/define`.
  - `@nylorun/agents`, `@nylorun/admin`, `@nylorun/studio` and `nylorun` send protocol 13.

- 94bf329: **Each model says what it reads, a file it does not read is refused before a turn starts, and a file is an artifact the model reads again after its turn (protocol 12).** A message could name any file, and a model that could not read it failed the turn at its model call; every later turn sent the file's bytes again. Now the Runtime knows what the Tenant's model reads, checks a message's files when it is accepted, and sends a file's bytes only in the turn that brought it. Protocol 12 only adds to 11: the Runtime serves both.

  - **Model inputs.** A model reads `text`, and `image`, `pdf`, `office`, `audio` or `video` when its catalog says so or the operator adds it where its API carries it natively (images everywhere; PDFs on the Anthropic, OpenAI, Azure and Google APIs; Office documents on the OpenAI Responses APIs; audio and video on Google's APIs and OpenAI-compatible completions). `GET /v1/tenant/models` gives each model `inputs` and `addableInputs`, `GET /v1/tenant/providers` each provider's `inputs`, and **`PUT /v1/tenant/models/inputs`** (the Management API; `admin.models.setInputs({ provider, model, inputs })`) sets the added ones, kept in the Tenant setting `model.inputs`. The Model Gate gives the provider adapter a model with an added image, so it is sent.
  - **A custom endpoint reads text only by default.** It used to be sent images. Set `settings.inputs` on `PUT /v1/tenant/model` (`image`, `pdf`, `audio`, `video`) for what yours reads; `office` is refused there. See MIGRATION.md.
  - **The accept check.** A message naming a file of a type the Tenant's model does not read is `422 attachment_unsupported`, with `details.parts` (`artifactId`, `name`, `mediaType`, `reason`), and no turn starts. Only the type is checked, never the size. Without a model in the vault nothing is refused.
  - **Files as artifacts.** After its turn a file is a reference line, `[Uploaded artifact "name" · <artifactId> v<n> · read_artifact to view]` (a tool's: `[Tool <name> returned artifact …]`). Our harness sends the turn's own files once more, as media, in one user message after the conversation, so a message reads the same in every later call. At the gate, an image the model reads is an image, a text file a `<file>` block, and any other file, or one that cannot be read, a note: no file fails a call. PDFs, Office documents, audio and video are notes until the gate sends them natively.
  - **`read_artifact` for every agent.** Every agent's session has it (an agent that declares its own keeps it), so every agent session pins its definition with it added. It takes a `version`, reads the Tenant-wide artifacts the session's messages named, and shows any file the Tenant's model reads; one it does not read fails `artifact.unsupported`.
  - **Compaction** keeps the summarized part's reference lines (`files` on the compaction entry), and counts the turn's files by type and size in its token estimate.
  - `@nylorun/core`: `PROTOCOL_VERSION` 12, required feature `model-inputs`, `HOST_PROTOCOL` `{ min: 11, max: 12 }`, error code `attachment_unsupported`; `MODEL_INPUTS`, `ModelInputSchema`, `PutModelInputsRequestSchema`, `ModelInputsViewSchema`, `CustomModelSettings.inputs`; `mediaReferenceLine` and `mediaReferenceOf` in `/define`; `TranscriptCompactionEntry.files`.
  - `@nylorun/agents`, `@nylorun/studio` and `nylorun` send protocol 12.

- b5ea2b5: **An agent is its manifest: step middleware and capability bundles are removed from authoring.** The Runtime already refused middleware; now the local engine runs none either, and an agent is built only from the builder's own methods. No protocol change. See MIGRATION.md.

  - **Removed:** `.use()`, `.capability()`, `capability()`, `CapabilityBuilder`, `middleware()`, `model()`, `StepMiddleware`, `StepRequest`, `StepResponse`, and `Implementations[id].middleware`. To reuse tools and instructions, write a function that adds them; a bundle you publish is an Agent Plugin.
  - **`@nylorun/agents`:** the standalone `skills()`, `plugin()` and `mcp()` factories are removed; use `.skills(dir)`, `.plugin(dir)` and `.mcp(servers)`. `.skills()` takes no options: the part takes the folder's name.
  - **`@nylorun/harness`:** each step offers the definition's tools and instructions in order. The `middleware.entered`, `middleware.completed` and `middleware.lease-violation` observe events are gone, and a model request carries no `model` directive or runtime context items.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [3a32a57]
- Updated dependencies [af90d1e]
- Updated dependencies [104f24f]
- Updated dependencies [c96b9a8]
- Updated dependencies [94bf329]
- Updated dependencies [b5ea2b5]
- Updated dependencies [aff9bb8]
- Updated dependencies [f44c018]
- Updated dependencies [c8e640b]
  - @nylorun/core@0.21.0-beta

## 0.26.0-beta

### Minor Changes

- e917bd6: **Bring your own harness: harness ids, harness-owned state, and who wrote each event (R4.1, R4.2, R4.4, R4.9).**

  - **Harness ids and routing.** An Environment's `harness` takes any harness id (`^[a-z][a-z0-9-]{1,62}$`). It is no longer only `nylorun`.
    - **The pin.** A session pins its harness when it opens: its Environment's harness, else `nylorun`. A flow always runs `nylorun`. `GET /v1/sessions/{id}` returns the pin as `harness`.
    - **Routing.** Only a connection whose `hello.name` is that id takes the session's runs.
    - **Our harness's name.** It now says `nylorun` in `hello`. A harness that says `@nylorun/harness` is refused with a message naming the new id, so an older harness image needs this Runtime's.
    - **Placement.** It is keyed by the real harness id, and `"*": {hosts: []}` refuses any harness the map does not name.
    - **Drift.** A turn on an Environment that now runs another harness is `409 harness_mismatch`; open a new session. For a pod Environment, a changed `harness` applies at the pod's next wake, like its image.
  - **Per-harness tokens.** `nylorun-operate harness token put <id>` makes a custom harness container's own Harness API credential, bound to its id; `list` and `rm` manage them. `NYLORUN_HARNESS_TOKEN` stays ours, bound to `nylorun`.
  - **A custom harness as a pod's image.** A pod Environment whose harness is not ours runs its `image` as the harness: the image's own entrypoint (`entrypoint: "image"` to the sandboxes service), with nothing copied in. It needs `image`.
  - **Harness-owned state.** Core stores a harness's turn state as sent and never reads it. Our engine now aligns its state with the turn's manifest itself.
    - **Limits for a custom harness.** Its state is at most 256 KiB, or its turn fails. It cannot pause for approvals in Harness API 2.
    - **Native tools.** It may declare the tools it runs itself in `hello` (`capabilities.tools`). Their calls (capability `harness`) are journaled like built-ins, and the log records a real `tool.completed` instead of `tool.unavailable`.
  - **Who wrote each event.** The writer sets an event's `source` and `evidence`; the event's type no longer decides them. Events written before this release still say `loop` or `api`.
    - **`client`**: a command, with a new `principal` taken from its credential.
    - **`harness`**: what a harness reported, with its harness id and `runId`. Evidence `claimed`.
    - **`core`**: core's own logic. Evidence `observed`.
  - **`effectId` on model calls.** `GET /v1/sessions/{id}/calls/model` returns each call's `effectId`, so a metered call joins the effect journal.
  - **The published contract grows.** It adds `HarnessCheckpointSchema` (the checkpoint fields a harness reads), `NativeToolSchema`, the harness id helpers, `HARNESS_TOOLS_CAPABILITY`, `MAX_HARNESS_STATE_BYTES`, and the gate error codes `key_required` and `effect_not_journaled`. It also documents the effect context keys, the model request hash rule and how a turn's status maps to its output method.

- 35e29b7: **Environments replace sandboxes and vaults (protocol 11). This is a fresh start: upgrading deletes your sandboxes, their disks and every vault except the model's, and closes every open session (its history stays readable).** List what you have before upgrading; see "Environments replace sandboxes and vaults" in MIGRATION.md.

  An Environment is where sessions run: one sandbox (kind `virtual`, `pod` or `none`) with a recipe that can change, and one vault of secrets for its shell, MCP servers and HTTP tools. The app decides who uses which Environment; the Runtime keeps it by id and holds its lifecycle.

  - `@nylorun/core`: protocol 11 (the Host accepts 11 only; older clients get `426`), required feature `environments`. `PutEnvironmentRequestSchema`, `EnvironmentViewSchema` (`recipe`, `version`, `appliedVersion`, `ownerUserId`, `lastUsedAt`), `PutEnvironmentSecretRequestSchema`, `EnvironmentSecretViewSchema`, `ENVIRONMENT_EVENT_TYPES`, `TenantEnvironmentsConfigSchema`, `environmentGranted`. `PutSessionRequest.environment` replaces `sandbox`, `vaultIds` and `credentialSelections`; `SessionView.environment` replaces the session's sandbox and vault fields. Error codes `environment_busy`, `environment_unavailable`, `environment_lost`, `environment_not_granted`, `environment_owner_mismatch` and `session_closed` (the `sandbox_*` codes and `sandbox_expired` are gone); session events `environment.state`, `environment.exec` and `environment.attached`; scope `environments:write`. Credential coverage takes `environmentId` and answers `covered` or `missing`; the MCP preview takes `environmentId`. The vault Management schemas are removed.
  - `@nylorun/runtime`: `/v1/environments/{id}` replaces `/v1/sandboxes/{id}`: `PUT` creates, finds or changes one (`kind` and `storage` fixed; a recipe change bumps `version`; a pod gets a new image or resources at its next start from stopped, a new allowlist within seconds), with list by label, events (`nylorun.environment-event/1`), stop, reset and delete. Each Environment owns one vault: `PUT|GET|DELETE /v1/environments/{id}/secrets/{name}` on the Runtime API, write-only, with a second credential for a host or URL refused at the write (`409 credential_conflict`). An optional owner guard (`ownerUserId`) is checked when a session opens and at every turn start. `lifecycle.deleteAfter` deletes an Environment unused that long; TTL and `onExpiry` are gone. Kind `none` holds secrets for MCP-only agents. `/v1/tenant/vaults`, user and installation vaults, the Tenant's default sandbox, inline sandboxes and `{ session }` sharing are removed. The Tenant setting is `environments.config` (`limits.environments`). Identity files grant `environments:` (an old `sandboxes:` key, or `sandboxes:write`, stops the Runtime with a message naming the new key). Migration `0020_environments`.
  - `@nylorun/harness`: the Harness API claims `environment.state` and `environment.exec`, and its workspace fields name `environmentId`.
  - `@nylorun/agents`: `client.environments` (`put`, `get`, `list`, `page`, `stop`, `reset`, `delete`, `events`, `secrets.put|list|get|delete`, `forSession`) replaces `client.sandboxes`; `createSession({ environment })`; `sessions.page({ environmentId })` filters by Environment. The AG-UI handler's session options take `environment`.
  - `@nylorun/admin`: `admin.coverage({ agentId, environmentId })` replaces `admin.vaults`; `admin.mcp.preview({ url, environmentId })`.
  - `@nylorun/studio`: Environments replace Sandboxes, with a create form, stop, reset, delete and their secrets; the Credentials forms write an Environment's secrets; New session picks an Environment and shows its coverage.
  - `nylorun`: `nylorun sandbox ls|rm` list and delete Environments; `nylorun mcp inspect --environment <id>` replaces `--vault`; `nylo reset --environments` replaces `--sandboxes`; `nylo doctor sandbox` reports the Environment limits.

- 3013501: **Tool calls are delivered at least once, and every one is on the record (R5 step 1).** A gateway restart used to park the sessions it interrupted as `uncertain` until someone cancelled them, a harness could call tools with no record, and nothing listed a session's tool calls. Now every tool call ends in the log with its outcome, a crash sends it again with the same key, and the gateway runs only calls the effect journal recorded.

  - **Every outcome in the log.** Each tool call ends in one `tool.completed` with `status` (`completed`: the tool answered; `failed`: the Runtime ended it, `tool.disabled`, `tool.unavailable` or `tool.interrupted`; `cancelled`), `kind` (`mcp`, `http`, `sandbox`, `platform`), `server`, `attempts` and `durationMs`. Refused and cancelled calls are in the log for the first time.
  - **`GET /v1/sessions/{id}/calls/tool`** pages a session's tool calls from the effect journal, in the order they were first sent: tool, input, status, sends, error and timing. Same credentials and paging as `/calls/model`; `@nylorun/agents` adds `session.toolCalls()`. Host feature `tool-calls`.
  - **At least once, with the same key.** An MCP or HTTP tool call that a crash, a shutdown or a lost gateway hop interrupted is sent again with its effect id as the key, up to 3 sends; then it fails to the model as `tool.interrupted` ("may have run") and the session continues. A gateway that restarts mid call runs the call again under its key instead of answering `uncertain`. HTTP tools get the key as `Idempotency-Key`, as before; MCP servers now get it in `_meta["nylorun/idempotency-key"]` on `tools/call`. A tool that honors the key acts once; `attempts` above 1 marks where one may have acted twice.
  - **Sandbox commands are never run twice.** A sandbox or core-served call a crash interrupted has no key to dedupe on, so it fails to the model as `tool.interrupted` at once, and the model decides whether to run it again.
  - **No tool call parks a session.** The `uncertain` state for tool calls, its cancel-only exit and R2b's read-only/idempotent `mcp.lost` exception are gone: a lost MCP answer is `mcp.lost` to the model for every tool. Model calls keep their own rules.
  - **The gateway runs only journaled calls.** Under a run token, `/nylorun/v1/tool-calls` and `/nylorun/v1/http-calls` need the call's effect id as `Idempotency-Key` (`400 key_required`), and the effect journal must hold it running, for the run's turn, the same tool and the same input (`409 effect_not_journaled`). A harness that skips the journal gets nothing run.
  - `@nylorun/harness`: `HarnessExecutors.resends(effect, error, run)` says a gate hop lost a call's answer; the harness then asks core again with the same intent and sends the call again.
  - **Approval** stays in the manifest and our harness still asks for it. Only the Runtime's own harness asks: one built from the Harness API can skip it until tool policy moves to the gateway (R5 step 2).

- 6061a3a: **Tool approvals are the Tenant's tool policy (R5 step 2).** An agent's manifest used to say which tool calls wait for a person, and only the Runtime's own harness asked; a harness built from the Harness API could skip it. Now the operator sets one tool policy for every agent and every harness, and the Runtime enforces it before anything is sent.

  - **`GET`/`PUT /v1/tenant/tool-policy`** (the Management API; `admin.toolPolicy.get()`/`.put({ rules })`): rules `{ effect: "allow" | "ask" | "deny", tool?, server?, kind?, agent?, when?, reason? }`. A rule matches a call when every selector it sets matches (`tool` and `server` take `*` globs; `when` tests input fields by dotted path with `equals`, `in`, `gt`, `gte`, `lt`, `lte` or `matches`). The strictest matching rule decides; a call no rule matches runs.
  - **Enforced for every harness.** Core decides an MCP or HTTP tool call as it journals it. `deny` fails it to the model as `tool.denied`, unsent. `ask` holds the call (`held` at `/calls/tool`) and pauses the turn with one `approval` interaction per held call (`turn.paused`, with the tool, its input and the reason). `approve` sends that exact call, or fails it as `tool.denied`. The Tool Gate runs only calls the journal holds running, so a held or refused call cannot run. Nothing holds a process while it waits: an approval survives a restart. A flow's HTTP stages are decided the same way.
  - **`approval` leaves the manifest.** `PUT /v1/agents/:id` and `saveAgent()` refuse a definition that sets `approval` on an HTTP tool, an MCP server or an MCP tool's settings; `http({ approval })` and `.mcp({ … approval })` throw; a turn manifest can no longer add one. The engine never asks for an HTTP or MCP tool's approval itself. A session pinned to a manifest saved with `approval: "always"` keeps it, as an ask.
  - `@nylorun/studio`: a paused session shows an approval card for each held call, with its tool, why it is held and its input, and **Approve** / **Deny**.
  - Migration: move each `approval: "always"` to an `ask` rule (see MIGRATION.md).

- 7800358: **Each turn is one OpenTelemetry trace, projected from the session log (R7).** An operator could not see what a turn did or where its time went without grepping container logs. Now every turn is a trace with a span for each model call, tool call and egress tunnel, exported over OTLP to any collector, readable per turn from the Runtime, and joined to the trace of the app that started it. No protocol change.

  - **Traces from the log.** A turn's end is its root span, `invoke_agent <agent>`; each model call is a `chat <model>` span, each tool call and flow HTTP stage an `execute_tool <tool>` span, each egress-gate tunnel a `CONNECT <host>` span, and each pause and answer a marker. A model or gate tool span is the gate's own start and end; usage and cost are the gate's (`nylorun.usage.mismatch` when the harness reported other numbers). Attribute names follow the OTel GenAI conventions at one pinned commit, recorded as `nylorun.semconv.genai` on the resource. Ids are derived from the log under a key the Tenant keeps (setting `trace.key`), so every export and read of a turn gives the same ids.
  - **OTLP export, off until you set an endpoint.** With `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) the Runtime posts OTLP/HTTP JSON from a replication slot of its own, `nylorun_trace_export`, in batches of up to 512 spans or every 2 s; `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` work as usual. No turn waits for it. A collector that is down costs only its spans: after three retries a batch is dropped and logged as `trace_export_dropped`, and the slot moves on, so Postgres keeps no WAL for it. `nylorun start` passes these variables to the runtime container.
  - **References by default.** Spans point at log events (`nylorun.event.cursor`) and carry no content unless you opt in per kind with `NYLORUN_TRACE_CONTENT` (`user`, `outputs`, `tool-results`, `errors`), or all of them with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`, each cut at 8 KiB. A span never carries a credential value, a prompt, a person's id, an identity header or an idempotency key.
  - **`GET /v1/sessions/{id}/turns/{turnId}/trace`** answers a turn's spans as OTLP JSON, the same spans the exporter posts: look at a turn without a collector, or post it to one to backfill. Application keys, as the `/calls` reads. Host feature `traces`; `@nylorun/agents` adds `session.trace(turnId)`, and `@nylorun/core/contracts` `TurnTraceSchema`.
  - **Trace context in and out.** A `traceparent` (and `tracestate`) on `POST /v1/sessions/{id}/commands`, an AG-UI run or an A2A message puts the turn in the caller's trace; `command.message` records it as `trace`. The turn hands its context on: to the harness in `TurnStart.trace`, to HTTP tools as `traceparent` beside `Idempotency-Key`, to MCP servers as `traceparent` on the call's requests, and to sandbox commands as `TRACEPARENT`.
  - **Harness API** (additive): the `effect.intent` answer `execute` may carry the tool call's `traceparent`. `@nylorun/harness`: `HarnessExecutors.tool` takes it as a fourth argument (`ToolCallContext`).

### Patch Changes

- e917bd6: **The Harness API is a published contract (R4.5).** Everything a harness sends or reads now has a schema in `@nylorun/core/harness-api`, and the Runtime validates with those same schemas:
  - the transport and the pod join (`HARNESS_API_PATH`, `HARNESS_API_HEADER`, `HOST_JOIN_PATH`, `HostJoinRequestSchema`, `HostJoinAnswerSchema`);
  - the Model and Tool Gate bodies (`ModelCallBodySchema`, `ToolCallBodySchema`, `HttpCallBodySchema`, the MCP bodies, `GATE_ERROR_CODES`);
  - the MCP snapshot (`McpSnapshotSchema`);
  - transcript entries (`TranscriptEntrySchema`);
  - the effect id rule (`effectIdOf`, `isEffectIdOf`).

  The build also writes them as one JSON Schema document, `@nylorun/core/harness-api/schema.json`, for harnesses written in other languages.

  Other changes:
  - `TurnStart` gains an optional `trace` (W3C `traceparent`) for the turn's trace context. Nothing fills it yet.
  - Core refuses a `hello` whose `api` is not `2`.
  - **The fixture model answers at the Model Gate (R4.3).** With a Tenant's `fixtureModel` seeded, the gate answers model calls itself and meters each one, like any model: a `model_usage` row with provider `fixture` and cost 0, readable at `GET /v1/sessions/{id}/calls/model`. Our harness no longer answers it locally.
  - The fixture model also answers scripted markers: `fixture:text`, `fixture:tool <name> <json>`, `fixture:budget` and `fixture:slow <seconds>`.
  - **The sandboxes service can run a harness image (R4.4, Go).** `PUT /v1/pods/{name}` accepts `entrypoint: "image"`: the workload image's own `ENTRYPOINT` and `CMD` run, with no engine copied in and no `harnessImage`. The default, `entrypoint: "engine"`, is unchanged. The Runtime starts sending it with the harness pin in a later change.

- Pin core to the tested release.
- Updated dependencies [17a97e9]
- Updated dependencies [b6214d9]
- Updated dependencies [e917bd6]
- Updated dependencies [5165451]
- Updated dependencies [35e29b7]
- Updated dependencies [e917bd6]
- Updated dependencies [a0cbca1]
- Updated dependencies [3013501]
- Updated dependencies [6061a3a]
- Updated dependencies [7d496e4]
- Updated dependencies [81c783e]
- Updated dependencies [7800358]
  - @nylorun/core@0.20.0-beta

## 0.25.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [212364b]
  - @nylorun/core@0.19.0-beta

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
