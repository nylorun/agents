# @nylorun/agents

## 0.24.0-beta

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

- 1ded443: Track T3, Agents that evolve: an Agent moves between versions of its manifest in place, with its id, disk, vault and sessions. `PUT /v1/agents/{id}` with another version moves it (`?dryRun=true` answers the plan, `AgentMovePlan`), and saving a manifest moves every Agent that tracks it. A harness-only change applies at once; a runtime change a pod applies only when it starts (image, resources, network, setup, files) leaves the Agent outdated (`targetVersion`, `waitingFor: "start"`) until its pod's next start, on the same volume; a version that adds a required secret waits for its value (`waitingFor: "secrets"`, state `input_required`). Its manifest's name, kind, harness and storage are fixed: `409 agent_fixed_field` replaces `409 agent_upgrade_unavailable`. Only secrets that fill a slot of the running version are used; others stay in the vault, dormant. New events `agent.outdated` and `agent.version_changed`, `GET /v1/agents?outdated=true`, and the save plan's `moves` and `agents_move` warning. Migration 0033 adds the Agent's target and failed versions and its start check.
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

## 0.23.0-beta

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

- 23774c4: **The last hard-coded limits are configuration (harness boundary B15c).** Still protocol 15 and Harness API 4. Every default is the value before. See MIGRATION.md, and DEPLOYMENT.md's Runtime limits and Host tuning.

  - **21 more Runtime limits** (`GET`/`PUT /v1/tenant/limits`): a message's parts (`messageParts`), page sizes (`pageItems`, `exportPageItems`, `environmentEventItems`; a page asked larger holds that many), labels (`artifactLabels`, `labelKeyChars`, `labelValueChars`), a manifest's setup command, descriptions and secret hosts (`setupCommandChars`, `manifestDescriptionChars`, `secretDescriptionChars`, `secretHosts`), a failed pod's reason (`setupReasonChars`, `setupCommandExcerptChars`), secret values (`secretValueChars`), the tool policy and budgets (`toolRules`, `toolRuleFieldChars`, `toolRuleTextChars`, `modelBudgets`) and flows (`flowConcurrency`, `flowMapItems`, `flowLoopIterations`, replacing the `NYLORUN_FLOW_*` variables no Host read). Request schemas lose these maxima; the Runtime checks the Tenant's.
  - **More Host tuning** (`NYLORUN_TUNING`): token lifetimes and clock tolerance (`keys.*`), the advance deadline and grace (`execution.*`), `nylorun-operate`'s waits, the credential store's lock, sweep arming, Postgres batches and the replication pool, a basin repair's log cadence, egress sockets, the engine poll and sandbox memory floor, MCP listing pages and diagnostics, sandbox helper commands, the scrub threshold, exec event and local stream sizes; and in the engine, `flowValueChars` and `toolResults.minPreviewBytes`.
  - **The CLI's own waits are `NYLORUN_CLI_TUNING`**: `nylorun start`'s waits and polls, the Compose healthchecks and WAL cap, and `nylorun local sandbox`'s waits.
  - **Studio follows the Runtime's limits**: no upload cap of its own, the Tenant's `requestBodyBytes` read for a write it parses past the default (`@nylorun/agents` exports `RUNTIME_LIMIT_DEFAULTS`), no CPU cap in its form.
  - **Kept, each justified where it is defined**: Linux's `MAX_ARG_STRLEN` (a setup command's ceiling) and `PATH_MAX` (a link target), a model-facing tool name's 64 characters, RFC 6838's media type length, Postgres's 65,535 bind parameters, a tmpfs page, and identifier grammars (the protocol's).

- 2459430: **An `environment_secret` reads `nylorun_managed` in the sandbox instead of `nylorun-managed`, so CLIs that check a token's format send their requests.**

  - The Vercel CLI refuses a `VERCEL_TOKEN` with any character outside letters, digits and `_` (`Must not contain: "-"`) and exits before egress-gate can set the header. `ENVIRONMENT_SECRET_SENTINEL` is now `nylorun_managed`.
  - egress-gate never compares the value: it replaces the credential's header whatever the CLI sent, so nothing else changes. A script that checks for the literal `nylorun-managed` should check for `nylorun_managed`.

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

## 0.22.0-beta

### Minor Changes

- a0cf8b2: **HTTP tools take `GET` and `DELETE`, and URL path parameters.**

  - `method` is `GET`, `POST` (default), `PUT`, `PATCH` or `DELETE`. `POST`, `PUT` and `PATCH` send the input as the JSON body, as before. `GET` and `DELETE` send no body: the input becomes the query string, after any query string written in the URL. An array repeats its name (`tag=a&tag=b`) and a `null` is left out.
  - The URL's path may name input fields as `{field}`, as in `https://api.example.com/orders/{orderId}`. Each value is percent-encoded into the path and is not sent again in the body or query string. A value that is empty, `.` or `..`, or not a string, number or boolean is refused before the call is sent (`tool.invalid-input`).
  - `http()` and the manifest contract check a tool against its input schema. Each `{field}` must be a required scalar property. For `GET` and `DELETE`, a property must not be an object and must not repeat a query parameter the URL already sets.
  - An HTTP verifier still takes only `POST`, `PUT` or `PATCH` and a URL without `{field}` parameters, because it is sent `{ input, output, iteration }` as a body. A credential with `via` cannot serve a tool with `{field}` parameters (`http.credential`).
  - core exports `httpToolRequest`, which maps a call's input to the request, and `httpPathParameters`. The Runtime's outbound `post()` is now `send()`, which can send a request without a body.

### Patch Changes

- 620072d: **Docs and schemas match what the CLI and the Runtime do.**

  - `@nylorun/core`: the environment manifest's JSON Schema (`@nylorun/core/schemas/environment-manifest.json`) takes the CLI's `{ path, from }` `files` entry, so an editor no longer flags a manifest that `nylorun environments manifests save` accepts. The Runtime's own schema is unchanged: the CLI turns the folder into `{ path, files }` before saving. `manifest_changed` says to save without `If-Match` (`--if-match`, `ifMatch`); no command takes `--force`.
  - Tool names, skill names and MCP server names are each unique within their kind, as the builder and the Runtime check; a tool, a skill and a server may share a name. The docs said they were unique across kinds.
  - `harness_mismatch` is described as what it is since protocol 14: an Environment's harness is fixed for its life (fork onto a manifest version to run another), and a session's turn is refused when its Environment id was deleted and made again with another harness, or an Environment changed in place before protocol 14 applies that change.
  - `@nylorun/agents`: the README names `nylorun environments list | delete`, not `nylorun local sandbox ls | rm`.
  - MIGRATION.md no longer offers a tool's `approval`, removed in protocol 11, as a replacement for step middleware.

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

## 0.21.0-beta

### Minor Changes

- 3a32a57: **Files by hash and images by digest (Q6, Q14).** An Environment's `files` entry may name files by content hash, and a pod Environment runs its image by digest once a pod ran it.

  - **Files by hash.** `{ path, files: { "<relative path>": "sha256:<hex>" } }` copies each definition file the Tenant holds (`PUT /v1/files/sha256:<hex>`, at most 10 MiB each, at most 1000 per entry) under `path`, before `setup`. A file the Tenant does not hold is refused when the manifest is saved or the Environment made. The engine reads them as a folder through `host/files/{index}`. `@nylorun/agents`: `environmentFiles(path, contents)` hashes them, and `manifests.save(manifest, { files })` and `plan()` upload those the Runtime lacks.
  - **Images by digest.** The sandboxes service reports the workload container's `imageID`; the first time a pod is ready the Runtime records it (`pod.imageDigest` in the view) and every later apply runs that digest, so a stop, relaunch or reset never pulls another image under the same tag. A fork pulls afresh. Migration 0027.
  - **Studio** lists files by hash on the Environment page.

- af90d1e: **Forks: how an Environment gets a new manifest version (Q15, Q17).** `POST /v1/environments/{id}/fork` makes a new Environment `id` from a manifest version (default the source's manifest at its latest), its disk started from a version of the source's (`disk`: `latest`, the default, snapshots first; a version; or `empty`) and the secrets the new manifest declares copied inside the Runtime (`secrets: "none"` copies none): each value is unsealed and sealed again under the new vault, with the slot's binding. The source keeps what it runs, its disk and its sessions, and gets `environment.forked`; the new Environment's view has `forkedFrom`. `dryRun: true` answers the plan: the disk, the secrets copied and left behind, required slots still missing, the changes and the sessions that stay. Migration 0026.

  - **Setup on a forked disk.** A pod fork onto other setup runs the new version's setup on the copied disk before its first turn: the engine connects first (the join answer's `afterSeed`), core writes the disk version through it, then the engine runs the setup, and turns wait until it reports it done. A fork onto the same setup, a restore and a lost-volume recovery skip it, as before.
  - `@nylorun/core`: `ForkEnvironmentRequestSchema`, `EnvironmentForkPlanSchema`, `ForkEnvironmentResponseSchema`, `EnvironmentView.forkedFrom`, the `environment.forked` event and `forkedFrom` on `environment.created`.
  - `@nylorun/agents`: `client.environments.fork(id, { id, manifest?, disk?, secrets?, labels?, ownerUserId? })` and `planFork()`.

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

- b5ea2b5: **An agent is its manifest: step middleware and capability bundles are removed from authoring.** The Runtime already refused middleware; now the local engine runs none either, and an agent is built only from the builder's own methods. No protocol change. See MIGRATION.md.

  - **Removed:** `.use()`, `.capability()`, `capability()`, `CapabilityBuilder`, `middleware()`, `model()`, `StepMiddleware`, `StepRequest`, `StepResponse`, and `Implementations[id].middleware`. To reuse tools and instructions, write a function that adds them; a bundle you publish is an Agent Plugin.
  - **`@nylorun/agents`:** the standalone `skills()`, `plugin()` and `mcp()` factories are removed; use `.skills(dir)`, `.plugin(dir)` and `.mcp(servers)`. `.skills()` takes no options: the part takes the folder's name.
  - **`@nylorun/harness`:** each step offers the definition's tools and instructions in order. The `middleware.entered`, `middleware.completed` and `middleware.lease-violation` observe events are gone, and a model request carries no `model` directive or runtime context items.

- f44c018: **Sessions on one Environment run their turns at the same time, and egress is recorded on the Environment (protocol 14, D66, D67).** A second session's turn on an Environment was refused with `409 environment_busy` until the first ended. Now any session on it may start a turn while others run; one turn per session stays. Which sessions work on one disk, and when, is the app's call. See MIGRATION.md, "Parallel turns, and egress on the Environment".

  - **Turns.** `checkEnvironmentTurn` no longer refuses a turn because another session's turn runs, and the flow-tree exception is gone. `environment_busy` still answers stop, reset, snapshot and restore while any turn runs, and a turn while a disk copy runs.
  - **Egress.** Every connection through egress-gate, allowed or refused, is `environment.egress` on the Environment's stream, with `runningTurns: [{ sessionId, turnId }]`, the turns running when it opened (at most 16). `egress.connection` leaves the session event catalog, and turn traces carry no `CONNECT` span.
  - **Reading it.** `GET /v1/environments/{id}/events` takes `types` (comma-separated), `since` and `until` (ISO times); `client.environments.events(id, { types, since, until })` in `@nylorun/agents`, and `nylorun environments events <id> --types --since --until`.
  - `@nylorun/core`: `EgressRunningTurnSchema`, `EgressRunningTurn`; `EgressConnectionPayloadSchema` gains `runningTurns`.

- 0b7cbbd: **Studio shows an Environment's connections (D67).** The Environment page's Events tab filters all events, its lifecycle, or the connections its sandbox opened, each with its host, outcome, bytes and the turns that were running. A session's Environment tab lists the connections a pod Environment opened while that session's turns ran, and names the other sessions whose turns ran too, since a connection is the Environment's. `@nylorun/agents` exports `ENVIRONMENT_EVENT_TYPES` and the types `EnvironmentEventType` and `EgressRunningTurn`.
- c8e640b: **A tool call is traced from the log alone to its skill or MCP server and the plugin that brought it.** No protocol change beyond 13. See MIGRATION.md.

  - **`tool.completed`** gains `skill` and `plugin` (`{ name, version? }`), and tool call rows (`GET /v1/sessions/{id}/calls/tool`, `session.toolCalls()`) gain `skill` and `plugin`, `null` when there is none. An MCP call gets its server's plugin. `load_skill` and `read_skill_resource` get the skill they name, and a sandbox tool whose input names `/skills/<name>/` gets that skill; both get the skill's plugin.
  - **`kind: "harness"`** (`TOOL_CALL_KINDS`): a tool the turn's harness declared in `hello.features.tools`. Such a call said `platform` before.
  - **`mcp.discovered`** names each server's `plugin`.
  - `@nylorun/core`: `skillOfToolCall`, `pluginOf` and `ToolCallTrace` in `/define`.
  - **Studio** shows each tool call's kind, server or skill, and a plugin badge, in the chat and the event details and summaries, and the plugin of each server `mcp.discovered` lists.

### Patch Changes

- bc22487: **`nylorun` does what `@nylorun/agents` does: `agents`, `sessions`, `environments` and `artifacts`.** Each is a group on the Runtime API, with the installation's application key, an identity provider's token (`NYLORUN_TOKEN`), and `--as <subject> [--scope <scope>]...` to act for a person.

  - **`agents list | get | save`:** `save <manifest.json|-> --files <dir>...` saves an agent from its manifest, uploading the definition files it names (found by their SHA-256) that the Runtime lacks.
  - **`sessions`:** `list`, `create`, `get`, `send` (text, `--data` JSON, or `--file <artifact>[@<version>]` parts), `approve [--deny]`, `respond`, `cancel`, `watch [--follow]` (events as JSON lines), `history`, `usage`, `calls [--tool]`, `trace`, and `exec <id> -- <command>` (bash in the session's sandbox; exits with its exit code).
  - **`environments`:** `list`, `get`, `put <id> [<recipe.json|->] [--kind] [--label]`, `stop`, `reset`, `delete`, `snapshot`, `versions`, `restore`, `delete-version`, `events`, and `secrets list|get|put|rm`; a secret's JSON comes from a file or standard input, never the command line.
  - **`artifacts`:** `list`, `get`, `upload <file|->` (`--to <id>` for a new version), `download`, `tree`, `diff`, `zip`, `link`, `rm`.
  - **`nylorun` now depends on `@nylorun/agents`.** A release of `@nylorun/agents` releases nylorun too.
  - **`@nylorun/agents`:** an incompatible Runtime's remedy names `npx nylorun@latest start` instead of a `nylorun runtime restart` that no longer exists.

- 9b07bdd: **Studio and the starter for environment manifests (protocol 14).**

  - **Studio, Environments page:** lists the environment manifests (each one's latest version, its kind, how many Environments were made from it, and who saved it). It saves a new version from JSON, with Check showing the plan first, under `If-Match`, so a save over someone else's is refused. It also makes an Environment from a version. Studio is one more client: any credential that may write Environments can do the same from the CLI or the SDK.
  - **Studio, Environment page:** shows the manifest version it was made from and whether a newer one exists ("Fork to vN"), the Environment it was forked from, its secret slots set or missing, and its pod's image digest. **Fork** opens the fork with its plan (disk, secrets copied and left behind, slots still missing, changes) before it makes the new Environment.
  - **The starter** ships `environments/scratch.json` (a virtual workspace with no network). `src/main.ts` saves each manifest in `environments/` beside the agents.
  - `@nylorun/agents` exports the manifest and fork contract types (`EnvironmentManifestView`, `EnvironmentManifestPlan`, `EnvironmentForkPlan`, …).

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

## 0.20.0-beta

### Minor Changes

- 5165451: **A pod's disk can start prepared, and every Environment's disk has versions (R2d steps 2 and 3).** Before, a new pod volume was empty and a disk could only be kept or reset. Now:

  - **Setup and input files** (pods, Host feature `environment-setup`): `PUT /v1/environments/{id}` takes `files` (versions of Tenant-wide artifacts, copied in: a file at its `path`, a folder under it) and `setup` (commands run in order with `/bin/sh -c`, `cwd` default `/workspace`, `timeout` default 10m and at most 30m, at most 16 of each). They run once per new disk, after the pod's engine joins and before its first turn, with the Environment's variables, secrets (as the sentinel) and egress. A failed command fails the pod (`observed: failed`, reason `setup: command N …`, an `environment.failed` event with the exit code and the end of the output) and the turn waiting for it; the next turn start runs the setup again. A virtual Environment refuses both with a `400`.
  - **Disk versions** (Host feature `environment-disk-versions`): `POST /v1/environments/{id}/snapshot` keeps a version of the disk between turns (`/workspace`, and a pod's `/harness` but the engine's own files) as a version of a folder artifact the Environment owns, with modes, modification times, links and empty directories (folder manifest `nylorun.folder.v2`); each file's bytes are stored once, and an unchanged disk makes no version. `POST .../restore` puts a version back: a virtual Environment at once, a pod on a new volume seeded before its next turn (`disk.operation` in the view meanwhile; turns wait). `PUT` with `from: { environment, version }` creates an Environment from another's version. `GET .../versions` and `DELETE .../versions/{n}` list and delete them; their trees, files, diffs and zips read through `/v1/artifacts`. A lost pod volume with a version is recovered from the latest one instead of refusing turns until a reset. Snapshot and restore during a turn are `409 environment_busy`. `EnvironmentView.disk` gives the latest version and the copy in progress. Migration `0021_disk_versions`.
  - `@nylorun/agents`: `client.environments.snapshot`, `restore`, `versions` and `deleteVersion`; `put` takes `setup`, `files` and `from`.

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

- b6214d9: Add opt-in artifact metadata pagination to `GET /v1/artifacts?limit=…`, shared
  `ArtifactListItem`/`ArtifactPage` contracts and SDK `artifacts.page()` (default 50,
  maximum 200). Hosts advertise `artifact-reads`. Pages order by creation time and
  ID descending, filter by session, kind and labels, bind cursors to the Tenant and
  filters, and reapply ownership and agent grants on each read. Legacy unpaged
  responses remain unchanged. A Drizzle migration adds the creation-order index;
  pages reuse the existing bounded read-only pool. Studio and every other Runtime
  client can consume this public API without database access.
- a0cbca1: **Clearer wording when a definition runs your code.** The refusal for a code tool or a flow's tool stage, the `hooks were removed` error and `nylo endpoints` now say that the Runtime runs agents from their manifests alone, instead of that it runs no code of yours during a session. Only the message text changed; anything matching the old wording (for example `runs no code of yours during a session`) needs the new text.
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

## 0.19.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [212364b]
  - @nylorun/core@0.19.0-beta

## 0.19.0-beta

### Minor Changes

- 7780b2f: **One client and connection layer.** The Project link and credentials are read one way, and every Runtime client shares one `/health` probe.

  - `@nylorun/core`: `@nylorun/core/project` (Node only, the one Core subpath that imports Node modules) reads the Nylorun home, a local Tenant's Host root (`tenantHostRoot`), the Project root (`findProjectRoot`) and the Project link and credentials (`findLinkedProject`, `readProjectLink`, `readCredentialsFile`), validated with `ProjectLinkFileSchema` and `ProjectCredentialsFileSchema`; a broken or newer file throws `ProjectFileError`. `@nylorun/core/transport` (browser-safe) holds the `/health` compatibility probe (`checkHealth`), `parseProtocolRange` (on `ProtocolRangeSchema`, ignoring fields a newer Host adds), `describeIncompatibility`, `requestHeaders` and `readBody`.
  - `@nylorun/agents`: `resolveConnection` and `createClient()` find the Project as every reader does: the nearest directory with `.nylorun/` from `cwd` upwards, never the home directory or above it (they used to walk to the filesystem root, and past a `.nylorun/` without a link). A link without `credentials.json`, or a link or credentials file that does not validate, is now `connection_missing` naming the file and `npx nylorun start`, instead of a raw file-system or parse error. `@nylorun/agents/client` loads the link reader only when `createClient()` resolves a connection, so it imports no Node module. The root entry re-exports `checkHealth`, `describeIncompatibility` and `parseProtocolRange`.
  - `@nylorun/admin`: `createAdmin` reads the Project link with the same reader. A link that does not validate is now refused like one from an older nylorun (when nothing else names the Host root), and a linked Project's `credentials.json` that does not validate is `connection_missing` instead of being skipped. `@nylorun/admin/project` re-exports `@nylorun/core/project` for tools that depend on this package. The `/health` check and request headers come from `@nylorun/core/transport`.
  - `nylorun`: reads the Project link and credentials with `@nylorun/core/project`; a credentials file whose keys are not 64 hex characters is replaced by `start`, as an unreadable one was. No command changes.
  - `@nylorun/cli`: `nylo` reads the Project root, link and credentials through `@nylorun/admin/project` instead of its own copies, with the same messages. No command changes.
  - `@nylorun/studio`: the server's Runtime compatibility probe is `checkHealth` from `@nylorun/agents`.

### Patch Changes

- 070674d: **One source of truth for the manifest and Harness API schemas.**

  - `@nylorun/core`: `Agent.from` (`agentFrom`) checks a manifest with `AgentManifestSchema`, the Runtime's own check, instead of a validator of its own, and refuses with `agent.build-failed` and the schema's messages (each prefixed with its path, such as `capabilities.0.tools.0.name: …`). It now refuses what the Runtime refuses at registration and it let through, such as unknown fields (it dropped them) or a tool or MCP server name that not every model provider accepts. The schema names a top-level `model` or `schemaVersion` and a capability's `model` as before, and the skill whose `files` are wrong (`Skill 'triage' files must include SKILL.md`). The rebuilt manifest is a frozen copy; the object passed in is no longer frozen. `AgentManifestSchema` and `WorkflowManifestSchema` are no longer force-cast to their types: the build checks that each accepts exactly `AgentManifest` and `WorkflowManifest`. `@nylorun/core/contracts` exports `McpServerManifestSchema`, `HEADER_NAME_PATTERN` and `LOOPBACK_HOSTS`. The Harness API's types (`@nylorun/core/harness-api`) are inferred from the schemas that validate its frames, so they match them: `TurnStart.manifest`, `TurnStart.checkpoint` and `RunRouting.rootManifest` are `object`, `WorkspaceCall.tool` is a sandbox tool name, `ABORT_REASONS` is a tuple, and properties are no longer `readonly` (arrays that were stay so).
  - `@nylorun/harness`: `runDurable` checks the manifest once, when it rebuilds the agent, instead of twice. The unpublished, stale `schemas/manifest.schema.json` (manifest `schemaVersion` 2) is gone; `z.toJSONSchema(AgentManifestSchema)` is the manifest's JSON Schema.
  - `@nylorun/agents`: a plugin's MCP servers are checked with core's `McpServerManifestSchema`, header-name pattern and loopback hosts. A server whose key is not a name every model provider accepts is skipped with a `plugin.mcp-server-skipped` warning, since the Runtime would refuse the manifest declaring it.
  - `@nylorun/runtime`: the stack configuration reads its four listeners (`NYLORUN_LISTEN_*`, `NYLORUN_GATES_LISTEN_*`, `NYLORUN_HARNESS_LISTEN_*`, `NYLORUN_EGRESS_LISTEN_*`) with one parser; the variables and their errors are unchanged.

- Pin core to the tested release.
- Updated dependencies [7780b2f]
- Updated dependencies [070674d]
  - @nylorun/core@0.18.0-beta

## 0.18.0-beta

### Major Changes

- 50e2f7e: **Protocol 10: MCP credentials come from a session's vaults only.** Nylorun no longer signs the installation in to MCP servers with OAuth and no longer asks a credential resolver. Upgrade every package together; MIGRATION.md has the details.

  - **Breaking (`@nylorun/runtime`): the MCP OAuth connect is gone.** `POST /v1/tenant/vaults/{vaultId}/oauth/start` and `GET /v1/oauth/callback` answer `404`. The vault credential type `oauth` and its refresh are gone: a credential is a `bearer` token or a `headers` map bound to a URL. Migration `0016_mcp_oauth_removed` drops the table of pending connects and deletes every `oauth` credential, writing one audit row each (actor `migration`); the Runtime logs `oauth_credential_removed` once for each, naming its vault, id and URL.
  - **Breaking (`@nylorun/runtime`): the credential resolver is gone.** The gateway no longer asks the operator's resolver for a person's credential when the session's vaults hold none. A process that still sets a `NYLORUN_RESOLVER_*` variable logs `resolver_removed` and ignores it. Keep a person's own keys in their user vault and attach it to their sessions (`vaultIds`). `TenantConfig.resolver`, `TenantConfig.publicUrl`, `TenantConfig.vaultFetch`, `startEphemeralRuntime({ resolver })`, the `ResolverConfig` export and `VaultService`'s `fetch` option are removed; `NYLORUN_PUBLIC_URL` still sets the protected resource metadata's `resource`.
  - **Breaking (`@nylorun/core`):** `PROTOCOL_VERSION` is 10 and `HOST_PROTOCOL` 4–10. `StartOAuthRequest`, `StartOAuthResponse`, the `oauth` variants of `CreateCredentialRequest` and `RotateCredentialRequest`, `oauth` in `CredentialInfo.type` and `CredentialInfo.expiresAt` are removed, and `ERROR_CODES` drops `oauth_client_required`, `oauth_state_invalid` and `oauth_failed`. `@nylorun/agents` and `@nylorun/cli` send protocol 10.
  - **Breaking (`@nylorun/admin`):** `admin.vaults` loses its OAuth start method.
  - **Breaking (`nylorun`):** the `connect` subcommand of `nylorun mcp` is removed (`nylorun mcp inspect` lists a server's tools instead), and the gateway's Compose service no longer passes the `NYLORUN_RESOLVER_*` variables.
  - `@nylorun/studio`: the Credentials page loses the OAuth type, the Expires column and the OAuth connect hint.

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

## 0.17.0-beta

### Major Changes

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

## 0.16.1-beta

### Patch Changes

- cb29dea: **READMEs for manifest-only agents.** Documentation only; no code changes.

  - `@nylorun/agents`: the Flow agents example opens the PR with an `http()` tool stage instead of a code tool, and shows how to keep a person's approval: a flow stage cannot take `approval` yet (`flow.approval-unsupported`), so the HTTP tool goes to an agent stage with `approval: "always"`. Requests set `Nylorun-Protocol` 8. The subagents section says `ctx.state`, `ctx.agent` and `ctx.ask`/`ctx.approve` apply only to `tool({ run })` in the local engine.
  - `@nylorun/cli`: no longer says `nylo endpoints` uses the Runtime API or replaces `nylo tenant endpoints`; it was removed with Action endpoints and exits 2.

## 0.16.0-beta

### Major Changes

- 4bd2a0b: **Flows run no code: workflow manifest v3 (manifest-only agents, step M2).** A flow agent is data: each stage gets the previous stage's output, a switch reads it, a map runs over it and a loop asks a verifier agent. See MIGRATION.md for what replaces each function.

  - **Breaking (`@nylorun/core`, `@nylorun/agents`):** stage `input` functions, `switch` `on`, loop `verify` functions and `decide` are removed; a builder option that names one is refused with what replaces it. `.loop()` takes a verifier agent and a required `max`. New `.pipe(...children)` adds one stage per child; `.step()` is a deprecated alias (`NYLORUN_DEP_STEP`). `Chain`, `Switch`, `Parallel`, `Map`, `Loop`, `withInstructions`, `withoutTools`, `isSlot`, `functionKey` and the `StageArgs`, `LoopVerifyFn`, `LoopDecideArgs`, `LoopChoice` and v1 workflow types are removed. `Agent.from` for a flow takes tool nodes only.
  - **Breaking (`@nylorun/core`):** workflow manifests are `workflowSchemaVersion: 3`; no node carries `input`, a switch has no `on`, a loop's `verify` is an agent and `max` is required. A v1 or v2 manifest is refused with a message naming the change. The `fn` and `verify` Actions and effect kinds, and the `loop.decided` event, are removed. `WorkflowManifestV2` / `WorkflowNodeV2` / `isWorkflowManifestV2` are now `WorkflowManifest` / `WorkflowNode` / `isWorkflowManifest`.
  - **Breaking (`@nylorun/harness`):** the flow engine is `flow-3` and runs only v3 manifests; v1 and v2 engines, `agentTurnValue` and the `fn` / `verify` effect kinds are removed. A switch picks the case named by the previous output or its `route` field, a map runs over an array or an `items` array, and a loop retries with its verifier's feedback until `max`. An `agent` effect carries the flow's input as `flowInput` when the stage's input differs.
  - **Breaking (`@nylorun/runtime`):** no `fn` or `verify` Actions are offered or delivered. An agent stage's message shows the flow's input as the original request before its own input, and each verifier verdict is recorded as `loop.verified`.
  - `@nylorun/studio`: the workflow tree draws v3 manifests (a loop shows its verifier agent and `max`); the loop timeline drops decide outcomes, and `loop.verified` shows the feedback.

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

- d36f0d9: **Hooks are removed; manifests are v5 (manifest-only agents, step M1).** The Runtime no longer calls the developer's code before or after a turn or a model call. See MIGRATION.md for what replaces each use.

  - **Breaking (`@nylorun/core`, `@nylorun/agents`):** `.beforeTurn()`, `.beforeModel()`, `.afterModel()`, `.afterTurn()`, the deprecated `.before()` / `.after()`, a capability's `before` / `after`, and the `Patch`, `Decision`, `TurnDecision`, `BeforeHook`, `AfterHook`, `HookScope` types and `runHookPoint` / `hooksFrom` helpers are removed. A capability that still passes `before` or `after` is refused with `hooks were removed: …`.
  - **Breaking (`@nylorun/core`):** `manifestSchemaVersion` is 5. `capabilities[].hooks` is gone; a manifest that names it, or a v3/v4 manifest, is refused with a message naming the change. The `hook` Action and the `hook` effect kind of the Harness API are removed.
  - **Breaking (`@nylorun/harness`):** the turn loop runs no hooks; the turn state a checkpoint carries is `{ turnId }`, and the engine version is `hosted-4`, so checkpoints of earlier engines are refused.
  - `@nylorun/runtime`: no `hook` Actions are offered or delivered.
  - `@nylorun/studio`: the Agent Manifest tab drops the Hooks count and the turn lifecycle.

- 107b07d: **Skills are files the Runtime holds and serves itself (track R2 M4).** Breaking: a skill's manifest names every file of its folder, and the skill tools no longer run in the developer's process. The protocol stays at 8 until the track ships.

  - `@nylorun/core`: `SkillManifest` gains `files`, each path of the skill's folder (`SKILL.md` required, `/`-separated, no `..`, at most 500 files) mapped to `sha256:<hex>`, so the manifest hash pins them. `skillRecords` and `SkillRecord` are gone; a declaration's `skillFiles` holds the bytes to upload (`SkillFileSource`). `load_skill` and `read_skill_resource` keep their names and input schemas but fail with `skills.runtime-only` outside a Runtime. New `DefinitionFileViewSchema`, error code `definition_files_missing`, Harness API request `definition.file`, and `definitionFilesOf`, `isSkillTool` and the definition-file limits. A top-level `functions` key is reserved and refused ("Functions are not available yet").
  - `@nylorun/runtime`: `PUT /v1/files/sha256:<hex>` stores a definition file (application key; at most 10 MiB; a body of another hash is `400`; `201` stored, `200` held already) in the Object store at `definitions/sha256/<hex>`, and `HEAD` says whether the Tenant holds one. New tables `definition_files` and `definition_file_uses` (migration `0013_definition_files`). `PUT /v1/agents/{id}` refuses a definition, nested agents and flow agents included, that names a file the Tenant lacks (`400 definition_files_missing`). Core serves `load_skill` (the `SKILL.md` body, the other files' paths, and `sandboxPath` with a sandbox) and `read_skill_resource` (text files only) from those files, with no Action. A session's sandbox gets each skill's files read-only under `/skills/<name>/` before the first call that opens it, and the sandbox's instructions name them; pod sandboxes mount an `emptyDir` at `/skills`. Unused files are not deleted yet.
  - `@nylorun/agents`: `.skills()`, `skills()` and `.plugin()` read every file of a skill's folder, binary included (not `.git/`, `node_modules/`, OS files or `.env` files), and hash it; a file over 10 MiB or more than 500 files fail the build. `saveAgent` uploads the files the Runtime lacks before the definition; `client.files` (`has`, `upload`, `ensure`) does it by hand.
  - `@nylorun/harness`: tests only.
  - `@nylorun/studio`: the agent's manifest lists each skill's files.

### Minor Changes

- a64aaca: **HTTP in flows (manifest-only agents, after M2 and M3).** An `http()` tool is a flow stage, and `http({ url })` is a Loop's HTTP verifier; the Runtime makes both requests through its Tool Gate, with no Action endpoint.

  - `@nylorun/core`: an HTTP tool may be a stage in `.pipe()`, a switch case, a Map item or a Loop body; its tool node carries its `http` target and binds nothing. The build refuses an HTTP stage whose input is known to be the wrong type (`flow.input-mismatch`, e.g. after an agent with no `.output()`) and `approval: "always"` on one (`flow.approval-unsupported`). `http()` without a name and an input returns an `HttpTarget`, an HTTP verifier: `.loop(body, { verify: http({ url, method?, credential?, timeoutMs? }), max })`, in the manifest `loop.verify: { http }`. `fn` and `command` verify targets are refused ("Functions are not available yet"). New `flowHttpTarget()` finds an HTTP stage or verifier by stage key; `isHttpTarget()`, `WorkflowHttpVerify` and `WorkflowLoopVerify` are exported.
  - `@nylorun/harness`: the flow engine checks an HTTP stage's input against its schema (`tool.invalid-input`), runs it as a `tool` effect and fails the stage on a failed outcome (`http.status`, `http.timeout`, `tool.invalid-output`, …). An HTTP verifier is a `tool` effect with `{ input, output, iteration }` and `context.role: "verify-http"`; a non-verdict or a failed request is `loop.verify-failed`. A Loop body that starts with an HTTP stage is retried with the Loop's input.
  - `@nylorun/agents`: `http()` builds HTTP verifiers too.
  - `@nylorun/runtime`: a flow's HTTP stages and verifiers are executed like an agent's HTTP tool: address policy, the flow session's vault credential, `Nylorun-Session-Id`/`-Turn-Id`/`-Agent-Id` (the flow agent's id) and the flow effect id as `Idempotency-Key`, run once at the gates service (`POST /nylorun/v1/http-calls` takes `tool: { sessionId?, stage }`) and `uncertain` when the answer is lost. An HTTP verifier's verdict is recorded as `loop.verified`.
  - `@nylorun/studio`: the workflow tree shows HTTP stages and HTTP verifiers with their method and URL.

- 40b7648: **HTTP tools and static approval (manifest-only agents, M3).** A tool can be one HTTP request the Runtime makes through its Tool Gate, with no Action endpoint; code tools keep working.

  - `@nylorun/core`: `ToolManifest` gains `http` (`url`, `method` `POST`/`PUT`/`PATCH`, `credential`, `timeoutMs` up to 300000) and `approval` (`never`/`always`, HTTP tools only); a tool is never both an agent and an HTTP request, and `fn` and `command` are refused ("Functions are not available yet"). Remote MCP servers take `approval`. `http()` builds an HTTP tool, `httpToolOf()` reads one; `SESSION_ID_HEADER`, `TURN_ID_HEADER` and `AGENT_ID_HEADER` name the headers it sends. `Agent.from` rebuilds HTTP tools without an implementation; an HTTP tool is refused as a flow stage.
  - `@nylorun/harness`: hosted HTTP tools keep their target, and `approval: "always"` (an HTTP tool's, or `DurableSessionTool.approval` for a remote MCP server's tools) pauses each call for approval. **Breaking:** `HarnessExecutors.recovers.remoteMcp` is renamed `recovers.tool`.
  - `@nylorun/agents`: exports `http` and the identity header constants.
  - `@nylorun/runtime`: the Tool Gate runs HTTP tool calls (`POST /nylorun/v1/http-calls` at the gates service, or in process): the input as JSON under the Host's address policy, the session's vault credential bound to the URL, `Nylorun-Session-Id`/`-Turn-Id`/`-Agent-Id` and the effect id as `Idempotency-Key`. A keyed call runs once (`tool_crossings`), so a re-send after a takeover joins it and one lost with the gateway is `uncertain`. Non-2xx answers, timeouts, refused addresses, missing credentials and output mismatches are tool errors the model sees. The credential resolver is asked with `target.kind: "http"` and the tool's `credential` name.
  - `@nylorun/studio`: the Agent Manifest tab lists HTTP tools with their method and URL, and marks tools and MCP servers that wait for approval.

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

## 0.15.0-beta

### Major Changes

- 98b0d37: **Protocol 8: the Runtime API and the Management API take separate keys (Runtime and Management APIs, step A4).** Upgrade every package together; `nylorun`, `@nylorun/cli` and Studio already use management keys (A3).

  - **Breaking (`@nylorun/runtime`): `/v1/tenant/*` takes only a management key.** An application key there, alone or acting for a subject, is `403 key_role_mismatch`; a management key acting for a subject is `403 subject_invalid`. This covers the Tenant's status, seed and reset, models, providers, usage and budgets, sandbox and artifact settings, application keys, vaults and signing keys. A management key on any other route but `/v1/me` and the public `/v1/access/jwks` is `403 key_role_mismatch`.
  - **Breaking (`@nylorun/runtime`): vaults and signing keys moved.** They are at `/v1/tenant/vaults…` (including `…/oauth/start`) and `/v1/tenant/signing-keys…`; `/v1/vaults…` and `/v1/access/signing-keys…` are gone, with no alias. Opening a session with `vaultIds` is unchanged, as are `GET /v1/oauth/callback` and `GET /v1/access/jwks`.
  - **Breaking (`@nylorun/core`, `@nylorun/runtime`): `tenant:settings` is retired.** It leaves `SUBJECT_SCOPES`; `Nylorun-Scopes` may still name it and it grants nothing. `/v1/tenant/models` and `/v1/tenant/providers` no longer admit `agents:write` subjects: apps don't read the model catalog.
  - **Breaking (`@nylorun/agents`):** the vault methods (`createVault`, `listVaults`, `getVault`, `deleteVault`, `createCredential`, `listCredentials`, `getCredential`, `rotateCredential`, `deleteCredential`) and `client.access.signingKeys` / `SigningKeysClient` are removed; use `admin.vaults` and `admin.signingKeys` from `@nylorun/admin`'s `createManagementClient`. `client.access.jwks()` stays.
  - `@nylorun/core`: `PROTOCOL_VERSION` is 8 and `HOST_PROTOCOL` 4–8, with the required feature `management-api`. Runtime API routes keep their request and response shapes.
  - `@nylorun/runtime`: `startEphemeralRuntime` registers a management key (`managementKey`, the key `bootstrap`).

### Minor Changes

- c66d8ed: Add optional session reads and a resumable model-ledger export: pinned manifests, usage totals, model calls, and opt-in session/history/sandbox pages (Host feature `session-reads`), and `GET /v1/tenant/calls/model` on the Management API (Host feature `calls-export`). Usage and model calls take an application key acting as itself; the export takes a management key. Runtime reads use a separate bounded, read-only Drizzle pool. The additive migration `0012_session_reads` preserves unknown legacy creation times and usage quality; the export uses safe transaction order without skipping committed rows. `@nylorun/agents` adds `client.sessions.page()`, `session.manifest()`, `session.usage()`, `session.modelCalls()`, `session.history({ limit })` and `client.sandboxes.page()`; `@nylorun/admin` adds `models.exportCalls()`. Legacy unpaged responses are unchanged.

### Patch Changes

- b28bdd7: **Local MCP servers work on a local Tenant, and a server that does not connect shows.** Additive; the protocol stays at 7.

  - `@nylorun/runtime`: remote MCP servers (`streamable-http`, `sse`) are reached under the Host's address policy, as Action endpoints are (`NYLORUN_ENDPOINT_*`, `tenant/outbound.ts`). In the local Docker stack `localhost`, `127.0.0.1` and `[::1]` now mean the machine that runs Docker (`host.docker.internal`), so `.mcp({ x: { type: "streamable-http", url: "http://localhost:3002/x" } })` connects where it used to fail with `fetch failed`. With `NYLORUN_ENDPOINT_PRIVATE=refuse` a server on a private address is refused; with `NYLORUN_ENDPOINT_HTTP=refuse` an `http` server is refused. Redirects are still not followed. A connection failure now names its cause (`connect ECONNREFUSED …`) instead of `fetch failed`. This applies in the gateway, a harness process and an in-process Tenant. `guardedFetch` takes `stream: true`: the answer streams, unbounded, with no timeout but the caller's signal.
  - `@nylorun/core`: new session event `mcp.discovered`, recorded once on the session's first turn with the MCP snapshot: one entry per declared server with `outcome` (`connected`, `refused`, `failed`), `message` and the number of `tools` it added (`McpDiscoveredPayloadSchema`, `McpServerOutcomeSchema`). A server that does not connect adds no tools for the session's life; this is where that shows in the event log, beside `mcpDiagnostics`.
  - `@nylorun/agents`: `.plugin()` and `plugin()` emit a process warning (`NylorunPluginWarning`, the diagnostic's code) for each part of the package they skip, so building or registering the agent says when a plugin's MCP server was dropped. The `plugin.mcp-server-skipped` message now says why: for example, plain `http` is accepted only for `localhost`, `127.0.0.1` or `[::1]`.
  - `@nylorun/studio`: the event list labels `mcp.discovered` and summarizes each server's outcome.

- Pin core to the tested release.
- Updated dependencies [3b3bdc6]
- Updated dependencies [6576e12]
- Updated dependencies [b28bdd7]
- Updated dependencies [cc107b1]
- Updated dependencies [7f763c3]
- Updated dependencies [98b0d37]
- Updated dependencies [c66d8ed]
  - @nylorun/core@0.14.0-beta

## 0.14.0-beta

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

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [8773586]
- Updated dependencies [e1bfb4b]
- Updated dependencies [5cfaed9]
- Updated dependencies [bd478ee]
- Updated dependencies [c0b604e]
  - @nylorun/core@0.13.0-beta

## 0.13.0-beta

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

- 6077272: **Folder artifacts and the turn-end outputs export (F8.2).** Part of protocol 6, with file artifacts.

  - **`@nylorun/runtime`: the turn-end export.** When an agent's turn completes, the Runtime reads `/workspace/outputs` of the session's sandbox and keeps it as a version of the session's folder artifact `outputs`: the first export creates it, and each later turn whose outputs changed adds a version (`artifact.created` / `artifact.version.created` with `kind: "folder"`, `source: "export"`, `fileCount` and `claimed: true`, since the listing and bytes are what the sandbox supplied). Nothing is exported without a sandbox or without outputs. An export past 10,000 files, 1 GiB, the per-file limit or the Tenant total stores nothing and records `artifact.export.skipped` with its reason; a failure records `artifact.export.failed`. Neither fails the turn. Core reads the workspace through one seam, `WorkspaceReader`, which the Harness API and pod sandboxes will implement later.
  - **`@nylorun/runtime`: folder artifacts.** A folder version is a manifest of paths to content-addressed files: each file's bytes are stored once at `blobs/sha256/<hex>`, so an unchanged file is never stored again, and the Tenant total (`GET /v1/tenant/artifacts` `usedBytes`) counts it once. New routes: `GET /v1/artifacts/{id}/versions/{n|latest}/tree` (the manifest), `…/files/{path}` (one file by its percent-encoded path, with Range), `…/diff?from=n` (files added, removed and changed) and `…/zip` (a streamed zip). `POST /v1/artifacts/{id}/links` takes `file` to link one file of a folder; a folder's link without it opens the zip. A folder's `/content`, a new version uploaded to a folder, and a message part naming a folder are `400`. Deleting a folder removes the files no other version names. Migration `0006_folder_artifacts` allows the `folder` kind and adds the `artifact_content` table.
  - **`@nylorun/core`:** `ArtifactKindSchema` (`file`, `folder`), the `export` source, `FolderEntrySchema`, `FolderManifestSchema`, `ArtifactTreeSchema`, `ArtifactDiffSchema`, the `artifact.export.skipped` and `artifact.export.failed` events, and `fileCount` and `claimed` on `artifact.created` / `artifact.version.created`.
  - **`@nylorun/agents`:** `client.artifacts.tree()`, `file()`, `diff()` and `zip()`, and `link(id, { file })`.

- 926711b: **Sandboxes are a resource (F7.1, blueprint D39; Host feature `sandboxes`).** A sandbox has its own id, a kind, a spec and labels, and outlives the sessions attached to it. Additive: protocol 5 is unchanged.

  - `PUT /v1/sandboxes/{id}` creates a sandbox or finds the one with that id (get-or-create in one call); `GET /v1/sandboxes/{id}`, `GET /v1/sandboxes?label=key=value` (repeatable), `GET /v1/sandboxes/{id}/events` and `DELETE /v1/sandboxes/{id}`. Ids are `/`-separated segments (`team-a/proj-42`), sent percent-encoded as one path segment. Only kind `virtual` runs; `pod` is refused with `sandbox_unavailable`. The spec is resolved against the Tenant's limits and fixed once the sandbox exists; labels can change.
  - A session attaches with `sandbox: { id }` and shares the sandbox's `/workspace` with every other session attached to it. Turns are serial per sandbox: a second session's turn is refused with `409 sandbox_busy` while another runs. Deleting a session (a sessions reset) only detaches it. Deleting a sandbox is refused while a turn runs in it; afterwards an attached session's next turn is refused with `sandbox_unavailable` until a sandbox with that id exists again.
  - Subject tokens carry an `sbx` claim: `POST /v1/tokens` takes `sandboxes`, exact ids or prefixes ending in `/*` (at most 16). A token reaches only the sandboxes they match, checked when a session attaches and at every turn start (`403 sandbox_not_granted`); any other sandbox is the 404 of a missing one. The new scope `sandboxes:write` lets a role create and delete the sandboxes its grants reach. Application keys reach every sandbox.
  - The Tenant holds at most `limits.sandboxes` sandboxes (`PUT /v1/tenant/sandbox`, default 100); one more is `409 limit_exceeded`.
  - Lifecycle events (`sandbox.created`, `sandbox.attached`, `sandbox.detached`, `sandbox.deleted`) go to the sandbox's own stream in the record, through the record module; the session's log records `sandbox.attached`. The sandbox stream is not relayed to S2.
  - New error codes `sandbox_not_granted`, `sandbox_busy` and `sandbox_unavailable`; the session view gains `sandboxId` and `sandboxSource: "sandbox"`. Migration `0004_sandbox_resources` adds `sandbox_resources`, `nylorun_streams.sandbox_events` and the sessions' `sandbox_id` column.
  - `@nylorun/agents`: `client.sandboxes` with `ensure(id, spec)`, `get`, `list({ labels })`, `delete`, `events`, and `forSession({ session, spec })`, which creates a sandbox for one session, opens the session on it, and deletes it with `release()`. It replaces sharing through another session (`sandbox: { session }` and the view's `sandboxOwnerId`, now deprecated). `client.tokens.create` takes `sandboxes`.
  - `nylorun sandbox ls [--label key=value]... [--json]` and `nylorun sandbox rm <id>` list and delete the running local Tenant's sandboxes.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [b352feb]
- Updated dependencies [6077272]
- Updated dependencies [b6bf1f5]
- Updated dependencies [8ed4ea6]
- Updated dependencies [678e085]
- Updated dependencies [926711b]
  - @nylorun/core@0.12.0-beta

## 0.12.0-beta

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

## 0.11.0-beta

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

## 0.10.0-beta

### Major Changes

- c121144: **Definitions no longer declare a sandbox.** `.sandbox()` on ReAct and flow agents, and the `sandbox`, `SandboxError`, `SandboxOptions` and `SandboxCapability` exports, are removed. Open the session with one instead, `createSession({ sandbox: { … } })`, or set the Tenant's default; see `MIGRATION.md`.

  - **Build and registration.** A capability that still carries `sandbox` fails the build (`sandbox.in-definition`), and `PUT /v1/agents/:id` refuses such a definition with a `400` that names it. Definitions stored before this release keep their sandbox.
  - **Trees.** `sandbox.mismatch` and `workflow.sandbox-mismatch` are gone, with the workflow manifest's derived `sandbox`: a tree shares the sandbox its session was opened with.
  - **Executors.** The action claim reports whether the session has a sandbox (`ActionClaim.sandbox`), and `ctx.sandbox` follows it.

- 9546ac7: **Protocol 4: every session event is typed, on the `nylorun.event/2` envelope.**

  - **The catalog.** `EVENT_CATALOG` in `@nylorun/core/contracts` lists every event type the Runtime writes, with its payload schema, its schema version and its source. `SessionEventSchema` is their union, discriminated on `type`; `parseSessionEvent` types a known event and returns an unknown one as the bare envelope.
  - **The envelope.** Events carry `schema`, `seq`, `epoch`, `runId`, `incarnation`, `schemaVersion`, `source`, `evidence`, `visibility`, `retention` and an optional `trace`. `createdAt` is renamed `time`. The envelope is no longer strict, so later fields never break a client.
  - **Validated writes.** `Tx.event` is typed by the catalog, and both Session Stores check each event against it before it commits (`InvalidEventError`). Workflow `action.pending` payloads may carry `path` and `key`.
  - **OpenAPI.** Each event type is a component (`MessageAssistantEvent`, …), `SessionEvent` is their union, and the session SSE and history responses refer to them.
  - **Clients.** `@nylorun/agents` reads events with `parseSessionEvent`, so a newer Runtime's event types reach your code instead of failing the stream. Studio reads `time`.

  See `MIGRATION.md`.

### Minor Changes

- c7614a4: **A2A: serve agents to other agents (v1, gateway mode).** The Runtime answers [A2A](https://a2a-protocol.org) 1.0 over JSON-RPC for the Tenant's agents (optional Host feature `a2a-endpoint`), and the app server publishes them with `createA2aHandler`.

  - **Runtime.** `POST /v1/a2a/agents/:agent` acts for a subject with `sessions:own`. It serves `SendMessage` (blocking up to 5 minutes, or `returnImmediately`), `GetTask` and `CancelTask`. A context is one session per subject, agent and `contextId`, and a task is one turn. A question pauses the task as `TASK_STATE_INPUT_REQUIRED` until the caller replies on the same task. The `messageId` is the idempotency key. `ListTasks`, streaming, push notifications and the extended card answer with their A2A errors, and approvals cannot be answered over A2A yet. `GET /v1/a2a/agents/:agent/card` returns the card built from the manifest, without interfaces. `observeSession` lets in-process readers join a session's shared event feed.
  - **Agents SDK.** `@nylorun/agents/a2a`: `createA2aHandler({ agents, subject, publicUrl, card })` forwards each partner's JSON-RPC request to the Runtime as that partner's subject, and serves the Agent Card with its own URL, provider and security schemes. It loads no A2A package. `Transport.forward` returns the Runtime's raw response.

- 5f23047: **Action endpoints: `createActionHandler` (preview; needs a Runtime with the `action-endpoints` feature to register).** An application serves its agents' tools, hooks and workflow functions from one HTTP handler, which the Runtime will call, in place of `connectAgents`.

  - `createActionHandler({ agents })` returns `{ fetch, node, register }`. `fetch` is a web-standard handler and `node` serves `node:http` and Express. Each request is verified before any code runs: its delivery token (`Nylorun-Signature`) must be an ES256 token signed by the Tenant's signing key, for this Tenant, this URL, this Action and generation, and the exact body. The Action then runs through the same code executors use, with the request's signal as `ctx.signal`. The answer is the tagged outcome (`Nylorun-Outcome: 1`). An agent or tool it does not serve answers `404`, and a workflow Action for another version of the workflow answers `409`. A token signed with a key the handler has not seen yet (just after a rotation) answers `503`, which the Runtime retries.
  - A process that only serves Actions needs no key: set `runtime: { url, tenant }` and it reads the Tenant's public keys, or pass them in `jwks`. Verification uses WebCrypto; the SDK takes no JWT dependency.
  - `register({ url })` saves the definitions (`saveDefinitions: false` skips it), registers the URL for every served agent, and pings each one through the Runtime. It refuses a Runtime without `action-endpoints` before sending anything.
  - `ctx.sandbox` calls back with the delivery token. `createActionSandbox` accepts no claim for this case, and `Transport.withKey` copies a transport with another bearer, sharing its compatibility check.

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

- e28b8a9: **New projects serve their tools as an Action endpoint.** Everything Nylorun ships now uses Action endpoints instead of executors. `connectAgents` still works, but it is deprecated.

  - **Starter (`create-agent`).** `src/main.ts` serves the agents with `createActionHandler` on `http://localhost:3001/nylorun/actions` (`PORT`, `NYLORUN_ACTIONS_URL`) and registers it. `npm run dev` and `npm start` work as before. The README explains which URL the Runtime must reach.
  - **Local stack (`nylorun`).** The Runtime container sets `NYLORUN_ENDPOINT_LOOPBACK=docker-host` and maps `host.docker.internal` to the Docker host, so a `localhost` endpoint on the developer's machine is reachable, on Linux Docker Engine too.
  - **Examples.** The AG-UI and browser-direct apps serve their Action endpoint at `/nylorun/actions` beside their other routes, and `register(origin)` replaces `connection.ready`.
  - **Docs.** The README, `DEPLOYMENT.md` and the `@nylorun/agents` README describe Action endpoints.

- 50d0fb5: **AG-UI in the Runtime.** The Runtime serves AG-UI itself at `/v1/ag-ui/agents/:agent` (optional Host feature `ag-ui-endpoint`), and pages reach it directly with a subject token. `@nylorun/agents` no longer contains or depends on any AG-UI package.

  - **Runtime.** `POST /v1/ag-ui/agents/:agent` runs (a `RunAgentInput` in, server-sent AG-UI events out); `GET …/threads/:thread/messages`, `GET …/threads/:thread/events` (reattach) and `POST …/threads/:thread/cancel`. For a person named by a subject token (limited to the role's agents) or by subject headers; an application key alone is `400`. A thread's session (`sessionIdFor`, unchanged, so existing threads keep their sessions) is created on its first run with `forwardedProps.nylorun.session` (`vaultIds`, `credentialSelections`, and `info` from app servers only) and never changed afterwards. Limits and a busy session are streamed as `RUN_ERROR`. A stream opened with a token ends at the token's expiry or revocation with `CUSTOM nylorun.stream_closed`. The translation moves here from `@nylorun/agents`, and `@ag-ui/core` becomes a Runtime dependency.
  - **Agents SDK.** `createAgUiHandler` keeps its options and routes and forwards each request to the Runtime acting for the signed-in person; it now needs a Runtime with `ag-ui-endpoint` (`502 runtime_feature_missing` otherwise). `session()` options apply when a thread's session is created; whatever the browser sends in `forwardedProps.nylorun` is replaced. `@ag-ui/core` is no longer a dependency. `@nylorun/agents/browser` adds `agUi(agentId)`, a `{ url, fetch }` for `HttpAgent` that adds the key and a current token and reattaches a run the Runtime ended at token expiry, so the agent sees one run, and `agUiHistory()`. The transport gains `forward()`, which returns the Runtime's response as it is.

- 50d0fb5: **Browser access: web pages and apps call the Runtime with a publishable key.** A page ships a publishable key and gets subject tokens from its app server; the Runtime answers it directly, with CORS (optional Host feature `browser-access`).

  - **Publishable keys.** `nr_pub_<tenantId>_…`, sent in `Nylorun-Key`, name the Tenant and one app, with an origin allowlist (exact origins, or `http://localhost:*` and `http://127.0.0.1:*` for development; none for native apps). `GET`/`POST /v1/access/publishable-keys`, `PUT`/`DELETE …/:id`. A key alone grants the policy's `anon` role, at most the public agent list, and reaches no session or vault. Postgres migration 4.
  - **Host.** With browser access on, requests with an `Origin` reach Tenant routes; `/health`, `/ready` and admin routes still refuse them. Preflights for browser routes (agents, sessions, vaults, AG-UI, JWKS) are answered from the route alone and grant no credentials; the actual request must carry a publishable key whose allowlist names the origin, and only then do responses (JSON, errors, `401`, `429`, event streams) carry CORS headers. A disallowed origin or unknown key gets the opaque `404`. Tenant and executor keys sent with an `Origin` are refused before they are looked up. `Nylorun-Tenant` may be left out when `Nylorun-Key` names the Tenant; both must agree when both are sent. Browser access is on in the stack (`NYLORUN_BROWSER_ACCESS=off` turns it off) and off for a Host started from `host.json` unless `browserAccess` is true.
  - **JWKS.** `GET /v1/access/jwks` is readable by any caller that reaches the Tenant.
  - **Agents SDK.** `@nylorun/agents/browser`: `createBrowserClient({ url, publishableKey, token })` keeps subject tokens in memory, refreshes them a minute before expiry or after `401 token_expired`, one fetch at a time, and creates sessions and vaults owned by the token's subject; it loads no Node module. `createTokenEndpoint()` is the app server's token route. `client.access.publishableKeys` manages keys. The transport accepts a `token` source and a `publishableKey`, and event streams the Runtime ends at token expiry reconnect at once. The Tenant API client classes move to a module with no Node imports; `@nylorun/agents` and `/client` export the same names.
  - **CLI.** `nylo access keys list|create|set-origins|revoke`.

- c121144: **Choose a session's sandbox when you open it.** `createSession({ sandbox })` (`PutSessionRequest.sandbox`) now takes `false`, `{ session }` to share, or an inline sandbox: `image`, `network.allow` and `resources`. Omit it for the Tenant's default. The agent definition needs no `.sandbox()`: the Runtime resolves the request against the Tenant's limits, pins it on the session and adds the six sandbox tools to that session only (capability `nylorun.sandbox`). The registered definition is unchanged.

  - **Tenant configuration.** `GET /v1/tenant/sandbox` adds `config`; `PUT /v1/tenant/sandbox` sets `default` (`none`, `virtual` or an inline sandbox) and `limits` (`network` ceiling, `resources` maximum, `defaultResources`, `idle`). Unset, a Tenant's default is `none` and its ceiling is the package registries and code hosts of today's `dev` preset. `SeedTenantConfigRequest.sandbox.config` seeds it.
  - **Checks at open.** A request outside the limits is a `400` that lists every problem. An inline sandbox from a caller acting for a subject is a `403`; such callers get the Tenant default or `false`. An `image` is refused: the virtual sandbox has no images. The sandbox is fixed for the session's life: a different one on a later `PUT` is a `409`.
  - **Trees inherit.** The agent sessions of a flow agent, the agents a session uses as tools, and sessions attached with `{ session }` use the sandbox the session was opened with, and get its tools.
  - **Compatible.** An agent that declares `.sandbox()` keeps working as before; opening its session with a `sandbox` value is a `400` that says to remove `.sandbox()` from the agent.

- 9d52189: **Studio embedding contract.** `@nylorun/core/contracts` defines the contract between Studio and an app that embeds it in an iframe, and `@nylorun/agents/studio-embed` re-exports it for Studio's web app and embedders such as Babai Desktop.

  - `StudioEmbedMessageSchema`: every `postMessage` between the two, on the envelope `{ type: "nylorun.studio", protocol, kind }`. Kinds: `ready`, `init`, `token.refresh`, `theme.changed`, `navigate`, `session`, `token.expiring`, `route.changed`, `open.external`, `open.babai`, `error`. `STUDIO_EMBED_PROTOCOLS` is `[1]`.
  - `StudioLoginTokenRequestSchema` and `StudioLoginTokenResponseSchema` for `POST /_studio/login-tokens` (now with optional `tenant` and `subject`), and `StudioSessionRequestSchema` and `StudioSessionResponseSchema` for `POST /_studio/sessions`.
  - `parseFrameAncestors` and `isFrameAncestor` validate `NYLORUN_STUDIO_FRAME_ANCESTORS`: exact origins only, no wildcards, keywords, scheme-only entries or paths.

- 50d0fb5: **Subject tokens: a person's own credential for the Runtime.** An app server mints a short-lived token for one signed-in person, and their app calls the Runtime directly (optional Host feature `subject-tokens`). Requests with application keys and subject headers are unchanged.

  - **Runtime.** `POST /v1/tokens` (application key only) mints an ES256 JWT for a subject and a role, valid 60–900 seconds. The Tenant API accepts it as a bearer and resolves its scopes and agents from the role on every request. Forged, foreign or malformed tokens get the opaque `404`; an expired token, a revoked subject, a revoked key or a removed role gets `401 token_expired` with `WWW-Authenticate`. Tokens carry only `agents:read`, `sessions:own` and `vaults:own`; they may not set session `info`, send `message.manifest` or store OAuth refresh credentials, and `GET /v1/agents` shows them `{ agentId, name, description }` of their role's agents only.
  - **Access policy.** `GET`/`PUT /v1/access/policy`: roles with token scopes, an agent allowlist and limits (`turnsPerHour`, `concurrentTurns`, answered with `429 limit_exceeded` and `Retry-After`). Without roles nothing is minted.
  - **Signing keys.** Per Tenant, the private key sealed with the vault KEK: `GET /v1/access/signing-keys`, `POST …/rotate` (refused while the previous key may still verify live tokens; `force` for incidents), `POST …/:kid/revoke`, `GET /v1/access/jwks`. A Tenant with signing keys and no KEK is quarantined `kek-missing`.
  - **Revocation.** `POST /v1/access/revocations` ends a subject's tokens; their open event streams end with `event: nylorun.closed` on every process. A stream opened with a token also ends when the token expires.
  - Postgres migration 3 adds `signing_keys`, `subject_epochs`, `subject_usage` and an index on the session owner and status. New error codes `token_expired` and `limit_exceeded`.
  - **Agents SDK.** `client.tokens.create()`, `client.access.getPolicy()`/`putPolicy()`/`revokeSubject()`/`jwks()` and `client.access.signingKeys.list()`/`rotate()`/`revoke()`, each checking the Host feature first.
  - **CLI.** `nylo access policy get|set|init`, `nylo access signing-keys list|rotate|revoke`, `nylo access revoke <subject>` and `nylo access token` for trying the API.

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

## 0.9.0-beta

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

- Pin core to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies [8cda500]
  - @nylorun/core@0.8.0-beta

## 0.8.0-beta

### Minor Changes

- a322696: **`@nylorun/agents/ag-ui`: serve agents to AG-UI clients from your own server.** `createAgUiHandler({ basePath, agents, subject })` returns a web-standard `fetch` handler (plus `run`, `history`, `reattach` and `cancel`), and `toNodeListener` adapts it to `node:http` and Express.

  - One session per person, agent and thread; the AG-UI message id is the idempotency key, so a retried run replays the same turn.
  - Approvals become AG-UI interrupts and resume through `runAgent({ resume })`.
  - History returns a plain AG-UI `Message[]` with the ids the live run used; reattach continues a run from `Last-Event-ID`.
  - Needs a Runtime with `transcript-events`. Adds the `@ag-ui/core` dependency (`~1.0.0`), loaded only by this subpath.

  `AgentsClient.hostFeatures()` returns the Runtime's protocol features, including optional ones.

- 844bff3: **Act for a person: `Nylorun-Subject` and `Nylorun-Scopes`.** An app server that holds the Tenant key can name the person each request is for, and the Runtime enforces it (optional Host feature `subject-headers`).

  - `client.as(subject, { scopes })` in `@nylorun/agents` sends both headers on every call, event streams included. Scopes: `agents:read`, `agents:write`, `sessions:own`, `vaults:own`, `tenant:settings`; default `["sessions:own"]`.
  - The Runtime limits a subject to the routes its scopes allow (`403 scope_required`) and to its own sessions and vaults: another owner's session, vault or sandbox is the same `404` as a missing one, including `PUT` on its session id (was `409`). Reset, config seed, executors, actions and the sandbox tool routes are open to no subject. Only application keys may send the headers.
  - The AG-UI handler calls the Runtime as each person and requires `subject-headers`; new optional `scopes` option. The host's `session()` parameters can no longer replace a session's id, agent or owner.
  - Core exports `SUBJECT_HEADER`, `SCOPES_HEADER`, `SUBJECT_SCOPES` and `parseSubjectHeaders`. Postgres Tenant schemas migrate to version 2 (an indexed session owner column).

  Requests without `Nylorun-Subject` are unchanged.

### Patch Changes

- 42272f8: The AG-UI handler answers `400` (`invalid_request`) when the Runtime refuses what the client sent, such as a `Last-Event-ID` it cannot read, instead of `502`.
- Pin core to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies [a322696]
  - @nylorun/core@0.7.0-beta

## 0.7.0-beta

### Minor Changes

- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.

### Patch Changes

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

- bf1c2da: **The microsandbox backend is removed; the Runtime runs sandbox tools on the virtual backend only.** The optional `microsandbox` dependency is gone. `sandbox.backend` and `NYLORUN_SANDBOX` accept `auto` or `virtual`, and `auto` selects `virtual`. A Tenant that stored `microsandbox` reads it as `auto`. `nylorun doctor sandbox` and the `nylorun dev` banner report only the virtual shell.
- Pin core to the tested release.
- Updated dependencies [bf1c2da]
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
  - @nylorun/core@0.6.0-beta

## 0.6.0-beta

### Minor Changes

- c49efed: **Breaking (pre-1.0 minor):** Tenant API connection and executor credentials for Runtime Clients.

  - `resolveConnection()` — options → environment → Project link; sources never mix.
  - `createClient()` with no arguments uses `resolveConnection`.
  - `connectAgents` application mode: save agents, `PUT /v1/executors` with **derived** tokens (HMAC of application key + Tenant + agent id), connect; tokens are not stored in Project credentials.
  - Re-exports `PROTOCOL_FEATURES`, `ERROR_CODES`, `compareVersions`.

- c49efed: **Breaking (pre-1.0 minor):** Replace a single SQLite Runtime per Project or home directory with a **Runtime Host** that serves isolated **Tenants**, selected by `Nylorun-Tenant` and negotiated with `Nylorun-Protocol` (protocol `2`, feature `runtime-tenants`). Vocabulary: Host root + Tenant + Project link.

  - **core:** `PROTOCOL_VERSION = 2`, `HOST_PROTOCOL`, `TENANT_HEADER`, `PROTOCOL_HEADER`, `newTenantId` / `isTenantId`, `checkCompatibility`; health schema gains `hostId` + `protocol` (`service: "nylorun-runtime"`); Tenant/admin wire schemas; Tenant model routes under `/v1/tenant/*`.
  - **runtime:** Host process + Tenant module; Tenant model routes under `/v1/tenant/*`; `startEphemeralRuntime` for tests/embeds; executors via `PUT /v1/executors`; sandbox prefix `nylorun-<tenant-id>-`.
  - **agents:** `createClient({ url, key, tenant })`; Transport sends Tenant + protocol headers; `/health` compatibility cache; `IncompatibleRuntimeError` with upgrade remedies.
  - **cli:** Host root lifecycle (`runtime up|down|status|logs|restart|run`); Project link (`.nylorun/link.json` + `credentials.json`); `tenant` commands; `runtime status --env` exports `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, `NYLORUN_TENANT`; removed Project/home SQLite selectors.
  - **studio:** `startStudio({ …, tenant: { id, name } })`; proxy forwards Tenant + protocol headers; UI shows Tenant name/short id.

- fd9fd87: Add workflows: compose agents and `tool()` with `Chain`, `Switch`, `Parallel`, `Map`, and `Loop`. A workflow is a registered runnable (`kind: "workflow"`) with the same session API as an agent — `export const agents`, `saveAgent` (saves referenced agents first), `createSession`, `input` (`content` or `data`), `observe({ follow })`, `pending`, `approve`, `cancel`. Slots (`{ run, id?, input? }`) reshape data between nodes. The flow engine (`runFlowDurable`) returns effects only; `harness/src/loop/` and `runDurable` are unchanged.

  HostEffect gains flow kinds `agent`, `tool` (node), `fn`, and `verify`, each with `path`, `key`, and `iterations`. The Runtime drives agent nodes through the public session contract (linked sessions, shared sandbox via `PutSession.sandbox`), offers `fn` / `verify` again on lease expiry, and routes executor Actions by `(workflowId, key)` with claim-scoped `ctx.sandbox`. Optional `message.manifest` is a turn-only variant of the session pin (turn manifests). Studio shows the manifest tree, live node status, and session links. Examples under `examples/agents/{chain,switch,parallel,map,loop,ship-feature}/`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
  - @nylorun/core@0.5.0-beta

## 0.5.0-beta

### Minor Changes

- 1cd7dc7: Add subagents: put an agent in another agent's `tools` (`Agent({ tools: [lookupOrder, researcher] })` or `.use({ tools: [researcher] })`) and the model can delegate to it. The tool is named after the agent's id, takes `{ task: string }`, and its description is the agent's `description`, which is now required for an agent used as a tool. The engine runs the child inside the parent's turn as a durable branch: fresh context, its own tools and hooks served by the root agent's executor, its own MCP servers, the session's sandbox, and only its final output (or `outputSchema` result) returned. Empty output, failures (with partial output marked as evidence), and requests for input or approval inside a child reach the parent as failed tool results. Parallel delegation calls run concurrently, completed child work is never re-run on replay, and cancelling the session cancels every child.

  v1 is one level deep and non-interactive. Nested delegation, child tools that declare `approval`, and differing sandboxes across the tree fail the build with a named diagnostic. The manifest adds an optional `agent` body on a tool (schema version unchanged), actions and effects carry `agent: { id, path, delegationId }`, tool context gains `ctx.agent`, the durable host resolves a new `delegation` effect kind, and the Runtime emits `delegation.started` / `delegation.completed` events and filters history with `?agent=` (`session.history({ agent })`). Studio shows delegations, labels child actions with their agent, and filters events by agent.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [1cd7dc7]
  - @nylorun/core@0.4.0-beta

## 0.4.0-beta

### Minor Changes

- b8d822a: Add `mcp(...)` to declare MCP servers as one capability for `Agent.use`, matching agent-plugins / manifest v3 `mcpServers` shape.
- b8d822a: Add `skills(path)` to load an agentskills.io catalog folder into `Agent.use` without duplicating `skills` and `skillRecords`. Parse `SKILL.md` frontmatter with `gray-matter`.
- b8d822a: Add `sandbox()`: one `.use(sandbox())` gives an agent Runtime-executed `bash`, `read`, `write`, `edit`, `grep` and `glob` tools on an isolated machine with a persistent `/workspace`. The Runtime selects a microsandbox microVM where available, otherwise an in-process virtual shell, enforces deny-by-default egress presets, owns sandbox lifecycle, and reports its choice through `GET /v1/host/sandbox`, the `nylorun dev` banner and `nylorun doctor sandbox`.
- b8d822a: Breaking beta: replace `beforeModelCall` / `afterModelCall` with scoped hooks. Register `before("turn" | "step", fn)` and `after("step" | "turn", fn)` on the agent, or `before: { turn, step }` / `after: { step, turn }` on a capability. `before("turn")` runs once per turn and its `Patch` applies to every model call in the turn; the new `after("turn")` returns a `TurnDecision` for the final answer. `after` hooks take one argument and receive `attempt`, and `retry` now retries instead of failing the run. The manifest moves to `manifestSchemaVersion: 4` with `capabilities[].hooks`, and `BeforeModelCallFn`, `AfterModelCallFn` and the `beforeModelCall` / `afterModelCall` action kinds are removed. Every capability registered at a hook point now runs in one `hook` executor action, an expired hook claim is offered again instead of becoming uncertain, and the durable engine version is `hosted-2`. Hook toggles now hide a capability's tools, or one tool of a multi-tool capability, instead of having no effect or failing. Studio lists each capability's hooks with how often they run and labels hook actions. See MIGRATION.md.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
  - @nylorun/core@0.3.0-beta

## 0.3.0-beta

### Minor Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [3a88f51]
  - @nylorun/core@0.2.0-beta

## 0.2.0-beta

### Minor Changes

- 41e613c: Ship the local SDK registry workflow with an independent SQLite Runtime, connected tool executor, authenticated Studio proxy, and a text-and-tool starter. Replace the legacy Hono starter and AG-UI transport. Require Node 24 and include the SDK in exact release compatibility pins.

  Break the Harness execution import from `/engine` to `/run` and rename hosted execution APIs to durable execution APIs, including RunBinding, BoundRunOptions, and createRunState. Update all consumers without compatibility aliases; retain persisted checkpoint fields and version pins.

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [2898d02]
  - @nylorun/core@0.1.1-beta

## 0.1.0-beta.1

Initial session SDK and connected SSE executor.
