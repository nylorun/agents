# Changelog

## 0.19.1-beta

### Patch Changes

- ed08ba8: Public text names no internal roadmap codes: the OpenAPI documents' descriptions, the type comments of `@nylorun/core`, `@nylorun/agents` and `@nylorun/admin`, and the CLI's help, README and generated compose file. A Runtime test fails when either OpenAPI document names one.
- Pin core to the tested release.
- Updated dependencies [ed08ba8]
- Updated dependencies [ed08ba8]
- Updated dependencies [ed08ba8]
- Updated dependencies [eeb6294]
- Updated dependencies [ed08ba8]
  - @nylorun/core@0.25.0-beta

## 0.19.0-beta

### Minor Changes

- 22c61ce: Protocol 16, Agents from one manifest (track T2), a fresh start. An agent manifest (v8) is one versioned document at `/v1/agent-manifests/{name}` with a `harness` section (what runs inside the loop, including the harness's id) and a `runtime` section (what an environment manifest said). The Runtime checks the two against each other when it is saved (`422 manifest_inconsistent` with `details.gaps`), in place of `requires` at session open. Agent definitions and environment manifests are gone.

  Environments are Agents: `/v1/agents/{id}` and its sub-routes, made from a saved manifest only (`manifest: "name"` tracks it, `"name@n"` pins a version; either resolves once, into `resolvedVersion`), with a derived `state` (`working`, `sleeping`, `input_required`, `failing`, `paused`) and `attention`. Every session runs on one Agent (`PUT /v1/sessions/{id} { agent, ownerUserId }`) and pins its manifest version. No session is special (D71). Error codes, events (`agent.*`), scopes (`agents:write`, `agent-manifests:write`) and identity-file grants (`agents`) say Agent; model budget scope `agent` is `manifest`. Harness API 5: `turn.start.agent` replaces `turn.start.environment`, with `definition` and `loop`. Migration 0032 closes older sessions (`protocol_16`) and drops Environments with their disks and vaults.

  The SDK has `client.agentManifests`, `client.agents` and `composeManifest(dir)` for three-file authoring; the CLI has `nylorun apply`, `nylorun agent-manifests`, `nylorun agents` and `nylorun migrate v8`; Studio has an Agents screen, an Agent page and an Agent manifests screen. See MIGRATION.md.

### Patch Changes

- 4fa160d: Agent memory, storage and API (track T5, D72). An agent manifest's `harness.memory` (`access`: `read_write` or `read_only`; `instructions`, at most 4,096 characters) turns on the Agent's memory: Markdown files under `/memories` it keeps across sessions, wakes and upgrades. The Runtime keeps them in Postgres (`memories`, `memory_versions`, migration 0036) with a version per change and who made it. `GET /v1/agents/{id}/memories` lists them (`pathPrefix`), `GET`, `PUT` (whole content, with an optional `contentSha256` precondition: `409 memory_conflict`) and `DELETE /v1/agents/{id}/memories/{path}` read, write and delete one (or a folder), and `GET /v1/agents/{id}/memory_versions` and `.../memory_versions/{versionId}` page the versions. A fork copies the memories (the fork plan adds `memories`); a delete removes them. `@nylorun/core` adds `memoryPathOf`, `memoryDescriptionOf` and the memory contracts; new Runtime limits `memoryBytes` (100 KiB) and `memoriesPerAgent` (10,000); new error code `memory_conflict`. The SDK adds `client.agents.memories`; the CLI adds `nylorun agents memories ls|cat|put|rm|versions`. The model's `memory` tool arrives in the next steps of T5.
- ffeb3bb: `schedule_wake` (track T4, D77). An agent manifest's `runtime.selfWake: true` offers the agent `schedule_wake`: `{in | at, note}` books its session's next turn, replacing the booking before, and `{cancel: true}` removes it. The Runtime serves the call in its own transaction (a new effect target, `{kind: "runtime", operation: "schedule_wake"}`, additive on Harness API 5; `turn.start.agent.selfWake` tells a harness to offer it), so a replayed turn books once. The booking fires as a trigger run of kind `wake`, its note the turn's message with `cause.kind: "self"`. New session events `wake.booked` and `wake.cancelled`, tool call kind `runtime`, and Runtime limits `wakeMaxAheadMs` and `wakeNoteChars`.
- f85483d: Triggers (track T4, D74). An agent manifest's `runtime.triggers` declares `schedule` (cron with an IANA `timezone`) and `at` triggers, each with the session its runs go to (a session id, opened on the first run, or `new` for a session per run) and its prompt. They start active with a new Agent, fire on a durable timer per trigger with Postgres as the truth (one late fire after downtime, never a backfill, a fixed jitter per trigger), and each fire is a run (`started`, `queued`, `skipped` or `failed`, with a reason) at `GET /v1/agents/{id}/runs`. A schedule adds at most one queued message to a busy session. `GET /v1/agents/{id}/triggers` and `POST .../triggers/{triggerId}/pause`, `/resume` and `/run` (with an `Idempotency-Key`); Agent reads add `nextWakeAt`, and the Agent's stream adds `agent.run`, `agent.trigger_paused` and `agent.trigger_resumed`. New Runtime limits: `triggersPerAgent`, `triggerMinIntervalMs` and `triggerRunRetentionMs` (with floors), `triggerRunsPerHour`, `triggerJitterPercent`, `triggerJitterMaxMs`, `triggerPromptChars`; Host tuning `triggers.lateGraceMs` and `triggers.intervalCheckFires`. The SDK's `client.agents` adds `triggers`, `pauseTrigger`, `resumeTrigger`, `runTrigger` and `runs`; the CLI adds `nylorun agents triggers` and `nylorun agents runs`.
- ae54de7: Webhook triggers (track T4, D75). A `webhook: "standard-webhooks"` trigger has an endpoint, `POST /v1/webhooks/{endpointId}`, an anonymous, unversioned route that takes any body up to the new Runtime limit `webhookBodyBytes` and verifies Standard Webhooks (`webhook-id`, `webhook-timestamp` within the Host's `triggers.webhookToleranceMs`, `webhook-signature`) in the keys service, which alone opens the trigger's sealed secret; anything else is `401` and writes nothing. A delivery runs the trigger once per `webhook-id` (`202 {runId, status}`); a paused trigger answers a signed one `409 trigger_paused`. `POST /v1/agents/{id}/triggers/{triggerId}/secret` makes or replaces the `whsec_` secret, shown once (`agent.trigger_secret_rotated`); trigger reads show `webhookUrl` and `secretSet`. The payload reaches the model under the trigger's prompt in a labelled `<trigger-payload>` block. The SDK adds `agents.rotateWebhookSecret`, and the CLI `nylorun agents triggers new-secret`.
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

## 0.18.0-beta

### Minor Changes

- 0a2fbc5: **Artifacts reach the harness through the Harness API; `read_artifact` and `save_artifact` run in the harness (protocol 15, Harness API 4).** The first step of the harness boundary: model-facing work belongs to the harness, and the Runtime offers primitives and holds limits and access. A fresh start for agent sessions: the Runtime speaks protocol 15 only. See MIGRATION.md.

  - **The artifact seam.** A harness reads and writes the artifacts of the run it holds: `artifact.read {artifactId, version?, offset?, length?}` answers the version's metadata (`ArtifactMetaSchema`) and its bytes from `offset`, at most `turn.start.limits.chunkBytes`; `artifact.write` (`begin`, `chunk`, `commit`, `abort`) makes a file artifact of the session or a new version of one of its own, streamed with backpressure into the Object store and committed in Postgres within the Tenant's and the Environment's artifact limits. The scope is always the run's session: its own artifacts, and the Tenant-wide ones its messages named; anything else is the new error code `not_found`, alike. A write's `key` makes it idempotent within the session (`artifact_versions.write_key`, migration 0028), and its `effectId` links the artifact to a tool call of the turn, whose call id `artifact.created` carries. An upload the run leaves open commits nothing. Client helpers: `readArtifact`, `openArtifactWrite`, `writeArtifactBytes`, `toBase64` and `fromBase64` in `@nylorun/core/harness-api`.
  - **Our harness runs the artifact tools.** `read_artifact` (every agent) and `save_artifact` (with a sandbox) are our engine's tools, defined in `@nylorun/harness` (`artifactToolsFor`, `runArtifactTool`) and run over the seam and the run's sandbox files (`HarnessExecutors.files`, `SandboxManager.writeBytes`); their calls are kind `harness`. `save_artifact` keys its write by its effect id. `read_artifact` takes `path` with a sandbox, which copies the whole artifact into it, and hands a file of any other type to the model as a file of the result (the Model Gate writes the note for one the model does not read; `artifact.unsupported` is gone). Its page is harness configuration, `createHarness({ artifactPageBytes })` (32 KiB by default), and now always ends on a whole character. `runDurable` takes `engineTools`; `apiHost` takes the engine's configuration.
  - **The Runtime pins no artifact tools.** `runtimeManifestFor` has no `save` or `read`; `RUNTIME_TOOL_NAMES` no longer holds the two names, so an author tool may take one (our harness then refuses the turn). A session without a sandbox or skills pins its definition unchanged. Core no longer runs either tool (`tenant/artifact-tool.ts` is gone). Migration 0029 closes every agent session that pinned them (`closedReason: "protocol_15"`, `409 session_closed`); workflow sessions carry over.
  - **Media types are core's.** `contentTypeFor`, `essence`, `normalizeContentType`, `isText`, `isModelImage`, `modelInputOf`, `inputLabel`, `extensionFor`, `unreadableReason`, `MODEL_IMAGE_TYPES` and `DEFAULT_CONTENT_TYPE` are exported from `@nylorun/core/contracts`, for the Runtime and harnesses alike.
  - `PROTOCOL_VERSION` 15 with required feature `harness-boundary`; `HARNESS_API_VERSION` 4. The SDKs and the CLI send protocol 15.

- b1e815d: **Runtime limits are a Tenant setting, and harnesses get them in `turn.start.limits`.**

  - What one record entry, model call, model file, tool answer, custom harness state and Harness API chunk may hold is the new Management API setting `GET`/`PUT /v1/tenant/limits` (`{ limits: { recordEntryBytes, modelCallBytes, modelFileBytes, toolAnswerBytes, harnessStateBytes, chunkBytes } }`), also `admin.settings.limits` and `nylorun tenant settings limits [get | put <file|->]`.
    - The defaults are today's sizes (`RUNTIME_LIMIT_DEFAULTS`): 960 KiB, 32 MiB, 8 MiB, 8 MiB, 256 KiB and 16 MiB. A limit left out of a `PUT` takes its default.
    - Each limit has a ceiling a dependency sets (`RUNTIME_LIMIT_CEILINGS`): S2's 1 MiB record less 64 KiB for the event's envelope, the 64 MiB Harness API frame, the longest JavaScript string. A limit above its ceiling is `400`, naming the ceiling.
    - Each is read from the Tenant's database where it is checked; nothing keeps it.
  - **The record holds every write to `recordEntryBytes`.** An event whose payload, or an effect outcome whose value, is larger, whoever wrote it, is refused with `limit_exceeded`: `413` (`details.limit: "recordEntryBytes"`) to an API client, the new Harness API error code `limit_exceeded` to a harness. A harness's claimed event past it is refused rather than dropped. Before, such an event reached a record S2 could not take.
  - **The gates read the setting.** The Model Gate refuses a body past `modelCallBytes` and a file past `modelFileBytes`; the Tool Gate keeps no MCP or HTTP answer past `toolAnswerBytes` (`mcp.too-large`, `http.too-large`) and reads no tool body past it. A custom harness's state past `harnessStateBytes` fails its turn with `limit_exceeded` (it was `invalid`), and a `definition.file` range longer than `chunkBytes` is `limit_exceeded`. Core's step budget for tool results is unchanged (256 KiB), or half `recordEntryBytes` when that is less.
  - **`turn.start` carries `limits`** (`RuntimeLimitsSchema`), the limits in force when the segment started. Harness API 3 and protocol 14 are unchanged, but `TurnStartSchema` is strict: a harness built against an older `@nylorun/core` refuses a `turn.start` with `limits`, so upgrade a custom harness with the Runtime. Our harness asks for skill files `limits.chunkBytes` at a time, and holds MCP answers on its own connections to `limits.toolAnswerBytes`. `createHarness` takes `onStart(grant, start)`.
  - **Removed exports:** `MAX_MODEL_CALL_BYTES`, `MAX_TOOL_BODY_BYTES`, `MAX_HARNESS_STATE_BYTES` and `DEFINITION_FILE_CHUNK_BYTES` from `@nylorun/core`. Added: `RuntimeLimitsSchema`, `RUNTIME_LIMIT_DEFAULTS`, `RUNTIME_LIMIT_CEILINGS`, `runtimeLimitsOf`, `runtimeLimitIssues`, `limitExceededMessage`, `S2_RECORD_MAX_BYTES`, `RECORD_ENVELOPE_RESERVE_BYTES`, `JS_STRING_MAX_LENGTH` and the `TenantLimits*` schemas.

- f2e9b0a: **Skill and artifact limits are set per Tenant and per Environment manifest; a skill holds up to 2 GiB by default, with no limit per file or on the number of files.**

  - The 10 MiB limit per skill file and the 500-file limit are gone. A skill's files may hold up to the Tenant's skill limit together: 2 GiB by default (`SKILL_TOTAL_BYTES_DEFAULT`). A file at two paths counts twice, since a sandbox holds both copies. `SKILL_FILES_MAX` and `DEFINITION_FILE_MAX_BYTES` are no longer exported.
  - The Tenant's skill limit is the new Management API setting `GET`/`PUT /v1/tenant/skills` (`{ limits: { totalBytes } }`), also available as `admin.settings.skills` and `nylorun tenant settings skills [get | put <file|->]`.
    - `PUT /v1/files/sha256:<hex>` takes a file up to that limit.
    - `PUT /v1/agents/{id}` refuses a skill over it, an agent used as a tool included: `413 limit_exceeded`, with `details.skills` listing each skill and its size.
  - An environment manifest, or the inline fields of `PUT /v1/environments/{id}`, may set `limits`: `artifacts.fileBytes`, `artifacts.totalBytes` and `skills.totalBytes`. Like the manifest's other fields, they are fixed for the Environment's life.
    - Each limit must be at most the Tenant's. A higher one is refused with `400` when the Environment is made or the manifest is saved.
    - A limit left out is the Tenant's at the time it is checked. A Tenant that lowers a limit lowers it for every Environment.
    - The Environment view's new `limits` field gives the limits in force.
  - An Environment's artifacts are its sessions' artifacts and its disk versions. Uploads, `save_artifact`, turn-end exports and disk snapshots hold them to the Environment's per-file limit and to its own total, as well as to the Tenant's total. A turn-end export past the Environment's total is skipped with the new reason `environment_total`, and a disk snapshot past it is `413` with `details.limit: "environment_total"`.
  - A session opens on an Environment only when its agent's skills fit the Environment's skill limit; otherwise it is `409 environment_unsuitable`, with `details.skills`.
  - `PUT /v1/files` streams the body to the Object store instead of holding it in memory. Only bytes that match the named hash reach the file's key. Environment files named by hash are held to the same per-file maximum.
  - `@nylorun/agents`: loading a skills folder no longer checks a size, since the limit is the Tenant's; the Runtime refuses an oversized skill. The `skills.file-too-large` and `skills.too-many-files` errors are gone. Files are hashed and read a chunk at a time.
  - Sandboxes get skill files as a stream. A harness fetches them from core 16 MiB at a time: `definition.file` takes optional `offset` and `length` (at most the Runtime limit `chunkBytes`).
  - `load_skill` and `read_skill_resource` read files of up to 10 MiB into the model's context. A larger file fails with `skill.resource_too_large`, and the error names the file's path in the sandbox when there is one.

### Patch Changes

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

- 23774c4: **The last hard-coded limits are configuration (harness boundary B15c).** Still protocol 15 and Harness API 4. Every default is the value before. See MIGRATION.md, and DEPLOYMENT.md's Runtime limits and Host tuning.

  - **21 more Runtime limits** (`GET`/`PUT /v1/tenant/limits`): a message's parts (`messageParts`), page sizes (`pageItems`, `exportPageItems`, `environmentEventItems`; a page asked larger holds that many), labels (`artifactLabels`, `labelKeyChars`, `labelValueChars`), a manifest's setup command, descriptions and secret hosts (`setupCommandChars`, `manifestDescriptionChars`, `secretDescriptionChars`, `secretHosts`), a failed pod's reason (`setupReasonChars`, `setupCommandExcerptChars`), secret values (`secretValueChars`), the tool policy and budgets (`toolRules`, `toolRuleFieldChars`, `toolRuleTextChars`, `modelBudgets`) and flows (`flowConcurrency`, `flowMapItems`, `flowLoopIterations`, replacing the `NYLORUN_FLOW_*` variables no Host read). Request schemas lose these maxima; the Runtime checks the Tenant's.
  - **More Host tuning** (`NYLORUN_TUNING`): token lifetimes and clock tolerance (`keys.*`), the advance deadline and grace (`execution.*`), `nylorun-operate`'s waits, the credential store's lock, sweep arming, Postgres batches and the replication pool, a basin repair's log cadence, egress sockets, the engine poll and sandbox memory floor, MCP listing pages and diagnostics, sandbox helper commands, the scrub threshold, exec event and local stream sizes; and in the engine, `flowValueChars` and `toolResults.minPreviewBytes`.
  - **The CLI's own waits are `NYLORUN_CLI_TUNING`**: `nylorun start`'s waits and polls, the Compose healthchecks and WAL cap, and `nylorun local sandbox`'s waits.
  - **Studio follows the Runtime's limits**: no upload cap of its own, the Tenant's `requestBodyBytes` read for a write it parses past the default (`@nylorun/agents` exports `RUNTIME_LIMIT_DEFAULTS`), no CPU cap in its form.
  - **Kept, each justified where it is defined**: Linux's `MAX_ARG_STRLEN` (a setup command's ceiling) and `PATH_MAX` (a link target), a model-facing tool name's 64 characters, RFC 6838's media type length, Postgres's 65,535 bind parameters, a tmpfs page, and identifier grammars (the protocol's).

- 6772612: **The remaining request, upload, token and sandbox limits are Tenant settings (harness boundary B15).** Still protocol 15 and Harness API 4. See MIGRATION.md and DEPLOYMENT.md's Runtime limits.

  - **27 more Runtime limits** in `GET`/`PUT /v1/tenant/limits`, each with today's value as its default and a ceiling from a dependency (a JavaScript string or timer, a request read as one string, a Harness API frame, a JavaScript number): request bodies and inline files (`requestBodyBytes`, `inlineFileBytes`), `a2aWaitMs`, `errorExcerptChars`, `traceContentBytes`, an Environment's labels, setup and input files (`environmentLabels`, `environmentSetupCommands`, `environmentFiles`, `environmentFilesPerEntry`, `environmentSecretSlots`, `setupCommandMs`, `setupOutputChars`), disk versions (`diskVersionEntries`, `diskVersionBytes`, `diskLeaseMs`, `diskPodWaitMs`; an Environment's manifest may lower the first two with `limits.disk`), model calls (`modelRequestMs`, `modelIdleMs`, `modelAttempts`, `modelRetryDelayMs`, `modelProviderRetries`, `modelRetryDelayMaxMs`, read by the gates for each call) and tools (`toolAttempts`, `httpToolTimeoutMs`, `mcpPreviewMs`, `mcpMetadataBytes`, and the new `mcpSnapshotBytes`: what a session pins of its MCP servers' tools and instructions, past which a server is left out with a diagnostic).
  - **Schema maxima are checked against the Tenant's limits**: an Environment's labels, setup commands, input files, files per entry, secret slots and setup timeout, and an HTTP tool's `timeoutMs` (at deploy and at each call). `limits.environments` and `lifecycle.stopGrace` lose their arbitrary caps; an identity file's issuer takes any number of grants and `jwksFetch` settings.
  - **`turn.start.limits` carries only a harness's limits** (`HarnessLimitsSchema`, `harnessLimitsOf`), and a harness drops one it does not know. `transcriptUpdates` takes `recordEntryBytes` and fills each event up to it; `CHUNK_BYTES` is gone.
  - **Constants a dependency or a standard fixes stay, named for it**: a token is read up to Node's `http.maxHeaderSize`; artifact names and folder paths keep `FILE_NAME_MAX` (255) and `FILE_PATH_MAX` (1,024); a skill file's path is what `FILE_PATH_MAX` leaves under its mount folder; `tracestate` keeps W3C's 512.
  - **Removed**: `ENVIRONMENT_LABELS_MAX`, `ENVIRONMENT_SETUP_MAX`, `ENVIRONMENT_SETUP_TIMEOUT_MAX_MS` (now `ENVIRONMENT_SETUP_TIMEOUT_DEFAULT`), `ENVIRONMENT_FILES_MAX`, `ENVIRONMENT_SECRET_SLOTS_MAX`, `TOKEN_ENVIRONMENT_GRANTS_MAX`, `HTTP_TOOL_MAX_TIMEOUT_MS`, `READ_ARTIFACT_MAX_BYTES` and `CHUNK_BYTES` from `@nylorun/core`; the image checks (`decodeImageBase64`, `validateImageBytes`, `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`), the Tenant configuration's `modelCall` and `TrustedIssuersOptions`' `refetchMs`/`maxAgeMs` from `@nylorun/runtime`. Studio's Environment form no longer caps setup commands and input files at 16: the Runtime checks the Tenant's limit.

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

## 0.17.1-beta

### Patch Changes

- 000ff75: **READMEs and help text match protocol 14.**

  - `nylorun --help` lists `environments fork`, `manifests` and `delete-version`. The package description no longer offers `nylo` as the Runtime client, and the README says nylorun depends on `@nylorun/agents` too.
  - The READMEs name the current commands: `nylorun tenant keys`, `nylorun tenant mcp inspect`, `nylorun local logs` and `nylorun local reset`. `@nylorun/admin` says it speaks protocol 14.
  - `@nylorun/agents`: a lost MCP or HTTP tool call is sent again with its key, then fails to the model as `tool.interrupted` (it is not left `uncertain`). Every manifest is v7. A2A takes `raw` files. A delegated agent cannot pause.
  - `@nylorun/runtime`: the README describes protocol 14, `PUT /v1/sessions/{id}` says it answers an identical session (vaults are no longer attached), and the database-layout error names `nylorun local reset`.
  - `@nylorun/create-agent`: `nylorun start` writes the project's keys (no key is derived any more).

- Pin core to the tested release.
- Updated dependencies [620072d]
- Updated dependencies [a0cf8b2]
  - @nylorun/core@0.22.0-beta

## 0.17.0-beta

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

## 0.16.0-beta

### Minor Changes

- 35e29b7: **Environments replace sandboxes and vaults (protocol 11). This is a fresh start: upgrading deletes your sandboxes, their disks and every vault except the model's, and closes every open session (its history stays readable).** List what you have before upgrading; see "Environments replace sandboxes and vaults" in MIGRATION.md.

  An Environment is where sessions run: one sandbox (kind `virtual`, `pod` or `none`) with a recipe that can change, and one vault of secrets for its shell, MCP servers and HTTP tools. The app decides who uses which Environment; the Runtime keeps it by id and holds its lifecycle.

  - `@nylorun/core`: protocol 11 (the Host accepts 11 only; older clients get `426`), required feature `environments`. `PutEnvironmentRequestSchema`, `EnvironmentViewSchema` (`recipe`, `version`, `appliedVersion`, `ownerUserId`, `lastUsedAt`), `PutEnvironmentSecretRequestSchema`, `EnvironmentSecretViewSchema`, `ENVIRONMENT_EVENT_TYPES`, `TenantEnvironmentsConfigSchema`, `environmentGranted`. `PutSessionRequest.environment` replaces `sandbox`, `vaultIds` and `credentialSelections`; `SessionView.environment` replaces the session's sandbox and vault fields. Error codes `environment_busy`, `environment_unavailable`, `environment_lost`, `environment_not_granted`, `environment_owner_mismatch` and `session_closed` (the `sandbox_*` codes and `sandbox_expired` are gone); session events `environment.state`, `environment.exec` and `environment.attached`; scope `environments:write`. Credential coverage takes `environmentId` and answers `covered` or `missing`; the MCP preview takes `environmentId`. The vault Management schemas are removed.
  - `@nylorun/runtime`: `/v1/environments/{id}` replaces `/v1/sandboxes/{id}`: `PUT` creates, finds or changes one (`kind` and `storage` fixed; a recipe change bumps `version`; a pod gets a new image or resources at its next start from stopped, a new allowlist within seconds), with list by label, events (`nylorun.environment-event/1`), stop, reset and delete. Each Environment owns one vault: `PUT|GET|DELETE /v1/environments/{id}/secrets/{name}` on the Runtime API, write-only, with a second credential for a host or URL refused at the write (`409 credential_conflict`). An optional owner guard (`ownerUserId`) is checked when a session opens and at every turn start. `lifecycle.deleteAfter` deletes an Environment unused that long; TTL and `onExpiry` are gone. Kind `none` holds secrets for MCP-only agents. `/v1/tenant/vaults`, user and installation vaults, the Tenant's default sandbox, inline sandboxes and `{ session }` sharing are removed. The Tenant setting is `environments.config` (`limits.environments`). Identity files grant `environments:` (an old `sandboxes:` key, or `sandboxes:write`, stops the Runtime with a message naming the new key). Migration `0020_environments`.
  - `@nylorun/harness`: the Harness API claims `environment.state` and `environment.exec`, and its workspace fields name `environmentId`.
  - `@nylorun/agents`: `client.environments` (`put`, `get`, `list`, `page`, `stop`, `reset`, `delete`, `events`, `secrets.put|list|get|delete`, `forSession`) replaces `client.sandboxes`; `createSession({ environment })`; `sessions.page({ environmentId })` filters by Environment. The AG-UI handler's session options take `environment`.
  - `@nylorun/admin`: `admin.coverage({ agentId, environmentId })` replaces `admin.vaults`; `admin.mcp.preview({ url, environmentId })`.
  - `@nylorun/studio`: Environments replace Sandboxes, with a create form, stop, reset, delete and their secrets; the Credentials forms write an Environment's secrets; New session picks an Environment and shows its coverage.
  - `nylorun`: `nylorun sandbox ls|rm` list and delete Environments; `nylorun mcp inspect --environment <id>` replaces `--vault`; `nylo reset --environments` replaces `--sandboxes`; `nylo doctor sandbox` reports the Environment limits.

- 6061a3a: **Tool approvals are the Tenant's tool policy (R5 step 2).** An agent's manifest used to say which tool calls wait for a person, and only the Runtime's own harness asked; a harness built from the Harness API could skip it. Now the operator sets one tool policy for every agent and every harness, and the Runtime enforces it before anything is sent.

  - **`GET`/`PUT /v1/tenant/tool-policy`** (the Management API; `admin.toolPolicy.get()`/`.put({ rules })`): rules `{ effect: "allow" | "ask" | "deny", tool?, server?, kind?, agent?, when?, reason? }`. A rule matches a call when every selector it sets matches (`tool` and `server` take `*` globs; `when` tests input fields by dotted path with `equals`, `in`, `gt`, `gte`, `lt`, `lte` or `matches`). The strictest matching rule decides; a call no rule matches runs.
  - **Enforced for every harness.** Core decides an MCP or HTTP tool call as it journals it. `deny` fails it to the model as `tool.denied`, unsent. `ask` holds the call (`held` at `/calls/tool`) and pauses the turn with one `approval` interaction per held call (`turn.paused`, with the tool, its input and the reason). `approve` sends that exact call, or fails it as `tool.denied`. The Tool Gate runs only calls the journal holds running, so a held or refused call cannot run. Nothing holds a process while it waits: an approval survives a restart. A flow's HTTP stages are decided the same way.
  - **`approval` leaves the manifest.** `PUT /v1/agents/:id` and `saveAgent()` refuse a definition that sets `approval` on an HTTP tool, an MCP server or an MCP tool's settings; `http({ approval })` and `.mcp({ … approval })` throw; a turn manifest can no longer add one. The engine never asks for an HTTP or MCP tool's approval itself. A session pinned to a manifest saved with `approval: "always"` keeps it, as an ask.
  - `@nylorun/studio`: a paused session shows an approval card for each held call, with its tool, why it is held and its input, and **Approve** / **Deny**.
  - Migration: move each `approval: "always"` to an `ask` rule (see MIGRATION.md).

### Patch Changes

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

## 0.15.0-beta

### Major Changes

- 1345f61: **`nylo` ships in `nylorun`; `@nylorun/cli` is deprecated.** One package runs a project's local Tenant (`nylorun`) and is the Runtime client of the linked installation (`nylo`). MIGRATION.md ("`nylo` ships in `nylorun`") has the details.

  - `nylorun`: a second bin, `nylo` (`npx -p nylorun nylo <command>`), with the same commands, flags, output and exit codes as `@nylorun/cli`'s. The `nylorun` command never loads it. nylorun now depends on `@nylorun/admin`, which `nylo` uses. `nylo configure`'s provider sign-in comes from `@earendil-works/pi-ai` (about 100 MB with its provider SDKs), which is not a dependency: the first `nylo configure` installs the tested version into `~/.nylorun/lib/pi-ai-<version>/` with npm, without install scripts, unless it resolves beside nylorun, so `npx nylorun` stays about 11 MB. `nylorun configure`, `nylorun status --env` and `nylorun doctor sandbox` still exit 2, now naming `npx -p nylorun nylo …`. `nylorun status|reset` (the local Tenant's containers and volumes) and `nylo status|reset` (the Management API) keep their meanings; both usages and the README say which is which.
  - **Deprecated (`@nylorun/cli`):** its `nylo` prints one line on stderr and runs nylorun's `nylo` with the same arguments and exit code; stdout is unchanged, so `eval "$(npx @nylorun/cli env)"` still works. It depends on `nylorun` only. A later release removes it.
  - **Breaking (`@nylorun/admin`): the `./project` subpath is removed.** It re-exported `@nylorun/core/project` for `nylo`, which now imports Core directly. Import `@nylorun/core/project` instead.
  - `@nylorun/create-agent`: `compatibility.json` no longer pins `@nylorun/cli`; the examples run `nylo` from their `nylorun` devDependency.

### Patch Changes

- 554df94: **Fixes for the one client layer.**

  - `@nylorun/admin`: `createAdmin` reads the Project link only in its local-Host step. Explicit `url` and `key`, or `NYLORUN_RUNTIME_URL` with `NYLORUN_MANAGEMENT_KEY`, no longer fail on a `.nylorun/link.json` that cannot be read (EACCES for a root-owned file after `sudo npx nylorun start`, EISDIR); the local-Host step refuses such a link, naming it, as it refuses a broken one (when nothing else names the Host root).
  - `@nylorun/admin`: a refusal without the Runtime's rejection body takes its code from the status: `invalid_request` (400), `credential_invalid` (401), `not_found` (404), `unsupported_media_type` (415), `internal_error` (5xx), else `request_rejected`; it was always `not_found`. Studio's own answers (`{ message }`, from its server and proxy, such as "This Studio session is invalid or has expired.") keep their message instead of one naming only the request and the status.
  - `nylorun`: `start` refuses Project or Host root credentials in a newer format than it reads ("Upgrade nylorun"), as it refuses a newer link, instead of replacing them with new keys in its own format.

## 0.14.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [212364b]
  - @nylorun/core@0.19.0-beta

## 0.14.0-beta

### Minor Changes

- 7780b2f: **One client and connection layer.** The Project link and credentials are read one way, and every Runtime client shares one `/health` probe.

  - `@nylorun/core`: `@nylorun/core/project` (Node only, the one Core subpath that imports Node modules) reads the Nylorun home, a local Tenant's Host root (`tenantHostRoot`), the Project root (`findProjectRoot`) and the Project link and credentials (`findLinkedProject`, `readProjectLink`, `readCredentialsFile`), validated with `ProjectLinkFileSchema` and `ProjectCredentialsFileSchema`; a broken or newer file throws `ProjectFileError`. `@nylorun/core/transport` (browser-safe) holds the `/health` compatibility probe (`checkHealth`), `parseProtocolRange` (on `ProtocolRangeSchema`, ignoring fields a newer Host adds), `describeIncompatibility`, `requestHeaders` and `readBody`.
  - `@nylorun/agents`: `resolveConnection` and `createClient()` find the Project as every reader does: the nearest directory with `.nylorun/` from `cwd` upwards, never the home directory or above it (they used to walk to the filesystem root, and past a `.nylorun/` without a link). A link without `credentials.json`, or a link or credentials file that does not validate, is now `connection_missing` naming the file and `npx nylorun start`, instead of a raw file-system or parse error. `@nylorun/agents/client` loads the link reader only when `createClient()` resolves a connection, so it imports no Node module. The root entry re-exports `checkHealth`, `describeIncompatibility` and `parseProtocolRange`.
  - `@nylorun/admin`: `createAdmin` reads the Project link with the same reader. A link that does not validate is now refused like one from an older nylorun (when nothing else names the Host root), and a linked Project's `credentials.json` that does not validate is `connection_missing` instead of being skipped. `@nylorun/admin/project` re-exports `@nylorun/core/project` for tools that depend on this package. The `/health` check and request headers come from `@nylorun/core/transport`.
  - `nylorun`: reads the Project link and credentials with `@nylorun/core/project`; a credentials file whose keys are not 64 hex characters is replaced by `start`, as an unreadable one was. No command changes.
  - `@nylorun/cli`: `nylo` reads the Project root, link and credentials through `@nylorun/admin/project` instead of its own copies, with the same messages. No command changes.
  - `@nylorun/studio`: the server's Runtime compatibility probe is `checkHealth` from `@nylorun/agents`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [7780b2f]
- Updated dependencies [070674d]
  - @nylorun/core@0.18.0-beta

## 0.13.0-beta

### Major Changes

- 50e2f7e: **Protocol 10: MCP credentials come from a session's vaults only.** Nylorun no longer signs the installation in to MCP servers with OAuth and no longer asks a credential resolver. Upgrade every package together; MIGRATION.md has the details.

  - **Breaking (`@nylorun/runtime`): the MCP OAuth connect is gone.** `POST /v1/tenant/vaults/{vaultId}/oauth/start` and `GET /v1/oauth/callback` answer `404`. The vault credential type `oauth` and its refresh are gone: a credential is a `bearer` token or a `headers` map bound to a URL. Migration `0016_mcp_oauth_removed` drops the table of pending connects and deletes every `oauth` credential, writing one audit row each (actor `migration`); the Runtime logs `oauth_credential_removed` once for each, naming its vault, id and URL.
  - **Breaking (`@nylorun/runtime`): the credential resolver is gone.** The gateway no longer asks the operator's resolver for a person's credential when the session's vaults hold none. A process that still sets a `NYLORUN_RESOLVER_*` variable logs `resolver_removed` and ignores it. Keep a person's own keys in their user vault and attach it to their sessions (`vaultIds`). `TenantConfig.resolver`, `TenantConfig.publicUrl`, `TenantConfig.vaultFetch`, `startEphemeralRuntime({ resolver })`, the `ResolverConfig` export and `VaultService`'s `fetch` option are removed; `NYLORUN_PUBLIC_URL` still sets the protected resource metadata's `resource`.
  - **Breaking (`@nylorun/core`):** `PROTOCOL_VERSION` is 10 and `HOST_PROTOCOL` 4–10. `StartOAuthRequest`, `StartOAuthResponse`, the `oauth` variants of `CreateCredentialRequest` and `RotateCredentialRequest`, `oauth` in `CredentialInfo.type` and `CredentialInfo.expiresAt` are removed, and `ERROR_CODES` drops `oauth_client_required`, `oauth_state_invalid` and `oauth_failed`. `@nylorun/agents` and `@nylorun/cli` send protocol 10.
  - **Breaking (`@nylorun/admin`):** `admin.vaults` loses its OAuth start method.
  - **Breaking (`nylorun`):** the `connect` subcommand of `nylorun mcp` is removed (`nylorun mcp inspect` lists a server's tools instead), and the gateway's Compose service no longer passes the `NYLORUN_RESOLVER_*` variables.
  - `@nylorun/studio`: the Credentials page loses the OAuth type, the Expires column and the OAuth connect hint.

### Minor Changes

- da93711: **Preview an MCP server's tools** (R2b C12). MIGRATION.md (protocol 10, "Previewing a server's tools") has the details.

  - `@nylorun/core`: `McpPreviewRequestSchema` and `McpPreviewSchema` (`McpPreviewTool`), and the error code `mcp_preview_failed`.
  - `@nylorun/runtime`: `POST /v1/tenant/mcp/preview` (the Management API) connects to a remote MCP server with the installation vault's credential for its URL (headers and `via`, no identity header), under the Host's address policy and within 15 s, and answers its server info, instructions, tools (model names, annotations, schema sizes) and renames; a `401` is `authRequired`, with the server's RFC 9728 protected-resource metadata. It runs in the keys service (`Keys.previewMcp`), which holds the plaintext, and calls no tool. Both OpenAPI documents list it.
  - `@nylorun/admin`: `admin.mcp.preview({ url, type?, name?, vaultId? })`.
  - `nylorun`: `nylorun mcp inspect <url> [--server <name>] [--vault <id>] [--sse] [--json]` prints the running Tenant's preview: a table of tools, the renames, or that the server needs a person's sign-in. Its `connect` subcommand still says it was removed, and now points to `inspect`.
  - `@nylorun/studio`: **Preview tools** on each credential of the Credentials page lists the tools behind its URL.

### Patch Changes

- fed5e58: **Docs: reaching a person's accounts** (R2b C5). The READMEs describe MCP credentials as protocol 10 has them (a `bearer` token or a `headers` map per URL, with `via` and an identity header for an MCP gateway), and point to "MCP servers and HTTP tools" in DEPLOYMENT.md: the operator's flow from credential to preview, tool settings, deferral, stored results and the error codes a model sees, with gateway recipes for Arcade, ToolHive, Obot and Nylorun Cloud and the proxy pattern for gateways that mint per person. `HttpToolTarget.credential`'s doc (`@nylorun/core`) no longer names the removed credential resolver.
- Pin core to the tested release.
- Updated dependencies [50e2f7e]
- Updated dependencies [e0e39ff]
- Updated dependencies [fed5e58]
- Updated dependencies [18f9a2f]
- Updated dependencies [da93711]
- Updated dependencies [90a817d]
- Updated dependencies [b8d10cb]
  - @nylorun/core@0.17.0-beta

## 0.12.0-beta

### Minor Changes

- cf5eb9c: **Protocol 9: the Runtime API is an OAuth 2.1 resource server for your identity provider's tokens.** Nylorun is still never the authorization server. Upgrade every package together; MIGRATION.md has the details.

  - **Breaking (`@nylorun/runtime`): a refused credential is `401`, not the opaque `404`.** No `Authorization` is `401 credential_required`; an unknown key, or a token no trusted issuer signed or that fails a check, is `401 credential_invalid`. Each carries `WWW-Authenticate: Bearer` (OAuth 2.1 §5.3), naming the protected resource metadata (`resource_metadata`) on the Runtime API when the Runtime has trusted issuers; the Management API's challenge is a bare `Bearer`. `token_expired` and `issuer_unavailable` gain the challenge too. Another Tenant named, a Tenant that could not open and an unsigned capability link stay the opaque `404`.
  - **Breaking (`@nylorun/runtime`): a request with neither `Nylorun-Protocol` nor `Authorization`** on an API route gets that route's `401` challenge instead of `426`, so a generic OAuth client learns where to sign in.
  - `@nylorun/runtime`: a token without a route's scope still gets `403 scope_required`, now with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`. The `Bearer` scheme is matched in any case (RFC 9110).
  - `@nylorun/runtime`: `GET /.well-known/oauth-protected-resource` (RFC 9728) serves the resource (`NYLORUN_PUBLIC_URL`, else the request's origin), the identity file's issuers in order and their scopes, with no key or protocol; `404` without an identity file.
  - **Breaking (`@nylorun/runtime`): the identity file drops `maxLifetime`.** The issuer sets its tokens' lifetimes; `exp` is required, `iat` no longer is. A key the file does not define, `maxLifetime` included, is ignored and logged (`identity_file_key_ignored`) instead of stopping the boot. `subject` defaults to `{sub}`, `scopes` to `{ claim: scope }` and `allowedScopes` to every token scope but `studio`.
  - `@nylorun/core`: `PROTOCOL_VERSION` is 9 and `HOST_PROTOCOL` 4–9, with the required feature `resource-server`; `ERROR_CODES` adds `credential_required` and `credential_invalid`. `@nylorun/agents`, `@nylorun/admin` and `@nylorun/cli` send protocol 9.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [cf5eb9c]
- Updated dependencies [2ed5fe0]
  - @nylorun/core@0.16.0-beta

## 0.11.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [4bd2a0b]
- Updated dependencies [a64aaca]
- Updated dependencies [40b7648]
- Updated dependencies [713e676]
- Updated dependencies [c135267]
- Updated dependencies [d36f0d9]
- Updated dependencies [107b07d]
  - @nylorun/core@0.15.0-beta

## 0.11.0-beta

### Major Changes

- 3b3bdc6: **The clients use management keys (Runtime and Management APIs, step A3).** The protocol stays at 7; every client keeps working against a protocol 7 Runtime's routes.

  - `nylorun`: `nylorun start` keeps an application key (`project`) and a management key (`project-management`) for a Project, in `<Host root>/project-credentials.json` and the Project's `.nylorun/credentials.json` (still format 1, with new `managementKey` and `managementPrincipalId` fields). A credentials file holding only an application key gains a management key at the next start. Commands outside a project keep `cli` and `cli-management`. Keys are issued through `nylorun-operate` in the runtime container instead of the Admin API, and `nylorun key put <id> --management` puts a management key. Seeding the Tenant and `nylorun mcp connect` use the management key (`/v1/tenant/vaults`). Studio reaches the Runtime's public listener.
  - `@nylorun/cli`: `status`, `reset`, `configure`, `doctor` and `access signing-keys` use the Management API through `@nylorun/admin` with the Project's management key, or `NYLORUN_MANAGEMENT_KEY`.
  - `@nylorun/studio`: local Studio needs no login. A request on the published loopback address (`localhost` or `127.0.0.1` at Studio's port) acts as signed in; hosts behind a sign-in proxy and embedding keep their login, and state-changing requests still need Studio's own `Origin`. Studio learns its Tenant from `GET /v1/tenant` with its key instead of the Admin API, and its Connections page manages vaults through `@nylorun/admin/client` at `/v1/tenant/vaults`.
  - **Breaking (`@nylorun/admin`, `@nylorun/runtime`): Studio's key is derived from the admin key alone.** `deriveStudioToken(adminKey)` takes no Tenant id (HMAC-SHA256 over `nylorun/studio/v2`). The Host registers the new key's hash at its next start, replacing the old one; an app that embeds Studio and derives its key must update.
  - `@nylorun/core`: `ProjectCredentialsFileSchema` gains optional `managementKey` and `managementPrincipalId`.

- 7f763c3: **The Admin API and the operator listener are gone (Runtime and Management APIs, step A5).** Host work moves to the machine: `nylorun` runs `nylorun-operate` inside the runtime container, and every remote client uses the Runtime API or the Management API.

  - **Breaking (`@nylorun/runtime`):** `/v1/admin/*` (status, host, shutdown, keys, openapi.json) is removed; it answers like any unknown route. The operator listener, `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`, `NYLORUN_ADMIN_ALLOWED_HOSTS` and `host.json`'s `adminPort` are gone, and so is the `admin-openapi.json` package file. Stop the Host with SIGTERM. `nylorun-operate status [--json]` reports the version, protocol and the Tenant's id, name, state and cause, exiting 2 when the Tenant is not open. `/ready` adds `harness: { mode, connected }` while the Tenant is open. `startEphemeralRuntime` loses `operatorListener` and `adminUrl`. The admin key stays: it derives Studio's key.
  - **Breaking (`@nylorun/admin`):** `createAdmin()` is the Management API client (`tenant`, `keys`, `models`, `vaults`, `signingKeys`, `settings`) with a management key: explicit `{ url, key }`, else `NYLORUN_RUNTIME_URL` + `NYLORUN_MANAGEMENT_KEY`, else the Project link's or the local Host root's management key. `status()`, `adminUrl`, the Admin API keys, `NYLORUN_ADMIN_URL`/`NYLORUN_ADMIN_KEY` and `OPERATOR_KEYS_FEATURE` are removed; `deriveStudioToken` and `mintStudioLoginToken` stay.
  - **Breaking (`@nylorun/core`):** `admin-status` leaves `PROTOCOL_FEATURES` (the Host still advertises it for protocol 5–7 clients) and `operator-keys` is removed; `AdminStatusSchema`, `AdminHostStatusSchema`, `HostAggregateSchema` and `HostShutdownResponseSchema` are removed.
  - **Breaking (`nylorun`):** no admin port: `NYLORUN_ADMIN_PORT` is no longer written or published (an existing one is ignored). `nylorun start` waits for `/ready`, and `nylorun status` reads readiness from `/ready` and the Tenant from `nylorun-operate status`.
  - `@nylorun/cli`: `nylo status` no longer falls back to the Admin API; when the Tenant does not answer it points to `npx nylorun status`.

### Minor Changes

- a6108f4: **The Management API's routes and client (Runtime and Management APIs, step A2).** Additive; the protocol stays at 7.

  - `@nylorun/runtime`: `GET /v1/tenant/keys`, `PUT /v1/tenant/keys/{keyId}` and `DELETE /v1/tenant/keys/{keyId}` manage the Tenant's application keys with a management key. A management key's name, `studio` and `bootstrap` are refused, so no API call creates, rotates or deletes a management key. Vaults (`/v1/tenant/vaults…`, including `…/oauth/start`) and signing keys (`/v1/tenant/signing-keys…`) are also served under `/v1/tenant`, for management keys only; the old `/v1/vaults…` and `/v1/access/signing-keys…` paths keep serving application keys until protocol 8. `GET /v1/oauth/callback` and `GET /v1/access/jwks` keep their paths.
  - `@nylorun/admin`: `createManagementClient({ url, key })` is the Management API's client: `tenant` (status, seed, reset), `keys` (application keys), `models` (catalog, providers, get, put, select, usage, budgets), `vaults` (with credentials and `startOAuth`), `signingKeys` and `settings` (sandbox, artifacts). `@nylorun/admin/client` exports it with no Node module, for browser apps behind a proxy that adds the key.

- c66d8ed: Add optional session reads and a resumable model-ledger export: pinned manifests, usage totals, model calls, and opt-in session/history/sandbox pages (Host feature `session-reads`), and `GET /v1/tenant/calls/model` on the Management API (Host feature `calls-export`). Usage and model calls take an application key acting as itself; the export takes a management key. Runtime reads use a separate bounded, read-only Drizzle pool. The additive migration `0012_session_reads` preserves unknown legacy creation times and usage quality; the export uses safe transaction order without skipping committed rows. `@nylorun/agents` adds `client.sessions.page()`, `session.manifest()`, `session.usage()`, `session.modelCalls()`, `session.history({ limit })` and `client.sandboxes.page()`; `@nylorun/admin` adds `models.exportCalls()`. Legacy unpaged responses are unchanged.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [3b3bdc6]
- Updated dependencies [6576e12]
- Updated dependencies [b28bdd7]
- Updated dependencies [cc107b1]
- Updated dependencies [7f763c3]
- Updated dependencies [98b0d37]
- Updated dependencies [c66d8ed]
  - @nylorun/core@0.14.0-beta

## 0.10.0-beta

### Major Changes

- bd478ee: **Subject tokens, browser keys and derived principals leave open source (F9 I3, protocol 7).** Upgrade these with the Runtime: they speak protocol 7, which this Runtime serves beside 4, 5 and 6; protocol 6 clients keep working on every route that remains. Browsers and apps present a trusted issuer's token (F9 I2), servers an operator key (F9 I1), and a person's own credentials come from the operator's credential resolver (F9 C1). See MIGRATION.md.

  - **Breaking (`@nylorun/runtime`, `@nylorun/core`): subject tokens are gone.** `POST /v1/tokens`, `POST /v1/access/revocations`, subject-token verification, revocation epochs and the `subject.revoked` stream signal are removed; the routes answer `404`, and a JWT no trusted issuer signed is the opaque `404`. A stream opened with a token now ends only at its expiry (`event: nylorun.closed`, reason `token_expired`; `StreamClosedFrame` loses `revoked`). Migration `0010_oss_auth_removals` drops the `subject_epochs`, `subject_usage` and `publishable_keys` tables. The `token` caller is a trusted issuer's token only: it loses `role`, `limits` and `epoch`, and `issuer` is always set; `GET /v1/me` no longer reports `via: token`. Core drops `SUBJECT_TOKEN_TYPE`, `SUBJECT_TOKEN_AUDIENCE`, `subjectTokenIssuer` (the Runtime's own tokens use `tenantTokenIssuer`, same value), `CreateTokenRequest`/`Response`, `RevokeSubject*`, `SubjectTokenClaims`, `TOKEN_TTL_MIN_SECONDS` and `TOKEN_TTL_DEFAULT_SECONDS`; `TOKEN_SCOPES` is `agents:read`, `sessions:own`, `sandboxes:write`.
  - **Breaking (`@nylorun/runtime`, `@nylorun/core`): the access policy and role limits are gone.** `GET`/`PUT /v1/access/policy` answer `404`, a turn is never refused with `429 limit_exceeded` for a role (limit requests at your proxy), and an existing `access.policy` setting is ignored. Core drops `AccessPolicy*`, `AccessRole*`, `RoleLimits*`, `DEFAULT_ACCESS_POLICY`, `PutAccessPolicyRequest` and `ROLE_NAME_PATTERN`.
  - **Breaking (`@nylorun/runtime`, `@nylorun/core`): publishable keys and the Runtime's CORS are gone.** `/v1/access/publishable-keys*` answer `404`, `Nylorun-Key` is ignored, `NYLORUN_BROWSER_ACCESS` and `browserAccess` (host.json, `createHost`, `startEphemeralRuntime`) are removed, and the Runtime sends no CORS headers. A request with `Origin` reaches the Tenant routes of the public listener with no toggle: a trusted issuer's token is served, an application key or delivery token is `403 origin_rejected`; admin routes, `/health`, `/ready` and the operator listener still refuse `Origin`. Any `OPTIONS` request is `204` with `Allow` and no CORS header: the operator's proxy answers preflights. Route declarations lose `browser` (`x-nylorun-browser` leaves the OpenAPI document) and the `publishable` credential; the token security scheme is `issuerToken`. Core drops `PUBLISHABLE_KEY_HEADER`, `PUBLISHABLE_KEY_PATTERN`, `PUBLISHABLE_KEY_ID_PATTERN`, `tenantOfPublishableKey`, `newPublishableKey`, `newPublishableKeyId`, `PublishableKey*`, `OriginEntrySchema`, `originAllowed` and `LOOPBACK_ORIGIN_WILDCARDS`.
  - **Breaking (`@nylorun/runtime`, `@nylorun/core`, `@nylorun/agents`): vault routes are application-only, and `vaults:own` is retired.** Every `/v1/vaults` route takes an application key acting for no one (operator keys, Studio); a request acting for a subject or a trusted issuer's token gets `403 scope_required`. `vaults:own` leaves `SUBJECT_SCOPES`, `TOKEN_SCOPES` and the issuer scopes; `Nylorun-Scopes` may still name it and it grants nothing. Existing user vaults stay attachable to their own owner's sessions. `client.createVault` takes `{ scope: "installation" }` or `ownerUserId`, and `client.listVaults()` takes an optional owner.
  - **Breaking (`@nylorun/runtime`, `@nylorun/core`, `@nylorun/admin`, `nylorun`): derived principals are gone.** Only Studio's key is derived from the admin key. `NYLORUN_DERIVED_PRINCIPALS` is ignored and no longer written, `hostPrincipals` takes no `derived`, `startEphemeralRuntime` no `derivedPrincipals`, and `@nylorun/admin` drops `deriveTenantKey`, `PROJECT_PRINCIPAL_ID` and `admin.deriveTenantKey`. Keys an earlier Host derived stay in the database and keep working as ordinary keys; replace them with operator keys. Core renames `DERIVED_PRINCIPAL_ID_PATTERN` to `APPLICATION_KEY_ID_PATTERN`.
  - **Breaking (`@nylorun/agents`):** `createTokenEndpoint`, `createBrowserClient` and the `@nylorun/agents/browser` entry, `client.tokens`, `TokensClient`, `PublishableKeysClient`, `client.access.getPolicy`/`putPolicy`/`revokeSubject`/`publishableKeys` and `Destination.publishableKey` are removed. `client.access.signingKeys` and `client.access.jwks()` stay, and `Destination.token` takes a trusted issuer's tokens.
  - **Breaking (`@nylorun/cli`):** `nylo access policy|keys|revoke|token` are removed and name what replaces them; `nylo access signing-keys list|rotate|revoke` stays.
  - **Breaking (`@nylorun/core`, `@nylorun/agents`, `@nylorun/studio`): the Studio embed message `open.babai` is now `open.session`** (`{ sessionId }`): it asks the embedding app to open that session in its own UI. Studio sends no such message itself.
  - **Breaking (`nylorun`): Studio embedding is opt-in.** No origin may frame Studio by default; list your app's origins with `nylorun start --studio-embed-origin <origin>`. A Tenant's `.env` from an earlier nylorun keeps the origins it had until `--studio-embed-origin-reset`.
  - `PROTOCOL_VERSION` is 7 and `HOST_PROTOCOL` 4–7; the Host features `subject-tokens`, `browser-access` and `derived-principals` are removed. `@nylorun/studio` and `@nylorun/create-agent` speak protocol 7.

### Minor Changes

- 5cfaed9: **Operator keys, and project links on them (F9 I1).** The Admin API manages the Tenant's application keys by name: `PUT /v1/admin/keys/{id}` creates a key or rotates it and returns it once, `GET /v1/admin/keys` lists every key's id, role and issue time (never the keys), and `DELETE /v1/admin/keys/{id}` removes one. A rotated or deleted key stops authenticating on its next request. Ids follow `^[a-z][a-z0-9-]{0,31}$`; `studio` (derived from the admin key) is refused. Keys keep today's format (64 hex) and only their SHA-256 is stored, in the existing principals table (no migration). Host feature `operator-keys` (additive, protocol unchanged); core adds the `OperatorKey`, `ListOperatorKeysResponse`, `PutOperatorKeyResponse` and `DeleteOperatorKeyResponse` schemas.

  - `@nylorun/admin`: `admin.keys.put(id)`, `admin.keys.list()` and `admin.keys.delete(id)`; they refuse with `incompatible_host` when the Host lacks `operator-keys`.
  - `nylorun key put|list|rm <id>` manages a running local Tenant's keys; `put` prints the key once on stdout.
  - `nylorun start` no longer derives the project's key. It keeps `.nylorun/credentials.json` while its key still reaches the Tenant (one authenticated read); otherwise it gives the project the operator key `project`, which the Host root keeps in `project-credentials.json` (0600) so every checkout linked to the Tenant shares it. An existing derived project key keeps working and is adopted.
  - `nylorun sandbox` uses the linked project's key, or the operator key `cli` it puts once and keeps in `<Host root>/cli-credentials.json` (0600).
  - The ephemeral Runtime (`startEphemeralRuntime`) no longer registers the derived `project` principal; pass `derivedPrincipals: ["project"]` to keep it. Derived principals (`NYLORUN_DERIVED_PRINCIPALS`, `deriveTenantKey`) still work on a Host.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [8773586]
- Updated dependencies [e1bfb4b]
- Updated dependencies [5cfaed9]
- Updated dependencies [bd478ee]
- Updated dependencies [c0b604e]
  - @nylorun/core@0.13.0-beta

## 0.9.0-beta

### Major Changes

- b352feb: **File artifacts, message parts and capability links (protocol 6).** Upgrade these with the Runtime: they speak protocol 6, which this Runtime serves beside 4 and 5. See MIGRATION.md.

  - **`@nylorun/runtime`: file artifacts.** A file is an artifact: an `af_` id, a name and numbered immutable versions, with rows in the new `artifacts` and `artifact_versions` tables (migration `0004_artifacts`) and bytes in the Object store (`BlobStore`). `POST /v1/artifacts?name=&sessionId=` uploads a file in one streamed request and `POST /v1/artifacts/{id}/versions` adds a version, within the Tenant's limits (`GET`/`PUT /v1/tenant/artifacts`: 100 MiB per file and 10 GiB in all by default); a body past either is `413 limit_exceeded`, refused mid-stream with nothing stored. `GET /v1/artifacts` lists them (by session), `GET /v1/artifacts/{id}` reads one with its versions, `GET /v1/artifacts/{id}/versions/{n|latest}/content` downloads through the Runtime with HTTP Range (`206`, `Content-Range`, `416`), and `DELETE /v1/artifacts/{id}` deletes it with its bytes. A session's artifacts go with it on a sessions reset, and appear in its history as `artifact.created`, `artifact.version.created` and `artifact.deleted` (new in the event catalog). A subject reaches only the artifacts of their own sessions.
  - **`@nylorun/runtime`: capability links.** `POST /v1/artifacts/{id}/links` mints a short-lived path, `/v1/artifact-links/<token>`, that downloads one version (with Range) with no credential and no `Nylorun-Protocol`: an ES256 JWT (`typ: nylorun-artifact+jwt`) signed with the Tenant's signing key, at most 15 minutes, and dead once the artifact is deleted. The Host logs its path without the token.
  - **Breaking (`@nylorun/core`, `@nylorun/runtime`): message `parts`.** A user message may carry `parts`: `text`, and `file` by `artifactId` (and `version`, else the latest, pinned when the message is accepted). Model-gate reads the file from the Object store: an image goes to the model as image input, a text file as text, and any other file fails the call (`invalid_request`). The record and the transcript hold only the reference. The gateway builds its `BlobStore` from `NYLORUN_OBJECT_STORE_*` (the Tenant's `fs` store without it). `PROTOCOL_VERSION` is 6; `HOST_PROTOCOL` is 4–6 and protocol 6 clients require the feature `artifacts`.
  - **`@nylorun/runtime`: `save_artifact`.** A session with a sandbox gets the `nylorun.artifacts` capability, whose `save_artifact` tool saves a sandbox file (`path`) or text (`content`) as an artifact of the session, carrying the turn and tool call on its event.
  - **Breaking (`@nylorun/runtime`): `MediaStore` is removed.** `MediaStore` and `localMedia` leave `@nylorun/runtime/node`, and `piModel` takes `files` (a resolver from an artifact reference to its bytes) instead of `media`; images are file artifacts. The image checks (`decodeImageBase64`, `validateImageBytes`, `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`) stay.
  - **`@nylorun/agents`:** `client.artifacts` (`upload`, `uploadVersion`, `list`, `get`, `download` with a range, `link`, `delete`), also on `BrowserClient`, and `session.inputParts(parts)`. A request with a body of its own type keeps it.
  - `@nylorun/admin`, `@nylorun/cli`, `nylorun`, `@nylorun/studio`: speak protocol 6.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [b352feb]
- Updated dependencies [6077272]
- Updated dependencies [b6bf1f5]
- Updated dependencies [8ed4ea6]
- Updated dependencies [678e085]
- Updated dependencies [926711b]
  - @nylorun/core@0.12.0-beta

## 0.8.0-beta

### Minor Changes

- 4b9906f: **Breaking: "Tenant" replaces "stack", and `nylorun start` works anywhere.** Each local installation holds one Tenant, and its name is the Tenant's name, so help, output, errors and docs say Tenant. See MIGRATION.md.

  - **Breaking (`nylorun`): selection.** Every command acts on the Tenant `--tenant <name>` names (replaces `--name`, which is removed), else `NYLORUN_TENANT` (replaces `NYLORUN_STACK`), else the Project link's `tenant`; `start` in a project names a new one after the project directory. Outside a project, or with `start --no-link`, commands act on the Tenant `default`. In a project without a link, commands other than `start` exit 2 and list the machine's Tenants. A name starting with `tn_` (a Tenant id) is refused.
  - **Breaking (`nylorun`): files.** Host roots are under `~/.nylorun/tenants/<name>/` (was `~/.nylorun/stacks/<name>/`) with `tenant.json` (was `stack.json`); the `.env` key is `NYLORUN_TENANT_NAME` (was `NYLORUN_STACK_NAME`); `NYLORUN_COMPOSE_PROJECT` replaces `NYLORUN_STACK_PROJECT`. Compose projects stay `nylorun-<name>`. Every command first moves 0.4 Host roots from `~/.nylorun/stacks/` to `~/.nylorun/tenants/` (renaming `stack.json` and the `.env` key), so they keep their volumes and keys. `nylorun ls` lists only directories with `tenant.json`.
  - **Breaking (`nylorun`): removed.** `nylorun legacy` and all handling of the single stack of releases before 0.4; the hidden `nylorun stack <cmd>` alias; `nylorun doctor stack|runtime`. Output says Tenant: `ls` prints `TENANT` and JSON `{ "tenants": [...] }`, `status` prints the Tenant id on its own line, and `doctor`'s row is `tenant`.
  - **Breaking: Project link format 3.** `.nylorun/link.json` is `{ "format": 3, "tenant", "tenantId", "hostUrl", "hostId" }`; `tenant` replaces `stack`. `@nylorun/agents`, `@nylorun/cli` and `@nylorun/admin` refuse an older link and name `npx nylorun start`, which rewrites it. `@nylorun/core`'s `ProjectLinkFileSchema` parses formats 0–3 with `tenant`.
  - **Breaking (`@nylorun/admin`):** `createAdmin({ tenant })` replaces `{ stack }`, `tenantHostRoot(name)` replaces `stackHostRoot(name)`, and local resolution reads `NYLORUN_TENANT` and the link's `tenant`.
  - `@nylorun/cli`: `status` and `endpoints` drop the `stack` line and JSON key; messages say Tenant. `@nylorun/agents`: a Runtime too old for the client says "update the Runtime (npx nylorun@latest start)". `@nylorun/studio`: setup hints say Tenant. `@nylorun/create-agent`: the next steps describe `npx nylorun@beta start` as this project's Tenant and its link.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [4b9906f]
  - @nylorun/core@0.11.0-beta

## 0.7.0-beta

### Major Changes

- 5ca1923: **Clients for one Tenant per installation: a stack per project, nothing selects a Tenant.** Upgrade these with the Runtime; they speak protocol 5. Existing stacks are left as they are: see MIGRATION.md.

  - **Breaking (`nylorun`): one stack per project.** `nylorun start` in a project creates the project's stack (named after the project directory, or `--name`; Host root `~/.nylorun/stacks/<name>/`, Compose project `nylorun-<name>`, its own free ports and volumes), waits for its Runtime to create the stack's Tenant, writes the Project link (`.nylorun/link.json` format 2: `stack`, `hostUrl`, `hostId`, `tenantId`) and `.nylorun/credentials.json` (the key of the derived principal `project`, derived from the stack's admin key), and seeds the model provider from the project's `.env`. `nylorun ls` lists the machine's stacks and `nylorun delete <name>` removes one with its volumes and Host root. `nylorun status` shows the stack's Tenant; `nylorun studio` opens it. The old single stack under `~/.nylorun` is never touched: `start` notes it, and `nylorun legacy stop|delete` handles it. Every stack command takes `--name <stack>` (or `NYLORUN_STACK`, or the Project link's stack); `start --no-link` starts a stack without linking the directory; `nylorun reset` resets the selected stack only. The runtime container's healthcheck is now `/health`, so a Tenant that cannot open is reported by `start` from the Admin status at once instead of after a 300 s wait. `NYLORUN_HOME` still overrides the Host root. Stacks start and stop only when you say so.
  - **Breaking (`@nylorun/cli`): no Tenant commands.** `nylo tenant create|use|list|current|delete` are removed; `nylo status`, `nylo reset` and `nylo endpoints` replace `nylo tenant status|reset|endpoints` on the linked installation. `nylo env` prints `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY` only. `nylo` no longer writes Project links.
  - **Breaking (`@nylorun/agents`): no Tenant to name.** The `tenant` option (`createClient`, `Transport`, `resolveConnection`, `createActionHandler({ runtime })`, `JwksCache`) and `NYLORUN_TENANT` are gone, and no request sends `Nylorun-Tenant`; a connection is a URL and a key. A Project link of format 0 or 1 is refused with `connection_missing`, naming `npx nylorun start`. `verifyDeliveryToken`'s `tenantId` is optional: without it any Tenant issuer is accepted, since the installation's keys bind it. `TENANT_HEADER` is no longer re-exported.
  - **Breaking (`@nylorun/admin`): status only.** `createTenant`, `listTenants`, `getTenant` and `deleteTenant` are removed; `status().tenant` names the Host's Tenant, and `deriveTenantKey` / `deriveStudioToken` derive its keys. Local Host resolution reads the stack's Host root (`stack` option, `NYLORUN_STACK`, or the Project link's `stack`); `NYLORUN_HOME` and `home` still override it. `stackHostRoot(name)` is exported.
  - **Breaking (`@nylorun/studio`): Studio serves its installation's Tenant.** The Tenant picker, list and create are gone, with `/_studio/tenants`; `/` opens `/tenants/<id>`. The `/tenants/:tenant` routes and the login token's `tenant` claim stay for embedders and must name that Tenant. The proxy sends no `Nylorun-Tenant`.
  - **`@nylorun/create-agent`:** the next steps are `npx nylorun start`, then `npm run dev`.
  - `@nylorun/core`: `ProjectLinkFileSchema` accepts format 2 with `stack`, and `tenantId` is optional; `ERROR_CODES` loses `tenant_conflict` and `active_work`.

- 5ca1923: **One Tenant per installation: a database per Tenant, protocol 5.** A Runtime serves exactly one Tenant, the one its Postgres database holds. Two Tenants are two installations.

  - **Breaking: fresh start.** The Tenant's state is in the fixed schema `nylorun` of its own database and its record in `nylorun_streams`, keyed by session (no `tenant_id`). A database written by an earlier Runtime (`tenant_<id>` schemas, or a record keyed by Tenant) is refused: the Host stays up but not ready, and `/v1/admin/status` names the cause `database-layout-old`. Point the Runtime at a new database (with the local stack, a new stack); the old one is never changed.
  - **The Host creates its Tenant** on first start, in the migration transaction: `NYLORUN_TENANT_ID` (default a new id), `NYLORUN_TENANT_NAME` (default `default`), the Studio principal and the derived principals of `NYLORUN_DERIVED_PRINCIPALS` (comma-separated, default `project`), whose keys the admin key derives (`deriveTenantKey`). Later starts open the same Tenant and add derived principals configured since.
  - **Breaking: no Tenant catalog.** `/v1/admin/tenants` and `/v1/admin/tenants/{tenantId}` are gone (404). `AdminStatus.tenants[]` is replaced by `AdminStatus.tenant` (`id`, `name`, `state: open | unavailable`, `envelope`, and `cause` when it could not be opened). `CreateTenantRequestSchema`, `AdminTenantSchema`, `AdminTenantStatusSchema`, `AdminTenantListSchema` and `QuarantineSchema` leave `@nylorun/core`; `HostTenantSchema` and `TenantCauseSchema` replace them. `@nylorun/admin`'s `listTenants`, `getTenant`, `deleteTenant` and `createTenant` are removed (see below).
  - **Readiness instead of quarantine.** A Tenant that cannot be opened (`schema-too-new`, `kek-missing`, `migration-failed`, `envelope-invalid`, `database-layout-old`, …) fails `/ready` (check `tenant`, which replaces `discovery`) and is reported with its repair in `/v1/admin/status` and the log; every Tenant request gets the opaque 404. A failure outside it (Postgres unreachable) is retried.
  - **Protocol 5.** `PROTOCOL_VERSION = 5`; the Host serves protocols 4 and 5 for one release. Clients no longer require `runtime-tenants`; the Host still advertises it. No request needs `Nylorun-Tenant`: a request without it reaches the Host's Tenant, and one naming another Tenant (or a malformed one), or a publishable key of another Tenant, gets the opaque 404. The OpenAPI documents drop the header parameter and the Admin Tenant routes.
  - **Paths.** The Tenant directory is `<Host root>/tenant/` (was `tenants/<id>/`); `trash/` and the SQLite move to it are gone. The gates service serves its database's Tenant, and its `Nylorun-Tenant` header is optional (when sent, it must name that Tenant).
  - **Breaking: `startEphemeralRuntime` needs a database; the in-memory Session Store is removed.** `StartEphemeralRuntimeOptions.database` is required: a Postgres URL, for which the Runtime opens a pool and ends it on `close()`, or a pool the caller ends. It creates its Tenant in that database through the same bootstrap as a Host, or serves the Tenant the database already holds; the data stays after `close()`, so give each test Tenant a database of its own. Durable Streams and scheduling stay in process. See `MIGRATION.md`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [fed780d]
- Updated dependencies [fed780d]
- Updated dependencies [7f4c3f1]
- Updated dependencies [5ca1923]
- Updated dependencies [5ca1923]
  - @nylorun/core@0.10.0-beta

## 0.6.0-beta

### Minor Changes

- 50d0fb5: **The Admin API on its own listener.** A Runtime can serve the Admin API on an operator listener, so the port that faces browsers and reverse proxies serves the Tenant API alone. The stack does this by default.

  - **Runtime.** With an operator listener (`adminPort` in `host.json`, or `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST` and `NYLORUN_ADMIN_ALLOWED_HOSTS` in a container), the public listener answers `/v1/admin/**` with the opaque `404` and the operator listener serves the Admin API, Host shutdown and the Tenant API, never to browsers. Each checks `Host` against its own port. `/ready` needs both listening; a taken port on either exits with code 98. Without one, a single listener serves everything as before.
  - **Stack.** `nylorun start` publishes the operator port on loopback (`NYLORUN_ADMIN_PORT`, default 8788), writes it to `host.json` as `adminPort`, and points Studio at `runtime:4001`. `nylorun status` prints it.
  - **Admin client.** Reads `adminPort` from `host.json` and sends Admin API requests there (`admin.adminUrl`); `admin.url` stays the Tenant API URL. A `host.json` without `adminPort` keeps working.

- 9d52189: **Embedding Studio in a desktop app.** Studio can be shown inside a desktop app such as Babai Desktop, in an iframe loaded from its URL and signed in by `postMessage` with a token limited to one Tenant.

  - **`nylorun`.** The local stack lets Babai's origins frame Studio: `NYLORUN_STUDIO_FRAME_ANCESTORS` in `stack/.env` defaults to `nylorun://localhost http://nylorun.localhost` and is passed to the Studio container. `nylorun start --studio-embed-origin <origin>` (repeatable) adds an exact origin, such as a desktop app's dev server, and keeps it across starts until `--studio-embed-origin-reset`. Wildcards are refused. `nylorun status` lists the origins under `Embeds`, and `status --json` as `studio.embedOrigins`.
  - **`@nylorun/admin`.** `mintStudioLoginToken({ studioUrl, adminKey, tenant?, subject? })` mints a single-use Studio login token from an app's backend. With `tenant`, the session it leads to reaches only that Tenant.
  - **Studio.** `POST /_studio/sessions` exchanges such a token for a one-hour bearer session kept in the frame's memory; dashboard pages send `frame-ancestors` from the allowlist instead of `X-Frame-Options: DENY`; `?embed=1` hides Studio's branding, follows the app's theme and routes, and reports its own; `/tenants/:tenant/sessions/:session` opens a session by id. The cookie login of `nylorun studio` is unchanged.

    The dashboard routes `/tenants/:tenant`, `/tenants/:tenant/agents/:agent`, `/tenants/:tenant/agents/:agent/sessions/:session`, `/tenants/:tenant/sessions/:session`, `/tenants/:tenant/vault` and `/tenants/:tenant/settings` are now a public contract for embedders: removing or changing one is a breaking change.

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

## 0.5.0-beta

### Minor Changes

- db956bc: Studio creates Tenants. While the Host has none, Studio asks for a name and creates the first one. A Tenant with no agents shows **Connect your code**: its model provider, the `npx @nylorun/cli tenant use <id>` command, and `npm run dev`. It switches to the agent list when the first agent registers.

  Every Tenant Studio creates registers the derived principal `project` (`PROJECT_PRINCIPAL_ID` in `@nylorun/admin`). `nylo tenant use` now falls back to that key, derived from the local admin key, so a Project links a Studio-created Tenant with no stored key. When it replaces a one-time application key, it keeps that key as `.nylorun/credentials.<tenantId>.json`, and `nylo tenant use <that id>` switches back. `nylorun up` again offers Studio for creating the first Tenant.

## 0.4.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies [8cda500]
  - @nylorun/core@0.8.0-beta

## 0.4.0-beta

### Minor Changes

- a322696: **Derived principals** (optional Host feature `derived-principals`): a client that holds the admin key no longer needs to store an application key.

  - `admin.createTenant({ name, principals: ["babai"] })` registers each named principal by the hash of its derived key, and `admin.deriveTenantKey(tenantId, principalId)` (or `deriveTenantKey(adminKey, tenantId, principalId)`) recomputes the key when needed.
  - `POST /v1/admin/tenants` accepts `derivedPrincipals: [{ id, credentialHash }]`. Ids match `^[a-z][a-z0-9-]{0,31}$` and `studio` is reserved; duplicate ids or credentials answer `400`. A retried create must name the same principals.
  - `createTenant` with `principals` throws `incompatible_host` before sending anything to a Host without the feature.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies [a322696]
  - @nylorun/core@0.7.0-beta

## 0.3.0-beta

### Minor Changes

- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [bf1c2da]
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
  - @nylorun/core@0.6.0-beta

## 0.2.0-beta

### Minor Changes

- c49efed: **New package:** Admin API client for managing clients (CLI, desktop Runtime panel, CI). Exports `createAdmin` with `createTenant`, `listTenants`, `getTenant`, `deleteTenant`, and `status`. Depends only on `@nylorun/core`. Resolves connection from options, then `NYLORUN_ADMIN_URL`/`NYLORUN_ADMIN_KEY`, then local Host settings (`host.json` + `host-credentials.json`). Developer applications do not depend on this package.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
  - @nylorun/core@0.5.0-beta

## 0.1.0-beta

- Package skeleton (Wave 0).
