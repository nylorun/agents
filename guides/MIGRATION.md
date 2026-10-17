# Session usage by token kind (protocol 18)

Additive: the Runtime serves protocol 16, 17 and 18. A protocol 16 or 17 client reads usage as
before; only a protocol 18 client gets the new fields.

- **Model calls carry their timing and their cost by token kind.** For a protocol 18 client,
  `GET /v1/sessions/{id}/calls/model` (and the export, `GET /v1/tenant/calls/model`) returns
  `startedAt` and `endedAt`, the gate's timing, and `usage.costSplit`
  `{input, cacheRead, cacheWrite, output}`. Both are null for a call recorded before they were
  kept.
- **Session usage adds the split and the model time.** For a protocol 18 client,
  `GET /v1/sessions/{id}/usage` adds `costSplit`, summed over the `splitCalls` calls that kept it,
  and `modelTimeMs`, each call's duration added up over the `timedCalls` calls that were timed.
- **Clients.** `@nylorun/agents` from this release speaks protocol 18 and requires the Host
  feature `usage-by-kind`, so it needs a Runtime from this release too (an older one answers
  `426`). An older SDK keeps working against this Runtime.

# A queue per session (protocol 17)

Additive: the Runtime serves protocol 16 and 17, and Harness API 5 is unchanged.

- **A message to a busy session is queued.** From protocol 17, a `message` sent while the
  session's turn runs, or while it waits on an approval, an answer or an uncertain call, is
  answered `{status: "queued", queuedMessageId, position}` and starts the next turn when this one
  ends, with every message that waited, each its own user message. A client that serializes its
  own messages and wants the old refusal sends `delivery: "reject"` (the SDK's
  `input(value, { delivery: "reject" })`, the CLI's `sessions send --reject-if-busy`): it is
  `409 session_busy`. A protocol 16 client's messages are `reject` unless they say otherwise.
  AG-UI and A2A keep the refusal: a run or a task is the turn it starts, so a busy thread ends
  the run with `RUN_ERROR` `session_busy`, and a busy context is an A2A `UnsupportedOperationError`
  naming the task in progress.
- **The busy refusal has a code.** `409 session_busy`, where it had none.
- **The queue is bounded.** At most the Runtime limit `sessionQueuedMessages` (default 100) wait;
  one more is `429 queue_full`. Session reads count `queuedMessages`.
- **Triggers.** An agent manifest's `runtime.triggers` is no longer refused: `schedule` (cron with a
  `timezone`) and `at` triggers start the Agent's turns on the session each names, with no client
  connected. They start active when an Agent is made; read and change them at
  `/v1/agents/{id}/triggers`, and their runs at `/v1/agents/{id}/runs`. Agent reads add
  `nextWakeAt`. A `webhook` trigger has an endpoint, `POST /v1/webhooks/{endpointId}`, that takes
  Standard Webhooks deliveries with no credential: make its signing secret with
  `POST /v1/agents/{id}/triggers/{triggerId}/secret` (`nylorun agents triggers new-secret`) and
  give the sender the secret and the trigger's `webhookUrl`. Relay other senders (GitHub, Stripe,
  Slack) through your app. `runtime.selfWake: true` offers the agent `schedule_wake`, which books
  its session's next turn (one booking per session). A Runtime on the internet should sit
  behind a proxy that limits requests to `/v1/webhooks/`.
- **Custom harnesses.** A turn that takes more than one queued message starts from
  `checkpoint.input` `{kind: "messages", messages: [...]}`, each one of the input shapes a single
  message has. Write each as its own `input` transcript entry.

# Agents from one manifest (protocol 16, Harness API 5)

A fresh start for agents, Environments and sessions: the Runtime speaks protocol 16 only, and
harnesses Harness API 5 only. Upgrade the Runtime, the SDKs, Studio, the CLI and any custom
harness together.

- **Environments, their disks and vaults are gone.** Migration 0032 drops every Environment with
  its disk versions and vault, as protocol 11 dropped sandboxes. Export what you need
  from a disk before you upgrade (`nylorun environments snapshot`, then the version's zip from
  `/v1/artifacts`), and write the secrets again into the Agents you make.
- **Delete the dropped Environments' pods.** The Runtime no longer knows them, and nothing deletes
  them: their Sandboxes, pods and volumes stay in the Tenant's namespace. Once the new release
  runs, and before you make pod Agents, delete them:
  `kubectl delete sandboxes.agents.x-k8s.io,secrets -l app.kubernetes.io/managed-by=nylorun-sandboxes -n nylorun-sbx-<tenant>`
  (`nylorun local sandbox status` names the namespace; each pod and volume goes with its Sandbox,
  and the secrets are their join tokens). Left in place,
  a pod Agent made with a dropped Environment's id starts on that Environment's Sandbox and volume.
- **Sessions opened before protocol 16 are closed.** Every open session gets
  `closedReason: "protocol_16"`: a message to one is `409 session_closed`, and its history stays
  readable. Open new sessions on Agents.
- **One agent manifest replaces a definition and an environment manifest.** `PUT /v1/agents/{id}`
  with a v7 manifest (`saveAgent`) and `/v1/environment-manifests` are gone. An agent manifest v8
  is saved at `PUT /v1/agent-manifests/{name}`, versioned as environment manifests were (with
  `If-Match` and `?dryRun=true`), with two sections:

  ```json
  {
    "manifestSchemaVersion": 8,
    "name": "triage",
    "description": "Sorts new GitHub issues",
    "harness": {
      "instructions": ["Label and route new issues."],
      "mcpServers": {
        "github": {
          "name": "github",
          "type": "streamable-http",
          "url": "https://api.githubcopilot.com/mcp/",
          "credential": "GITHUB_TOKEN"
        }
      }
    },
    "runtime": {
      "kind": "virtual",
      "secrets": {
        "GITHUB_TOKEN": { "type": "bearer", "url": "https://api.githubcopilot.com/mcp/", "required": true }
      }
    }
  }
  ```

  `harness` holds what v7 held at its top level (instructions, tools, skills, MCP servers,
  `outputSchema`), plus `id` (the harness that runs the loop: `nylorun` or a custom one, which
  was an environment manifest's `harness`), `plugins` and `loop`; or a flow (`kind: "workflow"`,
  `root`, `agents`). `runtime` holds an environment manifest's fields without `name` or
  `harness`, with `kind` required; leave it out for an agent with no compute (kind `none`).
- **Write the three files once with `nylorun migrate v8`.** It reads a v7 manifest (as
  `agents save` read it) and, with `--runtime`, an environment manifest, and writes
  `agent.manifest.json`, `harness.manifest.json` and `runtime.manifest.json`. Save them with
  `nylorun apply <dir>`, which prints the plan and saves with `If-Match`. A runtime file may be
  shared: several `agent.manifest.json` may name one. From code, `client.agentManifests.save({
  agent, runtime })` saves a built agent, and `composeManifest(dir)` reads the three files.
- **`requires` is checked when the manifest is saved.** The Runtime sees both sections, so a
  gap is `422 manifest_inconsistent` with `details.gaps` at save, not `409
  environment_unsuitable` when a session opens: a custom harness needs `runtime.kind` `pod` with
  an `image`; an MCP server's or HTTP tool's `credential` must name a `bearer` or `headers` slot of
  `runtime.secrets` bound to its URL; a skill's `secrets` (which replace `requires.secrets`) must
  name `environment_secret` or `environment_variable` slots; and skills need a sandbox (`virtual`
  or `pod`). A server that names no `credential` matches the vault by its URL, as before.
  `requires` leaves the API; a harness file may keep it, and `nylorun apply` checks it.
- **Environments are Agents.** `/v1/environments/{id}` is `/v1/agents/{id}`, with the same
  sub-routes (`events`, `stop`, `reset`, `snapshot`, `restore`, `versions`, `fork`, `secrets`), made
  from a saved manifest only: `PUT /v1/agents/{id} { manifest: "triage" }` tracks the manifest
  (and resolves its latest version now), `"triage@3"` pins version 3; inline recipe fields are
  gone, and `ownerUserId` is `owner`. An Agent runs one version at a time and evolves in place
  (track T3): a `PUT` naming another version moves it (`?dryRun=true` for the plan), a save moves
  every Agent that tracks the manifest, and each session's next turn runs the new version. A
  harness change applies at once; a pod's runtime change at its next start, on the same volume
  (`targetVersion`, `waitingFor`; `POST .../restart` applies it now), and a start that fails goes
  back to the version it ran (`failedVersion`, `agent.start_failed`). Its manifest's name, kind,
  harness and storage are fixed: `409 agent_fixed_field` (`environment_immutable` before), so fork
  it to change those. The view's `manifest` is
  the reference and `runtime` what it runs (`manifest` before), with `resolvedVersion`; the
  compute's state moved to `compute.state`, and `state` is the Agent's: `working`, `sleeping`,
  `input_required`, `failing` or `paused`, with `attention` naming the sessions behind it.
  `GET /v1/agents?state=input_required` filters on it.
- **Sessions run on an Agent.** `PUT /v1/sessions/{id}` takes `{ requestId, agent, ownerUserId,
  info? }` (`agentId` and `environment` before): `createSession({ agent, ownerUserId })`. The
  session pins its Agent's manifest version; its view's `agentId` is the Agent and `manifest`
  names the version; `implementationVersion`, `definitionHash` and `environment` are gone. No
  session is special: to keep one conversation going, reuse a session id you pick.
- **Names say Agent.** Error codes `agent_not_granted`, `agent_busy`, `agent_unavailable`,
  `agent_lost`, `agent_owner_mismatch` (each `environment_*` before); events `agent.*` on
  `GET /v1/agents/{id}/events` and `agent.attached` in a session's log; the scope `agents:write`
  (`environments:write` before), and `agent-manifests:write` to save manifests (what
  `agents:write` saved before). An identity file's `agents` lists Agent grants (ids, `p/*`
  prefixes, `{claim}/*`, `*`; absent reaches none), and its `environments` is refused: move those
  grants to `agents`. `GET /v1/me` drops `environments`.
- **A2A and AG-UI route to Agents.** `/v1/a2a/agents/{agentId}` and `/v1/ag-ui/agents/{agentId}`
  name an Agent: every caller's session runs on that Agent's disk and vault. Make one Agent per
  audience, or a kind `none` Agent for a public endpoint. AG-UI's
  `forwardedProps.nylorun.session` takes `info` only.
- **Model budgets key manifests.** Budget and usage scope `agent` is `manifest`, keyed by the
  agent manifest's name; migration 0032 renames stored budgets. `ModelCall.agentId` is
  `manifestName`.
- **Management API.** `POST /v1/tenant/credential-coverage` takes `{ agentId }` (an Agent: its
  manifest version against its vault); `POST /v1/tenant/mcp/preview` takes `agentId` for the
  vault; `POST /v1/tenant/reset` takes scope `agents` (`environments` before).
- **Harness API 5.** `turn.start.agent { id, kind, sandbox? }` replaces `turn.start.environment`,
  and `turn.start` adds `definition { name, version }` and the harness section's `loop`. A custom
  harness names `api: 5` in `hello`.

# The harness boundary: artifacts, inputs, instructions, tools and the workspace are the harness's (protocol 15, Harness API 4)

A fresh start for agent sessions: the Runtime speaks protocol 15 only, and harnesses Harness API 4
only. Upgrade the Runtime, the SDKs, Studio, the CLI and any custom harness together.

- **`read_artifact` and `save_artifact` are our harness's tools.** Our harness offers them to
  each agent and runs them itself, over the Harness API's new artifact seam; the Runtime no
  longer pins them in a session's `runtime` block and core no longer runs them. The model sees
  the same tools, and `read_artifact` with a sandbox also takes `path`, which copies the whole
  artifact into the sandbox. A `tool.completed` of either now says `kind: "harness"` (it said
  `platform`), and `artifact.created` still carries the call's `callId`.
- **Sessions pinned before protocol 15 are closed.** Every agent session pinned
  `read_artifact` (protocol 12 on), or a `runtime` block at all, so the upgrade's migrations
  (0029, 0030) close each one (`closedReason: "protocol_15"`); a message to one is
  `409 session_closed`. Its history stays readable: open a new session. Workflow sessions carry
  over.
- **The manifest has no `runtime` block.** The Runtime no longer writes the model's instructions
  or defines tools: our harness writes the skill catalog, the sandbox note and the skills' folder
  note, and defines the sandbox tools (`bash`, `read`, `write`, `edit`, `grep`, `glob`),
  `load_skill` and `read_skill_resource` itself, from the facts `turn.start` carries. The model
  sees the same text and tools in the same order, so the prompt's prefix is unchanged. A session
  pins its definition as registered: its `manifestHash` equals its `definitionHash`, with or
  without a sandbox or skills, and the sandbox spec stays on the session. Registering a manifest
  that sets `runtime` is `400` ("Manifest field runtime was removed"), and so is a turn variant
  that sets it.
- **The skill tools run in our harness.** `load_skill` and `read_skill_resource` read a skill's
  files over `definition.file`, and a file larger than the harness reads into the model's context
  (10 MiB, `createHarness({ skillReadBytes })`) or than one record entry holds
  (`limits.recordEntryBytes`) is `skill.resource_too_large`, as before for files over 10 MiB. A
  `tool.completed` of either says `kind: "harness"` (it said `platform`), with its `skill` and
  `plugin` as before.
- **No tool name is reserved.** An agent's own tool may be named `bash`, `load_skill`,
  `tool_search` or `read_artifact`: the manifest takes it. Our harness then fails a turn whose
  tools would share a name with one of its own (`agent.build-failed`, naming the tool): an author
  tool named `bash` runs in a session without a sandbox, and fails the turn in one with.
- **Tool policy rules name an MCP tool by `server` and `tool`.** A rule's `tool` is the tool's
  identity: an MCP tool's own name on its server, or an HTTP tool's declared name; the name the
  model knows it by never matches. Rewrite each rule that named a model-facing name:

  ```json
  { "effect": "ask", "tool": "github__create_issue" }
  ```

  becomes

  ```json
  { "effect": "ask", "server": "github", "tool": "create_issue" }
  ```

  A `tool` with `__` in it is `400` at `PUT /v1/tenant/tool-policy`. A policy stored before the
  upgrade with such a rule fails closed: every MCP and HTTP tool call is denied (`tool.denied`,
  naming the rule), and `GET /v1/tenant/tool-policy` answers `409 request_rejected`, until you
  `PUT` the policy again.
- **Approvals name the MCP tool.** An approval interaction for an MCP call carries `tool` (the
  server's own name) beside `server`, and its prompt reads `Approve <server> / <tool>?` (it was
  `Approve <toolName>?`, the model's `server__tool`); `toolName` stays the name the model used.
  Studio's tool and approval cards show `server / tool`, with "as `<toolName>`".
- **Tool calls carry their identity.** `tool.completed` and each row of
  `GET /v1/sessions/{id}/calls/tool` carry `tool`: an MCP tool's own name on `server`, or an HTTP
  tool's declared name (null on the read for a call with none); `toolName` is still the model's
  name. Traces add `nylorun.tool.identity`, and `gen_ai.tool.name` stays the model's name.
- **The harness names and defers MCP tools.** The session pins what its MCP servers listed, raw
  (`McpSnapshotSchema`, `snapshotSchemaVersion: 2`: each tool by its server's own name, disabled
  ones included, and the server's instructions uncut). Our harness names the tools for the model
  as before (`server__tool`, within 64 characters), decides which to defer, and runs
  `tool_search` itself: a `tool.completed` of it says `kind: "harness"`. The model sees the same
  tools. `mcp.discovered` no longer carries `renamed` or `deferred`, and its `tools` counts the
  tools the manifest leaves enabled. `POST /v1/tenant/mcp/preview` still gives `modelName` and
  `renamed`, as our harness names the tools, and no longer cuts `instructions`.
- **Sessions pinned with the old MCP snapshot are closed.** Migration 0031 closes each open
  session whose snapshot is version 1 (`closedReason: "protocol_15"`); a message to one is
  `409 session_closed`. Its history stays readable: open a new session.
- **Large tool results are the harness's to fit.** Core no longer shapes tool results: it
  refuses an outcome past `limits.recordEntryBytes` with `limit_exceeded`. Our harness stores
  what does not fit as file artifacts of the session, as core did, and the model sees the same
  previews. The Tool Gate still scrubs credentials and refuses an answer past `toolAnswerBytes`
  (`mcp.too-large`, `http.too-large`).
- **The outputs folder is our harness's.** Our harness saves `/workspace/outputs` as the
  session's `outputs` folder when a turn completes in a sandbox, before the turn ends (it was
  core, after). Versions it writes say `source: "engine"` (they said `export`; older versions
  keep it), still `claimed: true`, and an unchanged turn still adds none. The 10,000-file bound
  is the new Runtime limit `folderEntries` (`PUT /v1/tenant/limits`), and the 1 GiB bound is our
  harness's configuration (`createHarness({ outputs: { dir, maxBytes } })`).
  `artifact.export.skipped` and `artifact.export.failed` are our harness's claims, with the same
  payloads. A custom harness saves no outputs folder unless it writes one (§4b's folder mode).
- **Our harness mounts skill folders.** It puts each skill version's files at
  `/skills/<name>@<hash>/` before each sandbox call, as before; the Runtime mounts none, so
  `POST /v1/sessions/{id}/sandbox/{tool}` on a sandbox no turn has used finds no `/skills`.
- **An `environment_secret` reads `nylorun_managed` in the sandbox** (`ENVIRONMENT_SECRET_SENTINEL`;
  it read `nylorun-managed`), so a CLI that refuses a token with a `-`, such as Vercel's, sends
  its request. egress-gate sets the header whatever the CLI sent, so nothing else changes:
  update a script that tests for the literal `nylorun-managed`.
- **Compaction is a transcript edit.** `context.compacted` is written once per compaction, when
  the segment's transcript edit that replaced the history is recorded (it was written per
  summary call, as it returned), and has no `partial`. A compaction of an agent used as a tool
  writes none; its model calls are in the log as before. Traces lose
  `nylorun.compaction.partial`.
- **Scripted models go through a gate.** A Runtime whose model is not the vault's
  (`model: {kind: "scripted"}` or `"fixture"`, or an embedder's `modelProvider`) serves it from a
  Model Gate over the provider, metered like any: usage a scripted answer reports is in
  `GET /v1/tenant/usage`. The in-process harness opens every MCP server through the Tool Gate
  (`ToolGate.openMcp`), as a remote one does.
- **Any file may be sent.** A message naming a file the model does not read is accepted: no more
  `422 attachment_unsupported` (the error code is gone; A2A clients get no
  `CONTENT_TYPE_NOT_SUPPORTED` for one, and AG-UI no `RUN_ERROR`). Files are still held to the
  artifact size limits at upload. Our harness decides how the model sees each one: an image or
  document it reads as itself, a text file inlined, anything else a note telling the model why it
  is not shown. A workflow's agent steps now run with such files too. Studio's file picker offers
  every file, and its refusal chips are gone.
- **`turn.start.model`** describes the model the turn's calls use: `{provider, id, inputs,
  contextWindow, maxOutputTokens, reasoning?}`, absent for flows and without a model (see
  [HARNESS_API.md §3](./HARNESS_API.md#3-input-turnstart)). A custom harness must be built
  against this release's `@nylorun/core`: an older one refuses a `turn.start` with the field.
- **The Model Gate only fetches and translates.** It no longer writes notes for files: a text
  file sent as a media part, or a kind the model or its API does not read, fails the call with
  the new model failure code `unsupported_input`, and a file it cannot fetch (not the session's,
  missing, past `modelFileBytes`) with `invalid_request`, before anything is sent. A custom
  harness that sent every media part as it was now fails such a step: map each part through
  `turn.start.model.inputs` (`modelInputOf`, `isModelImage` in `@nylorun/core/contracts`), inline
  text yourself, and write your own line for the rest (`examples/harness-minimal` does). Our
  engine's choices are exported from `@nylorun/harness`: `fileView`, `representFiles`,
  `fileBlock`, `fileNote`, `mediaReferenceLine`.
- **`ModelCall.outputSchema` is removed.** The gate adds no JSON instruction and repairs no JSON:
  a harness with an output schema writes its own instruction and parses the model's text. Ours
  does, as before, so a structured turn behaves the same; its `message.assistant` now carries the
  answer's JSON text (it was `""`, derived from the gate's `json` block). An answer that is not
  JSON still fails the step `model.invalid_output`.
- **A file of a type the model does not read**, read with `read_artifact`, fails
  `artifact.unsupported` with the reason, as before protocol 15; a file the model reads reaches it
  as a file of the result.
- **A custom harness** says `hello {api: 4}`. It reads and writes its run's session's artifacts
  with `artifact.read` and `artifact.write` (`readArtifact`, `openArtifactWrite` and
  `writeArtifactBytes` in `@nylorun/core/harness-api`), in chunks of at most
  `turn.start.limits.chunkBytes`: see [HARNESS_API.md §4b](./HARNESS_API.md#4b-artifacts). The
  new Harness API error code is `not_found`. And:
  - **every tool call names its `target`** (`EffectTargetSchema`), its identity:
    `{kind: "mcp", server, tool}` (`tool` the server's own name), `{kind: "http", tool}` (the
    declared name), `{kind: "sandbox"}` or `{kind: "harness"}`; `platform` is gone. Core routes
    it by the target, never by its name, and the target is in the request hash. A call without
    one is answered `tool.unavailable` and runs nothing; an MCP tool the session did not
    discover is `tool.unknown`, one the turn disables `tool.disabled`; a `sandbox` call needs a
    session with a sandbox and one of the six operations as its `toolName`. A tool the harness
    runs in its own process is `harness`. An intent may name the `skill` it ran. See
    [HARNESS_API.md §4](./HARNESS_API.md#4-record-intent-outcome-hash-effect-ids);
  - **`turn.start.mcp` replaces `sessionTools` and `routing.mcpSnapshot`.** It states the
    session's MCP servers and their tools as listed, each with `enabled` and the manifest's
    `deferred` hint (`McpFactsSchema`); `session.mcp` answers `{mcp?}`. Build the model's tools
    from it: name each within 64 characters, skip `enabled: false`, and treat `deferred` as a
    hint. Our engine's are exported from `@nylorun/harness` (`mcpToolName`, `mcpToolNames`,
    `mcpToolSet`, `deferredToolsTools`, `runToolSearch`). See
    [HARNESS_API.md §3](./HARNESS_API.md#3-input-turnstart);
  - **an MCP gate call names the raw tool:** `tool-calls` takes
    `{server: {agentId?, serverName}, effectId, name, arguments}`, with `name` the target's
    `tool`;
  - **keep each outcome and transcript entry under `limits.recordEntryBytes`:** store the rest
    with `artifact.write`, keyed per effect, or reuse `shapeToolOutcome`, `StepBudget` and
    `spillKey` from `@nylorun/harness`. See [HARNESS_API.md §5b](./HARNESS_API.md#5b-tool-results);
  - **`hello.features.tools` is removed**, and `NativeToolSchema` with it: a harness declares no
    tools;
  - **mark a compaction.** Send each summary call's intent with `purpose: "summary"` (no
    `message.assistant` is recorded for it), and the edit that replaced the history with
    `kind: "compaction"` and `compaction: {trigger, tokensBefore, tokensAfter, summaryEffectIds}`
    (`transcriptUpdates(before, after, chunkBytes, compaction)`); core refuses facts naming a call
    that wrote no summary (`invalid`), and the turn fails. See
    [HARNESS_API.md §6](./HARNESS_API.md#6-transcript);
  - **`artifact.write` has a folder mode** (`kind: "folder"`, `file`, `refused`, `unchanged`) and
    `turn.start.limits.folderEntries`; `artifact.export.skipped` and `artifact.export.failed`
    are claims a harness may send. Core no longer sends `workspace.read` with `list` or `bytes`:
    a harness that serves workspaces drops them. See
    [HARNESS_API.md §4b](./HARNESS_API.md#4b-artifacts);
  - **a host that embeds `@nylorun/harness/api`** gives `HarnessExecutors.files` `list` and
    `mount` beside `read` and `write`: our engine lists and reads the outputs folder and mounts
    skill folders through them;
  - **`turn.start.environment`** states the Environment, `{id, kind, sandbox?: {workspace}}`, and
    `routing.sandbox.spec` the sandbox spec the session pinned. Offer sandbox tools, and write a
    note on the sandbox, from them: there is no `runtime` block to copy. Our engine's helpers
    are in `@nylorun/harness` (`engineToolsFor`, `sandboxTools`, `sandboxInstructions`,
    `skillCatalogText`, `skillFolderNote`, `skillTools`, `runSkillTool`).
- **Removed from `@nylorun/core`:** `EXPORT_MAX_FILES` (now `limits.folderEntries`),
  `EXPORT_MAX_BYTES` (now `OutputsConfig.maxBytes`, `DEFAULT_OUTPUTS_CONFIG` in
  `@nylorun/harness`), `WorkspaceBytesCall`, `WorkspaceListCall` and their schemas. Each
  `RUNTIME_LIMIT_CEILINGS` entry is `{value, unit, why}` (it was `{bytes, why}`); `unit` is
  `entries` for `folderEntries`.
- **Moved to `@nylorun/core/contracts`:** the media type helpers (`contentTypeFor`, `essence`,
  `normalizeContentType`, `isText`, `isModelImage`, `isOffice`, `modelInputOf`, `inputLabel`,
  `extensionFor`, `MODEL_IMAGE_TYPES` and `DEFAULT_CONTENT_TYPE`), so the Runtime and a harness
  type a file alike. `unreadableReason` is removed (use `fileView`), and `mediaReferenceLine`
  moved from `@nylorun/core/define` to `@nylorun/harness`: it names our tool. `READ_ARTIFACT_TOOL` and `SAVE_ARTIFACT_TOOL`
  stay in `@nylorun/core/define`. `@nylorun/harness`'s `createHarness`
  takes `artifactPageBytes` (the most one `read_artifact` page holds, 32 KiB by default),
  `sandboxTools` (the sandbox tools' limits, `DEFAULT_SANDBOX_TOOL_LIMITS`), `skillReadBytes`,
  `mcpTools` (when to defer MCP tools and `tool_search`'s limits, `DEFAULT_MCP_TOOL_CONFIG`) and
  `toolResults` (how results are shaped, `DEFAULT_TOOL_RESULT_CONFIG`); `runDurable` takes
  `engineTools` (`engineToolsFor`: an agent's tools and their text) and `mcp` (`mcpToolSet`, in
  place of `sessionTools`), and `apiHost` takes the engine's configuration.
- **Removed from `@nylorun/core/define`:** `runtimeManifestFor`, `runtimeToolOf`,
  `RuntimeManifest`, `RUNTIME_PART_ID` (now `SESSION_PART_ID`, `"session"`), `RUNTIME_TOOL_NAMES`,
  `isRuntimeToolName`, `createSandboxTools`, `SANDBOX_INSTRUCTIONS`, `LOAD_SKILL_TOOL`,
  `READ_SKILL_RESOURCE_TOOL`, `SKILL_TOOL_NAMES`, `isSkillTool`, `SKILLS_USAGE`,
  `formatSkillCatalog` and `skillOfToolCall`; the skill and sandbox ones are in
  `@nylorun/harness`. `@nylorun/agents` no longer re-exports `formatSkillCatalog` and
  `SKILLS_USAGE`. `agentFrom` takes `sessionInstructions`. The deferred tools moved to
  `@nylorun/harness` too: `TOOL_SEARCH_TOOL`, `TOOL_CALL_TOOL` and `deferredToolsTools` (now
  taking the harness's `McpToolConfig`); `deferredToolsInstructions` is `deferredToolsNote`, and
  `SERVER_INSTRUCTIONS_MAX_CHARS`, `TOOL_SEARCH_DEFAULT_LIMIT` and `TOOL_SEARCH_MAX_LIMIT` are
  `McpToolConfig` fields.
- **Host timings are configuration.** The Runtime's timeouts, retries, poll intervals and internal
  sizes are the Host tuning, set in `NYLORUN_TUNING` (one JSON object; `nylorun start` passes it to
  every container) and read once at start. Every default is the value before, so nothing changes
  until you set one; an unknown key or a value past its ceiling stops the process naming it. See
  [Host tuning](./DEPLOYMENT.md#host-tuning). A failed pod's reason now says `The pod was not
  ready within 300 s` (it said `5 minutes`).
- **Our engine's loop is configuration too.** `createHarness` takes `compaction`
  (`CompactionConfig`, `DEFAULT_COMPACTION_CONFIG`), `partialOutputChars`, `resendDelaysMs` and
  `leaseRetryMs`, beside `transcriptCacheMb`; `runDurable` takes `loop` (`LoopConfig`), and the
  compaction functions take a `CompactionConfig`. `EngineToolConfig` is `EngineConfig` (the tool
  config with `loop` and `resendDelaysMs`), and `apiHost` takes it.

- **The last limits are configuration (B15c).** Every default is the value before.
  - **21 more Runtime limits** (`GET`/`PUT /v1/tenant/limits`): `messageParts` (32),
    `pageItems` (200) and `exportPageItems` (1,000), `environmentEventItems` (1,000),
    `artifactLabels` (32), `labelKeyChars` (63) and `labelValueChars` (256), `setupCommandChars`
    (4,096), `setupReasonChars` (500) and `setupCommandExcerptChars` (80), `manifestDescriptionChars`
    (1,024), `secretDescriptionChars` (500), `secretValueChars` (8,192), `secretHosts` (32),
    `toolRules` (200), `toolRuleFieldChars` (200), `toolRuleTextChars` (500), `modelBudgets` (100),
    and the flow limits `flowConcurrency` (8), `flowMapItems` (1,000) and `flowLoopIterations`
    (100). An agent's `requires.secrets` is held to `environmentSecretSlots` at deploy. The request
    schemas lose these maxima (the OpenAPI documents no longer state them) and the Runtime refuses a
    request past the Tenant's limit with `400` naming it.
  - **A page asked larger than `pageItems` holds that many**, with a cursor to the rest, where a
    `limit` over 200 (1,000 for the export) was `400 query_invalid`. A page with no `limit` holds
    the route's default (50, 200 for the export) or the limit when it is lower. One read of an
    Environment's events holds at most `environmentEventItems`; `from` reads on.
  - **The flow limits are Runtime limits.** `NYLORUN_FLOW_MAX_CONCURRENCY`,
    `NYLORUN_FLOW_MAX_MAP_ITEMS` and `NYLORUN_FLOW_MAX_LOOP_ITERATIONS` (which no Host read) and the
    Tenant configuration's `flow` and `flowEnv` are removed, with `resolveFlowLimits`,
    `FLOW_LIMIT_DEFAULTS` and `FLOW_LIMIT_ENV`; set `flowConcurrency`, `flowMapItems` and
    `flowLoopIterations` instead. A flow's `turn.start.options.flowLimits` carries the last two.
  - **More Host tuning** (`NYLORUN_TUNING`): `keys.tokenTtlMaxSeconds` (900), `runTokenTtlSeconds`,
    `runTokenRenewSeconds`, `hostTokenTtlSeconds`, `tokenLifetimeSlackSeconds`,
    `clockToleranceSeconds`; `host.operateReadyTimeoutMs` (`nylorun-operate status` reads the
    container's `NYLORUN_TUNING`), `credentialLockPollMs`, `credentialLockAttempts`;
    `sweep.armConcurrency`; `execution.advanceDeadlineMs` (below `restate.inactivityMs`) and
    `advanceGraceMs`; `restate.staleSweepIntervals`; `postgres.replicationPoolSize`,
    `contentBatchRows`; `streams.basinLogEveryFailures`; `egress.credentialsMaxSockets`;
    `pods.enginePollMs`, `memoryFloorMiB`; `harness.mcpListPages`, `mcpDiagnosticChars`,
    `helperCommandTimeoutMs`, `helperCommandExcerptChars`, `scrubMinChars`, `execCommandChars`,
    `commandStreamBytes`; `engine.flowValueChars` and `engine.toolResults.minPreviewBytes`.
    The disk copy's `409`s take `Retry-After` from `tenant.retryAfterSeconds`, as the others do.
  - **The CLI's own waits are `NYLORUN_CLI_TUNING`** (DEPLOYMENT.md, "The CLI"): `nylorun start`'s
    waits and polls, the Compose healthchecks and WAL cap, and `nylorun local sandbox`'s waits.
    `nylorun tenant mcp inspect` no longer aborts after 30 s (the Runtime bounds the preview), and
    `nylorun tenant calls --limit` takes any whole number (a page holds at most `exportPageItems`).
  - **Studio follows the Runtime's limits**: its proxy no longer caps an upload at 32 MiB (the
    Tenant's artifact limits hold it) and asks the Runtime for `requestBodyBytes` when a JSON
    write it parses is past the default (`MAX_UPLOAD_BYTES` is removed from `@nylorun/studio`;
    `@nylorun/agents` exports `RUNTIME_LIMIT_DEFAULTS`); its Environment form no longer caps CPUs
    at 64.
  - **Caps with no dependency are gone**: a sandbox's `resources.cpus` (64: the Tenant's
    `limits.resources.cpus` holds it), an environment variable name's 128 characters, a custom
    model's `contextWindow` floor of 1,024, a Studio embed route's 2,048 characters, an identity
    file template's 200 characters, and the 0–99 index of a pod's setup files.
  - **Removed from `@nylorun/core`**: `MAX_MESSAGE_PARTS`, `TOKEN_TTL_MAX_SECONDS` and
    `ARTIFACT_LINK_MAX_TTL_SECONDS` (`keys.tokenTtlMaxSeconds`; a link asked longer gets that).
    New: `LINK_TARGET_MAX` (Linux's 4,096), `MODEL_TOOL_NAME_MAX` (64, from `@nylorun/core/define`),
    `POD_UID_PATTERN`, `JOIN_TOKEN_MAX`, `LINUX_ARG_MAX_BYTES`. From `@nylorun/runtime`:
    `RUN_TOKEN_TTL_SECONDS`, `RUN_TOKEN_RENEW_SECONDS`, `HOST_TOKEN_TTL_SECONDS`
    (`hostTokenTtlSeconds()`), `EGRESS_TOKEN_MAX_TTL_SECONDS` (`egressTokenMaxTtlSeconds()`),
    `CLOCK_TOLERANCE_SECONDS` (`clockToleranceSeconds()`), `HELPER_COMMAND_TIMEOUT_MS`
    (`helperCommandTimeoutMs()`), `DEFAULT_ADVANCE_DEADLINE_MS` and `DEFAULT_ADVANCE_GRACE_MS`.
  - Visible differences at the defaults: a page past its limit, a cut tool message's preview
    (up to 6 bytes longer: its room is now measured as JSON), a shortened tool result's artifact
    name (its tool part now fills up to 255 characters with the suffix), and Studio's egress
    rows, which say they are cut short only when a next read finds more.

- **The remaining request, upload, token and sandbox limits are Tenant settings.**
  `GET /v1/tenant/limits` answers 27 more Runtime limits, each with today's value as its default:
  `requestBodyBytes` (1 MiB), `inlineFileBytes` (20 MiB; an inline endpoint reads one such file's
  base64 and `requestBodyBytes` more, where it read 28 MiB), `a2aWaitMs`, `errorExcerptChars`,
  `traceContentBytes`, `environmentLabels`, `environmentSetupCommands`, `environmentFiles`,
  `environmentFilesPerEntry`, `environmentSecretSlots`, `setupCommandMs`, `setupOutputChars`,
  `diskVersionEntries`, `diskVersionBytes`, `diskLeaseMs`, `diskPodWaitMs`, `modelRequestMs`,
  `modelIdleMs`, `modelAttempts`, `modelRetryDelayMs`, `modelProviderRetries`,
  `modelRetryDelayMaxMs`, `toolAttempts`, `httpToolTimeoutMs`, `mcpSnapshotBytes` (new: what a
  session pins of its MCP servers' tools and instructions; a server past it is left out, with a
  `failed` diagnostic), `mcpPreviewMs` and `mcpMetadataBytes`. See
  [DEPLOYMENT.md](./DEPLOYMENT.md#runtime-limits). A `PUT` still replaces the whole document, so
  put back what you set before with the new ones.
- **An Environment's manifest may lower its disk versions' limits**: `limits.disk.versionBytes`
  and `versionEntries`, within the Tenant's. `EnvironmentView.limits` gains `disk`.
- **Counts and timeouts a schema capped are checked against the Tenant's limits.** The request
  schemas no longer cap an Environment's labels (32), setup commands and input files (16 each),
  the files of an entry by hash (1,000), secret slots (64) or a setup command's `timeout` (30m),
  nor an HTTP tool's `timeoutMs` (300 s: it may now ask for up to a JavaScript timer's
  2,147,483,647 ms). The Runtime refuses one past the Tenant's limit with `400` naming it: labels
  whenever they are set, a manifest when an Environment is made or the manifest saved, an agent
  when it is deployed; and a call waits at most the limit in force then. `limits.environments`
  in `PUT /v1/tenant/sandbox` has no maximum, and `lifecycle.stopGrace` no 30 s cap (it is the
  pod's `terminationGracePeriodSeconds`). An identity file's issuer takes any number of
  `environments` grants, and `jwksFetch` (`timeoutMs`, `maxBytes`, `maxKeys`, `refetchMs`,
  `maxAgeMs`) for how its JWKS is fetched.
- **Tokens are read up to Node's header size.** A bearer, issuer token or capability link is
  read up to `http.maxHeaderSize` (16 KiB), where the Runtime's own tokens stopped at 4 KiB.
- **`turn.start.limits` carries only a harness's limits** (`HarnessLimitsSchema`:
  `recordEntryBytes`, `modelCallBytes`, `modelFileBytes`, `toolAnswerBytes`, `harnessStateBytes`,
  `chunkBytes`, `folderEntries`), and a harness drops a limit it does not know.
- **Transcript edits fill each event up to `recordEntryBytes`.**
  `transcriptUpdates(before, after, recordEntryBytes, compaction?)` takes the run's
  `turn.start.limits.recordEntryBytes` (it split at 48 KiB, `CHUNK_BYTES`, now removed), so a
  long edit is fewer, larger `transcript.updated` events, each within the record entry limit.
- **Removed from `@nylorun/core`**: `ENVIRONMENT_LABELS_MAX`, `ENVIRONMENT_SETUP_MAX`,
  `ENVIRONMENT_FILES_MAX`, `ENVIRONMENT_SECRET_SLOTS_MAX`, `TOKEN_ENVIRONMENT_GRANTS_MAX`,
  `HTTP_TOOL_MAX_TIMEOUT_MS`, `READ_ARTIFACT_MAX_BYTES` (our harness's `artifactPageBytes`
  default) and `CHUNK_BYTES`; `ENVIRONMENT_SETUP_TIMEOUT_MAX_MS` is
  `ENVIRONMENT_SETUP_TIMEOUT_DEFAULT` (`"10m"`, a command's default). New: `HarnessLimitsSchema`,
  `HARNESS_LIMIT_DEFAULTS`, `harnessLimitsOf`, `inlineBodyBytes`, `TIMER_MAX_MS`,
  `FILE_NAME_MAX`, `FILE_PATH_MAX` (`ARTIFACT_NAME_MAX` and `ARTIFACT_PATH_MAX` are these) and
  `CUSTOM_MODEL_SETTING_DEFAULTS`. `SKILL_FILE_PATH_MAX` is what `FILE_PATH_MAX` leaves under a
  skill's mount folder (747, it was 512).
- **Removed from `@nylorun/runtime`**: `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`,
  `decodeImageBase64` and `validateImageBytes` (the Runtime used none of them; the
  interior-design example keeps its own), the Tenant configuration's `modelCall` (the Runtime
  limits `model*`; `piModel`'s `settings` still overrides them, and takes `providerRetries` and
  `maxRetryDelayMs`), and `TrustedIssuersOptions`' `refetchMs` and `maxAgeMs` (an issuer's
  `jwksFetch`).

# Runtime limits are a Tenant setting

Still protocol 14 and Harness API 3.

- **The limits are settings.** What one record entry, model call, model file, tool answer,
  custom harness state and Harness API chunk may hold is `GET`/`PUT /v1/tenant/limits`
  (`admin.settings.limits`, `nylorun tenant settings limits`), with today's sizes as defaults.
  See [DEPLOYMENT.md](./DEPLOYMENT.md#runtime-limits).
- **Every write into the record is held to `recordEntryBytes`** (960 KiB by default, S2's
  record less its envelope). A message, an outcome or an event past it is `413
  limit_exceeded` (`limit_exceeded` to a harness) instead of a record S2 cannot take.
- **A custom harness gets `turn.start.limits`**, and must be built against this release's
  `@nylorun/core`: an older one refuses a `turn.start` that carries the field. A harness whose
  state, outcome or `definition.file` range passes a limit gets the new Harness API error code
  `limit_exceeded` (the state's turn fails as before, now with that code).
- **Removed exports**, each now a Runtime limit: `MAX_MODEL_CALL_BYTES` and
  `MAX_TOOL_BODY_BYTES` (`modelCallBytes`, `toolAnswerBytes`), `MAX_HARNESS_STATE_BYTES`
  (`harnessStateBytes`) and `DEFINITION_FILE_CHUNK_BYTES` (`chunkBytes`). Read their defaults
  from `RUNTIME_LIMIT_DEFAULTS`, and a harness reads the values in force from `turn.start.limits`.

# Environment manifests, and Environments that never change (protocol 14)

The Runtime speaks protocol 14 only: upgrade the Runtime, the SDKs, Studio and the CLI
together. Sessions, Environments and their vaults carry over.

- **An Environment never changes what it runs.** `PUT /v1/environments/{id}` on an existing one
  may change only `labels` and `ownerUserId`. A field that matches what it runs is accepted, so a
  get-or-create call with the same body works as before; any other difference is
  `409 environment_immutable`, with `details.fields`. Code that changed an Environment's image,
  network, harness, lifecycle, setup or files in place forks it instead:
  `POST /v1/environments/{id}/fork` (`client.environments.fork()`) makes a new Environment with
  its disk and secrets, from the new manifest version, and new sessions name the new id.
- **The view's `recipe` is `manifest`.** `EnvironmentView.recipe` is renamed `manifest`; it also
  carries `manifestName`, `manifestVersion` and `manifestHash`, and `slots` when it declares
  secrets. `version` and `appliedVersion` no longer move. In `@nylorun/agents`,
  `EnvironmentRecipeInput` is `EnvironmentInput`.
- **Environment manifests** are new: save a named, versioned definition with
  `PUT /v1/environment-manifests/{name}` (`client.environments.manifests.save()`), check it first
  with `?dryRun=true` (`manifests.plan()`), and make Environments from it with
  `{ manifest: "name" }` or `"name@n"`. See
  [DEPLOYMENT.md](./DEPLOYMENT.md#agent-manifests).
- **Secret slots.** When what an Environment runs declares `secrets`, write each value with
  `{ value }` (or `{ headers }`); a name it does not declare is `409 secret_not_in_manifest`.
  Environments without slots take typed secret writes as before.
- **`requires`.** An agent manifest v7 may state what it needs of its Environment
  (`.requires({ sandbox, secrets })`); a session opened without it is
  `409 environment_unsuitable`. Agents that do not set it are unaffected.
- **Dry runs.** `PUT /v1/agents/{id}?dryRun=true` (`saveAgent(agent, { dryRun: true })`) checks a
  definition and saves nothing.
- **Studio** edits only an Environment's labels and owner guard; its setup and files are
  read-only.

## Parallel turns, and egress on the Environment

Part of protocol 14 (D66, D67).

- **Sessions on one Environment run their turns at the same time.** A turn start is no longer
  `409 environment_busy` because another session on the Environment has a turn running; one turn
  per session stays. If your app relied on the refusal to keep agents apart, send one session's
  message at a time yourself, or give each piece of work its own Environment (or a fork).
  `environment_busy` still answers stop, reset, snapshot and restore while any turn runs, and a
  turn while a disk copy runs.
- **Egress is on the Environment's stream.** `egress.connection` is gone from session logs and from
  turn traces (no `CONNECT` span). Every connection is `environment.egress` on
  `GET /v1/environments/{id}/events`, with `runningTurns: [{ sessionId, turnId }]`, the turns
  running when it opened (at most 16). To see a turn's egress, read the Environment's events
  with `types=environment.egress` and `since`/`until` around the turn
  (`client.environments.events(id, { types, since, until })`).
- **A skill's files are in a folder per version.** In a sandbox, a skill's files are under
  `/skills/<name>@<hash>/`, not `/skills/<name>/`, so two agents with different versions of a
  skill can share an Environment. The instructions and `load_skill`'s `sandboxPath` give the
  folder; a skill whose `SKILL.md` names `/skills/<name>/` should use paths relative to its own
  folder instead.
- **Sandbox commands of different sessions run at the same time.** Each session's commands keep
  their order. A long command in one session no longer holds back another session's commands on
  the same Environment.

# One command: `nylo` is part of `nylorun`

`nylorun` is the one command. `nylo` keeps its name until nylorun 0.18, which removes it and the
deprecated `@nylorun/cli`; each of its commands exits 2 naming the `nylorun` command that replaced
it. Commands other than the installation's
lifecycle moved into groups, each named after the API it uses, and the old spellings exit 2
naming the new one.

| Before | Now |
| --- | --- |
| `nylo status` | `nylorun status` (a remote installation with `NYLORUN_RUNTIME_URL` and `NYLORUN_MANAGEMENT_KEY`) |
| `nylo reset [--sessions\|--environments\|--all]` | `nylorun tenant reset …` |
| `nylo access signing-keys list\|rotate\|revoke` | `nylorun tenant signing-keys …` |
| `nylo configure` | `nylorun tenant models set` |
| `nylo doctor sandbox` | `nylorun doctor sandbox` |
| `nylo env`, `eval "$(npx -p nylorun nylo env)"` | Nothing: the SDKs read the Project link. Outside the project, give the process a key of its own (`nylorun tenant keys put <id>`) and the URL `nylorun status` prints |
| `nylorun key put\|list\|rm` | `nylorun tenant keys put\|list\|rm` |
| `nylorun mcp inspect <url>` | `nylorun tenant mcp inspect <url>` |
| `nylorun sandbox ls\|rm` | `nylorun environments list\|delete` |
| `nylorun sandbox enable\|disable\|status` | `nylorun local sandbox …` |
| `nylorun logs`, `ls`, `delete`, `reset`, `telemetry` | `nylorun local …` |

- **Two resets.** `nylorun local reset` deletes a local Tenant's volumes, Tenant directory and
  vault key (the next start creates it anew). `nylorun tenant reset` clears its sessions,
  Environments or all its data through the Management API and keeps the Tenant and its keys.
- **Which installation.** `tenant`, `environments`, `status` and `doctor sandbox` act on the local
  Tenant `--tenant` names, else the linked project's, else the default one, as before. Without
  `--tenant`, `NYLORUN_RUNTIME_URL` with `NYLORUN_MANAGEMENT_KEY` names a remote installation for
  the Management API commands, and with `NYLORUN_SERVER_KEY` for `environments`. `NYLORUN_RUNTIME_URL`
  alone is an app's and names nothing.
- **Scripts.** Replace `npx -p nylorun nylo <command>` with `npx nylorun <command>` as above; an
  npm script `nylo configure` becomes `nylorun tenant models set`.

# The flat agent manifest (protocol 13)

A fresh start: the Runtime speaks protocol 13 only, and refuses older manifests. Upgrade the
Runtime, the SDKs, Studio and the CLI together, then save your agents again (`saveAgent`, or
`PUT /v1/agents/{id}`). Sessions opened on protocol 12 do not carry over: open new ones.

**Manifest v7 has no capabilities.** The agent's parts sit at the top level:

```jsonc
{
  "manifestSchemaVersion": 7,
  "id": "support",
  "instructions": ["Answer in two sentences."],
  "tools": [{ "name": "refund_order", "inputSchema": {}, "http": { "url": "https://…" } }],
  "skills": { "triage": { "name": "triage", "description": "…", "files": {}, "plugin": { "name": "github", "version": "1.2.0" } } },
  "mcpServers": { "github": { "name": "github", "type": "streamable-http", "url": "https://…", "plugin": { "name": "github", "version": "1.2.0" } } },
  "runtime": { "sandbox": {}, "tools": [], "instructions": [] }
}
```

- **Versions 3 to 6, and a `capabilities` field, are refused** with a message to rebuild the agent.
  The SDK builds v7: rebuild and save.
- **Plugin labels.** `.plugin(dir)` adds its skills and servers to `skills` and `mcpServers`,
  each with `plugin: { name, version }` from its `plugin.json`. No `plugins` key and no
  `agent-plugin` part.
- **The `runtime` block** is what the Runtime adds when a session pins the agent: the session's
  `sandbox` spec, the tools it serves (the sandbox tools, `save_artifact`, `read_artifact`,
  `load_skill`, `read_skill_resource`) and their instructions (the skill catalog, the sandbox and
  artifact notes). Only the Runtime writes it: a definition or a turn variant that sets it is
  refused. It replaces the `nylorun.sandbox`, `nylorun.artifacts` and `nylorun.tools`
  capabilities. `GET /v1/sessions/{id}/manifest` returns it.
- **The skill tools and the catalog come from the Runtime.** `.skills()` and `.plugin()` no
  longer add `load_skill`, `read_skill_resource` or the catalog to the agent's instructions:
  `runtimeManifestFor(manifest, options)` in `@nylorun/core/define` shows what a session gets.
- **Reserved names.** An agent's tool may not take a Runtime tool's name (`RUNTIME_TOOL_NAMES`:
  `bash`, `read`, `write`, `edit`, `grep`, `glob`, `save_artifact`, `read_artifact`,
  `load_skill`, `read_skill_resource`, `tool_search`, `tool_call`), nor contain `__`, which MCP
  tool names use. Tool names are unique, and so are skill names and MCP server names, each
  within its kind: a tool, a skill and a server may share a name, since a server's tools are
  called `<server>__<tool>` and a skill is loaded by name through `load_skill`.
- **Turn variants.** A variant may remove tools, tighten MCP servers' tool settings, and change
  instructions, name, description and metadata. Its skills are fixed (equal to the pin's), and it
  may not set `runtime`, change `outputSchema` or add a part.

**Tools are known by name.** `capabilityId` is gone from `tool.completed`, `mcp.discovered`, the
rows of `GET /v1/sessions/{id}/calls/tool` and the Harness API. An HTTP tool's `server` is its
URL's host.

**Harness API 3.** `hello.capabilities` is renamed `features` (`features.tools`,
`features.workspace`), effects and gate calls carry no `capabilityId`, and there is no `harness`
pseudo-capability: a native tool is known by its name, and one whose name is taken fails the
turn at its start. A harness reads the flat manifest: `tools` and `runtime.tools`,
`instructions` then `runtime.instructions`. Core refuses `api: 2`. See
[HARNESS_API.md](./HARNESS_API.md) and [`examples/harness-minimal`](../examples/harness-minimal/README.md).

**In code:**

| Before | After |
| --- | --- |
| `manifest.capabilities.find((c) => c.id === "agent").tools` | `manifest.tools` |
| `Agent.from(json, { agent: { tools: { lookup } } })` | `Agent.from(json, { tools: { lookup } })`: `Implementations` is keyed by tool name |
| `binding.declarations` | `binding.parts`: `agent`, `mcp`, `skills:<folder>`, `plugin:<name>` |
| `middlewareId` in observe events and `ToolOwner` | `partId` |
| `SessionToolRef { capabilityId, name }` | `{ name, instructions? }` |
| `sandboxCapabilityManifest`, `artifactsCapabilityManifest`, `toolsCapabilityManifest` | `runtimeManifestFor` |
| `createHarness({ capabilities })` | `createHarness({ features })` |

Studio's Agent tab shows the manifest in sections (instructions, tools, skills, MCP servers),
with a badge for each plugin, and a session's Runtime section from `manifest.runtime`.

## Tracing a tool call

Every tool call can be traced from the log alone to its skill or MCP server and the plugin that
brought it. No protocol change beyond 13.

- **`tool.completed`** gains `skill` and `plugin` (`{ name, version? }`), and the rows of
  `GET /v1/sessions/{id}/calls/tool` (`session.toolCalls()`) gain `skill` and `plugin`, `null`
  when there is none. An MCP call gets its server's plugin. `load_skill` and
  `read_skill_resource` get the skill they name, and a sandbox tool (`bash`, `read`, `grep`,
  `glob`, …) whose input names `/skills/<name>/` gets that skill; both get the skill's plugin.
- **`kind: "harness"`** marks a tool the turn's harness declared in `hello.features.tools` and
  ran itself. Before, such a call said `platform`.
- **`mcp.discovered`** names each server's `plugin`.

Studio shows each tool call's kind, server or skill, and a plugin badge, in the chat and the
event details, and the plugin of each server `mcp.discovered` lists.

# Step middleware and capability bundles are removed

An agent is its manifest: nothing of yours runs in a step, here or in the local engine. No
protocol change.

| Removed | Instead |
| --- | --- |
| `.use(fn)`, `.use(id, fn)`, `middleware()`, `StepMiddleware` | The Tenant's tool policy (an `ask` or `deny` rule), an output schema, or your own harness (Harness API) |
| `.use({ … })`, `.capability(…)`, `capability()`, `CapabilityBuilder` | `.instructions()`, `.tools()`, `.subagents()`, `.mcp()`, `.skills()`, `.plugin()`. To reuse a set, write a function that adds it: `const billing = (agent) => agent.tools(refund).instructions(BILLING)` |
| `skills(dir)`, `plugin(dir)`, `mcp(servers)` | `.skills(dir)`, `.plugin(dir)`, `.mcp(servers)` |
| `.skills(dir, { id })` | `.skills(dir)`; the part takes the folder's name |
| `model()` and a capability's `model` | The Runtime picks the model: the Tenant's model, or the session's |
| `Implementations[id].middleware` | Nothing: `Agent.from(json, implementations)` takes tools only |

The engine no longer emits `middleware.entered`, `middleware.completed` or
`middleware.lease-violation`, and a model request has no `model` directive or runtime context
items.

# Model inputs and files (protocol 12)

Protocol 12 only adds to protocol 11: the Runtime serves clients of both, and nothing a protocol
11 client sends changes meaning. What changes:

- **A custom endpoint reads text only by default.** A custom OpenAI-compatible endpoint used to
  be sent images. Now it reads what its settings say: if yours reads images, set
  `settings.inputs: ["image"]` on `PUT /v1/tenant/model`. It may also read `pdf`, `audio` and
  `video`.
- **A file the model does not read is refused at accept.** A message whose `parts` name a file of
  a type the Tenant's model does not read is answered `422 attachment_unsupported`, with each
  refused file in `details.parts` (`artifactId`, `name`, `mediaType`, `reason`), and no turn
  starts. It used to start a turn that failed at its model call. Only the type is checked, never
  the size: a file the provider refuses fails that turn.
- **What a model reads.** `GET /v1/tenant/models` gives each model `inputs` (what it reads) and
  `addableInputs` (what its API carries that its catalog does not list), and
  `GET /v1/tenant/providers` each provider's `inputs`. `PUT /v1/tenant/models/inputs`
  (`admin.models.setInputs({ provider, model, inputs })`) adds inputs to a catalog model.
- **A file is a reference line after its turn.** The model gets a file's bytes only in the turn
  that brought it (a message, a tool result, a `read_artifact` load). Later turns show the line
  `[Uploaded artifact "name" · <artifactId> v<n> · read_artifact to view]`, and the model reads
  the file again with `read_artifact`. Every agent now has `read_artifact`, so each session
  pins its definition with it added: `manifestHash` differs from the definition's
  (`definitionHash` in the session view names the definition). An agent that declares its own
  `read_artifact` keeps it.

No migration runs.

# Each turn is a trace, and every row that ends a call carries its timing (R7)

No protocol change, and nothing to do unless you read the session log yourself:

- **One row per model call.** A step that said nothing (no text and no tool calls) now writes
  `message.assistant` with `text: ""`, and each partial summary of a long compaction writes
  `context.compacted` with `partial: true`. If you render raw events, skip empty assistant
  messages with `isEmptyAssistantMessage` from `@nylorun/core/contracts`. The AG-UI and A2A
  histories already skip both.
- **New event types.** `node.completed` ends a flow's HTTP stage, `egress.connection` records a
  pod's connection through egress-gate in the session log, and `environment.egress` records one
  on the Environment's stream while no turn holds it. (Since protocol 14 every connection is
  `environment.egress`; see "Parallel turns, and egress on the Environment".) Clients ignore event types they do not know.
- **More fields on existing events.** Model and tool outcomes carry `effectId`, `durationMs` and
  the gate's own times; turn ends carry `durationMs`, `pausedMs`, `agentId` and `totals`. A turn
  started before this release has no `durationMs`.
- **Traces are off until you set an endpoint.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export each
  turn as one OpenTelemetry trace. The exporter uses a second replication slot,
  `nylorun_trace_export`, so a managed Postgres needs `max_replication_slots` of at least 2. Read
  one turn's spans without a collector at `GET /v1/sessions/{id}/turns/{turnId}/trace`
  (`session.trace(turnId)`). See [Traces](./DEPLOYMENT.md#traces).

Migration `0022` adds the gate's times to the usage ledger and runs at start.

# Bring your own harness: harness ids and who wrote each event (R4)

- **Our harness says `nylorun`.** A harness names itself in `hello` with its harness id, and ours
  is `nylorun`. A connection that says `@nylorun/harness` is refused with a message naming the
  new id, so upgrade the harness with the Runtime: on a local Tenant `nylorun start` does it.
  Elsewhere, run the `harness` container and `NYLORUN_SANDBOX_HARNESS_IMAGE` (the image sandbox
  pods copy the engine from) at this Runtime's image.
- **Who wrote each event.** An event's `source` and `evidence` are now set by the code that wrote
  it, not by its type: a command is `client`, with a `principal` taken from its credential; what
  a harness reported is `harness`, with its harness id, `runId` and evidence `claimed`; core's own
  logic is `core`, evidence `observed`. Events written before this release still say `api` or
  `loop`, so a client that filters on `source.kind` should accept both spellings.
- **A session pins its harness.** An Environment's `harness` takes any harness id, and a session
  pins its Environment's harness when it opens (`GET /v1/sessions/{id}` returns it as
  `harness`). A turn on an Environment that now names another harness is `409
  harness_mismatch`: open a new session.

To run a harness of your own, see [HARNESS_API.md](./HARNESS_API.md).

# Tool approvals are the Tenant's tool policy (R5)

**`approval` leaves the manifest.** An agent no longer says which of its tool calls wait for a
person: the operator does, once for every agent and every harness, with the Tenant's tool policy.
`PUT /v1/agents/:id` and `saveAgent()` refuse a definition that sets `approval` on an HTTP tool,
an MCP server or an MCP tool's settings, and `http({ approval })` and `.mcp({ … approval })` throw.

Move each `approval: "always"` to an `ask` rule, with a management key:

```ts
// Before
Agent({ id: "support" })
  .tools(http({ name: "refund_order", input, url, approval: "always" }))
  .mcp({ github: { type: "streamable-http", url, tools: { create_issue: { approval: "always" } } } });

// After: the agent declares its tools…
Agent({ id: "support" })
  .tools(http({ name: "refund_order", input, url }))
  .mcp({ github: { type: "streamable-http", url } });

// …and the Tenant's tool policy holds them for a person.
import { createAdmin } from "@nylorun/admin";
await createAdmin().toolPolicy.put({
  rules: [
    { effect: "ask", agent: "support", tool: "refund_order" },
    { effect: "ask", agent: "support", tool: "github__create_issue" },
  ],
});
```

A rule can also refuse a call (`deny`) or test its input (`when`); see [Tool
policy](./DEPLOYMENT.md#tool-policy). Approving is unchanged: the turn pauses (`turn.paused`) and
`session.approve(interactionId, approved)` answers it. A refused call now reaches the model as a
failed result with the code `tool.denied`, and its `tool.completed` says `status: "failed"`. A
session pinned to a manifest saved with `approval: "always"` keeps that approval until it ends.
A turn manifest can no longer add an approval.

**Tool calls are delivered at least once.** A crash, a restart or a lost gateway connection sends
an MCP or HTTP call again with the same key (`Idempotency-Key`, or
`_meta["nylorun/idempotency-key"]` for MCP), up to three sends; then the model gets
`tool.interrupted`. A sandbox command a crash interrupted fails to the model the same way, and is
not run again. No tool call leaves a session `uncertain` any more, and `mcp.lost` reaches the model
for every tool. Make a side effect safe to repeat by honoring the key. `GET
/v1/sessions/{id}/calls/tool` (`session.toolCalls()`) lists a session's tool calls with their sends.

# Environments replace sandboxes and vaults (protocol 11): a fresh start

**Upgrading deletes your sandboxes, their disks and every vault except the model's, and closes
every open session.** Sessions keep their history (read, stream and export it as before), but
take no new turn: a message, approval or answer is `409 session_closed`. List what you have
before you upgrade (below), then recreate Environments and write their secrets again. Secret
values cannot be exported, so have them at hand.

An Environment is where sessions run: one sandbox (kind `virtual`, `pod` or `none`) with a recipe
that can change, and one vault of secrets for its shell, MCP servers and HTTP tools. The app
decides who uses which Environment (one per person, per project or per session): the Runtime
stores it by id, holds its lifecycle and checks only grants, the optional owner guard and serial
turns. Clients and SDKs of this release send `Nylorun-Protocol: 11`, and the Runtime accepts
protocol 11 only: an older client is answered `426` naming the protocol it needs. Upgrade the
Runtime, `@nylorun/agents`, `@nylorun/admin`, `nylorun` and Studio together.

## Before you upgrade: list what you have

With the old release still running, an application key in `NYLORUN_KEY` and a management key in
`NYLORUN_MANAGEMENT_KEY`:

```bash
curl -s -H "Authorization: Bearer $NYLORUN_KEY" -H "Nylorun-Protocol: 10" "$NYLORUN_URL/v1/sandboxes" > sandboxes.json
curl -s -H "Authorization: Bearer $NYLORUN_MANAGEMENT_KEY" -H "Nylorun-Protocol: 10" "$NYLORUN_URL/v1/tenant/vaults" > vaults.json
for vault in $(node -p "JSON.parse(require('fs').readFileSync('vaults.json')).vaults.map(v => v.id).join(' ')"); do
  curl -s -H "Authorization: Bearer $NYLORUN_MANAGEMENT_KEY" -H "Nylorun-Protocol: 10" "$NYLORUN_URL/v1/tenant/vaults/$vault/credentials" > "credentials-$vault.json"
done
```

`sandboxes.json` has each sandbox's id, kind, labels and spec; the credential files have each
credential's name, type and binding (URL, hosts, header), never its value. A pod sandbox's files
go with its volume: push or copy out what you need first.

## What changes

| Protocol 10 | Protocol 11 |
| --- | --- |
| `PUT /v1/sandboxes/{id}` (create or find, spec fixed) | `PUT /v1/environments/{id}`: create, find or change. `kind` and `storage` are fixed; a change of image, resources, network, harness or lifecycle bumps `version` |
| `GET /v1/sandboxes`, `/{id}`, `/{id}/events`, `POST .../stop`, `.../reset`, `DELETE` | The same under `/v1/environments`; `DELETE` also deletes the vault |
| `network.allow` | `network.allowedHosts`, which applies within seconds |
| `image`, `resources` fixed | Change them: a pod gets them when it next starts from stopped (`appliedVersion` says what runs) |
| `lifecycle.ttl` (from creation), Tenant `limits.ttl`, `lifecycle.onExpiry`, `sandbox_expired` | `lifecycle.deleteAfter`: deletes an Environment unused that long (no turn, change, secret write, stop or reset). `lifecycle.idle` per Environment, at most the Tenant's |
| — | Kind `none`: a vault and no compute, for agents with remote MCP servers and HTTP tools only |
| — | `ownerUserId`: the owner guard. Only that owner's sessions may name the Environment |
| Vaults under `/v1/tenant/vaults` (Management API): user vaults, installation vaults, credentials by id, rotate | One vault per Environment, written on the Runtime API: `PUT /v1/environments/{id}/secrets/{name}` creates or replaces, `GET .../secrets` lists names, types and bindings, `DELETE .../secrets/{name}`. No value is ever read back |
| `CreateCredentialRequest` `{ name, auth: { type, ... } }` | `PutEnvironmentSecretRequest`: `{ type: "environment_secret", value, allowedHosts, inject? }`, `{ type: "environment_variable", value }` (the name is the variable), `{ type: "bearer", url, value, via?, identity? }`, `{ type: "headers", url, headers, via?, identity? }` (the name is a label) |
| `409 credential_conflict` at session open | At the secret write: a second `environment_secret` for a host, or a second `bearer`/`headers` credential for a URL |
| `PutSessionRequest.sandbox` (`false`, `{ id }`, `{ session }`, inline; omitted = Tenant default), `vaultIds`, `credentialSelections` | `environment: "<id>"`, or nothing: no sandbox and no credentials. The removed fields are a `400` |
| `SessionView.vaultIds`, `credentialSelections`, `sandboxOwnerId`, `sandboxId`, `sandbox`, `sandboxSource` | `SessionView.environment: { id, version } \| null`, and `closedReason` on a closed session |
| Tenant setting `sandbox.config`: `default`, `limits.sandboxes`, `limits.ttl`, `lifecycle.onExpiry` | `environments.config` (still `PUT /v1/tenant/sandbox`): `limits.environments`; the other three are gone |
| `POST /v1/tenant/credential-coverage { agentId, ownerUserId?, vaultIds?, credentialSelections? }` | `{ agentId, environmentId }`; each entry is `covered` or `missing` |
| `POST /v1/tenant/mcp/preview { url, vaultId? }` | `{ url, environmentId? }` |
| Error codes `sandbox_busy`, `sandbox_unavailable`, `sandbox_lost`, `sandbox_not_granted`, `sandbox_expired` | `environment_busy`, `environment_unavailable`, `environment_lost`, `environment_not_granted`; new `environment_owner_mismatch` and `session_closed` |
| Session events `sandbox.state`, `sandbox.exec`, `sandbox.attached` | `environment.state`, `environment.exec`, `environment.attached` (also the Harness API's claims) |
| Lifecycle stream `nylorun.sandbox-event/1` (`sandbox.*`, `sandboxId`) | `nylorun.environment-event/1` (`environment.*`, `environmentId`); no `expired` |
| Scope `sandboxes:write`; identity file `sandboxes: [...]` grants; `/v1/me` `sandboxes` | `environments:write`; `environments: [...]`; `/v1/me` `environments`. The old spellings are refused, with a message naming the new one |
| `@nylorun/agents` `client.sandboxes.ensure`, `forSession`; `createSession({ sandbox, vaultIds })` | `client.environments.put`, `.secrets.put`, `.forSession`; `createSession({ environment })` |
| `@nylorun/admin` `admin.vaults.*`, `admin.vaults.coverage` | `admin.coverage({ agentId, environmentId })` |
| Reset scope `sandboxes` | `environments` |

## Recreate what you need

One Environment per person, with their keys, as an app server does it:

```ts
import { createClient } from "@nylorun/agents";

const client = await createClient();
await client.environments.put("users/alice/web", {
  kind: "pod",
  image: "node:22-bookworm",
  network: { allowedHosts: ["github.com", "api.github.com", "registry.npmjs.org"] },
  ownerUserId: "alice",
  lifecycle: { deleteAfter: "30d" },
});
await client.environments.secrets.put("users/alice/web", "GH_TOKEN", {
  type: "environment_secret",
  value: process.env.ALICE_GITHUB_TOKEN!,
  allowedHosts: ["github.com", "api.github.com"],
  inject: { header: "Authorization", format: "Basic {base64:x-access-token:{value}}" },
});
await client.environments.secrets.put("users/alice/web", "linear", {
  type: "bearer",
  url: "https://mcp.linear.app/mcp",
  value: process.env.ALICE_LINEAR_KEY!,
});
const session = await client.createSession({
  agentId: "coder",
  ownerUserId: "alice",
  environment: "users/alice/web",
});
```

Where each old shape goes:

- **An installation vault** every session attached: write its credentials into each Environment
  that needs them. A key many Environments share is written into each; shared references are a
  later addition, if asked for.
- **A user vault**: the person's own Environment (`users/<person>/<name>`) with `ownerUserId` set
  to them. A token caller's grants (`environments: ["users/{sub}/*"]`) keep each person to theirs.
- **The Tenant's default sandbox**: create the Environment and name it on every session. A default
  is a mapping, so it is the app's.
- **An inline sandbox, or a sandbox shared with `{ session }`**: `client.environments.forSession()`
  gives a session an Environment of its own and deletes it on `release()`; two sessions share one
  by naming the same id.
- **A sandbox resource**: an Environment with the same id, `network.allow` renamed
  `network.allowedHosts`, and `lifecycle.ttl` replaced by `lifecycle.deleteAfter`.
- **An MCP-only agent**: a `kind: "none"` Environment holds its keys.

## Operators

- **Identity files**: rename each issuer's `sandboxes:` grants to `environments:` and
  `sandboxes:write` in `allowedScopes` (and in your identity provider's scope mappings) to
  `environments:write`, in the same window as the upgrade. The Runtime refuses to start with the
  old names, and a token whose only write scope is `sandboxes:write` is `403 insufficient_scope`.
- **Pods**: the Runtime no longer knows the pods of the sandboxes it dropped. Delete them from
  the Tenant's namespace once the new release runs, for example
  `kubectl delete sandboxes.agents.x-k8s.io --all -n <namespace>` (their volumes go with them).
- **Studio**: the Sandboxes view is now Environments, with a create form, stop, reset and delete,
  and the Credentials forms write an Environment's secrets. New session picks an Environment
  instead of vaults.
- A virtual Environment's recipe applies to the sessions opened after a change; a pod's image and
  resources at its next start from stopped, its network within seconds.

# `nylo` ships in `nylorun`; `@nylorun/cli` is deprecated

The Runtime client, `nylo`, moved into the `nylorun` package as its second command. One package
now runs a project's local Tenant (`nylorun`) and talks to the linked installation (`nylo`). The
commands, their flags, output and exit codes are unchanged; only the messages that named
`@nylorun/cli`, "the CLI" or "the nylorun package" now name `nylo` and nylorun. `@nylorun/cli`
stays as a forwarder: its `nylo` prints one line on stderr and runs nylorun's, so
`npx @nylorun/cli status` and `eval "$(npx @nylorun/cli env)"` keep working (stdout carries only
the export lines). nylorun 0.18 removes it.

| Before | Now |
| --- | --- |
| `npx @nylorun/cli <command>` | `npx -p nylorun nylo <command>`, or `npx nylo <command>` in a project with `nylorun` as a devDependency |
| `eval "$(npx @nylorun/cli env)"` | `eval "$(npx -p nylorun nylo env)"` |
| `@nylorun/cli` as a devDependency (for `nylo` in npm scripts) | `nylorun` as a devDependency; remove `@nylorun/cli` |
| `nylorun configure`, `nylorun status --env`, `nylorun doctor sandbox` naming `npx @nylorun/cli …` | They exit 2 as before, naming `npx -p nylorun nylo configure`, `… env` and `… doctor sandbox` |
| `@nylorun/admin/project` (a re-export of `@nylorun/core/project`) | Removed: import `@nylorun/core/project` |
| `@nylorun/cli` in `cli/create-agent/compatibility.json` | Removed: the creator pins Core, Harness, Agents, Admin and Runtime |

Outside a project that installs `nylorun`, `npx nylo` looks for an npm package named `nylo`, which
is not Nylorun's: use `npx -p nylorun nylo`.

`nylorun status|reset` and `nylo status|reset` keep their meanings, which differ:

- `nylorun status` reports the local Tenant from this machine: its containers, endpoints, Runtime
  health and state, also when the Tenant is stopped or not open. `nylo status` asks the linked
  installation, local or remote, through the Management API: the open Tenant's checks, counts and
  sandbox backend.
- `nylorun reset` deletes all the local Tenant's data (volumes, `tenant/` and the vault key); the
  next start creates it anew. `nylo reset` clears the Tenant's sessions, sandboxes or all its data
  (`--all`) through the Management API, and keeps the Tenant, its keys and the Project link.

`nylo configure` signs in to a model provider with `@earendil-works/pi-ai`, about 100 MB with its
provider SDKs. `nylorun` does not depend on it, so `npx nylorun` stays small: the first
`nylo configure` installs the tested version into `~/.nylorun/lib/pi-ai-<version>/` with npm,
without install scripts, unless it resolves beside nylorun. Studio's model settings and `.env` at
`nylorun start` need no install. `nylorun` now depends on `@nylorun/admin` (about 150 kB) for
`nylo`; the `nylorun` command loads neither.

# Credentials for skills: two new vault credential kinds

Vault credentials gain `environment_secret` and `environment_variable` (R2c), for skills whose
CLIs run in pod sandboxes. Nothing you use changes: existing credentials, routes and the protocol
(10) are as they were. Two things are new to a client:

- `CredentialInfo.type` can be `environment_secret` or `environment_variable`, and
  `CredentialInfo.binding.url` is absent for them (their binding has `secretName`,
  `allowedHosts` and `inject`, or `variableName` and `variableValue`). A client that reads
  `binding.url` for every credential, or parses `type` as `bearer | headers` only, must allow
  these.
- `PUT /v1/sessions/{id}` can answer `409` with code `credential_conflict` when the attached
  vaults set one variable twice, bind one host twice, or the sandbox would serve two owners'
  secrets.

The pod engine's join answer also carries the egress CA certificate (`caCertificate`); an image
whose engine is older ignores it. See "Credentials for skills" in
[DEPLOYMENT.md](./DEPLOYMENT.md#credentials-for-skills).

# The harness has no provider adapters: `@nylorun/harness/model/adapters` is removed

The harness makes no model call. Each step builds the provider-neutral `ModelCall` and reads
back a `ModelCandidate` (`@nylorun/core/define`); the Runtime's Model Gate makes the provider
call. The OpenAI Chat Completions, OpenAI Responses and Anthropic Messages translators that
`@nylorun/harness` still shipped, which the Runtime never used, are removed with their subpath.
Nothing changes on the wire, in a manifest or in a checkpoint, and an agent the Runtime runs is
unaffected.

| Removed (`@nylorun/harness`) | Now |
| --- | --- |
| The `./model/adapters` subpath | Not exported (`ERR_PACKAGE_PATH_NOT_EXPORTED`) |
| `toChatCompletions`, `fromChatCompletions`, `chatCompletionsAdapter` and the `ChatCompletions*` types | Removed |
| `toResponses`, `fromResponses`, `responsesAdapter` and the `Responses*` types | Removed |
| `toMessages`, `fromMessages`, `anthropicAdapter`, `AnthropicAdapterOptions` and the `Messages*` types | Removed |
| `preparedModel`, `AdapterSend`, and `PreparedModelOptions` (also from the package root) | Call `context.reportPreparedCall({ adapter, call })` in your adapter |

A host that runs the engine in process (`run` from `@nylorun/harness/run`) passes `onModelCall`,
a `ModelAdapter`: use the Runtime's `piModel` (`@nylorun/runtime/node`), or map the `ModelCall` to
your provider in your own code. To publish the provider request as the `model.prepared`
observation, call `context.reportPreparedCall({ adapter, call })` once per call with a JSON-safe
`call`, which is all `preparedModel()` did.

# MCP credentials from vaults only (protocol 10)

Nylorun no longer holds an OAuth client for MCP servers and no longer asks a credential
resolver. A session's MCP servers and HTTP tools get their credentials from the vaults attached
to the session, and nowhere else. The same release adds the rest of a complete MCP client: header
map and gateway credentials, tool names every model accepts, coded tool errors, results that fit,
per-tool settings, deferred tools and a preview of a server's tools. Clients and SDKs of this
release send `Nylorun-Protocol: 10`; the Runtime still serves protocol 4 to 9 clients on every
route that remains.

The sections below go in order: what is removed, how to move your credentials, the new credential
kinds, then the changes to tool names, errors, results, per-tool settings (manifest v6), deferred
tools and previews. The operator's guide to all of it, with gateway recipes, is "MCP servers and
HTTP tools" in [DEPLOYMENT.md](./DEPLOYMENT.md#mcp-servers-and-http-tools).

## What is removed

| Removed | Now |
| --- | --- |
| `POST /v1/tenant/vaults/{vaultId}/oauth/start`, `admin.vaults.startOAuth(…)` | `404`; no replacement in the Runtime |
| `GET /v1/oauth/callback` | `404`. Remove its rule from your reverse proxy |
| `nylorun mcp connect` | Removed; it says how to add a key instead. `nylorun mcp inspect <url>` lists a server's tools (see "Previewing a server's tools") |
| The vault credential type `oauth` (`auth: { type: "oauth", accessToken, expiresAt?, refresh? }` on create and rotate), and the gateway's refresh of it | A credential is a `bearer` token or a `headers` map bound to a URL. A create or rotate with `type: "oauth"` is `400` |
| `CredentialInfo.expiresAt`, and `oauth` in `CredentialInfo.type` | Gone from the type and the answers |
| `StartOAuthRequest`, `StartOAuthResponse` (`@nylorun/core`) | Removed |
| The error codes `oauth_client_required`, `oauth_state_invalid`, `oauth_failed` | Removed from `ERROR_CODES` |
| The credential resolver: `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` on the gateway | Ignored. The Runtime logs `resolver_removed` naming the variables, and starts |
| In process: `TenantConfig.resolver`, `startEphemeralRuntime({ resolver })`, the `ResolverConfig` type, `TenantConfig.publicUrl`, `TenantConfig.vaultFetch`, `VaultService`'s `fetch` option | Removed |

`NYLORUN_PUBLIC_URL` stays: it is the `resource` of the protected resource metadata.

## Existing `oauth` credentials are deleted

On its first start the Runtime applies migration `0016_mcp_oauth_removed`. It drops the table of
pending OAuth connects and deletes every vault credential of type `oauth`, writing one audit row
for each (actor `migration`, action `delete`, target the credential's URL). Then it logs one
`oauth_credential_removed` warning per deleted credential, with its vault id, credential id and
URL. The rows cannot be converted: the secret's encryption is bound to its type.

A session that attached a vault holding one of them now calls that server with no credential,
until you add one. Before you upgrade, list each vault's credentials
(`admin.vaults.credentials.list(vaultId)`) and note those of type `oauth`. After it, for each
server:

- if the server takes an API key or a long-lived token, add it as a `bearer` credential bound to
  the same URL (`admin.vaults.credentials.create(vaultId, { name, auth: { type: "bearer", url,
  token } })`), or as a `headers` credential when it takes another header (see "Header and
  gateway credentials" below);
- otherwise, reach the server through a gateway that holds the OAuth sign-in, with a credential
  for the same URL that has `via` and an identity header: see "Reaching a person's accounts" in
  [DEPLOYMENT.md](./DEPLOYMENT.md#reaching-a-persons-accounts).

## A person's credentials move to their vault

The gateway no longer asks your resolver for a person's credential when the session's vaults
hold none. Move what your resolver served:

- **Static keys** (a person's API key or personal access token): create that person's vault with
  a management key (`admin.vaults.create({ name, ownerUserId })`, or `POST /v1/tenant/vaults`
  with `ownerUserId`), add each key as a `bearer` (or `headers`) credential bound to the server's
  URL, and pass the vault's id in `vaultIds` when you open that person's sessions. Unlike the resolver, which
  was asked for every person's session, a vault is used only by the sessions that attach it.
- **OAuth sign-ins** (a person's GitHub or Google account): Nylorun does not refresh them. Reach
  those servers through a gateway that holds each person's sign-in: one credential in an
  installation vault with the gateway's key, `via` and an identity header, which carries the
  session owner. See "Reaching a person's accounts" in
  [DEPLOYMENT.md](./DEPLOYMENT.md#reaching-a-persons-accounts), with recipes for several gateways.

Then remove `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` from the gateway's environment
(and from the shell that runs `nylorun start`), and retire the resolver.

## Header and gateway credentials

These are new, and need no change to existing credentials. Each applies to remote MCP servers and
HTTP tools alike, in an installation vault or a person's user vault.

- **A header map.** `auth: { type: "headers", url, headers: { "DD-API-KEY": "…",
  "DD-APPLICATION-KEY": "…" } }` sends every header in the map, for servers that take an
  `x-api-key`, several keys, or a scheme other than `Bearer`. The values are sealed like a token;
  `CredentialInfo` lists the names only (`headerNames`, lower case). A rotation replaces the whole
  map. The MCP transport's headers (`Content-Type`, `Accept`, `Mcp-Session-Id`, …),
  `Idempotency-Key` and `Nylorun-*` are refused (`400`). A credential header replaces a manifest
  header of the same name.
- **`via`, a gateway.** With `via` on a `bearer` or `headers` credential, the server's requests
  go to that URL instead of the one the manifest names. The credential is still chosen by the
  manifest's URL, and tool names and diagnostics keep the manifest's server name, so moving a
  server from a key to a gateway changes no manifest. `via` is an `https` URL (`http` only to a
  loopback host) with no userinfo, query string or fragment, and the Host's address policy applies
  to it.
- **An identity header.** `identity: { header: "X-User-Id" }` adds the session owner's subject
  (`ownerUserId`, from the session record) in that header, for a gateway that keeps each person's
  accounts. A session owned by `installation` sends none.
- A rotation keeps `via` and `identity` unless it gives them; `null` removes one.
- A `401` from the server, or from the gateway, is `credential_rejected` (see "Tool errors the
  model sees").

## Tool and MCP server names

`PUT /v1/agents/{id}`, which `saveAgent` calls, refuses a definition whose declared tool (HTTP
tools included) or MCP server is named with anything but letters, digits, `_` and `-`, or with
more than 64 characters (`400`, naming it): the rule agent tools already follow, and what every
model provider accepts in a tool name. Rename such a tool or server and register the agent again. A
session opened before the upgrade keeps its pinned tools.

An MCP server's own tool names need no change. The model knows a tool as `server__tool` with every
other character replaced by `_`; one over 64 characters keeps 55 and gets `_` and 8 hex characters
of a hash, as does one whose new name collides. The server is still called by its own name, and
`mcp.discovered` lists each renamed tool (`renamed: [{ serverToolName, name }]`).

## Tool errors the model sees

**A `401` is `credential_rejected`.** When an MCP server or HTTP tool answers `401`, the model
sees a failed tool call with code `credential_rejected` (new in `ERROR_CODES`), and it is not
retried. Before, an MCP tool call left the call `uncertain` and an HTTP tool gave
`http.status`. The `tool.completed` event's `error` names the `server` (the MCP server or the
HTTP tool's `credential`) and the `vault` scope (`installation` or `user`) whose credential was
sent; never a value.

A remote MCP tool call that fails otherwise now gives the model a failed tool result with a code,
where before the call was left `uncertain` for an operator: `mcp.unreachable` (never sent;
`retryable: true`), `mcp.forbidden` (`403`), `mcp.error` (a JSON-RPC error, its code in the
message) and `mcp.status` (another HTTP error status). A call sent whose answer was lost is
`mcp.lost` to the model for a tool the server marks `readOnlyHint` or `idempotentHint`; any
other stays `uncertain`, as does a call lost with a gateway restart. `tool.completed`'s `error`
carries the code and `retryable`. When a server has ended the connection's session (`404` to its `Mcp-Session-Id`),
or a credential's `via` has moved, the Runtime opens the connection again and sends the call once
more, since the tool never saw it.

Credential values a server echoes back (a vault token or header value of at least 8 characters,
and the token of a `Bearer` value) are replaced with `[redacted]` in MCP and HTTP tool results
and errors, before the model, an event or the gateway's record sees them. `tool.completed` gains
`redacted`, the number replaced. Other fields, such as a `nextToken`, are left as they are.

## Tool results that fit

An agent's remote MCP and HTTP tool results can change shape in `tool.completed`'s `output`, and
in what the model sees, when they are large or hold files. Nothing changes for a text or JSON
result of at most 32 KiB.

- **Larger than 32 KiB** (as JSON): the Runtime stores the result as a file artifact of the
  session and records `{ truncated: true, artifactId, version, contentType, size, preview }`,
  `preview` being its first 4 KiB and last 1 KiB. Download the whole result from
  `/v1/artifacts/{artifactId}/versions/1/content`. A structured result stored this way is not
  checked against the tool's output schema.
- **Images, audio and blob resources** in an MCP result: each becomes a file artifact, and its
  part says `{ type, artifactId, version, contentType, size }` (a resource keeps its `uri`).
  Before, an image was dropped when the result had text, and sent as base64 when it had none; now
  every part stays. A model that reads images also sees the image; one that does not gets a note.
- **Mixed MCP results** keep each part: a part too large is stored alone, the largest text first.
  A `resource_link` stays a link.
- **Past 8 MiB**: an MCP answer is the failed result `mcp.too-large`, as an HTTP tool's answer
  already was `http.too-large`.
- When an artifact cannot be stored (your `/v1/tenant/artifacts` limits are reached), the preview
  stays and `dropped` says why the rest is gone.
- **Many results in one step** share 256 KiB: the results of one model step are one transcript
  entry. Once the step's other results have taken it, a result past 1 KiB is stored and recorded
  as a stub naming its artifact, with less preview or none.

These artifacts are the session's, `source: "engine"`, with `artifact.created` carrying the turn
and the tool call, so they appear in `GET /v1/artifacts?sessionId=…` and count toward the
Tenant's artifact limits. The model reads one with the new built-in tool `read_artifact`
(`{ artifactId, offset?, length? }`, up to 32 KiB a call), which a session gets for each agent with
an MCP server or an HTTP tool, with or without a sandbox. Such a session's pinned manifest now has
`read_artifact` added, as a sandbox session's has its tools, so its `manifestHash` differs from
the definition's. To tell whether a session runs the registered definition, compare the session
view's new `definitionHash` (the definition it was opened from; absent on sessions opened
before) with the definition's `manifestHash`, as Studio now does. An agent that declares its own tool named `read_artifact` keeps it and sees
previews only. A session opened before the upgrade gets previews, but no `read_artifact`.

## Per-tool settings and manifest v6

An MCP server may now set its tools one by one. `tools` maps the server's own tool names (as its
docs show them, before the `server__tool` renaming) to `{ enabled?, approval?, deferred? }`, with
`"*"` for every tool without an entry; `deferred` on the server sets every tool's deferral (see
below). Each setting resolves from the tool's entry, then `"*"`, then the server, then the
default: enabled, approval `never`, deferral automatic.

```ts
Agent({ id: "triage" }).mcp({
  github: {
    type: "streamable-http",
    url: "https://api.githubcopilot.com/mcp/",
    tools: {
      "*": { enabled: false }, // an allowlist: only the tools below
      search_issues: { enabled: true },
      create_issue: { enabled: true, approval: "always" },
    },
  },
});
```

A disabled tool never reaches the model and is never called. A key that names no tool the server
lists is not an error, since servers change their lists: `mcp.discovered` names it in the server's
`unknownTools` (and its `message`), and counts the tools the settings disabled in `disabled`.

These fields are manifest **v6**. The Runtime accepts v5 manifests unchanged, and the builder
writes v6 only for an agent that sets `tools` or `deferred`, so every other manifest, and its hash,
stays as it was. A v5 manifest that sets them is refused, naming the version they need; an older
Runtime refuses a v6 manifest (`Unsupported manifestSchemaVersion 6`).

A turn's `message.manifest` may now change an MCP server's `tools`, but only to tighten them: set
`enabled: false` or `approval: "always"` on a tool or on `"*"`. A variant that enables a tool,
lifts an approval, drops an entry or changes `deferred` is refused, as before
(`Turn manifest is not a variant of the session's pinned manifest`). It may be v6 for a v5 pin.

## Deferred tools

When an agent's MCP tools would take more than a tenth of the model's context window (their names,
descriptions and input schemas as JSON, at 4 characters a token), the Runtime takes them out of
the model's tool list. The model gets two tools instead, and a short note naming each server, how
many of its tools are deferred, and the server's own instructions (cut to 2,000 characters):

- `tool_search { query, limit? }` finds deferred tools by words of their names and descriptions
  (BM25, 8 by default, at most 20) and returns each one's `name`, `description` and
  `inputSchema`;
- `tool_call { name, arguments? }` runs one. Arguments that do not match its `inputSchema` come
  back as a failed result (`tool.invalid-arguments`), and nothing runs. Otherwise the call is the
  tool's own: it waits for approval when the tool needs it, its effect and `tool.completed` name
  the tool (not `tool_call`), and its errors, scrubbing and stored results are a direct call's.

The context window is the Tenant's model's (`GET /v1/tenant/model`: the custom endpoint's
`contextWindow`, else the provider catalog's; 32,768 tokens when unknown). `deferred: true` or
`false` on a tool, on `"*"` or on the server overrides the size rule. The decision is made once,
when a session first readies its MCP servers, and kept for the session's life, so the tool list in
every model call of a session is the same and the provider's prompt cache holds; `mcp.discovered`
counts each server's deferred tools in `deferred`.

A session of an agent with a remote MCP server now pins a `nylorun.tools` capability, empty in
the manifest (the two tools come with the session's discovered tools), so its `manifestHash`
differs from the definition's, as with `read_artifact`; `definitionHash` names the definition.
An agent that declares a tool named `tool_search` or `tool_call` gets no such capability and keeps
every MCP tool in its list, as does a session opened before the upgrade, or a turn whose variant
drops the capability.

## Previewing a server's tools

`POST /v1/tenant/mcp/preview` (the Management API: a management key, or Studio's) shows what a
remote MCP server offers before an agent names it. It is new; nothing changes for existing
clients.

```json
{ "url": "https://mcp.linear.app/mcp", "type": "streamable-http", "name": "linear", "vaultId": "…" }
```

Only `url` is required. `type` defaults to `streamable-http`; `name` is the server name the model
names are made with (default: the URL host's name before its top-level domain, without a leading
`mcp`, `www` or `api`: `linear` for `mcp.linear.app`); `vaultId` picks the installation vault whose
credential is sent (default: every installation vault, and `409` when two hold one for the URL).
The keys service connects with that credential (its headers and its `via`; never an identity
header, since no person asked), under the Host's address policy, lists the tools within 15 s,
closes the connection, and calls no tool. The answer:

- `serverInfo`, `instructions`, `credentialSent`, and `tools`: each with `serverToolName`,
  `modelName` (what the model would call it; absent for a tool the Runtime leaves out),
  `description`, `annotations` and `schemaBytes`, the size of its input schema;
- `renamed`: the tools whose model name is not `server__tool`;
- `authRequired` instead of tools, still `200`, when the server answered `401`: its RFC 9728
  protected-resource metadata (`resourceMetadata`, from the challenge's `resource_metadata`, else
  the well-known path), so you know it needs a person's sign-in: reach it through a gateway, or
  with a key.

A server that cannot be listed is `502 mcp_preview_failed`, a new error code, with
`details.failure` the code a tool call would have had (`mcp.unreachable` for an address the Host
refuses, a failed connection or 15 s of silence). No credential value is in any answer.

`admin.mcp.preview({ url, … })` (`@nylorun/admin`) calls it, `nylorun mcp inspect <url> [--server
<name>] [--vault <id>] [--sse] [--json]` prints it for the running local Tenant, and Studio's
Credentials page has **Preview tools** on each credential.

# The Runtime API as an OAuth resource server (protocol 9)

The Runtime API now behaves as an OAuth 2.1 resource server for your identity provider's
tokens. Nylorun is still never the authorization server: it signs no one in and mints no
person's token. This release changes how refused credentials are answered, publishes where
tokens come from, and simplifies the identity file. Clients and SDKs of this release send
`Nylorun-Protocol: 9`; the Runtime still serves protocol 4 to 8 clients, but answers them the
new way too.

## A refused credential is `401`, not the opaque `404`

| Request | Before | Now |
| --- | --- | --- |
| No `Authorization` header | `404 not_found` | `401 credential_required`, `WWW-Authenticate: Bearer resource_metadata="…"` |
| A key the Tenant does not know (rotated, deleted, another Tenant's, the admin key) | `404 not_found` | `401 credential_invalid`, `WWW-Authenticate: Bearer error="invalid_token", …` |
| A token no trusted issuer signed, or one that fails a check | `404 not_found` | `401 credential_invalid` |
| An expired token | `401 token_expired` | The same, with `error_description` and `resource_metadata` in the challenge |
| A token without the route's scope | `403 scope_required` | The same, with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` |
| A request with neither `Nylorun-Protocol` nor `Authorization` on an API route | `426` | `401 credential_required` |

The reason a credential was refused stays in the runtime's log (`credential rejected`). A
Tenant id that is not this installation's, a Tenant that could not be opened and a capability
link the Runtime did not sign are still the opaque `404`. On the Management API the challenge
is a bare `Bearer`: it takes management keys only.

What to change:

- Code that treated a `404` as "bad key" should look for `401` and the codes
  `credential_required` and `credential_invalid` (both in `ERROR_CODES`). In `@nylorun/agents`
  they are a `RuntimeError` with `status` 401 and the code in `body.code`; in `@nylorun/admin`
  an `AdminError` with that `code`.
- A browser app that refreshes its token on `401` can now rely on it for every refused token,
  not only an expired one.
- If your reverse proxy rewrites `401` or strips `WWW-Authenticate`, stop: clients need both.
  Expose `WWW-Authenticate` in your CORS answer (DEPLOYMENT.md already lists it).

## Protected resource metadata

With an identity file, `GET /.well-known/oauth-protected-resource` (RFC 9728) answers the
resource (`NYLORUN_PUBLIC_URL`, else the request's origin), the trusted issuers in the file's
order, and their scopes. It needs no key or `Nylorun-Protocol`. Forward it at your reverse
proxy beside `/health`, `/ready` and `/v1/*`, and set `NYLORUN_PUBLIC_URL` so `resource` is
the URL your clients use. Without an identity file it is a `404`.

## The identity file

- `maxLifetime` is removed. How long a token lives is your identity provider's setting; the
  Runtime checks `exp` only, and no longer requires `iat` (one in the future is still refused).
  A file that still has `maxLifetime` boots: the key is ignored and logged.
- Any key the file does not define is ignored with a warning (`identity_file_key_ignored` in
  the runtime's log) instead of stopping the boot. Check the log after editing the file: a
  misspelled optional field such as `agent:` is ignored, not refused.
- `subject`, `scopes` and `allowedScopes` are optional:

  | Field | Default |
  | --- | --- |
  | `subject` | `"{sub}"` |
  | `scopes` | `{ claim: scope }`, OAuth's standard claim |
  | `allowedScopes` | `[agents:read, sessions:own, sandboxes:write]`; list `studio` to grant it |

  A file that sets them keeps working unchanged. If you leave `subject` out, note that the
  default is the bare `sub`: a file that used `u:{sub}` must keep it, or every person's
  sessions get a new owner.
- Set `audience` to the Runtime's public URL where your provider allows it: that is the
  RFC 8707 `resource` an OAuth client asks for.

# Manifest-only agents (protocol 8, manifest v5)

The Runtime now runs an agent from its manifest alone: during a session it never calls your
code. This release removes what used to run your code mid-session, Action endpoints included;
it ships in the same protocol 8 beta as the Runtime and Management APIs. Manifests are
`manifestSchemaVersion: 5`. A Runtime of this release refuses a v4 manifest with a message that
names what changed, and a session pinned to a v4 manifest cannot take another turn: rebuild and
save your agents with this SDK, then start new sessions.

## Hooks are removed

`.beforeTurn()`, `.beforeModel()`, `.afterModel()` and `.afterTurn()` (with the deprecated
`.before()` and `.after()`), a capability's `before` and `after`, the manifest's
`capabilities[].hooks`, the `hook` Action and the `Patch`, `Decision` and `TurnDecision` types are
gone. A manifest or capability that still names them is refused with
`hooks were removed: …`. Each use has a replacement that needs no code of yours mid-turn:

| Hook use                                            | Instead                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Add instructions for a turn (`beforeTurn`)          | `.instructions()`, or send the message with a turn manifest that changes them |
| Hide tools or capabilities for a turn               | A turn manifest that leaves them out (a variant may remove tools)            |
| Deny or approve a proposed tool call (`afterModel`) | `approval` on the tool                                                       |
| Check or redo the final answer (`afterTurn`)        | An output schema, or a flow `loop` with a verifier agent                     |
| Write session state                                 | Your service keeps it, keyed by `Nylorun-Session-Id` (an HTTP tool)          |
| A policy over every model call                      | Bring your own harness (Harness API)                                         |

Studio's Agent Manifest tab no longer shows hooks or the turn lifecycle. The engine version is
`hosted-4`.

## Remote MCP servers only

Nylorun accepts remote MCP servers only: `streamable-http` and `sse`, declared by URL and reached
through the Runtime's gates with an optional vault credential. A `stdio` server is refused
wherever it is declared: `.mcp({...})`, a plugin's `mcp.json` (`.plugin()` and `plugin()` throw
`PluginError` with code `plugin.mcp-stdio`), and `PUT /v1/agents/:id` (`400`):

```text
MCP server 'local' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL.
```

What to do: run the server behind an HTTP transport (several open gateways wrap a stdio server as
streamable HTTP) and declare its URL instead of its command:

```ts
// Before
Agent({ id: "assistant" }).mcp({ files: { type: "stdio", command: "npx", args: ["files-mcp"] } });

// After
Agent({ id: "assistant" }).mcp({ files: { type: "streamable-http", url: "https://mcp.example.com/files" } });
```

Also gone with stdio: `pluginRoots` in `PUT /v1/agents/:id` (the strict schema now refuses it),
`prepareStdioLaunch`, `expandPluginPlaceholders` and `StdioLaunch` from `@nylorun/agents`,
`tenantChildEnvironment` and `startEphemeralRuntime({ baseline })` from `@nylorun/runtime`, and
the local stack's `plugins/` mount and the harness's `plugin-data/`, `home/` and `tmp/` mounts. A
plugin's skills work as before.

## HTTP tools replace code tools

A code tool (`tool({ run })`) used to run in your process, delivered to your Action endpoint.
Action endpoints are removed ([below](#action-endpoints-are-removed)), so the Runtime refuses
a definition with a code tool. Move each one to an **HTTP tool**: the Runtime makes one request
to your service per call, through its Tool Gate, or serve it from a remote MCP server.

```ts
// Before: a code tool, run by your Action endpoint
const refundOrder = tool({
  name: "refund_order",
  input: z.object({ orderId: z.string(), amount: z.number() }),
  approval: () => true,
  run: async (input) => billing.refund(input),
});

// After: an HTTP tool; your service serves POST /refunds
const refundOrder = http({
  name: "refund_order",
  input: z.object({ orderId: z.string(), amount: z.number() }),
  url: "https://billing.example.com/refunds",
  credential: "billing", // a vault credential bound to the URL, instead of a secret in your code
  approval: "always",
});
```

Your service receives the model's input as the JSON body, with `Nylorun-Session-Id`,
`Nylorun-Turn-Id`, `Nylorun-Agent-Id` and an `Idempotency-Key` that stays the same when the
call is re-sent; it answers JSON (checked against `output`) or text, and any other status is a
tool error the model sees. What does not carry over:

- `approval` is static (`"never"` or `"always"`), not a function of the input.
- `ctx.state`, `ctx.ask`, `ctx.approve`, `ctx.sleep`, `ctx.waitFor`, `ctx.step` and progress
  events have no HTTP form; keep that logic in your service or in the agent's instructions.
- A code tool used as a flow stage becomes an HTTP stage the same way: put the `http()` tool in
  `.pipe()` (see [Flows run no code](#flows-run-no-code)). Its input is the previous stage's
  output, and `approval` is not supported on a flow stage yet.
- The methods are `POST` (default), `PUT` and `PATCH`; the input is always the body.

See [sdks/agents/README.md](../sdks/agents/README.md#http-tools).

## Skills are files the Runtime serves

A skill is now every file of its folder, uploaded once and served by the Runtime: no skill call
reaches your process. The manifest's `skills.<name>` gains `files`, each path of the folder
(`SKILL.md` required) mapped to `sha256:<hex>`; the build hashes them, binary files included.

- **Nothing to change** if you load skills with `.skills(folder)`, `skills(folder)` or
  `.plugin(folder)` and register with `saveAgent`: it uploads the files the Runtime lacks
  (`client.files`) before the definition.
- **`PUT /v1/agents/{id}` by hand** must upload each file first with
  `PUT /v1/files/sha256:<hex>` (application key, the raw bytes, at most 2 GiB; `HEAD` says
  whether the Runtime holds it). A definition naming a file the Runtime lacks is
  `400 definition_files_missing`, with the hashes in `details.missing`.
- **`skillRecords` is gone** from capability declarations (and `SkillRecord` from
  `@nylorun/core/define`): declare `skills` with `files`, and `skillFiles` for the bytes to upload.
- **`load_skill` and `read_skill_resource` run only on the Runtime.** In a local run without one
  they fail with `skills.runtime-only`. `read_skill_resource` refuses a binary file; with a
  sandbox the model finds it under `/skills/<name>/`.
- A top-level `functions` key in a manifest is reserved: it is refused for now.

## Flows run no code

Flow agents compile to workflow manifest v3 (`workflowSchemaVersion: 3`) on the `flow-3`
engine. A flow is data: stage `input` functions, `switch` `on`, loop `verify` functions and
`decide` are gone, and so are the `fn` and `verify` Actions they were delivered as. A v1 or v2
workflow manifest is refused with `workflowSchemaVersion 2 is no longer supported: …`, and a
builder option that names a function is refused with what replaces it. The first stage gets the
flow's input and every later stage the previous stage's output, so each agent returns what the
next stage needs through its `.output()` schema. An agent after the first stage also sees the
flow's input as the original request.

| Before                                                                           | Instead                                                                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `{ input: ({ input, results, flowInput }) => … }` on a stage                     | The previous agent's output schema returns what the next stage takes                                      |
| `.switch(cases, { on: ({ input }) => input.kind })`                              | `.switch(cases)`: the previous output is the case name, or has a `route` field                            |
| `.map(each, { input: ({ input }) => input.tasks })`                              | `.map(each)` over an array output, or an output with an `items` array                                     |
| `.loop(body, { verify: ({ output }) => verdict })`                               | `.loop(body, { verify: verifierAgent, max })`, the agent's output schema `VerdictSchema`                  |
| `.loop(body, { verify: ({ output }) => check(output) })`, `check` in your service | `.loop(body, { verify: http({ url }), max })`: your service answers the verdict                           |
| `.loop(body, { verify, decide })`                                                | `.loop(body, { verify, max })`: a fail retries with the feedback until `max`; `max` is required           |
| `.step(x)`, `.step(x, { id })`                                                   | `.pipe(x)`, `.pipe(x.withId(id))`; `.pipe(a, b, c)` adds three stages (`.step` warns, `NYLORUN_DEP_STEP`) |
| `Chain`, `Switch`, `Parallel`, `Map`, `Loop`, `withInstructions`, `withoutTools` | A flow agent: `Agent({ id }).pipe(…)`, `.switch()`, `.parallel()`, `.map()`, `.loop()`                    |
| `Agent.from(flow, { nodes: { "route:on": fn, … } })`                             | `Agent.from(flow, { nodes: { open_pr: tool } })`: only tool nodes take code                               |

A verifier agent gets `{ task, response, iteration }` and must return `{ pass, feedback? }`, with
feedback when `pass` is false; anything else fails the loop with `loop.verify-failed`. Each
verdict is recorded as a `loop.verified` event; `loop.decided` is gone.

A verify function that checked the output with your own code moves to your service as an
**HTTP verifier**: `http({ url, method?, credential?, timeoutMs? })`, with no name or input.
The Runtime makes one request per attempt through its Tool Gate, as for an HTTP tool (the
identity headers, an `Idempotency-Key` per attempt, the vault credential), with the body
`{ input, output, iteration }`: the Loop's input, the attempt's output and its number. Your
service answers `{ pass: true }` or `{ pass: false, feedback }`; any other answer, a failure
status or a timeout fails the loop with `loop.verify-failed`.

```ts
// Before: a verify function run by your Action endpoint
.loop(fixer, { verify: async ({ output }) => ((await ci.run(output)).ok ? { pass: true } : { pass: false, feedback: "tests fail" }), max: 3 })

// After: your service serves POST /verify and answers the verdict
.loop(fixer, { verify: http({ url: "https://ci.example.com/verify", credential: "ci" }), max: 3 })
```

A code tool stage (`tool({ run })`) runs only in the local engine: the Runtime refuses a flow
agent with one ([below](#action-endpoints-are-removed)). `fn` and `command` verify targets are
reserved and refused for now.

## Action endpoints are removed

The Runtime no longer delivers tool calls to your process. Gone:

- `PUT`, `GET` and `DELETE /v1/endpoints`, `POST /v1/endpoints/{agentId}/ping` and
  `/v1/actions/{actionId}/{heartbeat,result,sandbox/:tool}` (they answer `404`); delivery tokens
  (`Nylorun-Signature`, `Nylorun-Outcome`, `nylorun-delivery+jwt`); the gates service's
  `/nylorun/v1/deliveries`; the `actions` and `endpoints` tables (a migration drops them).
- `createActionHandler`, `executeAction`, `createActionSandbox` and the `Action`, `ActionOutcome`
  and `ActionHandler*` types in `@nylorun/agents`; `tool({ background: true })`; `ctx.sandbox`,
  `ctx.state`, `ctx.ask` and `ctx.approve` in a tool on the Runtime (they still work in the local
  engine, `@nylorun/harness/run`).
- The `action.pending`, `.delivered`, `.delivery_failed`, `.completed` and `.uncertain` events:
  a tool the Runtime ran is a `tool.completed` event, and a `turn.paused` interaction carries the
  tool call's `callId`.
- The `action-endpoints` protocol feature: protocol stays 8, and a client that requires the
  feature (an earlier SDK, CLI or Studio) is refused by the Host's feature check. The Harness API
  is v2: held runs (`holdMs`, `effect.resolved`) are gone.
- `nylo endpoints`, and in Tenant status `checks.endpoints`, `agents[].registered`,
  `agents[].endpoint` and `counts.pendingActions`.

`PUT /v1/agents/{id}` refuses (`400`) a definition with a tool that has no `http` and no
`agent` and is not one of the Runtime's built-ins, and a flow agent with a code tool stage (a
tool stage without `http`);
`saveAgent` refuses the same before sending:

```text
Tool 'lookup_order' of agent 'assistant' runs your code, but the Runtime runs agents from their manifests alone. Make it an http() tool or serve it from a remote MCP server (see MIGRATION.md).
```

What to do:

```ts
// Before: serve the agents' tools and register the URL
const actions = createActionHandler({ agents, url });
createServer(actions.node).listen(3001);
await actions.register({ url });

// After: save the agents; their tools are http() tools or MCP servers
const client = createClient();
for (const agent of agents) await client.saveAgent(agent);
```

A process that only served Actions is no longer needed; the service your HTTP tools call is
an ordinary HTTP service (see [HTTP tools](#http-tools-replace-code-tools)). `saveAgent`'s
`implementationVersion` is optional (`NYLORUN_IMPLEMENTATION_VERSION`, else `dev`). The
starter (`npm create @nylorun/agent`) saves its agent and runs no server.

# Runtime and Management APIs (protocol 8)

Every Tenant now serves two APIs on its one URL, split by route and by key. The **Runtime API**
is for developers: everything under `/v1` but `/v1/tenant/*` (agents, sessions with AG-UI and
A2A, sandboxes, artifacts, `/v1/me` and the JWKS). It takes application keys and trusted
issuers' tokens, through `@nylorun/agents`. The
**Management API** is for operators: `/v1/tenant/*` (models, vaults, signing keys, settings,
application keys, seed and reset) and `GET /v1/oauth/callback`. It takes **management keys**
only, through `@nylorun/admin`. The Admin API and its operator listener are gone: Host work runs
on the machine, with `nylorun` or `nylorun-operate`.
[SELF_HOSTING.md](./SELF_HOSTING.md#keys) describes the result.

The protocol is now 8, with the required feature `management-api`. A Runtime of this release
serves protocols 4 to 8: an older client keeps reaching the Runtime API, whose routes keep their
request and response shapes, but not `/v1/tenant/*` with an application key, nor the moved and
removed paths. Upgrade every package together (`@nylorun/core`, `@nylorun/runtime`,
`@nylorun/agents`, `@nylorun/admin`, `@nylorun/cli`, `nylorun` and Studio; `nylorun start` pins
the matching images). Old paths answer `404`, with no alias.

**Who is affected.** A developer on a local Tenant who uses the SDK with the Project link, Studio,
`nylo` and `nylorun` has nothing to do: the first `nylorun start` of this release gives the
project a management key beside its application key. You are affected if you:

- configure the Tenant (models, budgets, sandbox or artifact settings, seed, reset) with an
  application key, or act for a subject with `tenant:settings`;
- create vaults or rotate signing keys from an app (`client.createVault`,
  `client.access.signingKeys`, `/v1/vaults`, `/v1/access/signing-keys`);
- call the Admin API (`/v1/admin/*`, `admin.status()`, `NYLORUN_ADMIN_URL` and
  `NYLORUN_ADMIN_KEY`), or issue keys with it;
- run a Runtime yourself with `NYLORUN_ADMIN_LISTEN_*` or `adminPort`, or proxy `/v1/admin`;
- embed Studio and derive its key with `deriveStudioToken(adminKey, tenantId)`;
- publish or read `admin-openapi.json`.

What to do:

1. **`/v1/tenant/*` → a management key and `@nylorun/admin`.** An application key there, alone or
   acting for a subject, is `403 key_role_mismatch`, and so is a management key on any other
   route but `/v1/me` and the public `GET /v1/access/jwks`. Get a management key (step 5), then
   move the calls to `createAdmin()`, which reads `NYLORUN_RUNTIME_URL` and
   `NYLORUN_MANAGEMENT_KEY`, or the Project link's management key:

   ```ts
   // Before: an application key, by hand
   await fetch(`${url}/v1/tenant/sandbox`, {
     method: "PUT",
     headers: { authorization: `Bearer ${process.env.NYLORUN_SERVER_KEY}`, "nylorun-protocol": "7", "content-type": "application/json" },
     body: JSON.stringify({ default: "virtual" }),
   });

   // After: a management key
   import { createAdmin } from "@nylorun/admin";

   const admin = createAdmin();
   await admin.settings.sandbox.put({ default: "virtual" });
   ```

   Over HTTP, send the management key with `Nylorun-Protocol: 8`. The groups are
   `admin.tenant` (status, seed, reset), `admin.keys`, `admin.models` (catalog, providers,
   credentials, selection, usage, budgets), `admin.vaults`, `admin.signingKeys` and
   `admin.settings` (sandbox, artifacts) ([sdks/admin/README.md](../sdks/admin/README.md)). `nylo status`,
   `reset`, `configure`, `doctor` and `access signing-keys` use the Project's management key, or
   `NYLORUN_MANAGEMENT_KEY`. `/v1/tenant/models` and `/v1/tenant/providers` no longer admit
   `agents:write` subjects: apps don't read the model catalog.
2. **Vaults and signing keys moved to the Management API.** `/v1/vaults…` (including
   `…/oauth/start`) is now `/v1/tenant/vaults…`, and `/v1/access/signing-keys…` is
   `/v1/tenant/signing-keys…`, for management keys only. `@nylorun/agents` drops the vault
   methods (`createVault`, `listVaults`, `getVault`, `deleteVault`, `createCredential`,
   `listCredentials`, `getCredential`, `rotateCredential`, `deleteCredential`),
   `client.access.signingKeys` and `SigningKeysClient`:

   ```ts
   // Before (@nylorun/agents, an application key)
   const vault = await client.createVault({ scope: "installation", name: "tools", idempotencyKey: "tools" });
   await client.createCredential(vault.id, { name: "linear", idempotencyKey: "linear", auth });
   const { vaults } = await client.listVaults();
   await client.access.signingKeys.rotate();

   // After (@nylorun/admin, a management key)
   const vault = await admin.vaults.create({ scope: "installation", name: "tools", idempotencyKey: "tools" });
   await admin.vaults.credentials.create(vault.id, { name: "linear", idempotencyKey: "linear", auth });
   const vaults = await admin.vaults.list(); // the array itself
   await admin.signingKeys.rotate();
   ```

   An MCP OAuth connect starts with `admin.vaults.startOAuth(vaultId, { url, server,
   clientId? })`; `nylorun mcp connect` already does. Unchanged: opening a session with
   `vaultIds`, `GET /v1/oauth/callback` (providers keep the redirect URI they have), and
   `GET /v1/access/jwks` with `client.access.jwks()`.
3. **`tenant:settings` is retired.** It leaves `SUBJECT_SCOPES`; `Nylorun-Scopes` may still name
   it, and it grants nothing. No subject reaches the Management API: a management key with
   `Nylorun-Subject` or `Nylorun-Scopes` is `403 subject_invalid`, and one sent with an `Origin`
   is `403 origin_rejected`. An app server that changed settings for a person calls the
   Management API from the server, as the management key itself, and keeps its own record of
   who asked.
4. **The Admin API and the operator listener → the machine.** `/v1/admin/*` (status, host,
   shutdown, keys, `openapi.json`) answers `404`. The operator listener,
   `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`, `NYLORUN_ADMIN_ALLOWED_HOSTS`,
   `host.json`'s `adminPort` and nylorun's `NYLORUN_ADMIN_PORT` are gone (an existing one in
   `docker/.env` is ignored and no longer published). `@nylorun/admin` drops `admin.status()`,
   `adminUrl`, `NYLORUN_ADMIN_URL`, `NYLORUN_ADMIN_KEY`, the Admin API's keys and
   `OPERATOR_KEYS_FEATURE`. Host work runs on the Tenant's machine:

   ```sh
   # Before: the Admin API on the operator port
   curl -H "Authorization: Bearer $ADMIN_KEY" http://127.0.0.1:8788/v1/admin/status
   curl -X PUT -H "Authorization: Bearer $ADMIN_KEY" http://127.0.0.1:8788/v1/admin/keys/backend

   # After: a local Tenant
   npx nylorun status                       # runs nylorun-operate status in the runtime container
   npx nylorun key put backend              # an application key
   npx nylorun stop

   # After: a Runtime you run yourself
   docker compose exec runtime nylorun-operate status --json
   kubectl exec <runtime pod> -- nylorun-operate keys list
   ```

   `nylorun-operate status [--json]` reports the version, protocol and the Tenant's id, name,
   state and cause, and exits 2 when the Tenant is not open; it needs no key, so it works when
   the Tenant cannot open. The Tenant's own status over HTTP is `admin.tenant.status()`
   (`GET /v1/tenant`). `/ready` adds `harness: { mode, connected }`, and `nylorun start` waits
   for `/ready`. Stop a Runtime with SIGTERM. `startEphemeralRuntime` loses `operatorListener`
   and `adminUrl`, takes `managementKey`, and returns it (the key `bootstrap`).
5. **Issue management keys on the machine.** No API call creates one, so a leaked key can't mint
   another. `nylorun start` gives a linked project `project-management` (and keeps `cli-management`
   outside a project), in `.nylorun/credentials.json` (`managementKey`,
   `managementPrincipalId`; still format 1) and the Host root's credentials files. Elsewhere:

   ```sh
   npx nylorun key put ci --management                                       # a local Tenant
   docker compose exec runtime nylorun-operate keys put ci --role management  # your own Compose file
   kubectl exec <runtime pod> -- nylorun-operate keys put ci --role management
   ```

   Or mount a **bootstrap secret**: a file holding a key of 64 lowercase hex characters
   (`openssl rand -hex 32`), named by `NYLORUN_MANAGEMENT_KEY_FILE` on the runtime. The Runtime
   registers it as the management key `bootstrap` at every start, and replaces it when the file
   changes. Give the tool `NYLORUN_RUNTIME_URL` and `NYLORUN_MANAGEMENT_KEY`. Application keys
   now come from a management key: `admin.keys.put(id)` or `PUT /v1/tenant/keys/{keyId}`, which
   refuse a management key's id, `studio` and `bootstrap`; `nylorun key put <id>` still works.
   Existing keys stay application keys.
6. **Self-hosted Runtime and reverse proxy.** Remove `NYLORUN_ADMIN_LISTEN_*` and `adminPort`, and
   the proxy's `/v1/admin` block: the Runtime has one listener and the path answers `404`.
   Optionally answer `/v1/tenant/*` with `403` outside your operator networks, leaving
   `/v1/oauth/callback` open
   ([DEPLOYMENT.md](./DEPLOYMENT.md#reaching-the-runtime-from-another-machine)). Clients that
   check `/health` look for `management-api`: `operator-keys` is gone, and the Host advertises
   `admin-status` only for protocol 5 to 7 clients. Migration `0011_key_roles` gives the `studio`
   principal its role. The reference documents are `GET /openapi/runtime.json` (alias
   `/openapi.json`) and `GET /openapi/management.json`, with no key; the package and each release
   ship `openapi.json` and `management-openapi.json`, which replaces `admin-openapi.json`.
7. **Studio: key v2, and no login on loopback.** Studio's key is derived from the admin key alone
   (HMAC-SHA256 over `nylorun/studio/v2`), and the Host registers the new key's hash at its next
   start, replacing the old one. An app that embeds Studio and derives its key updates the call:

   ```ts
   // Before
   const studioKey = deriveStudioToken(adminKey, tenantId);
   // After
   const studioKey = deriveStudioToken(adminKey);
   ```

   `mintStudioLoginToken` is unchanged, and embedding keeps its login. Local Studio needs no
   login on its published loopback address (`localhost` or `127.0.0.1` at its port); a host
   behind a sign-in proxy keeps its sign-in. Studio reads its Tenant from `GET /v1/tenant` with
   its own key, and its Connections page manages vaults at `/v1/tenant/vaults`.

| Before | After |
| --- | --- |
| An application key on `/v1/tenant/*` | A management key: `createAdmin()` (`NYLORUN_RUNTIME_URL` + `NYLORUN_MANAGEMENT_KEY`) |
| `client.createVault`, `listVaults`, `getVault`, `deleteVault`, `createCredential`, `listCredentials`, `getCredential`, `rotateCredential`, `deleteCredential`; `/v1/vaults…` | `admin.vaults.create`, `list`, `get`, `delete`, `credentials.create`, `.list`, `.get`, `.rotate`, `.delete`; `/v1/tenant/vaults…` |
| `POST /v1/vaults/{vaultId}/oauth/start` | `admin.vaults.startOAuth(vaultId, …)`; `POST /v1/tenant/vaults/{vaultId}/oauth/start` |
| `client.access.signingKeys.list`, `rotate`, `revoke`; `SigningKeysClient`; `/v1/access/signing-keys…` | `admin.signingKeys.list`, `rotate`, `revoke`; `/v1/tenant/signing-keys…` |
| `tenant:settings` | Retired: the Management API as the management key itself |
| `GET /v1/admin/status`, `GET /v1/admin/host`, `admin.status()` | `nylorun status`, `nylorun-operate status`; `admin.tenant.status()` for the open Tenant |
| `POST /v1/admin/host/shutdown` | `nylorun stop`; SIGTERM |
| `PUT /v1/admin/keys/{id}`, `GET /v1/admin/keys`, `DELETE /v1/admin/keys/{id}` | `PUT`, `GET`, `DELETE /v1/tenant/keys…` (`admin.keys`, application keys); `nylorun key put <id> [--management]`, `nylorun-operate keys` |
| `GET /v1/admin/openapi.json`, `@nylorun/runtime/admin-openapi.json` | `GET /openapi/management.json`, `@nylorun/runtime/management-openapi.json` |
| `GET /openapi.json` | `GET /openapi/runtime.json` (`/openapi.json` stays as its alias) |
| `NYLORUN_ADMIN_URL`, `NYLORUN_ADMIN_KEY`, `adminUrl` | `NYLORUN_RUNTIME_URL`, `NYLORUN_MANAGEMENT_KEY` |
| `NYLORUN_ADMIN_PORT`, `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`, `NYLORUN_ADMIN_ALLOWED_HOSTS`, `adminPort`; the operator listener | One listener; `nylorun-operate` in the runtime container |
| `startEphemeralRuntime({ operatorListener })`, `.adminUrl` | `managementKey` (option and result) |
| `deriveStudioToken(adminKey, tenantId)` | `deriveStudioToken(adminKey)` |
| Required feature `admin-status`; Host feature `operator-keys`; `OPERATOR_KEYS_FEATURE` | Required feature `management-api` |
| Core: `AdminStatusSchema`, `AdminHostStatusSchema`, `HostAggregateSchema`, `HostShutdownResponseSchema` | Removed; `KEY_ROLES`, `KeyRole`, `BOOTSTRAP_KEY_ID` and the error code `key_role_mismatch` are new |

- **Kept:** every Runtime API route and its shapes, application keys (existing keys stay
  `application`), `client.as()` with `Nylorun-Subject` and `Nylorun-Scopes`, `vaultIds` on
  sessions, `GET /v1/access/jwks`, `GET /v1/oauth/callback`, `GET /v1/me` (a management key is
  `via: management:<id>`), the admin key in `host-credentials.json` (no request accepts it),
  `mintStudioLoginToken`, and the package name `@nylorun/admin`.

# Open-source auth (protocol 7)

Open source now verifies and enforces, and leaves sign-in, people and their secrets to you.
Servers use **operator keys**, browsers and apps present **your identity provider's JWTs**
(a trusted issuer in the identity file), shared credentials live in **installation vaults**,
and a person's own credentials come from **your credential resolver**. Subject tokens,
publishable keys, the access policy, derived keys and per-person vault routes are removed.
[SELF_HOSTING.md](./SELF_HOSTING.md) describes the result.

The protocol is now 7. A Runtime of this release still serves protocol 4, 5 and 6 clients on
every route that remains; a protocol 7 client (this release's `@nylorun/agents`,
`@nylorun/admin`, `@nylorun/cli`, `nylorun` and Studio) needs this release's Runtime, so
upgrade them together (`nylorun start` pins the matching image). Removed routes answer `404`.

**Who is affected.** A single developer on a local Tenant who uses the SDK with the Project
link, Studio and `nylorun sandbox` has nothing to do: `nylorun start` adopts the project's key.
You are affected if you mint subject tokens, ship a publishable key or use
`@nylorun/agents/browser`, set an access policy, derive keys from the admin key
(`NYLORUN_DERIVED_PRINCIPALS`, `deriveTenantKey`), create or read vaults while acting for a
person (`vaults:own`), embed Studio in another app, or refresh OAuth credentials against a
token endpoint on a private address.

What to do:

1. **Derived keys → operator keys.** Only Studio's key is still derived from the admin key.
   `NYLORUN_DERIVED_PRINCIPALS` is ignored and no longer written, and `@nylorun/admin` drops
   `deriveTenantKey`, `PROJECT_PRINCIPAL_ID` and `admin.deriveTenantKey`. A key an earlier Host
   derived stays in the database and keeps working as an ordinary key. Give each client its own
   operator key: `npx nylorun key put <id>` on a local Tenant, `admin.keys.put(id)` in
   `@nylorun/admin`, or `PUT /v1/admin/keys/{id}` on the operator listener. Putting the id of a
   derived key (`project`, or your own) rotates it to a random key, so do that once the client
   has its new key. `nylorun start` already gives linked projects the key `project` and keeps an
   existing project key that works.
2. **Subject tokens and `createTokenEndpoint` → a trusted issuer.** `POST /v1/tokens`,
   `POST /v1/access/revocations`, `client.tokens`, `createTokenEndpoint`,
   `client.access.revokeSubject` and `nylo access token|revoke` are gone, and a JWT no trusted
   issuer signed is the opaque `404`. Remove your token route. List your identity provider in
   the identity file (`<Host root>/identity.yaml`, or `NYLORUN_IDENTITY_FILE`), with `issuer`,
   `audience`, `jwks`, a `subject` template such as `u:{sub}` and the scopes, and send the
   provider's token as the bearer
   ([SELF_HOSTING.md](./SELF_HOSTING.md#the-identity-file)). Revoke people at the provider and
   keep its tokens short-lived: a stream opened with a token now ends only at its expiry
   (`token_expired`; `StreamClosedFrame` loses `revoked`, and the `subject.revoked` signal is
   gone).
3. **Publishable keys, `createBrowserClient` and browser access → the IdP's JWT and CORS at your
   proxy.** `/v1/access/publishable-keys*`, `@nylorun/agents/browser` (`createBrowserClient`),
   `client.access.publishableKeys`, `nylo access keys`, the `Nylorun-Key` header,
   `NYLORUN_BROWSER_ACCESS` and `browserAccess` (`host.json`, `createHost`,
   `startEphemeralRuntime`) are removed, and the Runtime sends no CORS headers. In the page, sign
   in with your provider's SDK and call the Runtime with `fetch`, sending
   `Authorization: Bearer <token>` and `Nylorun-Protocol: 7`; for a chat UI, give
   `@ag-ui/client`'s `HttpAgent` a `fetch` that adds them. Answer preflights and add
   `Access-Control-Allow-Origin` for your app's origins at the reverse proxy
   ([SELF_HOSTING.md](./SELF_HOSTING.md#cors-at-your-proxy)). An application key or delivery
   token sent with an `Origin` is `403 origin_rejected`.
4. **Access policy roles and limits → issuer settings and proxy limits.**
   `GET`/`PUT /v1/access/policy`, `client.access.getPolicy`/`putPolicy` and
   `nylo access policy` are gone, and a stored policy is ignored. Move each role to the identity
   file: its scopes to `allowedScopes` and your tokens' scope claim (or `scopes.fixed`), its
   agents to `agents`, its sandboxes to `sandboxes` templates, and `tokens.maxTtlSeconds` to
   `maxLifetime`. Turn limits (`429 limit_exceeded`) are gone: limit requests per person at your
   proxy.
5. **Per-person vaults and `vaults:own` → installation vaults and your resolver.** Every
   `/v1/vaults` route takes an application key acting for no one; acting for a person, or with
   an issuer's token, it is `403 scope_required`. `vaults:own` grants nothing. Move shared
   credentials into an installation vault: Studio's Connections page,
   `client.createVault({ scope: "installation", … })`, or `nylorun mcp connect <url>` for an
   OAuth MCP server. Keep each person's own credentials in your secret store and answer for them
   from a resolver (`NYLORUN_RESOLVER_URL`, `NYLORUN_RESOLVER_TOKEN` on the gateway;
   SELF_HOSTING.md; removed in protocol 10). Existing person vaults stay
   attachable to their owner's sessions; `client.listVaults()` takes an optional owner.
6. **Studio embedding.** The embed message `open.babai` is now `open.session` (`{ sessionId }`):
   it asks the embedding app to open that session in its own UI. Embedding is opt-in: no origin
   may frame Studio by default (`NYLORUN_STUDIO_FRAME_ANCESTORS` is empty); list your app's
   origins with `nylorun start --studio-embed-origin <origin>`. A Tenant's `.env` from an
   earlier nylorun keeps the origins it had; `--studio-embed-origin-reset` clears them.
7. **OAuth refresh follows `NYLORUN_ENDPOINT_*`.** Refreshing an OAuth vault credential now goes
   through the same address policy as Action deliveries: no redirects, and with
   `NYLORUN_ENDPOINT_PRIVATE=refuse` a token endpoint on a private address is refused where
   refresh used to call it. Allow private addresses on that gateway, or move the token endpoint.

| Before | After |
| --- | --- |
| `NYLORUN_DERIVED_PRINCIPALS`, `deriveTenantKey`, `admin.deriveTenantKey`, `PROJECT_PRINCIPAL_ID` | `nylorun key put <id>`, `admin.keys.put(id)`, `PUT /v1/admin/keys/{id}` |
| `hostPrincipals({ derived })`, `startEphemeralRuntime({ derivedPrincipals })` | Operator keys; `DERIVED_PRINCIPAL_ID_PATTERN` is `APPLICATION_KEY_ID_PATTERN` |
| `POST /v1/tokens`, `client.tokens.create`, `createTokenEndpoint`, `nylo access token` | Your identity provider's tokens, trusted through the identity file |
| `POST /v1/access/revocations`, `client.access.revokeSubject`, `nylo access revoke` | Revoke at the provider; tokens end at their expiry |
| `GET`/`PUT /v1/access/policy`, `client.access.getPolicy`/`putPolicy`, `nylo access policy` | The issuer's `allowedScopes`, `agents`, `sandboxes` and `maxLifetime`; limits at your proxy |
| `/v1/access/publishable-keys*`, `client.access.publishableKeys`, `nylo access keys`, `Nylorun-Key` | The IdP's JWT as the bearer |
| `@nylorun/agents/browser`, `createBrowserClient` | `fetch` with `Authorization` and `Nylorun-Protocol` |
| `NYLORUN_BROWSER_ACCESS`, `browserAccess`; CORS from the Runtime | CORS at your reverse proxy |
| `vaults:own`; vault routes acting for a person | Installation vaults (application keys); your credential resolver |
| `Destination.publishableKey`; `Destination.token` for subject tokens | `Destination.token` takes a trusted issuer's tokens |
| Default Studio frame ancestors | None; `--studio-embed-origin <origin>` |
| `GET /v1/me` `via: token` | `via: issuer:<name>` |
| Core: `SUBJECT_TOKEN_*`, `subjectTokenIssuer`, `CreateTokenRequest`, `AccessPolicy*`, `PUBLISHABLE_KEY_*`, `originAllowed`, … | Removed; `tenantTokenIssuer` for the Runtime's own tokens; `TOKEN_SCOPES` is `agents:read`, `sessions:own`, `sandboxes:write` |

- **Kept:** `GET /v1/access/jwks`, the signing-key routes and `nylo access signing-keys
  list|rotate|revoke` (delivery tokens and capability links), `client.as()` with
  `Nylorun-Subject` and `Nylorun-Scopes`, and Studio's own sign-in and embedding.
- **Self-hosted Runtime.** Remove `NYLORUN_DERIVED_PRINCIPALS` and `NYLORUN_BROWSER_ACCESS`.
  Set `NYLORUN_IDENTITY_FILE` on the runtime for your issuers, `NYLORUN_RESOLVER_URL` and
  `NYLORUN_RESOLVER_TOKEN` on the gateway for a resolver, and `NYLORUN_PUBLIC_URL` to the public
  address the OAuth callback uses. Migration `0010_oss_auth_removals` drops the
  `subject_epochs`, `subject_usage` and `publishable_keys` tables.

# File artifacts and message parts (protocol 6); `MediaStore` removed

Files that users upload or agents make are **file artifacts**: an id, a name and numbered
versions, metadata in the Tenant's database and bytes in the Object store (RustFS in a local
Tenant). Clients use `client.artifacts` (`@nylorun/agents`): `upload` streams a file in one
request, `list`, `get`, `download` (with Range), `link` (a short-lived capability URL that needs
no credential) and `delete`. A user message can name files: `session.inputParts([{ type:
"text", text }, { type: "file", artifactId }])`, and the model reads an image as an image and a
text file as text. A session with a sandbox has `save_artifact`, so the agent can hand the user
a file it made. A Tenant's limits are `PUT /v1/tenant/artifacts` (default 100 MiB per file, 10
GiB in all).

The protocol is now 6. A Runtime of this release still serves protocol 4 and 5 clients; a
protocol 6 client (this release's `@nylorun/agents`, `@nylorun/admin`, `@nylorun/cli` and
`nylorun`) needs this release's Runtime, so upgrade them together (`nylorun start` pins the
matching image).

**`MediaStore` and `localMedia` are removed from `@nylorun/runtime/node`**, and `piModel` no
longer takes `media`. Store images as file artifacts and name them in message parts; an
embedder that calls `piModel` itself passes `files`, a resolver from an artifact reference
(`{ artifactId, version }`) to `{ name, mediaType, bytes }`. `decodeImageBase64`,
`validateImageBytes`, `IMAGE_MEDIA_TYPES` and `MAX_IMAGE_BYTES` stay in `@nylorun/runtime` for
code that checks image bytes itself.

# Local Tenants: Studio at `http://localhost:<port>` again

The Studio proxy of nylorun 0.6 is gone. Each Tenant's Studio is at
`http://localhost:<port>` again (`nylorun ls` lists them; `nylorun studio --tenant <name>`
opens one signed in), and each keeps its own session cookie (`nylorun_studio_<name>`), so
two Studios in one browser stay signed in. Restate runs with its own defaults: the 256 MiB
RocksDB cap of 0.6 is removed, since it did not lower Restate's memory.

Nothing to do: the first `nylorun` command of this release removes the proxy's container
and network (`nylorun-proxy`) and `~/.nylorun/proxy/`, and says so once. Update bookmarks
from `http://<name>.localhost:4160` to the Studio URL `nylorun ls` shows. `NYLORUN_PROXY_PORT`,
`NYLORUN_PROXY_DISABLED` and Studio's `NYLORUN_STUDIO_PUBLIC_ORIGINS` are no longer read;
`nylorun status --json` has no `studio.proxyUrl` (`studio.url` is unchanged).

# Local Tenants: readable names, several Tenants, Studio at `<name>.localhost`

Every container, network and volume of a local Tenant is now named after the Tenant and
labelled `dev.nylorun.tenant: <name>`, so several Tenants run side by side and are easy to
tell apart in Docker. The Compose service `s2` is now `s2-lite`. Each Studio has its own
address, `http://<name>.localhost:4160`, through one small proxy container per machine
(`nylorun-proxy`), and its own session cookie. `nylorun ls` shows each Tenant's memory
(a Tenant uses about 1.2 GB, most of it Restate), and `nylorun stop --all` stops them all.

**A Tenant created by nylorun 0.5 starts fresh.** Its data is in volumes with the old
names; `nylorun start` refuses it (exit 3) and names them, so it never runs on new, empty
volumes with the old keys.

What to do, from nylorun 0.5:

1. Upgrade `nylorun`.
2. For each Tenant created by 0.5 (`nylorun ls`), run `nylorun reset --tenant <name>`. It
   deletes the Tenant's data, keys and old volumes (`<project>_postgres`, `_restate`,
   `_s2`, `_workspaces`) and the old network `<project>_default`; the next
   `nylorun start` creates the Tenant anew and relinks the project. Re-enter model
   credentials that were not in `.env`, and run `npm run dev` to register your agents
   again.
3. Replace the old names in scripts, CI and bookmarks:

| Before | After (Tenant `shop`) |
| --- | --- |
| Containers `nylorun-shop-<service>-1` | `nylorun-shop-<service>`: `nylorun-shop-postgres`, `-restate`, `-s2-lite`, `-gateway`, `-runtime`, `-studio` |
| Service `s2` (`nylorun logs s2`, `docker compose … s2`) | `s2-lite` (`nylorun logs s2-lite`) |
| Network `nylorun-shop_default` | `nylorun-shop` |
| Volumes `nylorun-shop_postgres`, `_restate`, `_s2`, `_workspaces` | `nylorun-shop-postgres`, `-restate`, `-s2-lite`, `-workspaces` |
| Studio at `http://localhost:<port>` | `http://shop.localhost:4160` (`start`, `ls`, `nylorun studio`); `http://localhost:<port>` still works and `nylorun status` shows it |
| Studio session cookie `nylorun_studio_session` | `nylorun_studio_shop` (`NYLORUN_STUDIO_SESSION_COOKIE`; Studio's default is unchanged): sign in again with `nylorun studio` |
| `nylorun ls` columns `TENANT STATE RUNTIME STUDIO PROJECT` | `TENANT STATE MEMORY RUNTIME STUDIO PROJECT`; JSON adds `memoryBytes` |

The proxy publishes on `127.0.0.1` and `[::1]` at port 4160 (or a free port chosen once,
kept in `~/.nylorun/proxy/.env`) and holds no Tenant data. Set `NYLORUN_PROXY_DISABLED=1`
to run without it; Studio is then `http://localhost:<port>` as before. A Tenant under
`NYLORUN_HOME` or `NYLORUN_COMPOSE_PROJECT` never uses it. (The next release removes the
proxy; see above.)

# Local Tenants: "Tenant" replaces "stack"

`nylorun` now calls what it runs a **Tenant**: each local installation holds one Tenant,
and the installation's name is the Tenant's name. Commands take `--tenant <name>` and
`NYLORUN_TENANT`, Host roots move to `~/.nylorun/tenants/<name>/`, and the Project link is
format 3 with a `tenant` field. `nylorun start` also works outside a project: there it
runs the Tenant `default`.

What to do, from nylorun 0.4:

1. Upgrade `nylorun`, `@nylorun/agents`, `@nylorun/cli` and `@nylorun/admin` together:
   they read link format 3.
2. Nothing for Host roots. The first `nylorun` command moves each
   `~/.nylorun/stacks/<name>/` to `~/.nylorun/tenants/<name>/` (`stack.json` becomes
   `tenant.json`, the `docker/.env` key `NYLORUN_STACK_NAME` becomes
   `NYLORUN_TENANT_NAME`) and says so once. Compose projects, ports, volumes and keys do
   not change.
3. Run `npx nylorun start` in each project. It rewrites `.nylorun/link.json` as format 3.
   Until then the SDK, `nylo` and `@nylorun/admin` refuse the old link and say so.
4. Replace the old names in scripts, CI and code:

| Before | After |
| --- | --- |
| `nylorun <command> --name <stack>` | `nylorun <command> --tenant <name>` |
| `NYLORUN_STACK` | `NYLORUN_TENANT` (a name; a `tn_…` id is refused) |
| `NYLORUN_STACK_PROJECT` | `NYLORUN_COMPOSE_PROJECT` |
| `~/.nylorun/stacks/<name>/`, `stack.json` | `~/.nylorun/tenants/<name>/`, `tenant.json` (moved for you) |
| `NYLORUN_STACK_NAME` in `docker/.env` | `NYLORUN_TENANT_NAME` (renamed for you) |
| `.nylorun/link.json` format 2 `{ stack, hostUrl, hostId, tenantId }` | Format 3 `{ tenant, tenantId, hostUrl, hostId }`; `npx nylorun start` rewrites it |
| `createAdmin({ stack })`, `stackHostRoot(name)` | `createAdmin({ tenant })`, `tenantHostRoot(name)` |
| Outside a project, `--name` required | The Tenant `default` (also for `start --no-link`) |
| `nylorun ls`: column `STACK`, JSON `{ stacks, legacy }` | Column `TENANT`, JSON `{ tenants }` |
| `nylorun legacy stop\|delete` | Removed: [remove the old installation with Docker](#one-tenant-per-installation-protocol-5) |
| `nylorun stack <command>`, `nylorun doctor stack\|runtime` | `nylorun <command>`, `nylorun doctor` |
| `nylo status` / `nylo endpoints`: `stack` line and JSON key | Removed; the Tenant's name is printed |

A `NYLORUN_TENANT=tn_…` left from releases before 0.4 is refused: unset it, or set a
Tenant's name (`nylorun ls` lists them).

# One Tenant per installation (protocol 5)

A Runtime now serves exactly one Tenant, the one its own Postgres database holds, and
nothing in a request selects it. Locally that means one Tenant per project: `nylorun start`
in a project creates the project's Tenant and the Project link together. Two Tenants are
two installations.

**This release starts fresh.** The old installation under `~/.nylorun` (Compose project
`nylorun`, `tenant_<id>` schemas) is never migrated, changed or deleted. Your agents, sessions, keys and vault credentials stay in it until you remove it.

What to do:

1. Upgrade the packages together (`@nylorun/agents`, `@nylorun/cli`, `@nylorun/admin`,
   `nylorun`): clients speak protocol 5.
2. In each project, run `npx nylorun start`. It creates the project's Tenant
   (`~/.nylorun/tenants/<project>/`, Compose project `nylorun-<project>`, its own ports and
   volumes), writes a new `.nylorun/link.json` and `.nylorun/credentials.json`, and seeds
   the model provider from the project's `.env`. A link to the old installation is
   replaced. To share one Tenant between checkouts, run
   `npx nylorun start --tenant <name>` in the others.
3. Re-enter model credentials that were not in `.env` (`npm run configure`, or Studio),
   and register your agents again: `npm run dev` does this.
4. Stop or remove the old installation with Docker when you no longer need it (`nylorun`
   no longer handles it). Stop it:
   `docker compose --project-name nylorun --file ~/.nylorun/stack/compose.yaml --env-file ~/.nylorun/stack/.env stop`.
   Remove it with `down --volumes` in place of `stop` (its volumes, its Tenants and their
   vault keys go), then delete `host.json`, `host-credentials.json`, `host-state.json`,
   `stack/`, `home/`, `tmp/` and `trash/` under `~/.nylorun`, and the `tn_…` directories
   in `~/.nylorun/tenants/` (never one with a `tenant.json`).

| Before | After |
| --- | --- |
| One installation per machine (`~/.nylorun`, Compose project `nylorun`) serving many Tenants | One Tenant per project: `~/.nylorun/tenants/<name>/`, Compose project `nylorun-<name>`; `nylorun ls`, `nylorun delete <name>` |
| `nylo tenant create\|use\|list\|current\|delete` | `nylorun start` in the project (creates its Tenant and the link); `--tenant <name>` attaches to an existing Tenant |
| `nylo tenant status\|reset\|endpoints` | `nylo status\|reset\|endpoints` on the linked installation; `nylorun status` shows the Tenant |
| `NYLORUN_TENANT`, `Nylorun-Tenant`, `createClient({ tenant })`, `runtime: { url, tenant }` | Gone: `NYLORUN_RUNTIME_URL` + `NYLORUN_SERVER_KEY` (or the link), `createClient({ url, key })`, `runtime: { url }` |
| `.nylorun/link.json` format 1 `{ hostUrl, hostId, tenantId }` with a minted application key | Format 3 `{ tenant, tenantId, hostUrl, hostId }`; `credentials.json` holds the key of the derived principal `project`. Clients refuse a link below format 3 and name `nylorun start` |
| `admin.createTenant`, `listTenants`, `getTenant`, `deleteTenant`; `/v1/admin/tenants*` | Gone (404). The Host creates its Tenant on first start; `admin.status().tenant` names it and why it is not open |
| `AdminStatus.tenants[]`, per-Tenant quarantine | `AdminStatus.tenant`; a Tenant that cannot be opened fails `/ready` with its cause (`schema-too-new`, `kek-missing`, `database-layout-old`, …) |
| `verifyDeliveryToken({ tenantId })` required | `tenantId` optional: the endpoint accepts its installation's Tenant |
| Studio's Tenant picker, list and create | Studio serves its installation's Tenant; `/` opens `/tenants/<id>` |
| `<Host root>/tenants/<id>/` | `<Host root>/tenant/` |
| `ERROR_CODES` `tenant_conflict`, `active_work` | Removed |

- **Self-hosted Runtime.** Point the Runtime at a new, empty database. One that holds
  `tenant_<id>` schemas fails readiness with `database-layout-old`. Set
  `NYLORUN_TENANT_NAME` (and optionally `NYLORUN_TENANT_ID`) for the Tenant it creates, and
  `NYLORUN_DERIVED_PRINCIPALS` (default `project`) for the clients whose keys the admin key
  derives, e.g. `project,app-server`.
- **Protocol 4 clients** keep working against this Runtime for one release: a request
  without `Nylorun-Tenant`, or naming the Host's Tenant, reaches it; one naming another
  Tenant is the opaque `404`.
- **Keys and ids.** The Tenant id stays as identity (token issuers, key formats, basin
  names); application and publishable keys of the new Tenant keep their formats.

# `startEphemeralRuntime` needs a database

The in-memory Session Store is gone: `startEphemeralRuntime()` (`@nylorun/runtime`,
`@nylorun/runtime/core`) now requires `database`, the Postgres database of the Tenant it
serves. Pass a URL, and the Runtime opens a pool and ends it on `close()`, or a pool you end
yourself. It creates its Tenant in that database on first start (or serves the one the
database holds), and the data stays after `close()`, so give each test its own database and
drop it afterwards.

```ts
const runtime = await startEphemeralRuntime({
  hostRoot,
  database: "postgres://nylorun:nylorun@127.0.0.1:55432/my_test_db",
});
```

# Session events on the `nylorun.event/2` envelope (protocol 4)

Protocol 4 puts every session event on the `nylorun.event/2` envelope and types each event
type in one catalog (`EVENT_CATALOG` in `@nylorun/core/contracts`), published in
`openapi.json`. A Runtime and SDK must both speak protocol 4; upgrade them together. An older
client is refused with `426 protocol_unsupported`.

| Before | After |
| --- | --- |
| `createdAt` | `time` |
| `eventId`, `sessionId`, `tenantId`, `turnId`, `cursor`, `type`, `payload` | Unchanged |
| — | New: `schema` (`"nylorun.event/2"`), `seq`, `epoch`, `runId` (null), `incarnation` (0), `schemaVersion`, `source`, `evidence`, `visibility`, `retention`, optional `trace` |
| `LiveEventSchema` was strict: any new field failed parsing | Unknown top-level fields are dropped, and `parseSessionEvent` returns an event of an unknown type as the bare envelope instead of throwing |
| `payload` typed for the 14 transcript events (`parseTranscriptEvent`) | Every type typed: `SessionEvent` is a union discriminated on `type`; `SessionEventOf<"action.delivered">` names one |
| `GET /v1/sessions/:id/items` items: `LiveEvent` | `SessionEvent` (the client reads unknown types as `LiveEvent`) |

- **Your code.** Read `event.time` instead of `event.createdAt`. Switch on `event.type` to
  narrow `payload`, and ignore types you do not know.
- **Other languages.** Generate types from `openapi.json`: each type is a component named
  after it (`MessageAssistantEvent`, `ActionDeliveryFailedEvent`, …), and `SessionEvent` is
  their union.
- **Writers.** The Runtime checks every event against the catalog before it commits it, so a
  stream never carries an event the catalog does not describe.

## Session history starts fresh

This release makes Postgres the record of every session event and S2 the delivery tier fed
from it. Upgrading deletes each Tenant's sessions (with their commands, checkpoints, effects,
Actions and links) and their history; Tenant settings, agents, Action endpoints, keys, policy
and vaults stay. Cursors from before the upgrade are not valid after it.

- **Local stack.** `nylorun start` recreates the Postgres container with `wal_level=logical`;
  its data volume is kept.
- **Your own Postgres.** Set `wal_level = logical` and restart it, and give the Runtime's role
  `REPLICATION` (see `DEPLOYMENT.md`). An `api` or `all` Runtime with S2 refuses to start
  without them.

# Action endpoints replace executors (superseded: [Action endpoints are removed](#action-endpoints-are-removed))

Protocol 3 removes executors. The Runtime no longer offers Actions for a process to claim.
It POSTs each Action (tool, hook, `fn`, `verify`) to the URL your app registers, signed with a
short-lived delivery token, and your app answers with the outcome. A Runtime and SDK must both
speak protocol 3; upgrade them together.

| Before | After |
| --- | --- |
| `connectAgents({ agents })` | `const actions = createActionHandler({ agents, url })`, served by your HTTP server (`actions.node` or `actions.fetch`), then `await actions.register({ url })` |
| `@nylorun/agents/executor` | `createActionHandler` from `@nylorun/agents` |
| Executor keys: `NYLORUN_EXECUTOR_KEY`, derived keys, `PUT /v1/executors` | None. `register()` sends `PUT /v1/endpoints` with the application key; each delivery carries its own token |
| `GET /v1/executors`, `DELETE /v1/executors/:agentId` | `GET /v1/endpoints`, `DELETE /v1/endpoints/:agentId`, `POST /v1/endpoints/:agentId/ping`, `nylo tenant endpoints` |
| `GET /v1/executors/connect`, `GET /v1/actions`, `POST /v1/actions/:id/claim` | None: the Runtime POSTs to the endpoint |
| The `action_result` session command | The endpoint's answer. A tool marked `background: true` answers `202` and posts `POST /v1/actions/:id/result` |
| `POST /v1/actions/:id/heartbeat` with a claim | The same route with the delivery token, for background tools. It returns a fresh token |
| `POST /v1/actions/:id/sandbox/:tool` with `claimId` and `generation` | The same route with the delivery token. `ctx.sandbox` is unchanged |
| Action status `claimed`, `claimId`, `leaseExpiresAt` | `delivering`, `deadlineAt` |
| `action.claimed` events | `action.delivered`, and `action.delivery_failed` while the endpoint can't be reached |
| Tenant summary `connectedExecutors` | `inFlightDeliveries` |

- **Reachability.** The Runtime must reach the URL. On the local stack, `localhost` means the
  machine running Docker. A Runtime elsewhere needs a public URL, such as a tunnel. A Runtime
  that refuses private addresses (Cloud) refuses `localhost` URLs.
- **Long tools.** An inline delivery lasts `timeoutMs` (default 60 s, at most 840 s). Mark
  longer tools `background: true`; the handler heartbeats and posts the result.
- **In flight during the upgrade.** Postgres migration 6 treats Actions that an executor had
  claimed as lost deliveries. A tool becomes `uncertain`. A hook, `fn` or `verify` is
  delivered again once the agent's endpoint is registered.
- **Status.** `GET /v1/tenant/status` lists `endpoint` per agent instead of `connected`, and
  checks `endpoints` instead of `executors`.

# Sandboxes are chosen when a session is opened

Agent and flow agent definitions no longer declare a sandbox. A session gets one when
it is opened, within limits its Tenant sets, so the same agent runs in any Tenant.

| Before | After |
| --- | --- |
| `Agent(…).sandbox()` or `.use(sandbox())` | Remove it. Open the session with `createSession({ …, sandbox: {} })`, or set the Tenant's default |
| `.sandbox({ image, network, resources })` | `createSession({ …, sandbox: { network: { allow }, resources } })`. The virtual sandbox has no images: `image` goes on a pod sandbox resource (`kind: "pod"`) |
| `.sandbox({ idle })` | The Tenant's `limits.idle` (`PUT /v1/tenant/sandbox`) |
| `network.preset: "dev"` (the old default) | List the hosts in `network.allow`. The Tenant's ceiling defaults to the same package registries and code hosts; no `allow` means no egress |
| `.sandbox(spec)` on a flow agent, `.sandbox()` on its agents | Open the flow's session with the sandbox; its agents, tool steps and `verify` inherit it |
| Identical specs across a tree (`sandbox.mismatch`, `workflow.sandbox-mismatch`) | Gone: a tree shares the sandbox its session was opened with |
| `sandbox`, `SandboxError`, `SandboxOptions` exports | Removed |

- **Registration.** `PUT /v1/agents/:id` refuses a definition that declares a sandbox
  with a `400` that names it. The builder fails with `sandbox.in-definition`.
- **Tenant default.** Unset, it is `none`: sessions that name no sandbox get none, as
  agents without `.sandbox()` did. Set it with `PUT /v1/tenant/sandbox`, for example
  `{ "default": "virtual" }`, so Studio sessions and AG-UI threads get one.
- **Callers acting for a user.** An inline sandbox from `app.as(…)` is a `403`; use the
  Tenant's default or `false`.
- **Already stored.** Definitions registered before the upgrade keep their declared
  sandbox until they are saved again, and sessions keep the sandbox they were created
  with.
- **Executors.** `ctx.sandbox` follows the session (the action claim says whether it
  has one), so tools and `verify` in a tree opened with a sandbox get it.

# The Admin API on its own port

The stack now serves the Admin API on a second port, `NYLORUN_ADMIN_PORT` (default
8788, published on loopback only), and the Runtime port (`NYLORUN_PORT`) serves the
Tenant API alone: admin routes there answer `404`. `nylorun start` picks the port,
writes it to `stack/.env` and to `host.json` as `adminPort`, and Studio reaches the
Runtime on the stack network at `runtime:4001`.

- `@nylorun/admin` reads `adminPort` from `host.json` and sends Admin API requests
  there; `admin.url` stays the Tenant API URL and `admin.adminUrl` is new. A
  `host.json` without `adminPort` keeps working against one port.
- Code that called `/v1/admin/*` on the Runtime port itself, or `NYLORUN_ADMIN_URL`
  pointing at it, must use the admin port.
- A Runtime you run yourself keeps one port unless you set `adminPort` in
  `host.json`, or `NYLORUN_ADMIN_LISTEN_PORT` (with `NYLORUN_ADMIN_ALLOWED_HOSTS`
  off loopback) in a container.
- Reverse proxies forward the Runtime port only. Keep the `/v1/admin` block as
  defense in depth.

# Studio opens signed in

`nylorun up` prints Studio as `http://localhost:<port>`, without a login token.
In a terminal it opens Studio in the browser, signed in; `--no-open` (or CI)
keeps the browser closed and says to run `nylorun studio`. A sign-in lasts 30
days and survives Studio restarts. `nylorun studio` also prints the plain URL
when it opens the browser; `nylorun studio --no-open` still prints the
single-use login URL, so scripts that read the `Studio` line of `nylorun up`
should use `nylorun studio --no-open` instead.

# Flow agents as subagents

`.subagents(flowAgent)` now works: the flow agent's workflow manifest v2 is inlined in
the delegating tool (`tools[].agent` may be a workflow manifest), and the Runtime runs
it in a linked session per call. `delegation.flow-unsupported` now only reports a
workflow built with `Chain`, `Switch`, `Parallel`, `Map` or `Loop`. A Runtime older than
this release rejects a manifest with a flow subagent at registration.

# Flow agents on workflow manifest v2

Flow agents now compile to workflow manifest v2 and run on the `flow-2` engine.
Code written with the flow agent syntax needs no change; what changes is on the wire
and in session ids.

- **One document.** The manifest embeds every agent the flow runs (`agents`), and
  `saveAgent(flowAgent)` PUTs that one document with the agents' plugin roots. The
  flow's agents are no longer registered, or listed, on their own.
- **Sessions follow the agents.** An agent's linked session is named by its id
  (`fixer`, `implementer[0]`, `review/reader`), not by the control stages around it.
  Runs started before the upgrade finish on `flow-1` with their old paths; new runs
  of a redeployed flow open new linked sessions.
- **Stage keys.** Functions are bound under a stage's `id`, or its position
  (`@1.default.1`), plus `:input`, `:on`, `:verify` or `:decide`. A flow executor
  only runs flow actions for the manifest hash it serves.
- **Nested `flow()`** functions receive `flowInput` (the enclosing agent's input);
  `flow.flow-input-nested` is gone.
- **A Loop that runs out of attempts** fails with `loop.exhausted` (was `loop.stopped`).
- **The same agent twice** in one flow needs a new id (`flow.duplicate-leaf`).
- **Sandbox.** Declare the spec once with `.sandbox(spec)` on the flow agent; agents
  in it use `.sandbox()` with no options, or the same spec.
- **Nesting.** A flow agent can be a step of another flow agent. It can't be a child
  of `Chain`, `Switch`, `Parallel`, `Map` or `Loop`, which keep building v1 workflows,
  and a v1 workflow can't be a step of a flow agent.
- `Agent.from(json, { nodes, agents })` rebuilds a flow agent from its v2 document.

# One `Agent` builder: named methods and flow agents (deprecations)

Every capability now has its own method on `Agent`, and deterministic workflows
are written as flow agents on the same builder. The old forms keep working for one
minor release and warn once each (`DeprecationWarning`, codes below). Manifests are
unchanged: the new syntax compiles to exactly what the old syntax produced.

| Before | After | Warning code |
| --- | --- | --- |
| `Agent({ id, instructions, tools, outputSchema })` | `Agent({ id }).instructions(…).tools(…).output(schema)` | `NYLORUN_DEP_AGENT_OPTIONS` |
| agents inside `tools: [...]` | `.subagents(agent)` | — |
| `.use(mcp({ gh: { name: "gh", … } }))` | `.mcp({ gh: { … } })`; `name` defaults to the key | `NYLORUN_DEP_USE` |
| `.use(skills(dir))` / `.use(plugin(dir))` | `.skills(dir)` / `.plugin(dir)` | `NYLORUN_DEP_USE` |
| `.use(sandbox(spec))` | `.sandbox(spec)` | `NYLORUN_DEP_USE` |
| `.use(capability({ id, instructions, tools }))` | `.capability(capability({ id }).instructions(…).tools(…))` | `NYLORUN_DEP_USE`, `NYLORUN_DEP_CAPABILITY_OPTIONS` |
| `.before("turn", fn)` / `.before("step", fn)` | `.beforeTurn(fn)` / `.beforeModel(fn)` | `NYLORUN_DEP_HOOKS` |
| `.after("step", fn)` / `.after("turn", fn)` | `.afterModel(fn)` / `.afterTurn(fn)` | `NYLORUN_DEP_HOOKS` |

`.use(middlewareFunction)` has no replacement yet and does not warn.
`.skills()` and `.plugin()` read files, so they are on the `Agent` exported from
`@nylorun/agents`; `@nylorun/agents/define` exports the portable builder without them.

Workflows become flow agents. `Chain`, `Switch`, `Parallel`, `Map` and `Loop` still
work and produce the same (v1) manifests.

| Before | After |
| --- | --- |
| `Chain({ id, steps: [a, b] })` | `Agent({ id }).step(a).step(b)` |
| slot `{ run, id, input: ({ value, results }) => … }` | `.step(x, { id, input: ({ input, results, flowInput }) => … })` |
| `Switch({ id, on: (input) => key, cases, default })` | `.switch({ ...cases, default }, { on: ({ input }) => key, id })` |
| `Parallel({ id, branches })` | `.parallel(branches, { id })` |
| `Map({ id, over: (input) => list, each })` | `.map(each, { id, input: ({ input }) => list })`; a Map runs over its input |
| `Loop({ id, run, verify, decide })` | `.loop(body, { verify, max })`, or `{ verify, decide }` returning `{ output }` or `{ retry, agent? }` |

A loop needs `max` or `decide` (`loop.max-required`).

# `nylorun` and `nylo`: setup and the Runtime client (breaking beta)

The `nylorun` command moves to a new unscoped package, `nylorun`, which only
sets up and runs the local stack and never creates Tenants. `@nylorun/cli`
stays as the Runtime client with its own command, `nylo`: Tenants, the Project
link and the model provider. The two packages are independent. A project
depends on `@nylorun/agents` alone and runs both tools with `npx`:

```sh
npx nylorun up                   # set up the stack on the first run, then start it
npx @nylorun/cli tenant create   # the project's Tenant and Project link, model from .env
npm run dev                      # tsx watch src/main.ts
```

| Before | After |
| --- | --- |
| `nylorun start` / `nylorun stop` (from `@nylorun/cli`) | unchanged, from `nylorun`; `nylorun up` / `nylorun down` are aliases |
| `nylorun dev` | `nylo tenant create` once, then the project's `npm run dev` (`tsx watch`) |
| `nylorun dev --ephemeral` | removed; the repository's smoke checks create temporary fixture-model Tenants themselves |
| `nylorun dev --no-studio` / `--no-open` | `npm run dev`; `nylorun studio` opens Studio on the linked Tenant |
| `nylorun tenant …` | `nylo tenant …` (plus `nylo tenant create [name]`) |
| `nylorun configure` | `nylo configure` |
| `nylorun status --env` | `nylo env` |
| `nylorun doctor sandbox` | `nylo doctor sandbox` |
| `package.json` `nylorun.runtime` / `nylorun.studio` in `@nylorun/cli` | the same fields in `nylorun` |

The moved `nylorun` commands exit 2 and name their replacement; `nylo` does the
same for the stack commands. In a generated project, drop the CLI and change
the `dev` script:

```diff
   "scripts": {
-    "dev": "nylorun dev",
+    "dev": "tsx watch --env-file-if-exists=.env src/main.ts",
     "start": "node dist/src/main.js"
   },
   "devDependencies": {
-    "@nylorun/cli": "…",
```

An existing Project link keeps working: `connectAgents` reads it, so a linked
project only needs the new `dev` script. `npm create @nylorun/agent` now
installs the project and prints these steps instead of starting development;
`--no-open` is accepted and ignored.

# Runtime V1: the Docker stack (breaking beta)

The local Runtime moves from one SQLite file per Tenant, run by the
`nylorun-runtime` launcher, to a Docker Compose stack that `nylorun` manages:

| Service | Role |
| --- | --- |
| `postgres` | Session Store: one schema `tenant_<id>` per Tenant |
| `restate` | Durable Session Execution: wakes, one advance per session, the Tenant sweep |
| `s2` (s2-lite) | Durable Streams: one event stream per session, read by history and SSE |
| `runtime` | The Runtime, image `ghcr.io/nylorun/runtime` |
| `studio` | Studio's dashboard and trusted proxy, image `ghcr.io/nylorun/studio` |

Upgrade in this order: install the prerequisites, move to the new commands,
recreate your Tenants, then update generated projects. Upgrade
`@nylorun/core`, `@nylorun/agents`, `@nylorun/admin`, `@nylorun/cli` and
`@nylorun/create-agent` together; the CLI pins the Runtime and Studio images.

### 1. Prerequisites

Node 24 or newer and Docker with Compose v2 (Docker Desktop, OrbStack or
Colima); on Windows, both inside WSL2. A global `@nylorun/runtime` is no longer
used: remove it with `npm uninstall --global @nylorun/runtime`. `nylorun doctor`
checks the prerequisites and the stack's health.

### 2. Commands

| Before | After |
| --- | --- |
| `nylorun runtime up`, `nylorun runtime run` | `nylorun start` (or its alias `nylorun up`) |
| `nylorun runtime down` | `nylorun stop` (or its alias `nylorun down`; volumes are kept) |
| `nylorun runtime restart` | `nylorun stop`, then `nylorun start` |
| `nylorun runtime status [--json]` | `nylorun status [--json]` |
| `nylorun runtime status --env` | `nylo env` ([above](#nylorun-and-nylo-setup-and-the-runtime-client-breaking-beta)) |
| `nylorun runtime logs`, `nylorun logs` (launcher) | `nylorun logs [service] [-f] [--tail <n>]` |
| `nylorun stack logs`, `nylorun stack studio` | `nylorun logs`, `nylorun studio` |
| `nylorun studio [--local-ui] [--port <n>]` (in-process proxy) | `nylorun studio [--no-open]`: a fresh login URL for the stack's Studio, on the linked Project's Tenant |
| `nylorun dev --local-ui` | `npm run dev`, then `nylorun studio` (opens Studio on the Project's Tenant) |
| `nylorun dev --ephemeral` (in-process Runtime) | removed ([step 6](#6-nylorun-dev---ephemeral-and-the-fixture-model)) |
| `nylorun doctor runtime` | `nylorun doctor` (Node, Docker, Compose v2, stack health) |
| `nylorun-runtime up\|down\|status\|logs` | `nylorun start\|stop\|status\|logs` |
| — | `nylorun reset [--yes]`: delete the stack's volumes and every Tenant |

The removed `nylorun` commands exit 2 and name their replacement. `nylorun
start` writes `compose.yaml` and `.env` (mode 0600) under `<Host root>/stack/`
and publishes on loopback only: the Runtime on `8787` and Studio on `4161` by
default, or free ports chosen on the first start and kept in `.env`.
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` replace the pinned images.

### 3. Tenants move to Postgres; SQLite Tenants are not migrated

A Tenant is now a Postgres schema, and the SQLite Session Store is removed.
On its first start the Runtime moves every Tenant directory from the SQLite
Runtime (`~/.nylorun/tenants/<id>/` holding a `tenant.sqlite`) to
`~/.nylorun/trash/<id>-sqlite-<time>/` and logs `sqlite_tenant_moved_to_trash`
with its id. Copy anything you still need out of `trash/`, then delete it.

Recreate each Tenant: remove `.nylorun/link.json` and
`.nylorun/credentials.json`, then run `nylo tenant create` in the project.

### 4. The `nylorun-runtime` launcher is removed

`@nylorun/runtime` is a library with no bin. The launcher and its
`host-state.json` are gone; the Runtime runs only as the
`ghcr.io/nylorun/runtime` image, whose entry requires `NYLORUN_DATABASE_URL`.
`openTenantRuntime(config, hooks)` requires the Tenant's opened `store` and
`envelope`, and `HostStateFile` is no longer exported.

### 5. Studio is a stack service

`@nylorun/studio` is no longer published to npm; it ships only as the
`ghcr.io/nylorun/studio` image, served on `http://localhost:4161`. The hosted
dashboard at `local.nylorun.studio`, the local UI mode (`--local-ui`,
`ui: "local" | "hosted"`), the pairing fragment, the `nylorun-studio` bin and
`startStudio()` are removed. The CLI asks the Studio container for a
single-use login token (valid for two minutes) with the admin key and opens
`/login?token=…`, which sets an `HttpOnly`, `SameSite=Strict` cookie;
`nylorun studio` mints a fresh one.

Studio reaches each Tenant as the **Studio principal**: application principal
`studio`, whose key Studio derives from the admin key and the Tenant id
(`deriveStudioToken` in `@nylorun/admin`). `createTenant` registers its hash
when it creates the Tenant. Tenants created before this release have no Studio
principal, which is one more reason to recreate them.

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

### 6. `nylorun dev --ephemeral` and the fixture model

`--ephemeral` is removed with `nylorun dev`. The repository's smoke checks
create a temporary Tenant through `@nylorun/admin`, seed it with the
Tenant-level fixture model and delete it afterwards
(`scripts/lib/temporary-tenant.mjs`).

The fixture model is a Tenant setting rather than a Host-wide mode:
`PUT /v1/tenant/config/seed` accepts `fixtureModel: true` (stored as
`model.fixture`, insert-if-absent). Other Tenants on the same Host keep their
model. In the CLI, `NYLORUN_DEV_MODEL=fixture` now only skips model setup. The
Runtime no longer reads it: a Host started with it no longer answers every
Tenant with the fixture model. Seed the Tenant setting instead.

`startEphemeralRuntime()` (`@nylorun/runtime`, `@nylorun/runtime/core`) keeps
its signature, but its Tenants live in memory (the memory Session Store and
memory Durable Streams) instead of SQLite under the Host root. Nothing survives
`close()`, and a retained Host root cannot be reopened with its sessions. Use it
for tests and embeds that need the Runtime's HTTP API without Docker; use the
stack for anything durable.

### 7. Sandboxes: the microsandbox backend is removed

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

### 8. Wire and contract changes

Protocol stays `2`. Clients from this release require `studio-principal`, so
they report an older Host as `incompatible_host`.

| Change | Where |
| --- | --- |
| Required feature `studio-principal`: `POST /v1/admin/tenants` accepts optional `studioCredentialHash` (SHA-256 of the derived Studio key) and stores application principal `studio`; idempotent create compares it too. `principalId: "studio"` is reserved (400) | `PROTOCOL_FEATURES`, `CreateTenantRequestSchema` |
| Optional Host feature `tenant-fixture-model`: `fixtureModel: true` on the Tenant seed. Clients do not require it; the temporary test Tenants check `/health` for it | `OPTIONAL_HOST_FEATURES`, `SeedTenantConfigRequestSchema` |
| `GET /v1/tenant` reports `checks.store` instead of `checks.sqlite`, and gains optional `execution` (stuck Restate invocations) and `streams` (basin, outbox depth, relay lag) | `TenantStatusSchema` |
| `GET /v1/admin/status` aggregates gain optional `outboxDepth` and `relayLagMs` | `HostAggregateSchema` |
| Quarantine code `locked` and its `lockPath`/`lockPid` are removed; the codes are `kek-missing`, `corrupt`, `schema-too-new`, `migration-failed`, `envelope-invalid`, `open-timeout` and `open-failed`. A schema newer than the Runtime is `schema-too-new` | `QuarantineSchema` |
| `sandbox.backend` accepts `auto` or `virtual` | `SeedTenantConfigRequestSchema` |
| `LAUNCHER_PROTOCOL` and the launcher `ERROR_CODES` (`platform_unsupported`, `launcher_failed`, `lock_timeout`, `foreign_port`, `host_unresponsive`, `host_start_failed`, `host_schema_newer`, `host_format_newer`, `downgrade_refused`, `upgrade_failed`) are removed | `@nylorun/core/compatibility` |
| `GET /ready` covers Postgres, Restate and S2 (`checks`); a Tenant whose Postgres or Restate is unreachable answers `503` | Runtime Host |

# Runtime Clients and Admin API (breaking beta)

Vocabulary: [runtime/server/src/CONTEXT.md](../runtime/server/src/CONTEXT.md).

> Runtime V1 (above) replaces this release's launcher, its global
> `@nylorun/runtime` install and the `nylorun-studio` binary. The client
> packages, `src/main.ts` and the three deployment variables below still apply.

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

### Existing Host roots

- A Host started by the Tenants-era CLI is reused while it runs.
- Its next restart moves it onto the installed `@nylorun/runtime`.
- `host.json` gains `format` and `runtimeVersion` on the first launcher write.
- Project link and credentials accept format `0` (missing `format`) and write
  format `1`.

Upgrade `@nylorun/core`, `@nylorun/agents`, `@nylorun/admin`, `@nylorun/cli`,
`@nylorun/studio` and the installed `@nylorun/runtime` together (breaking beta
set). Protocol feature `admin-status` is additive on
protocol `2`.

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

Vocabulary: [runtime/server/src/CONTEXT.md](../runtime/server/src/CONTEXT.md).

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
package combination in `cli/create-agent/compatibility.json`.

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

Upgrade the harness, SDK, Runtime, Studio, and creator as the tested compatible set in `cli/create-agent/compatibility.json`. This migration changes public entry points and the session protocol.

1. Import `Agent` and `tool` from `@nylorun/agents`. Export `agents` from `agents/index.ts`. Keep model selection in Runtime configuration.
2. Remove the starter's Hono application and old `Runtime` / `serveAgents` / `openSession` imports. Definitions no longer expose `agent.run()`.
3. `nylorun start` was removed in favor of `nylorun serve [entry]` for the compiled build. **That `serve` command is itself removed** in Runtime Clients — use `node dist/src/main.js` / `nylorun dev` (see steps 1–4 above). The Runtime Host remains its own persistent process: `nylorun runtime up` / `down` / `status`, with Host root `NYLORUN_HOME` / `~/.nylorun` and a Project link under `.nylorun/`.
4. Update custom applications to SDK `createClient` and session commands with stable idempotency keys. Trusted servers supply `ownerUserId`; input text uses `content`. Pass `tenant` (see Runtime Tenants section above).
5. Custom connected executors use `connectAgents({ agents, runtime: { url, key, tenant } })`. Prefer application-mode `connectAgents({ agents })` with derived tokens (Runtime Clients). The local CLI no longer writes executor tokens into Project credentials.
6. Studio uses canonical history and authenticated SSE through its local proxy. Attach with the generated `nylorun-studio` npm script or the Project-aware `nylorun studio` CLI command; both resolve the Project link. Remove AG-UI and legacy manifest endpoint configuration.

Keep credentials in gitignored `.nylorun/`; provider configuration uses `.env` only as a one-time seed into the Tenant vault. Keep backups of old SessionRecord/event files. They are not automatically converted to new SQLite checkpoints. Session export/import and migration tooling are deferred. Start new sessions after changing definitions or implementations. Because the Host now outlives `dev`, a source change re-registers agents and reconnects executors rather than restarting the Host.

Explicit in-process engine execution remains available to host authors through `@nylorun/harness/run`; it is not loaded by the application SDK. OSS and Cloud consume the harness independently.

The release workflow covers local text and ordinary tools. Advanced examples remain source references outside the default registry. Media, approvals UI, deployment recipes, and broad recovery/conformance gates remain for later releases. Subagents (agents used as tools, one level deep) ship with this branch; see [the SDK](../sdks/agents/README.md).

## Execution API rename

Replace `@nylorun/harness/engine` imports with `@nylorun/harness/run`. Rename `runHosted` to `runDurable`, `createHostedCheckpoint` to `createDurableCheckpoint`, `HostedCheckpoint` / `HostedResult` to `DurableCheckpoint` / `DurableResult`, and `EngineHost` to `DurableHost`. Rename `EngineBinding`, `EngineRunOptions`, and `createEngineState` to `RunBinding`, `BoundRunOptions`, and `createRunState`. There are no compatibility aliases.

Durable execution reconstructs progress from a checkpoint and individually journaled effect outcomes; the host must persist both. Existing checkpoint fields and `ENGINE_VERSION = "hosted-1"` remained compatible at the time of this rename; scoped hooks later moved the engine to `hosted-2`.
