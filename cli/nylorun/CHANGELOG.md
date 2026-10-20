# nylorun

## 0.18.3-beta

### Patch Changes

- Pin core to the tested release.
- Pin agents to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [fce0c9b]
- Updated dependencies [ab7c08a]
- Updated dependencies [4a563e7]
- Updated dependencies
- Updated dependencies
  - @nylorun/core@0.26.0-beta
  - @nylorun/agents@0.26.0-beta
  - @nylorun/admin@0.19.2-beta

## 0.18.2-beta

### Patch Changes

- Pin studio to the tested release.

## 0.18.1-beta

### Patch Changes

- Pin studio to the tested release.

## 0.18.0-beta

### Minor Changes

- eeb6294: Session usage as one ledger (protocol 18). The usage ledger keeps each model call's cost by token kind (uncached input, cache read, cache write, output) at the prices the adapter applied (migration 0037). For a protocol 18 client, `GET /v1/sessions/{id}/calls/model` returns each call's `startedAt`, `endedAt` and `usage.costSplit` (null for a call recorded before), and `GET /v1/sessions/{id}/usage` adds `costSplit` with `splitCalls`, and the calls' durations added up as `modelTimeMs` with `timedCalls`. A protocol 16 or 17 client reads usage as before. Studio's Usage tab is rebuilt on them: a Session card with one tokens bar and a ledger of tokens and cost by kind adding up to a total row, then the model calls grouped by turn with the same columns (cached, uncached, output, total, time, cost), and a row menu whose View event opens the call's event in the Events tab.

### Patch Changes

- ed08ba8: Public text names no internal roadmap codes: the OpenAPI documents' descriptions, the type comments of `@nylorun/core`, `@nylorun/agents` and `@nylorun/admin`, and the CLI's help, README and generated compose file. A Runtime test fails when either OpenAPI document names one.
- ed08ba8: `nylo` and the deprecated `@nylorun/cli` name the release that removes them, nylorun 0.19, where they said "one release": `nylo`'s message ends "nylorun 0.19 removes nylo.", and `@nylorun/cli`'s stderr line, description and README say nylorun 0.19 removes both.
- ed08ba8: `--help` (or `-h`) works on every command and subcommand: it prints that command's own usage on stdout and exits 0, where `nylorun migrate v8 --help`, `nylorun tenant budgets --help` and others exited 2 with "Unknown option --help", and `nylorun tenant settings --help` printed the usage of `budgets`, `tool-policy` and `coverage` too. `nylorun --help` lists every `agents` command (`pin`, `track`, `restart`, `triggers`, `runs` and `memories` were missing) and `migrate v8 --name`, and the README lists `agents pin`, `track`, `restart`, `put --dry-run`, `fork --label` and `list --outdated`.
- ed08ba8: Webhook URLs name the Runtime's public URL. A trigger's `webhookUrl` is at `NYLORUN_PUBLIC_URL`, else the origin the request reached, so behind a reverse proxy that rewrites `Host` to `localhost:<port>` it is the proxy's URL, not `http://localhost:<port>`; the Runtime API's `401` challenges name it too. `nylorun start` passes `NYLORUN_PUBLIC_URL` from its shell to the runtime container (default `http://localhost:<port>`).
- Pin core to the tested release.
- Pin agents to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [ed08ba8]
- Updated dependencies [ed08ba8]
- Updated dependencies [ed08ba8]
- Updated dependencies [ed08ba8]
- Updated dependencies [eeb6294]
- Updated dependencies [ed08ba8]
- Updated dependencies
- Updated dependencies
  - @nylorun/core@0.25.0-beta
  - @nylorun/agents@0.25.0-beta
  - @nylorun/admin@0.19.1-beta

## 0.17.0-beta

### Minor Changes

- cc8d034: Track T3 in the clients. The SDK has `client.agents.plan(id, input)` (what a move would do), `client.agents.restart(id, { retry? })` and `list({ outdated: true })`. The CLI has `nylorun agents pin <id> <n>`, `track <id>`, `restart <id> [--retry]`, `put --dry-run`, and `list --outdated` (`--behind` kept as its alias), and prints the version an Agent moves to. Studio's Agent page moves an Agent (Move to vN, Pin, Track), restarts it on a pending version or retries a failed one, and shows "vN at next start", a version waiting for secrets, or one that failed to start. The starter's dev loop no longer deletes and remakes its Agent: the tracking Agent moves on each save.
- 22c61ce: Protocol 16, Agents from one manifest (track T2), a fresh start. An agent manifest (v8) is one versioned document at `/v1/agent-manifests/{name}` with a `harness` section (what runs inside the loop, including the harness's id) and a `runtime` section (what an environment manifest said). The Runtime checks the two against each other when it is saved (`422 manifest_inconsistent` with `details.gaps`), in place of `requires` at session open. Agent definitions and environment manifests are gone.

  Environments are Agents: `/v1/agents/{id}` and its sub-routes, made from a saved manifest only (`manifest: "name"` tracks it, `"name@n"` pins a version; either resolves once, into `resolvedVersion`), with a derived `state` (`working`, `sleeping`, `input_required`, `failing`, `paused`) and `attention`. Every session runs on one Agent (`PUT /v1/sessions/{id} { agent, ownerUserId }`) and pins its manifest version. No session is special (D71). Error codes, events (`agent.*`), scopes (`agents:write`, `agent-manifests:write`) and identity-file grants (`agents`) say Agent; model budget scope `agent` is `manifest`. Harness API 5: `turn.start.agent` replaces `turn.start.environment`, with `definition` and `loop`. Migration 0032 closes older sessions (`protocol_16`) and drops Environments with their disks and vaults.

  The SDK has `client.agentManifests`, `client.agents` and `composeManifest(dir)` for three-file authoring; the CLI has `nylorun apply`, `nylorun agent-manifests`, `nylorun agents` and `nylorun migrate v8`; Studio has an Agents screen, an Agent page and an Agent manifests screen. See MIGRATION.md.

- 4fa160d: Agent memory, storage and API (track T5, D72). An agent manifest's `harness.memory` (`access`: `read_write` or `read_only`; `instructions`, at most 4,096 characters) turns on the Agent's memory: Markdown files under `/memories` it keeps across sessions, wakes and upgrades. The Runtime keeps them in Postgres (`memories`, `memory_versions`, migration 0036) with a version per change and who made it. `GET /v1/agents/{id}/memories` lists them (`pathPrefix`), `GET`, `PUT` (whole content, with an optional `contentSha256` precondition: `409 memory_conflict`) and `DELETE /v1/agents/{id}/memories/{path}` read, write and delete one (or a folder), and `GET /v1/agents/{id}/memory_versions` and `.../memory_versions/{versionId}` page the versions. A fork copies the memories (the fork plan adds `memories`); a delete removes them. `@nylorun/core` adds `memoryPathOf`, `memoryDescriptionOf` and the memory contracts; new Runtime limits `memoryBytes` (100 KiB) and `memoriesPerAgent` (10,000); new error code `memory_conflict`. The SDK adds `client.agents.memories`; the CLI adds `nylorun agents memories ls|cat|put|rm|versions`. The model's `memory` tool arrives in the next steps of T5.
- 9e60e40: Protocol 17, a queue per session (track T4, D76). A message sent while the session's turn runs or waits is queued (`{status: "queued", queuedMessageId, position}`, `message.queued`) and starts the next turn when this one ends, with every queued message, each its own user message (`queue.taken`); a cancel ends the turn, not the queue. `delivery: "reject"` keeps the refusal, now `409 session_busy`, and a protocol 16 client's messages default to it, so the Host serves protocol 16 and 17. The queue holds at most the Runtime limit `sessionQueuedMessages` (`429 queue_full`), and session reads count `queuedMessages`. Our engine takes `{kind: "messages", messages}` as a turn's input. The SDK's `input` and `inputParts` take `delivery`, and the CLI's `sessions send` takes `--reject-if-busy`. See MIGRATION.md.
- f85483d: Triggers (track T4, D74). An agent manifest's `runtime.triggers` declares `schedule` (cron with an IANA `timezone`) and `at` triggers, each with the session its runs go to (a session id, opened on the first run, or `new` for a session per run) and its prompt. They start active with a new Agent, fire on a durable timer per trigger with Postgres as the truth (one late fire after downtime, never a backfill, a fixed jitter per trigger), and each fire is a run (`started`, `queued`, `skipped` or `failed`, with a reason) at `GET /v1/agents/{id}/runs`. A schedule adds at most one queued message to a busy session. `GET /v1/agents/{id}/triggers` and `POST .../triggers/{triggerId}/pause`, `/resume` and `/run` (with an `Idempotency-Key`); Agent reads add `nextWakeAt`, and the Agent's stream adds `agent.run`, `agent.trigger_paused` and `agent.trigger_resumed`. New Runtime limits: `triggersPerAgent`, `triggerMinIntervalMs` and `triggerRunRetentionMs` (with floors), `triggerRunsPerHour`, `triggerJitterPercent`, `triggerJitterMaxMs`, `triggerPromptChars`; Host tuning `triggers.lateGraceMs` and `triggers.intervalCheckFires`. The SDK's `client.agents` adds `triggers`, `pauseTrigger`, `resumeTrigger`, `runTrigger` and `runs`; the CLI adds `nylorun agents triggers` and `nylorun agents runs`.
- ae54de7: Webhook triggers (track T4, D75). A `webhook: "standard-webhooks"` trigger has an endpoint, `POST /v1/webhooks/{endpointId}`, an anonymous, unversioned route that takes any body up to the new Runtime limit `webhookBodyBytes` and verifies Standard Webhooks (`webhook-id`, `webhook-timestamp` within the Host's `triggers.webhookToleranceMs`, `webhook-signature`) in the keys service, which alone opens the trigger's sealed secret; anything else is `401` and writes nothing. A delivery runs the trigger once per `webhook-id` (`202 {runId, status}`); a paused trigger answers a signed one `409 trigger_paused`. `POST /v1/agents/{id}/triggers/{triggerId}/secret` makes or replaces the `whsec_` secret, shown once (`agent.trigger_secret_rotated`); trigger reads show `webhookUrl` and `secretSet`. The payload reaches the model under the trigger's prompt in a labelled `<trigger-payload>` block. The SDK adds `agents.rotateWebhookSecret`, and the CLI `nylorun agents triggers new-secret`.

### Patch Changes

- Pin core to the tested release.
- Pin agents to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [218b078]
- Updated dependencies [cc8d034]
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
- Updated dependencies
- Updated dependencies
  - @nylorun/core@0.24.0-beta
  - @nylorun/agents@0.24.0-beta
  - @nylorun/admin@0.19.0-beta

## 0.16.0-beta

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

- 6772612: **The remaining request, upload, token and sandbox limits are Tenant settings (harness boundary B15).** Still protocol 15 and Harness API 4. See MIGRATION.md and DEPLOYMENT.md's Runtime limits.

  - **27 more Runtime limits** in `GET`/`PUT /v1/tenant/limits`, each with today's value as its default and a ceiling from a dependency (a JavaScript string or timer, a request read as one string, a Harness API frame, a JavaScript number): request bodies and inline files (`requestBodyBytes`, `inlineFileBytes`), `a2aWaitMs`, `errorExcerptChars`, `traceContentBytes`, an Environment's labels, setup and input files (`environmentLabels`, `environmentSetupCommands`, `environmentFiles`, `environmentFilesPerEntry`, `environmentSecretSlots`, `setupCommandMs`, `setupOutputChars`), disk versions (`diskVersionEntries`, `diskVersionBytes`, `diskLeaseMs`, `diskPodWaitMs`; an Environment's manifest may lower the first two with `limits.disk`), model calls (`modelRequestMs`, `modelIdleMs`, `modelAttempts`, `modelRetryDelayMs`, `modelProviderRetries`, `modelRetryDelayMaxMs`, read by the gates for each call) and tools (`toolAttempts`, `httpToolTimeoutMs`, `mcpPreviewMs`, `mcpMetadataBytes`, and the new `mcpSnapshotBytes`: what a session pins of its MCP servers' tools and instructions, past which a server is left out with a diagnostic).
  - **Schema maxima are checked against the Tenant's limits**: an Environment's labels, setup commands, input files, files per entry, secret slots and setup timeout, and an HTTP tool's `timeoutMs` (at deploy and at each call). `limits.environments` and `lifecycle.stopGrace` lose their arbitrary caps; an identity file's issuer takes any number of grants and `jwksFetch` settings.
  - **`turn.start.limits` carries only a harness's limits** (`HarnessLimitsSchema`, `harnessLimitsOf`), and a harness drops one it does not know. `transcriptUpdates` takes `recordEntryBytes` and fills each event up to it; `CHUNK_BYTES` is gone.
  - **Constants a dependency or a standard fixes stay, named for it**: a token is read up to Node's `http.maxHeaderSize`; artifact names and folder paths keep `FILE_NAME_MAX` (255) and `FILE_PATH_MAX` (1,024); a skill file's path is what `FILE_PATH_MAX` leaves under its mount folder; `tracestate` keeps W3C's 512.
  - **Removed**: `ENVIRONMENT_LABELS_MAX`, `ENVIRONMENT_SETUP_MAX`, `ENVIRONMENT_SETUP_TIMEOUT_MAX_MS` (now `ENVIRONMENT_SETUP_TIMEOUT_DEFAULT`), `ENVIRONMENT_FILES_MAX`, `ENVIRONMENT_SECRET_SLOTS_MAX`, `TOKEN_ENVIRONMENT_GRANTS_MAX`, `HTTP_TOOL_MAX_TIMEOUT_MS`, `READ_ARTIFACT_MAX_BYTES` and `CHUNK_BYTES` from `@nylorun/core`; the image checks (`decodeImageBase64`, `validateImageBytes`, `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`), the Tenant configuration's `modelCall` and `TrustedIssuersOptions`' `refetchMs`/`maxAgeMs` from `@nylorun/runtime`. Studio's Environment form no longer caps setup commands and input files at 16: the Runtime checks the Tenant's limit.

- Pin core to the tested release.
- Pin agents to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
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
- Updated dependencies
- Updated dependencies
  - @nylorun/core@0.23.0-beta
  - @nylorun/agents@0.23.0-beta
  - @nylorun/admin@0.18.0-beta

## 0.15.1-beta

### Patch Changes

- 000ff75: **READMEs and help text match protocol 14.**

  - `nylorun --help` lists `environments fork`, `manifests` and `delete-version`. The package description no longer offers `nylo` as the Runtime client, and the README says nylorun depends on `@nylorun/agents` too.
  - The READMEs name the current commands: `nylorun tenant keys`, `nylorun tenant mcp inspect`, `nylorun local logs` and `nylorun local reset`. `@nylorun/admin` says it speaks protocol 14.
  - `@nylorun/agents`: a lost MCP or HTTP tool call is sent again with its key, then fails to the model as `tool.interrupted` (it is not left `uncertain`). Every manifest is v7. A2A takes `raw` files. A delegated agent cannot pause.
  - `@nylorun/runtime`: the README describes protocol 14, `PUT /v1/sessions/{id}` says it answers an identical session (vaults are no longer attached), and the database-layout error names `nylorun local reset`.
  - `@nylorun/create-agent`: `nylorun start` writes the project's keys (no key is derived any more).

- Pin core to the tested release.
- Pin agents to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [620072d]
- Updated dependencies [a0cf8b2]
- Updated dependencies [000ff75]
- Updated dependencies
- Updated dependencies
  - @nylorun/core@0.22.0-beta
  - @nylorun/agents@0.22.0-beta
  - @nylorun/admin@0.17.1-beta

## 0.15.0-beta

### Minor Changes

- bf8ec79: **`nylorun environments` for manifests and forks (protocol 14).**

  - `nylorun environments manifests list | get <name> [--version n] | versions <name> | save <file>... [--if-match n] [--dry-run] | rm <name>`. `save` reads each JSON file (dropping `$schema`). A `files` entry with `"from": "<folder>"`, relative to the file, becomes files by content hash; `save` uploads those the Runtime lacks. `--dry-run` prints the plan and exits 1 when the Runtime would refuse the save.
  - `nylorun environments put <id> --manifest <name[@n]>` makes an Environment from a manifest version.
  - `nylorun environments fork <id> <new-id> [--manifest name@n] [--disk latest|n|empty] [--secrets copy|none] [--label k=v]... [--dry-run]` forks an Environment onto a new manifest version, and names the required slots still to set.
  - `nylorun environments list` shows each Environment's manifest and version. `--behind` keeps those made from an older version than their manifest's latest.
  - `nylorun environments secrets put <id> <name>`, with no file, writes a slot's value piped in on standard input.
  - `nylorun agents save --dry-run` checks a definition and saves nothing.

- 104f24f: **Environment manifests, and Environments that never change (protocol 14, D63 to D65).** An Environment's definition can now be saved like an agent: a named, versioned environment manifest, written as a JSON file with a published schema and checked with a plan before it is saved. An Environment is made from one version and keeps it for life; a save changes no Environment. The Runtime speaks protocol 14 only; sessions, Environments and vaults carry over. See MIGRATION.md.

  - **Environment manifests.** `PUT /v1/environment-manifests/{name}` saves the next version, or answers the latest `unchanged`; `If-Match: <version>` refuses a save over a newer one (`412 manifest_changed`), and `?dryRun=true` answers the plan (changes, errors, warnings, the Environments behind) and saves nothing. Each version records `savedBy`. `GET` (latest), `GET /v1/environment-manifests`, `.../versions`, `.../versions/{n}` and `DELETE` (refused while an Environment names it, `409 manifest_in_use`). Migration 0025.
  - **Pinned Environments.** `PUT /v1/environments/{id}` takes `manifest: "name"` (the latest at creation) or `"name@n"`. On an existing Environment only `labels` and `ownerUserId` may change; fields that match are accepted, and anything else is `409 environment_immutable` with `details.fields`. The view's `recipe` is now `manifest`, with `manifestName`, `manifestVersion`, `manifestHash` and `slots`; `version` and `appliedVersion` no longer move. `environment.created` names the manifest.
  - **Secret slots.** A manifest's (or inline) `secrets` declares each secret's name, type, binding, `required` and `description`, never a value. On such an Environment a secret write sends only `{ value }` (or `{ headers }`), the binding comes from the slot, and an undeclared name is `409 secret_not_in_manifest`.
  - **`requires`.** Agent manifest v7 takes `requires: { sandbox?: "none" | "any" | "pod", secrets? }` (`.requires()` in `@nylorun/core/define`), checked when a session opens (`409 environment_unsuitable`, `details.missing`). Turn variants keep it.
  - **Dry runs.** `PUT /v1/agents/{id}?dryRun=true` checks a definition and saves nothing (`dryRun: true` in the answer).
  - `@nylorun/core`: `PROTOCOL_VERSION` 14, `HOST_PROTOCOL` `{ min: 14, max: 14 }`, required feature `environment-manifests`; `EnvironmentManifestSchema`, `EnvironmentSecretSlotSchema`, `parseEnvironmentManifestRef` and the view, plan and save schemas; JSON Schemas at `@nylorun/core/schemas/environment-manifest.json` and `@nylorun/core/schemas/agent-manifest.json` (`$id` `https://docs.nylorun.com/schemas/environment-manifest/v1.json` and `.../agent-manifest/v7.json`).
  - `@nylorun/agents`: `client.environments.manifests` (`save`, `plan`, `get`, `list`, `versions`, `delete`), `environmentManifest()`, `EnvironmentInput` (was `EnvironmentRecipeInput`), value-only `secrets.put`, and `saveAgent(agent, { dryRun })`.
  - **Studio** edits only an Environment's labels and owner guard, shows the manifest it was made from, and its setup and files are read-only.
  - `nylorun environments put` help says what it runs never changes.

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

- a4c431a: **One command, `nylorun`, grouped by the API each command uses.** `nylo` became part of `nylorun`, and the commands that are not the installation's lifecycle moved into groups: `environments` (the Runtime API, an application key), `tenant` (the Management API, a management key) and `local` (Docker and kubectl on this machine). See MIGRATION.md.

  - **`nylorun`:** `up`, `down`, `start`, `stop`, `status`, `studio` and `doctor` stay at the top. `tenant reset|keys|signing-keys|models set|mcp inspect`; `environments list|delete`; `local ls|delete|logs|reset|sandbox|telemetry`; `doctor sandbox`. The old spellings (`nylorun logs`, `reset`, `key`, `mcp`, `sandbox`, `configure`, …) exit 2 naming their replacement.
  - **Remote installations:** without `--tenant`, `NYLORUN_RUNTIME_URL` with `NYLORUN_MANAGEMENT_KEY` points `status`, `doctor sandbox` and `tenant` at a remote installation, and with `NYLORUN_SERVER_KEY` points `environments` there. `tenant keys` then manages application keys through the Management API; `tenant mcp inspect` and `environments` no longer need a local Tenant.
  - **`nylo`:** for one release, each command exits 2 naming the `nylorun` command that replaced it. `nylo env` has no replacement: the SDKs read the Project link themselves.
  - **`@nylorun/cli`:** its `nylo` still runs nylorun's, which now names the replacement.
  - **`@nylorun/runtime`:** messages that named `nylo configure`, `nylorun sandbox enable|status` or `nylorun key put` name `nylorun tenant models set`, `nylorun local sandbox enable|status` and `nylorun tenant keys put`.

- f44c018: **Sessions on one Environment run their turns at the same time, and egress is recorded on the Environment (protocol 14, D66, D67).** A second session's turn on an Environment was refused with `409 environment_busy` until the first ended. Now any session on it may start a turn while others run; one turn per session stays. Which sessions work on one disk, and when, is the app's call. See MIGRATION.md, "Parallel turns, and egress on the Environment".

  - **Turns.** `checkEnvironmentTurn` no longer refuses a turn because another session's turn runs, and the flow-tree exception is gone. `environment_busy` still answers stop, reset, snapshot and restore while any turn runs, and a turn while a disk copy runs.
  - **Egress.** Every connection through egress-gate, allowed or refused, is `environment.egress` on the Environment's stream, with `runningTurns: [{ sessionId, turnId }]`, the turns running when it opened (at most 16). `egress.connection` leaves the session event catalog, and turn traces carry no `CONNECT` span.
  - **Reading it.** `GET /v1/environments/{id}/events` takes `types` (comma-separated), `since` and `until` (ISO times); `client.environments.events(id, { types, since, until })` in `@nylorun/agents`, and `nylorun environments events <id> --types --since --until`.
  - `@nylorun/core`: `EgressRunningTurnSchema`, `EgressRunningTurn`; `EgressConnectionPayloadSchema` gains `runningTurns`.

- bc22487: **`nylorun` does what `@nylorun/agents` does: `agents`, `sessions`, `environments` and `artifacts`.** Each is a group on the Runtime API, with the installation's application key, an identity provider's token (`NYLORUN_TOKEN`), and `--as <subject> [--scope <scope>]...` to act for a person.

  - **`agents list | get | save`:** `save <manifest.json|-> --files <dir>...` saves an agent from its manifest, uploading the definition files it names (found by their SHA-256) that the Runtime lacks.
  - **`sessions`:** `list`, `create`, `get`, `send` (text, `--data` JSON, or `--file <artifact>[@<version>]` parts), `approve [--deny]`, `respond`, `cancel`, `watch [--follow]` (events as JSON lines), `history`, `usage`, `calls [--tool]`, `trace`, and `exec <id> -- <command>` (bash in the session's sandbox; exits with its exit code).
  - **`environments`:** `list`, `get`, `put <id> [<recipe.json|->] [--kind] [--label]`, `stop`, `reset`, `delete`, `snapshot`, `versions`, `restore`, `delete-version`, `events`, and `secrets list|get|put|rm`; a secret's JSON comes from a file or standard input, never the command line.
  - **`artifacts`:** `list`, `get`, `upload <file|->` (`--to <id>` for a new version), `download`, `tree`, `diff`, `zip`, `link`, `rm`.
  - **`nylorun` now depends on `@nylorun/agents`.** A release of `@nylorun/agents` releases nylorun too.
  - **`@nylorun/agents`:** an incompatible Runtime's remedy names `npx nylorun@latest start` instead of a `nylorun runtime restart` that no longer exists.

- f0d4817: **`nylorun tenant` covers the Management API: models, usage, calls, budgets, tool policy, coverage and settings.** The group set the model only with prompts, and the rest of `@nylorun/admin` needed code. Now each Management API call has a command, for a local Tenant or the installation `NYLORUN_RUNTIME_URL` and `NYLORUN_MANAGEMENT_KEY` name.

  - **Models.** `tenant models catalog | providers | get` print a table or a line (`--json` for the answer). `tenant models select <provider> [--model <id>]` switches to a provider that has a credential, keeping its model and endpoint. `tenant models set --provider <id> --model <id> [--base-url <url>]` sets an API key without prompts or pi-ai, for CI: the key is read from stdin, never from the arguments, and a terminal on stdin is refused (exit 2). With no flags, `models set` prompts as before.
  - **Usage and calls.** `tenant usage [--scope tenant|agent|turn] [--id <id>] [--period day|month|total]` prints the totals as JSON. `tenant calls [--after <cursor>] [--limit <n>]` prints every recorded model call as one JSON line, page after page, until caught up, then the cursor to resume from on stderr.
  - **Files in, files out.** `tenant budgets`, `tenant tool-policy`, `tenant settings sandbox` and `tenant settings artifacts` take `get` (the default), which prints the document as JSON, or `put <file|->`, which replaces it with the JSON body in a file or on stdin. A body is checked against its schema before anything is sent (exit 2 when it does not parse). What `budgets`, `tool-policy` and `settings artifacts` print, `put` takes back.
  - **Coverage.** `tenant coverage --agent <id> [--environment <id>]` shows which secret of the Environment each of the agent's MCP servers and HTTP tools would get (`--json` for the answer).
  - Usage errors exit 2 before any request.

### Patch Changes

- Pin core to the tested release.
- Pin agents to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [3a32a57]
- Updated dependencies [af90d1e]
- Updated dependencies [104f24f]
- Updated dependencies [c96b9a8]
- Updated dependencies [94bf329]
- Updated dependencies [b5ea2b5]
- Updated dependencies [aff9bb8]
- Updated dependencies [f44c018]
- Updated dependencies [bc22487]
- Updated dependencies [0b7cbbd]
- Updated dependencies [9b07bdd]
- Updated dependencies [c8e640b]
- Updated dependencies
- Updated dependencies
  - @nylorun/core@0.21.0-beta
  - @nylorun/agents@0.21.0-beta
  - @nylorun/admin@0.17.0-beta

## 0.14.0-beta

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

- 7800358: **Each turn is one OpenTelemetry trace, projected from the session log (R7).** An operator could not see what a turn did or where its time went without grepping container logs. Now every turn is a trace with a span for each model call, tool call and egress tunnel, exported over OTLP to any collector, readable per turn from the Runtime, and joined to the trace of the app that started it. No protocol change.

  - **Traces from the log.** A turn's end is its root span, `invoke_agent <agent>`; each model call is a `chat <model>` span, each tool call and flow HTTP stage an `execute_tool <tool>` span, each egress-gate tunnel a `CONNECT <host>` span, and each pause and answer a marker. A model or gate tool span is the gate's own start and end; usage and cost are the gate's (`nylorun.usage.mismatch` when the harness reported other numbers). Attribute names follow the OTel GenAI conventions at one pinned commit, recorded as `nylorun.semconv.genai` on the resource. Ids are derived from the log under a key the Tenant keeps (setting `trace.key`), so every export and read of a turn gives the same ids.
  - **OTLP export, off until you set an endpoint.** With `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) the Runtime posts OTLP/HTTP JSON from a replication slot of its own, `nylorun_trace_export`, in batches of up to 512 spans or every 2 s; `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` work as usual. No turn waits for it. A collector that is down costs only its spans: after three retries a batch is dropped and logged as `trace_export_dropped`, and the slot moves on, so Postgres keeps no WAL for it. `nylorun start` passes these variables to the runtime container.
  - **References by default.** Spans point at log events (`nylorun.event.cursor`) and carry no content unless you opt in per kind with `NYLORUN_TRACE_CONTENT` (`user`, `outputs`, `tool-results`, `errors`), or all of them with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`, each cut at 8 KiB. A span never carries a credential value, a prompt, a person's id, an identity header or an idempotency key.
  - **`GET /v1/sessions/{id}/turns/{turnId}/trace`** answers a turn's spans as OTLP JSON, the same spans the exporter posts: look at a turn without a collector, or post it to one to backfill. Application keys, as the `/calls` reads. Host feature `traces`; `@nylorun/agents` adds `session.trace(turnId)`, and `@nylorun/core/contracts` `TurnTraceSchema`.
  - **Trace context in and out.** A `traceparent` (and `tracestate`) on `POST /v1/sessions/{id}/commands`, an AG-UI run or an A2A message puts the turn in the caller's trace; `command.message` records it as `trace`. The turn hands its context on: to the harness in `TurnStart.trace`, to HTTP tools as `traceparent` beside `Idempotency-Key`, to MCP servers as `traceparent` on the call's requests, and to sandbox commands as `TRACEPARENT`.
  - **Harness API** (additive): the `effect.intent` answer `execute` may carry the tool call's `traceparent`. `@nylorun/harness`: `HarnessExecutors.tool` takes it as a fourth argument (`ToolCallContext`).

### Patch Changes

- a0cbca1: **Clearer wording when a definition runs your code.** The refusal for a code tool or a flow's tool stage, the `hooks were removed` error and `nylo endpoints` now say that the Runtime runs agents from their manifests alone, instead of that it runs no code of yours during a session. Only the message text changed; anything matching the old wording (for example `runs no code of yours during a session`) needs the new text.
- Pin core to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
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
- Updated dependencies
  - @nylorun/core@0.20.0-beta
  - @nylorun/admin@0.16.0-beta

## 0.13.0-beta

### Minor Changes

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

- Pin admin to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [554df94]
- Updated dependencies [1345f61]
  - @nylorun/admin@0.15.0-beta

## 0.12.2-beta

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [212364b]
  - @nylorun/core@0.19.0-beta

## 0.12.1-beta

### Patch Changes

- 7780b2f: **One client and connection layer.** The Project link and credentials are read one way, and every Runtime client shares one `/health` probe.

  - `@nylorun/core`: `@nylorun/core/project` (Node only, the one Core subpath that imports Node modules) reads the Nylorun home, a local Tenant's Host root (`tenantHostRoot`), the Project root (`findProjectRoot`) and the Project link and credentials (`findLinkedProject`, `readProjectLink`, `readCredentialsFile`), validated with `ProjectLinkFileSchema` and `ProjectCredentialsFileSchema`; a broken or newer file throws `ProjectFileError`. `@nylorun/core/transport` (browser-safe) holds the `/health` compatibility probe (`checkHealth`), `parseProtocolRange` (on `ProtocolRangeSchema`, ignoring fields a newer Host adds), `describeIncompatibility`, `requestHeaders` and `readBody`.
  - `@nylorun/agents`: `resolveConnection` and `createClient()` find the Project as every reader does: the nearest directory with `.nylorun/` from `cwd` upwards, never the home directory or above it (they used to walk to the filesystem root, and past a `.nylorun/` without a link). A link without `credentials.json`, or a link or credentials file that does not validate, is now `connection_missing` naming the file and `npx nylorun start`, instead of a raw file-system or parse error. `@nylorun/agents/client` loads the link reader only when `createClient()` resolves a connection, so it imports no Node module. The root entry re-exports `checkHealth`, `describeIncompatibility` and `parseProtocolRange`.
  - `@nylorun/admin`: `createAdmin` reads the Project link with the same reader. A link that does not validate is now refused like one from an older nylorun (when nothing else names the Host root), and a linked Project's `credentials.json` that does not validate is `connection_missing` instead of being skipped. `@nylorun/admin/project` re-exports `@nylorun/core/project` for tools that depend on this package. The `/health` check and request headers come from `@nylorun/core/transport`.
  - `nylorun`: reads the Project link and credentials with `@nylorun/core/project`; a credentials file whose keys are not 64 hex characters is replaced by `start`, as an unreadable one was. No command changes.
  - `@nylorun/cli`: `nylo` reads the Project root, link and credentials through `@nylorun/admin/project` instead of its own copies, with the same messages. No command changes.
  - `@nylorun/studio`: the server's Runtime compatibility probe is `checkHealth` from `@nylorun/agents`.

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [7780b2f]
- Updated dependencies [070674d]
  - @nylorun/core@0.18.0-beta

## 0.12.0-beta

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
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [50e2f7e]
- Updated dependencies [e0e39ff]
- Updated dependencies [fed5e58]
- Updated dependencies [18f9a2f]
- Updated dependencies [da93711]
- Updated dependencies [90a817d]
- Updated dependencies [b8d10cb]
  - @nylorun/core@0.17.0-beta

## 0.11.2-beta

### Patch Changes

- 6711320: `/ready` no longer checks S2: its `checks` cover the listener, the Tenant, Postgres and Restate, and an unreachable S2 leaves it `200`. S2 only serves API listeners (history, SSE, AG-UI and A2A), so an outage degrades those reads and never makes the Runtime unready. S2's reachability stays in the Tenant's status (`GET /v1/tenant`, `streams.reachable`).
- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [cf5eb9c]
- Updated dependencies [2ed5fe0]
  - @nylorun/core@0.16.0-beta

## 0.11.1-beta

### Patch Changes

- Pin runtime to the tested release.
- Pin studio to the tested release.

## 0.11.0-beta

### Minor Changes

- 713e676: **Remote MCP servers only (blueprint D47).** Nylorun accepts `streamable-http` and `sse` MCP servers, declared by URL and reached through the gates; stdio servers and plugin roots are gone. See MIGRATION.md.

  - **Breaking (`@nylorun/core`):** `McpServerManifest` and the manifest schema keep only `streamable-http` and `sse`. A `stdio` server is refused by `.mcp({...})` (`McpError`, code `mcp.stdio`), by `Agent.from` and by the wire schema, all with one message (`stdioMcpRefusal`): "MCP server 'x' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL." `PutAgentRequest` loses `pluginRoots`, `CapabilityDeclaration` loses `pluginRoot`, and the Harness API's `RunRouting` loses `pluginRoots`.
  - **Breaking (`@nylorun/agents`):** `.plugin()` and `plugin()` throw `PluginError` (code `plugin.mcp-stdio`) for a stdio server in a plugin's `mcp.json`; its remote servers and skills load as before. `saveAgent` no longer sends plugin roots. `prepareStdioLaunch`, `expandPluginPlaceholders` and `StdioLaunch` are removed.
  - **Breaking (`@nylorun/runtime`):** no stdio MCP launcher: `PUT /v1/agents/:id` refuses a stdio server (`400`) and `pluginRoots`. `TenantConfig.childEnv`, `TenantPaths.pluginData` and `tmp`, `tenantChildEnvironment`, `startEphemeralRuntime({ baseline })` and `configForFactory`'s `baseline` and `hostConfig` are removed; the harness service no longer takes `childEnv` or `paths.pluginData`.
  - `nylorun`: the local stack no longer mounts the Host root's `plugins/` into the runtime and harness containers, nor the Tenant's `plugin-data/`, `home/` and `tmp/` into the harness, which now mounts only `sandboxes/`.

- c135267: **Action endpoints are removed (manifest-only agents, M6).** The Runtime runs no code of yours during a session: an agent's tools are HTTP tools, remote MCP servers, agents used as tools and the Runtime's built-ins. Protocol stays 8; the `action-endpoints` feature is gone, so a client that requires it is refused. See MIGRATION.md, "Action endpoints are removed".

  - **Breaking (`@nylorun/core`):** the `Action`, endpoint (`PutEndpointsRequest`, `Endpoint`, `EndpointHealth`, …) and delivery schemas, `SIGNATURE_HEADER`, `OUTCOME_HEADER`, `DELIVERY_TOKEN_TYPE` and the `action.*` events (`action.pending`, `.delivered`, `.delivery_failed`, `.completed`, `.uncertain`) are removed, and `ToolDefinition.background` with them. `ActionOutcome` is renamed `EffectOutcome`. Tenant status loses `checks.endpoints`, `agents[].registered` and `agents[].endpoint`, and `counts.pendingActions`; the session view loses `actions`. A `turn.paused` interaction carries the tool call's `callId`. New `codeToolsOf` and `codeToolRefusal` name a definition's tools that would run your code. The Harness API is v2 (`HARNESS_API_VERSION = 2`): `TurnStart.options.holdMs` and `effect.resolved` are removed.
  - **Breaking (`@nylorun/harness`):** held runs are gone: `createHarness` loses `holdMs`, and `apiHost` its `hold` option.
  - **Breaking (`@nylorun/agents`):** `createActionHandler`, `executeAction`, `createActionSandbox`, `definitionDeclaresSandbox`, `isActionSandboxTool` and the `Action`, `ActionOutcome`, `ActionHandler`, `ActionHandlerOptions`, `RegisterOptions`, `ExecuteActionOptions` and `ExecutableDefinition` types are removed. `saveAgent` refuses a code tool (`tool({ run })`) or a flow tool stage before sending; its `implementationVersion` is optional (`NYLORUN_IMPLEMENTATION_VERSION`, else `dev`).
  - **Breaking (`@nylorun/runtime`):** `/v1/endpoints` and `/v1/actions/*` answer `404`; delivery tokens, the deliverer, background tools, held runs (`TenantConfig.actionHoldMs`), `DurableExecution.deliver`, the Restate `NylorunAction` object, the `action_result` wake and the gates service's `/nylorun/v1/deliveries` are removed, and a migration drops the `actions` and `endpoints` tables. `PUT /v1/agents/:id` refuses a definition with a code tool or a flow tool stage (`400`); a tool the Runtime cannot run fails with `tool.unavailable`. The fixture model answers in text when the agent offers no `lookup_order` tool.
  - **Breaking (`@nylorun/cli`):** `nylo endpoints` is removed (a usage error that says why); `nylo status` shows uncertain effects instead of pending Actions.
  - **Breaking (`@nylorun/create-agent`):** the starter saves its agent with `saveAgent` and runs no server: no Action endpoint, `PORT` or `NYLORUN_ACTIONS_URL`. Its assistant has no tools, with a commented `http()` tool to start from.
  - `nylorun`: the local stack's comments speak of MCP servers and HTTP tools on this machine, not Action endpoints.
  - `@nylorun/studio`: the `action.*` event views and delivery status are removed; the chat shows `tool.completed`, and the Agent Manifest tab lists tools without a target as code tools.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [4bd2a0b]
- Updated dependencies [a64aaca]
- Updated dependencies [40b7648]
- Updated dependencies [713e676]
- Updated dependencies [c135267]
- Updated dependencies [d36f0d9]
- Updated dependencies [107b07d]
  - @nylorun/core@0.15.0-beta

## 0.10.0-beta

### Major Changes

- 7f763c3: **The Admin API and the operator listener are gone (Runtime and Management APIs, step A5).** Host work moves to the machine: `nylorun` runs `nylorun-operate` inside the runtime container, and every remote client uses the Runtime API or the Management API.

  - **Breaking (`@nylorun/runtime`):** `/v1/admin/*` (status, host, shutdown, keys, openapi.json) is removed; it answers like any unknown route. The operator listener, `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`, `NYLORUN_ADMIN_ALLOWED_HOSTS` and `host.json`'s `adminPort` are gone, and so is the `admin-openapi.json` package file. Stop the Host with SIGTERM. `nylorun-operate status [--json]` reports the version, protocol and the Tenant's id, name, state and cause, exiting 2 when the Tenant is not open. `/ready` adds `harness: { mode, connected }` while the Tenant is open. `startEphemeralRuntime` loses `operatorListener` and `adminUrl`. The admin key stays: it derives Studio's key.
  - **Breaking (`@nylorun/admin`):** `createAdmin()` is the Management API client (`tenant`, `keys`, `models`, `vaults`, `signingKeys`, `settings`) with a management key: explicit `{ url, key }`, else `NYLORUN_RUNTIME_URL` + `NYLORUN_MANAGEMENT_KEY`, else the Project link's or the local Host root's management key. `status()`, `adminUrl`, the Admin API keys, `NYLORUN_ADMIN_URL`/`NYLORUN_ADMIN_KEY` and `OPERATOR_KEYS_FEATURE` are removed; `deriveStudioToken` and `mintStudioLoginToken` stay.
  - **Breaking (`@nylorun/core`):** `admin-status` leaves `PROTOCOL_FEATURES` (the Host still advertises it for protocol 5–7 clients) and `operator-keys` is removed; `AdminStatusSchema`, `AdminHostStatusSchema`, `HostAggregateSchema` and `HostShutdownResponseSchema` are removed.
  - **Breaking (`nylorun`):** no admin port: `NYLORUN_ADMIN_PORT` is no longer written or published (an existing one is ignored). `nylorun start` waits for `/ready`, and `nylorun status` reads readiness from `/ready` and the Tenant from `nylorun-operate status`.
  - `@nylorun/cli`: `nylo status` no longer falls back to the Admin API; when the Tenant does not answer it points to `npx nylorun status`.

### Minor Changes

- 3b3bdc6: **The clients use management keys (Runtime and Management APIs, step A3).** The protocol stays at 7; every client keeps working against a protocol 7 Runtime's routes.

  - `nylorun`: `nylorun start` keeps an application key (`project`) and a management key (`project-management`) for a Project, in `<Host root>/project-credentials.json` and the Project's `.nylorun/credentials.json` (still format 1, with new `managementKey` and `managementPrincipalId` fields). A credentials file holding only an application key gains a management key at the next start. Commands outside a project keep `cli` and `cli-management`. Keys are issued through `nylorun-operate` in the runtime container instead of the Admin API, and `nylorun key put <id> --management` puts a management key. Seeding the Tenant and `nylorun mcp connect` use the management key (`/v1/tenant/vaults`). Studio reaches the Runtime's public listener.
  - `@nylorun/cli`: `status`, `reset`, `configure`, `doctor` and `access signing-keys` use the Management API through `@nylorun/admin` with the Project's management key, or `NYLORUN_MANAGEMENT_KEY`.
  - `@nylorun/studio`: local Studio needs no login. A request on the published loopback address (`localhost` or `127.0.0.1` at Studio's port) acts as signed in; hosts behind a sign-in proxy and embedding keep their login, and state-changing requests still need Studio's own `Origin`. Studio learns its Tenant from `GET /v1/tenant` with its key instead of the Admin API, and its Connections page manages vaults through `@nylorun/admin/client` at `/v1/tenant/vaults`.
  - **Breaking (`@nylorun/admin`, `@nylorun/runtime`): Studio's key is derived from the admin key alone.** `deriveStudioToken(adminKey)` takes no Tenant id (HMAC-SHA256 over `nylorun/studio/v2`). The Host registers the new key's hash at its next start, replacing the old one; an app that embeds Studio and derives its key must update.
  - `@nylorun/core`: `ProjectCredentialsFileSchema` gains optional `managementKey` and `managementPrincipalId`.

### Patch Changes

- b28bdd7: **Local MCP servers work on a local Tenant, and a server that does not connect shows.** Additive; the protocol stays at 7.

  - `@nylorun/runtime`: remote MCP servers (`streamable-http`, `sse`) are reached under the Host's address policy, as Action endpoints are (`NYLORUN_ENDPOINT_*`, `tenant/outbound.ts`). In the local Docker stack `localhost`, `127.0.0.1` and `[::1]` now mean the machine that runs Docker (`host.docker.internal`), so `.mcp({ x: { type: "streamable-http", url: "http://localhost:3002/x" } })` connects where it used to fail with `fetch failed`. With `NYLORUN_ENDPOINT_PRIVATE=refuse` a server on a private address is refused; with `NYLORUN_ENDPOINT_HTTP=refuse` an `http` server is refused. Redirects are still not followed. A connection failure now names its cause (`connect ECONNREFUSED …`) instead of `fetch failed`. This applies in the gateway, a harness process and an in-process Tenant. `guardedFetch` takes `stream: true`: the answer streams, unbounded, with no timeout but the caller's signal.
  - `@nylorun/core`: new session event `mcp.discovered`, recorded once on the session's first turn with the MCP snapshot: one entry per declared server with `outcome` (`connected`, `refused`, `failed`), `message` and the number of `tools` it added (`McpDiscoveredPayloadSchema`, `McpServerOutcomeSchema`). A server that does not connect adds no tools for the session's life; this is where that shows in the event log, beside `mcpDiagnostics`.
  - `@nylorun/agents`: `.plugin()` and `plugin()` emit a process warning (`NylorunPluginWarning`, the diagnostic's code) for each part of the package they skip, so building or registering the agent says when a plugin's MCP server was dropped. The `plugin.mcp-server-skipped` message now says why: for example, plain `http` is accepted only for `localhost`, `127.0.0.1` or `[::1]`.
  - `@nylorun/studio`: the event list labels `mcp.discovered` and summarizes each server's outcome.

- 7a22f7f: **`nylorun start` opens no browser.** `start` (and `up`) prints the Runtime and Studio URLs, says to run `nylorun studio` to sign a browser in to Studio, and ends with a pointer to `nylorun --help`. It no longer mints a Studio login token or opens Studio, also in a terminal. `--no-open` is still accepted and ignored. `nylorun studio` signs a browser in as before.
- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [3b3bdc6]
- Updated dependencies [6576e12]
- Updated dependencies [b28bdd7]
- Updated dependencies [cc107b1]
- Updated dependencies [7f763c3]
- Updated dependencies [98b0d37]
- Updated dependencies [c66d8ed]
  - @nylorun/core@0.14.0-beta

## 0.9.0-beta

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

- 8773586: **Installation vaults and a credential resolver (F9 C1).** A session's MCP credential now comes from its attached vaults, then from the operator's own credential resolver; nothing changes for existing vaults, and the protocol stays at 6.

  - Installation vaults: `POST /v1/vaults` takes `scope: "installation"` (no `ownerUserId`) from an application key acting for no one; a request acting for a subject gets `403`. The vault is owned by `installation`, now a reserved subject like `host`. Any session may attach one and select its credentials. `GET /v1/vaults` from an application key lists them after the named person's vaults, and lists only them without `ownerUserId`; a request acting for a subject never sees one (the opaque `404`). The host model vault stays hidden and unattachable. Migration 0008 adds the scope.
  - The credential resolver: `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` on the gateway (`TenantConfig.resolver` and `startEphemeralRuntime({ resolver })` in process). When the session's vaults hold nothing for a remote MCP server's URL, the Runtime POSTs `{ owner, session, turn, target: { kind: "mcp", server, agent, url } }` with the resolver's bearer: `200 { headers, expiresAt? }` is used, `404` goes without a credential, and anything else or no answer within 5 s refuses the server with `credential_unavailable`. Owner and turn come from the session row. Answers are cached per owner and URL until `expiresAt`, at most 5 minutes (60 s without one), and concurrent misses share one request. See DEPLOYMENT.md, Credentials.
  - `nylorun`: the gateway's Compose service passes `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` from the shell that runs `nylorun start` (unset by default).
  - Studio: the Vault page is now **Connections**, and creates installation vaults.

- e1bfb4b: **MCP OAuth connect for installation vaults (F9 C2).** The installation can sign in once to a remote MCP server that uses OAuth, and every session that attaches the vault uses the credential. Additive; the protocol stays at 6.

  - `POST /v1/vaults/{vaultId}/oauth/start` (application keys acting for no one, installation vaults only) takes `{ url, server, clientId? }` and answers `{ authorizeUrl, expiresAt }`. The Runtime discovers the server's authorization server (RFC 9728, then RFC 8414), registers itself (RFC 7591) unless `clientId` names a registered client, and starts an S256 PKCE sign-in whose `state` works once, for ten minutes. A server without registration and no `clientId` is `400 oauth_client_required`.
  - `GET /v1/oauth/callback` takes the browser back: anonymous and unversioned like an artifact link, it exchanges the code and stores an `oauth` credential bound to the URL, named after `server` (connecting again rotates it), and answers a small HTML page. An unknown, used or expired `state` is `oauth_state_invalid`; the authorization server's refusal is `oauth_failed`. The callback's base is `NYLORUN_PUBLIC_URL` (`TenantConfig.publicUrl`), else the start request's origin.
  - Every OAuth step runs in the gateway's keys module (F9-D14): the runtime container never sees a token, the PKCE verifier or a client secret, and makes no outbound call. Migration 0009 adds `oauth_pending`, with the verifier and secret sealed under the vault key. `Keys` gains `startOAuth` and `finishOAuth`.
  - OAuth requests, including refresh of every OAuth vault credential, now go through `guardedFetch` (`tenant/outbound.ts`): the `NYLORUN_ENDPOINT_*` address policy checked on the address connected to, no redirects, a bounded answer. With `NYLORUN_ENDPOINT_PRIVATE=refuse` a token endpoint on a private address is refused, where refresh used to call it.
  - `@nylorun/core`: `ERROR_CODES` adds `oauth_client_required`, `oauth_state_invalid` and `oauth_failed`; `StartOAuthRequestSchema` and `StartOAuthResponseSchema`.
  - `nylorun mcp connect <url> --server <name> [--vault <id>] [--client-id <id>]`: creates the installation vault `mcp` if needed, opens the sign-in page and waits up to 10 minutes for the credential. See DEPLOYMENT.md, "Connecting a remote MCP server with OAuth".

- 5cfaed9: **Operator keys, and project links on them (F9 I1).** The Admin API manages the Tenant's application keys by name: `PUT /v1/admin/keys/{id}` creates a key or rotates it and returns it once, `GET /v1/admin/keys` lists every key's id, role and issue time (never the keys), and `DELETE /v1/admin/keys/{id}` removes one. A rotated or deleted key stops authenticating on its next request. Ids follow `^[a-z][a-z0-9-]{0,31}$`; `studio` (derived from the admin key) is refused. Keys keep today's format (64 hex) and only their SHA-256 is stored, in the existing principals table (no migration). Host feature `operator-keys` (additive, protocol unchanged); core adds the `OperatorKey`, `ListOperatorKeysResponse`, `PutOperatorKeyResponse` and `DeleteOperatorKeyResponse` schemas.

  - `@nylorun/admin`: `admin.keys.put(id)`, `admin.keys.list()` and `admin.keys.delete(id)`; they refuse with `incompatible_host` when the Host lacks `operator-keys`.
  - `nylorun key put|list|rm <id>` manages a running local Tenant's keys; `put` prints the key once on stdout.
  - `nylorun start` no longer derives the project's key. It keeps `.nylorun/credentials.json` while its key still reaches the Tenant (one authenticated read); otherwise it gives the project the operator key `project`, which the Host root keeps in `project-credentials.json` (0600) so every checkout linked to the Tenant shares it. An existing derived project key keeps working and is adopted.
  - `nylorun sandbox` uses the linked project's key, or the operator key `cli` it puts once and keeps in `<Host root>/cli-credentials.json` (0600).
  - The ephemeral Runtime (`startEphemeralRuntime`) no longer registers the derived `project` principal; pass `derivedPrincipals: ["project"]` to keep it. Derived principals (`NYLORUN_DERIVED_PRINCIPALS`, `deriveTenantKey`) still work on a Host.

- b906050: **Studio for a team (F9 S1).** Studio can sit behind a sign-in proxy such as oauth2-proxy. A request with no Studio session that carries a JWT, in `X-Forwarded-Access-Token` or as an `Authorization` bearer that is not a Studio session, signs in when the Runtime's `GET /v1/me` verifies it and reports the `studio` scope: Studio sets its usual signed session cookie, which records the subject for its write log and ends no later than the token (at most the usual 30 days), and serves the request. Studio never trusts the header unverified and keeps nothing else. A token without the scope gets `403` naming `studio`; a token the Runtime refuses, or one that is not a JWT, gets `401`. Admitted people get Studio's Tenant-wide view; the CLI sign-in and embedding are unchanged, and a valid embed bearer session still wins. New `NYLORUN_STUDIO_ALLOWED_HOSTS`: extra `Host` values Studio serves, comma-separated (`studio.acme.dev`); its state changes accept that host's `https` and `http` origins, and the cookie is `Secure` when the proxy sends `X-Forwarded-Proto: https`. The default is unchanged: only `localhost` and `127.0.0.1` on the published port. `nylorun start` passes `NYLORUN_STUDIO_ALLOWED_HOSTS` from its environment to the Studio container.
- c0b604e: **Trusted issuers (F9 I2).** The Tenant API accepts JWTs from the operator's own identity provider as bearers, configured in an identity file: `NYLORUN_IDENTITY_FILE` names a YAML file listing each issuer's `name`, `issuer`, `audience`, `jwks` URL or static PEM `keys`, a `subject` template over scalar claims (`u:{sub}`), `scopes` from a claim or a fixed list, `allowedScopes`, an optional `agents` allowlist, optional `sandboxes` grant templates (`{org_id}/*`) and `maxLifetime`. A malformed file stops the boot, naming the issuer and the field; a subject template without a claim is malformed. A bearer whose unverified `iss` names an issuer is verified with RS256, ES256 or EdDSA only, up to 16 KiB, `aud` matching, `exp` and `iat` required and `exp − iat` within `maxLifetime`, and becomes a token caller (`role: issuer:<name>`) with the issuer's scopes, agents and rendered sandbox grants; subject revocation does not reach it. JWKS keys are fetched only from the configured URL (no redirects), cached by `kid`, refetched at most once a minute for an unknown `kid`; while a JWKS is unreachable cached keys keep working and a new `kid` is `401 issuer_unavailable` (new error code). A browser request with an issuer token needs no publishable key (CORS comes from the operator's proxy). New: `GET /v1/me` reports the subject, scopes, agents, sandbox grants and `via` (`application:<id>`, `subject`, `token` or `issuer:<name>`) of any credential; the issuer-only scope `studio`; `ISSUER_SCOPES`, `CALLER_SCOPES` and `MeResponseSchema` in `@nylorun/core/contracts`; `parseIdentityFile` and `createTrustedIssuers` in `@nylorun/runtime`, and an `issuers` option on `startEphemeralRuntime`; Host feature `trusted-issuers` (additive, protocol unchanged). `nylorun start` sets `NYLORUN_IDENTITY_FILE=/nylorun/identity.yaml` on the runtime container when `<Host root>/identity.yaml` exists.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [8773586]
- Updated dependencies [e1bfb4b]
- Updated dependencies [5cfaed9]
- Updated dependencies [bd478ee]
- Updated dependencies [c0b604e]
  - @nylorun/core@0.13.0-beta

## 0.8.0-beta

### Major Changes

- b352feb: **File artifacts, message parts and capability links (protocol 6).** Upgrade these with the Runtime: they speak protocol 6, which this Runtime serves beside 4 and 5. See MIGRATION.md.

  - **`@nylorun/runtime`: file artifacts.** A file is an artifact: an `af_` id, a name and numbered immutable versions, with rows in the new `artifacts` and `artifact_versions` tables (migration `0004_artifacts`) and bytes in the Object store (`BlobStore`). `POST /v1/artifacts?name=&sessionId=` uploads a file in one streamed request and `POST /v1/artifacts/{id}/versions` adds a version, within the Tenant's limits (`GET`/`PUT /v1/tenant/artifacts`: 100 MiB per file and 10 GiB in all by default); a body past either is `413 limit_exceeded`, refused mid-stream with nothing stored. `GET /v1/artifacts` lists them (by session), `GET /v1/artifacts/{id}` reads one with its versions, `GET /v1/artifacts/{id}/versions/{n|latest}/content` downloads through the Runtime with HTTP Range (`206`, `Content-Range`, `416`), and `DELETE /v1/artifacts/{id}` deletes it with its bytes. A session's artifacts go with it on a sessions reset, and appear in its history as `artifact.created`, `artifact.version.created` and `artifact.deleted` (new in the event catalog). A subject reaches only the artifacts of their own sessions.
  - **`@nylorun/runtime`: capability links.** `POST /v1/artifacts/{id}/links` mints a short-lived path, `/v1/artifact-links/<token>`, that downloads one version (with Range) with no credential and no `Nylorun-Protocol`: an ES256 JWT (`typ: nylorun-artifact+jwt`) signed with the Tenant's signing key, at most 15 minutes, and dead once the artifact is deleted. The Host logs its path without the token.
  - **Breaking (`@nylorun/core`, `@nylorun/runtime`): message `parts`.** A user message may carry `parts`: `text`, and `file` by `artifactId` (and `version`, else the latest, pinned when the message is accepted). Model-gate reads the file from the Object store: an image goes to the model as image input, a text file as text, and any other file fails the call (`invalid_request`). The record and the transcript hold only the reference. The gateway builds its `BlobStore` from `NYLORUN_OBJECT_STORE_*` (the Tenant's `fs` store without it). `PROTOCOL_VERSION` is 6; `HOST_PROTOCOL` is 4–6 and protocol 6 clients require the feature `artifacts`.
  - **`@nylorun/runtime`: `save_artifact`.** A session with a sandbox gets the `nylorun.artifacts` capability, whose `save_artifact` tool saves a sandbox file (`path`) or text (`content`) as an artifact of the session, carrying the turn and tool call on its event.
  - **Breaking (`@nylorun/runtime`): `MediaStore` is removed.** `MediaStore` and `localMedia` leave `@nylorun/runtime/node`, and `piModel` takes `files` (a resolver from an artifact reference to its bytes) instead of `media`; images are file artifacts. The image checks (`decodeImageBase64`, `validateImageBytes`, `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`) stay.
  - **`@nylorun/agents`:** `client.artifacts` (`upload`, `uploadVersion`, `list`, `get`, `download` with a range, `link`, `delete`), also on `BrowserClient`, and `session.inputParts(parts)`. A request with a body of its own type keeps it.
  - `@nylorun/admin`, `@nylorun/cli`, `nylorun`, `@nylorun/studio`: speak protocol 6.

### Minor Changes

- e58e6ec: **egress-gate: pod sandboxes reach only the hosts their spec allows (F7.2).** A new `egress` service runs in the gateway's process (`--service gates,keys,egress`) on `NYLORUN_EGRESS_LISTEN_PORT` (default 4200). It is a CONNECT proxy: each tunnel needs an egress token (`Proxy-Authorization`, Basic with the token as password or Bearer) for a live sandbox at its current host epoch, a host name (no IP literal) that the sandbox's `network.allow` names exactly or by `*.suffix`, port 443 or 80, and a name that resolves to a public address; the gate connects to that checked address and pipes bytes, with no TLS interception and no credential injection. Plain HTTP is answered `405`; a sandbox holds at most 64 tunnels; idle tunnels close after 5 minutes; refusals are logged, never emitted as events. Egress tokens (`typ: nylorun-egress+jwt`), minted with each host token at a pod's join, are accepted nowhere else; egress-gate also refuses a token of a sandbox that is deleted, lost or expired, or of a pod other than the one that joined. Sandbox spec resolution lets `pod` sandboxes allow `*.suffix` hosts within the Tenant's ceiling (virtual ones keep exact names). With sandboxes enabled, `nylorun` runs the gateway with `egress` and publishes it on `NYLORUN_SANDBOX_BIND` at `NYLORUN_SANDBOX_EGRESS_PORT`, next to the gates.
- 186ec3f: **A local Tenant has an Object store: RustFS, behind the Runtime's new `BlobStore` seam.** `nylorun start` adds a `rustfs` container (RustFS 1.0.1, single node and single drive, pinned by digest) on the `nylorun-<tenant>-rustfs` volume, unpublished and without its console. Its secret key is generated once into `docker/.env` (`NYLORUN_OBJECT_STORE_SECRET_KEY`), and only the `runtime` and `gateway` containers receive the credential (`NYLORUN_OBJECT_STORE_ENDPOINT`, `_ACCESS_KEY`, `_SECRET_KEY`); the runtime creates the bucket at boot. The Runtime reaches the store through `BlobStore` (put with a streamed body and a size cap, get with a byte range, head, delete, list by prefix) with an `s3` adapter over the plain S3 API and an `fs` adapter, which a Runtime without `NYLORUN_OBJECT_STORE_ENDPOINT` (embedded, ephemeral, tests) uses under the Tenant directory's `blobs/`. Nothing stores files there yet; file artifacts build on it.
- 3fd1cda: **The harness container, the network split, and Restate's UI closed by default (F6.2).** A local Tenant now runs agent turns, stdio MCP servers and workspaces in a `harness` container: the runtime image as `--service harness`, connected to the runtime's Harness API (`ws://runtime:4200/nylorun/harness/v1`, `NYLORUN_HARNESS=remote`) with `NYLORUN_HARNESS_TOKEN`, which `nylorun start` generates once and keeps in `.env`. The harness holds no other credential, mounts only the Tenant directory's `sandboxes/`, `plugin-data/`, `home/` and `tmp/` under `/harness`, publishes no port and is healthy once connected; `nylorun status` and `nylorun doctor` report it, and `nylorun logs harness` shows its log. `NYLORUN_HARNESS=in-process` in `.env` rolls back to turns in the runtime container (the harness service is then removed).

  - Plugin roots: the Host root's `plugins/` directory is mounted read-only at its own path into the harness and runtime containers, so a stdio MCP server from a plugin under `~/.nylorun/tenants/<name>/plugins/` runs in the harness.
  - Networks: `<project>-store` (internal) joins Postgres, s2-lite, Restate and RustFS to the runtime and the gateway only; `<project>-harness` joins the harness to the runtime and the gateway only; the default network keeps egress and the published ports.
  - Restate's admin API and UI (unauthenticated) are no longer published. `nylorun start --restate-ui` (or `NYLORUN_RESTATE_UI=1`) publishes them on loopback for that start and prints the URL.

- 678e085: **Pod sandboxes (F7.2, second part).** With `nylorun sandbox enable`, a sandbox resource of kind `pod` (`PUT /v1/sandboxes/{id}` with `kind: "pod"`, an `image`, `*.suffix` hosts, `storage` and `lifecycle.ttl`) is an agent-sandbox pod on the Tenant's cluster, created at once. The turns of the sessions attached to it run in the pod: the engine is copied from the Runtime image into the pod (the Runtime image now carries tini for it), waits until the pod's NetworkPolicy is in force, exchanges its join token for a host token at the Harness API listener (`POST /nylorun/harness/v1/host/join`, published for pods on the Docker host's address, with the gates), and serves its sandbox alone. New: `POST /v1/sandboxes/{id}/stop` and `/reset`; the Tenant's `limits.ttl`, `lifecycle.onExpiry`, `lifecycle.stopGrace` and `placement`; idle stop; lifecycle events `sandbox.running`, `.suspended`, `.expired`, `.relaunched`, `.lost`, `.reset` and `.failed`; error codes `placement_refused`, `sandbox_lost` and `sandbox_expired`; `cluster` in `GET /v1/tenant/sandbox`; Host feature `sandbox-pods` (additive, protocol unchanged). Without a cluster, kind `pod` is `409 sandbox_unavailable` (it was 400). Migration `0007_sandbox_pods` adds the pod lifecycle columns to `sandbox_resources`.
- 926711b: **Sandboxes are a resource (F7.1, blueprint D39; Host feature `sandboxes`).** A sandbox has its own id, a kind, a spec and labels, and outlives the sessions attached to it. Additive: protocol 5 is unchanged.

  - `PUT /v1/sandboxes/{id}` creates a sandbox or finds the one with that id (get-or-create in one call); `GET /v1/sandboxes/{id}`, `GET /v1/sandboxes?label=key=value` (repeatable), `GET /v1/sandboxes/{id}/events` and `DELETE /v1/sandboxes/{id}`. Ids are `/`-separated segments (`team-a/proj-42`), sent percent-encoded as one path segment. Only kind `virtual` runs; `pod` is refused with `sandbox_unavailable`. The spec is resolved against the Tenant's limits and fixed once the sandbox exists; labels can change.
  - A session attaches with `sandbox: { id }` and shares the sandbox's `/workspace` with every other session attached to it. Turns are serial per sandbox: a second session's turn is refused with `409 sandbox_busy` while another runs. Deleting a session (a sessions reset) only detaches it. Deleting a sandbox is refused while a turn runs in it; afterwards an attached session's next turn is refused with `sandbox_unavailable` until a sandbox with that id exists again.
  - Subject tokens carry an `sbx` claim: `POST /v1/tokens` takes `sandboxes`, exact ids or prefixes ending in `/*` (at most 16). A token reaches only the sandboxes they match, checked when a session attaches and at every turn start (`403 sandbox_not_granted`); any other sandbox is the 404 of a missing one. The new scope `sandboxes:write` lets a role create and delete the sandboxes its grants reach. Application keys reach every sandbox.
  - The Tenant holds at most `limits.sandboxes` sandboxes (`PUT /v1/tenant/sandbox`, default 100); one more is `409 limit_exceeded`.
  - Lifecycle events (`sandbox.created`, `sandbox.attached`, `sandbox.detached`, `sandbox.deleted`) go to the sandbox's own stream in the record, through the record module; the session's log records `sandbox.attached`. The sandbox stream is not relayed to S2.
  - New error codes `sandbox_not_granted`, `sandbox_busy` and `sandbox_unavailable`; the session view gains `sandboxId` and `sandboxSource: "sandbox"`. Migration `0004_sandbox_resources` adds `sandbox_resources`, `nylorun_streams.sandbox_events` and the sessions' `sandbox_id` column.
  - `@nylorun/agents`: `client.sandboxes` with `ensure(id, spec)`, `get`, `list({ labels })`, `delete`, `events`, and `forSession({ session, spec })`, which creates a sandbox for one session, opens the session on it, and deletes it with `release()`. It replaces sharing through another session (`sandbox: { session }` and the view's `sandboxOwnerId`, now deprecated). `client.tokens.create` takes `sandboxes`.
  - `nylorun sandbox ls [--label key=value]... [--json]` and `nylorun sandbox rm <id>` list and delete the running local Tenant's sandboxes.

- db045cd: **The sandboxes service and `nylorun sandbox enable` (F7.2, first part).** A new image, `ghcr.io/nylorun/sandboxes`, versioned with the Runtime, drives agent-sandbox v1.0.5 Sandboxes in one namespace per Tenant: `PUT`, `GET ?wait=` and `DELETE /v1/pods/{name}` with an operation id, `/ready` and `/v1/info`, behind a bearer token only the runtime container holds. `nylorun sandbox enable --context <name>` installs into that kubeconfig context only (the pinned controller when absent, the namespace `nylorun-sbx-<tenant>`, a ServiceAccount whose Role covers Sandbox lifecycle and join Secrets, no NetworkPolicy or exec rights), refuses a cluster whose NetworkPolicy it cannot prove enforced, records `<Host root>/sandboxes/cluster.json` and the token, and adds the `sandboxes` service to the Tenant; `nylorun sandbox disable` and `nylorun sandbox status` remove and report it. Sessions do not run in pods yet: that comes with the Harness API and egress-gate.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [b352feb]
- Updated dependencies [6077272]
- Updated dependencies [b6bf1f5]
- Updated dependencies [8ed4ea6]
- Updated dependencies [678e085]
- Updated dependencies [926711b]
  - @nylorun/core@0.12.0-beta

## 0.7.0-beta

### Minor Changes

- 9af30d8: **The Studio proxy is removed, and Restate runs with its own memory defaults.** Each Tenant's Studio is at `http://localhost:<port>` again (`nylorun studio --tenant <name>` opens it signed in): its own session cookie already keeps it apart from other Studios, so the proxy only added a container and a second address. The 256 MiB RocksDB cap did not lower Restate's memory, so it is gone. The first command of this release removes the proxy that 0.6 started (`nylorun-proxy` and `~/.nylorun/proxy/`); `NYLORUN_PROXY_PORT`, `NYLORUN_PROXY_DISABLED`, `studio.proxyUrl` and Studio's `NYLORUN_STUDIO_PUBLIC_ORIGINS` are gone.

### Patch Changes

- Pin studio to the tested release.

## 0.6.0-beta

### Minor Changes

- 0cbd5c9: **Breaking (`nylorun`): readable Docker names, several Tenants on one machine, and Studio at `http://<name>.localhost:4160`.** See MIGRATION.md.

  - **Breaking (`nylorun`): names.** Every container, the network and every volume carries the Tenant's Compose project: containers `nylorun-<name>-postgres`, `-restate`, `-s2-lite`, `-gateway`, `-runtime`, `-studio` (were `…-1`), network `nylorun-<name>` (was `nylorun-<name>_default`), volumes `nylorun-<name>-postgres`, `-restate`, `-s2-lite`, `-workspaces` (were `nylorun-<name>_postgres`, …), each labelled `dev.nylorun.tenant: <name>`. The Compose service `s2` is now `s2-lite` (`nylorun logs s2-lite`).
  - **Breaking (`nylorun`): Tenants created by 0.5 start fresh.** `start` on a Tenant whose data is in the old volumes exits 3 without starting it and names them; `nylorun reset --tenant <name>` starts it anew. `reset` and `delete` also remove the old volumes and the old network.
  - **Studio proxy.** One Caddy container per machine (`nylorun-proxy`, files in `~/.nylorun/proxy/`) gives each Tenant's Studio the address `http://<name>.localhost:<port>` (`NYLORUN_PROXY_PORT`, 4160 or a free port chosen once), on `127.0.0.1` and `[::1]` (IPv4 only, saying so, when Docker refuses `::1`). It holds no Tenant data and routes browsers only. `start` brings it up when Studio starts, prints Studio's proxy URL and signs in there (on Studio's own port when the proxy does not answer); a proxy failure never fails `start`. `status` shows both URLs, `ls` and `nylorun studio` the proxy's. `NYLORUN_PROXY_DISABLED=1` turns it off; a Tenant under `NYLORUN_HOME` or `NYLORUN_COMPOSE_PROJECT` does not use it. `doctor` has a `proxy` row.
  - **Several Tenants.** Restate's RocksDB memory is capped at 256 MiB, so a Tenant uses about 600–700 MB (was about 1.3 GB). `nylorun ls` has a `MEMORY` column (`memoryBytes` in `--json`). `start` names the other running Tenants and their memory. `nylorun stop --all` stops every running Tenant and the proxy, keeping their volumes.
  - **`@nylorun/studio`.** `NYLORUN_STUDIO_PUBLIC_ORIGINS` lists exact `http:` origins Studio also serves (Host and `Origin` checks); a login token's URL is on the origin it was minted on; `NYLORUN_STUDIO_SESSION_COOKIE` names the session cookie (default `nylorun_studio_session`; `nylorun` sets `nylorun_studio_<name>`, so Studios on one host keep their own sessions); the `421` answer lists the served origins.

### Patch Changes

- Pin runtime to the tested release.
- Pin studio to the tested release.

## 0.5.0-beta

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

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [4b9906f]
  - @nylorun/core@0.11.0-beta

## 0.4.0-beta

### Major Changes

- 5ca1923: **Clients for one Tenant per installation: a stack per project, nothing selects a Tenant.** Upgrade these with the Runtime; they speak protocol 5. Existing stacks are left as they are: see MIGRATION.md.

  - **Breaking (`nylorun`): one stack per project.** `nylorun start` in a project creates the project's stack (named after the project directory, or `--name`; Host root `~/.nylorun/stacks/<name>/`, Compose project `nylorun-<name>`, its own free ports and volumes), waits for its Runtime to create the stack's Tenant, writes the Project link (`.nylorun/link.json` format 2: `stack`, `hostUrl`, `hostId`, `tenantId`) and `.nylorun/credentials.json` (the key of the derived principal `project`, derived from the stack's admin key), and seeds the model provider from the project's `.env`. `nylorun ls` lists the machine's stacks and `nylorun delete <name>` removes one with its volumes and Host root. `nylorun status` shows the stack's Tenant; `nylorun studio` opens it. The old single stack under `~/.nylorun` is never touched: `start` notes it, and `nylorun legacy stop|delete` handles it. Every stack command takes `--name <stack>` (or `NYLORUN_STACK`, or the Project link's stack); `start --no-link` starts a stack without linking the directory; `nylorun reset` resets the selected stack only. The runtime container's healthcheck is now `/health`, so a Tenant that cannot open is reported by `start` from the Admin status at once instead of after a 300 s wait. `NYLORUN_HOME` still overrides the Host root. Stacks start and stop only when you say so.
  - **Breaking (`@nylorun/cli`): no Tenant commands.** `nylo tenant create|use|list|current|delete` are removed; `nylo status`, `nylo reset` and `nylo endpoints` replace `nylo tenant status|reset|endpoints` on the linked installation. `nylo env` prints `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY` only. `nylo` no longer writes Project links.
  - **Breaking (`@nylorun/agents`): no Tenant to name.** The `tenant` option (`createClient`, `Transport`, `resolveConnection`, `createActionHandler({ runtime })`, `JwksCache`) and `NYLORUN_TENANT` are gone, and no request sends `Nylorun-Tenant`; a connection is a URL and a key. A Project link of format 0 or 1 is refused with `connection_missing`, naming `npx nylorun start`. `verifyDeliveryToken`'s `tenantId` is optional: without it any Tenant issuer is accepted, since the installation's keys bind it. `TENANT_HEADER` is no longer re-exported.
  - **Breaking (`@nylorun/admin`): status only.** `createTenant`, `listTenants`, `getTenant` and `deleteTenant` are removed; `status().tenant` names the Host's Tenant, and `deriveTenantKey` / `deriveStudioToken` derive its keys. Local Host resolution reads the stack's Host root (`stack` option, `NYLORUN_STACK`, or the Project link's `stack`); `NYLORUN_HOME` and `home` still override it. `stackHostRoot(name)` is exported.
  - **Breaking (`@nylorun/studio`): Studio serves its installation's Tenant.** The Tenant picker, list and create are gone, with `/_studio/tenants`; `/` opens `/tenants/<id>`. The `/tenants/:tenant` routes and the login token's `tenant` claim stay for embedders and must name that Tenant. The proxy sends no `Nylorun-Tenant`.
  - **`@nylorun/create-agent`:** the next steps are `npx nylorun start`, then `npm run dev`.
  - `@nylorun/core`: `ProjectLinkFileSchema` accepts format 2 with `stack`, and `tenantId` is optional; `ERROR_CODES` loses `tenant_conflict` and `active_work`.

### Minor Changes

- ee9e471: **Only the gateway can read the vault key (F4.2).** `nylorun start` writes the Tenant's vault key to `<Host root>/keys/vault-kek`. Only the `gateway` container mounts `keys/`, read-only, and runs `--service gates,keys`. The runtime container covers `keys/` and `docker/` with empty read-only mounts, so it reads neither the vault key nor Restate's private key and `.env`. `nylorun reset` deletes the key with the Tenant's data.
- e3af093: **A stack's Docker Compose files live in `docker/`.** `compose.yaml`, `.env` and `restate-identity.pem` are written to `~/.nylorun/stacks/<name>/docker/` (or `$NYLORUN_HOME/docker/`), so the folder says what it holds: to change a port, edit `docker/.env`. The single stack of older releases keeps its `~/.nylorun/stack/`, which `nylorun legacy` reads as it is.
- 7bd38d6: **The local stack runs a gateway container: model calls leave the Runtime.** `nylorun up` now runs the Runtime image twice, the combined packing: `runtime` (`--service core,loop`: the APIs and the agent loop) and `gateway` (`--service gates,keys`: the Model Gate, the Tool Gate and the keys service). Every model call, remote MCP call and Action delivery of the loop crosses the gateway, which alone reads the Tenant's credentials and the vault key. A new stack starts with the gateway.

  - **Breaking for hand-written Compose files:** in a container, a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and `NYLORUN_GATES_TOKEN`. Run the image a second time with `--service gates,keys` (see `DEPLOYMENT.md`). The image's default command is now `--service core,loop`.
  - The gateway has no published port, mounts only the Host's Tenant directory (`tenant/`) and `keys/`, both read-only, and reaches model servers on this machine at `host.docker.internal`. `docker/.env` holds `NYLORUN_GATES_TOKEN`, generated once and kept across starts.
  - `nylorun status` shows a Gateway line, `nylorun doctor` fails when the gateway is unhealthy and names `nylorun logs gateway`, and `nylorun logs gateway` is accepted.
  - An image set with `NYLORUN_RUNTIME_IMAGE` must be this release or newer: older Runtimes don't know `--service`.

- 31cfec0: **Action deliveries leave through the gateway (F4.1).** With the gates service, every delivery and endpoint ping is POSTed by the gateway (`POST /nylorun/v1/deliveries`) under the gateway's own `NYLORUN_ENDPOINT_*` policy. The delivery state machine is unchanged. A gateway that cannot be reached counts as a delivery that was not sent, so it is retried, and its failure code is `gateway.unreachable`.

  - `nylorun`: the `gateway` container now sets `NYLORUN_ENDPOINT_LOOPBACK=docker-host`, so Action endpoints on this machine stay reachable.
  - A process that runs only `core` also reads `NYLORUN_GATES_URL`, for endpoint pings.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [fed780d]
- Updated dependencies [fed780d]
- Updated dependencies [7f4c3f1]
- Updated dependencies [5ca1923]
- Updated dependencies [5ca1923]
  - @nylorun/core@0.10.0-beta

## 0.3.0-beta

### Minor Changes

- e28b8a9: **New projects serve their tools as an Action endpoint.** Everything Nylorun ships now uses Action endpoints instead of executors. `connectAgents` still works, but it is deprecated.

  - **Starter (`create-agent`).** `src/main.ts` serves the agents with `createActionHandler` on `http://localhost:3001/nylorun/actions` (`PORT`, `NYLORUN_ACTIONS_URL`) and registers it. `npm run dev` and `npm start` work as before. The README explains which URL the Runtime must reach.
  - **Local stack (`nylorun`).** The Runtime container sets `NYLORUN_ENDPOINT_LOOPBACK=docker-host` and maps `host.docker.internal` to the Docker host, so a `localhost` endpoint on the developer's machine is reachable, on Linux Docker Engine too.
  - **Examples.** The AG-UI and browser-direct apps serve their Action endpoint at `/nylorun/actions` beside their other routes, and `register(origin)` replaces `connection.ready`.
  - **Docs.** The README, `DEPLOYMENT.md` and the `@nylorun/agents` README describe Action endpoints.

- 50d0fb5: **The Admin API on its own listener.** A Runtime can serve the Admin API on an operator listener, so the port that faces browsers and reverse proxies serves the Tenant API alone. The stack does this by default.

  - **Runtime.** With an operator listener (`adminPort` in `host.json`, or `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST` and `NYLORUN_ADMIN_ALLOWED_HOSTS` in a container), the public listener answers `/v1/admin/**` with the opaque `404` and the operator listener serves the Admin API, Host shutdown and the Tenant API, never to browsers. Each checks `Host` against its own port. `/ready` needs both listening; a taken port on either exits with code 98. Without one, a single listener serves everything as before.
  - **Stack.** `nylorun start` publishes the operator port on loopback (`NYLORUN_ADMIN_PORT`, default 8788), writes it to `host.json` as `adminPort`, and points Studio at `runtime:4001`. `nylorun status` prints it.
  - **Admin client.** Reads `adminPort` from `host.json` and sends Admin API requests there (`admin.adminUrl`); `admin.url` stays the Tenant API URL. A `host.json` without `adminPort` keeps working.

- 9546ac7: **The stream relay, ready to wire in.** The Runtime gains the relay that will feed S2 from a Postgres record of session events over logical replication (Durable Streams v1); nothing uses it yet.

  - **Relay core** (`streams/relay/`): per-session pumps appending with `matchSeq`, acknowledgements only after S2 has the rows, refills from the record on a gap, reconciliation after a new or lost slot, and rows of an old basin generation dropped.
  - **Change source** (`adapters/replication/pgoutput.ts`): a persistent `pgoutput` slot, one active process per slot, always resumed from the confirmed position; a pending reconciliation is kept in `nylorun_streams.relay_slots` so a crash cannot skip it.
  - **Shared schema** (`nylorun_streams`): `session_events`, `session_log_heads`, `relay_slots` and the `nylorun_stream_relay` publication, migrated by the Host.
  - **Basin generations**: `basinOf(tenantId, generation)` names a Tenant's later basins (`<basin>-<g base36>`).
  - **Local stack**: Postgres runs with `wal_level=logical` and `max_slot_wal_keep_size=4GB`. `nylorun start` recreates the Postgres container once; its data volume is kept. `DEPLOYMENT.md` lists the settings for a Postgres you run yourself.

- 9d52189: **Embedding Studio in a desktop app.** Studio can be shown inside a desktop app such as Babai Desktop, in an iframe loaded from its URL and signed in by `postMessage` with a token limited to one Tenant.

  - **`nylorun`.** The local stack lets Babai's origins frame Studio: `NYLORUN_STUDIO_FRAME_ANCESTORS` in `stack/.env` defaults to `nylorun://localhost http://nylorun.localhost` and is passed to the Studio container. `nylorun start --studio-embed-origin <origin>` (repeatable) adds an exact origin, such as a desktop app's dev server, and keeps it across starts until `--studio-embed-origin-reset`. Wildcards are refused. `nylorun status` lists the origins under `Embeds`, and `status --json` as `studio.embedOrigins`.
  - **`@nylorun/admin`.** `mintStudioLoginToken({ studioUrl, adminKey, tenant?, subject? })` mints a single-use Studio login token from an app's backend. With `tenant`, the session it leads to reaches only that Tenant.
  - **Studio.** `POST /_studio/sessions` exchanges such a token for a one-hour bearer session kept in the frame's memory; dashboard pages send `frame-ancestors` from the allowlist instead of `X-Frame-Options: DENY`; `?embed=1` hides Studio's branding, follows the app's theme and routes, and reports its own; `/tenants/:tenant/sessions/:session` opens a session by id. The cookie login of `nylorun studio` is unchanged.

    The dashboard routes `/tenants/:tenant`, `/tenants/:tenant/agents/:agent`, `/tenants/:tenant/agents/:agent/sessions/:session`, `/tenants/:tenant/sessions/:session`, `/tenants/:tenant/vault` and `/tenants/:tenant/settings` are now a public contract for embedders: removing or changing one is a breaking change.

### Patch Changes

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

- c0f4623: `nylorun up`/`start` refuses to downgrade the shared stack. When this release pins a Runtime older than `host.json` `runtimeVersion` or the running Runtime's `/health` version, it exits 5 before changing the stack files or containers, and names the remedy: update nylorun, or pass the new `--allow-downgrade` flag. `nylorun studio` applies the same check when it starts the stack. With `NYLORUN_RUNTIME_IMAGE` set, the check is skipped and `host.json` keeps its recorded `runtimeVersion`.
- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
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

## 0.2.1-beta

### Patch Changes

- db956bc: Studio creates Tenants. While the Host has none, Studio asks for a name and creates the first one. A Tenant with no agents shows **Connect your code**: its model provider, the `npx @nylorun/cli tenant use <id>` command, and `npm run dev`. It switches to the agent list when the first agent registers.

  Every Tenant Studio creates registers the derived principal `project` (`PROJECT_PRINCIPAL_ID` in `@nylorun/admin`). `nylo tenant use` now falls back to that key, derived from the local admin key, so a Project links a Studio-created Tenant with no stored key. When it replaces a one-time application key, it keeps that key as `.nylorun/credentials.<tenantId>.json`, and `nylo tenant use <that id>` switches back. `nylorun up` again offers Studio for creating the first Tenant.

- Pin studio to the tested release.

## 0.2.0-beta

### Minor Changes

- c82aa6f: `nylorun up` prints Studio as `http://localhost:<port>`, with no login token in it, and in a terminal opens Studio in the browser already signed in (`--no-open` keeps the browser closed). The Studio sign-in lasts 30 days and survives Studio restarts: the session cookie is signed with a key derived from the admin key instead of being held in memory. `nylorun studio` prints the plain URL when it opens the browser; `nylorun studio --no-open` still prints the single-use login URL.

### Patch Changes

- 5e4947a: `nylorun up` no longer says a Tenant can be created in Studio, which has no way to create one. While the Host has no Tenant, it names `npx @nylorun/cli tenant create` alone.
- Pin studio to the tested release.

## 0.1.2-beta

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies [8cda500]
  - @nylorun/core@0.8.0-beta

## 0.1.1-beta

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies [a322696]
  - @nylorun/core@0.7.0-beta

## 0.1.0-beta

### Minor Changes

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [bf1c2da]
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
  - @nylorun/core@0.6.0-beta
