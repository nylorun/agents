# The Harness API

A harness runs an agent's loop: it calls the model, runs tools, and reports what happened. The
Runtime keeps everything else: the session's record, its lease and ownership, the gates that
hold every credential, and the settle that ends a turn. The Harness API is the contract between
the two. Our harness (`@nylorun/harness`, harness id `nylorun`) is one implementation; you can
write another, in any language, from this page alone.

This page is the reference, section by section, and then a guide to building one.
[`examples/harness-minimal`](../examples/harness-minimal/README.md) is a complete harness of about
800 lines that depends only on `ws` and `@nylorun/core/harness-api`.

The Harness API is southbound: from the Runtime down to a loop. It is not a northbound API for
calling vendor agents, and it is not the Runtime API your app uses.

## §0 Where the contract lives

Every message, body and document below has a zod schema in `@nylorun/core/harness-api`, and the
Runtime validates with the same schemas. The package also ships them as one JSON Schema document,
`@nylorun/core/harness-api/schema.json`, with `$defs` for each schema by name and for each
request's `<method>.params` and `<method>.result`. A harness in Python or Go validates against
that file.

## §1 Transport

- A WebSocket to core's harness listener (port 4200 by default), path `/nylorun/harness/v1`.
- Upgrade headers: `Authorization: Bearer <token>` and `Nylorun-Harness-Api: 1`. A wrong path
  is `404`, a missing or unknown token `401`, a missing header `426`, a closed Tenant `503`.
- One JSON text message per frame, at most 64 MiB (`HARNESS_MAX_PAYLOAD`). Frames
  (`FrameSchema`): `{t: "req", id, m, p}`, `{t: "res", id, ok: true, r}`,
  `{t: "res", id, ok: false, e: {code, message}}`, `{t: "msg", m, p}`, `{t: "abort", id}` and
  `{t: "ping"}`. Either end may send requests; ids are per sender.
- Core pings every 30 s and drops a harness it has not heard from for 90 s. Its runs then end
  as `connection.lost`, and the next advance offers them again.
- Error codes (`HARNESS_ERROR_CODES`): `run_not_held`, `turn_cancelled`, `ownership_lost`,
  `effect_drift`, `invalid`, `unavailable`, `internal`, `not_found` (an artifact that is not
  there for your run, §4b) and `limit_exceeded` (what you sent passes a Runtime limit of
  `turn.start.limits`, or an artifact limit; the message names the limit and its value).

Which token:

- A harness container uses its own token, made by the operator with
  `nylorun-operate harness token put <id>` and bound to that harness id. Our harness uses
  `NYLORUN_HARNESS_TOKEN`, bound to `nylorun`.
- A harness in a pod sandbox holds no token: it joins (§9).

## §2 Work: hello, lease, renew, release

- `hello {api: 4, name, version, features}` is the first request.
  - `name` is the harness id: `^[a-z][a-z0-9-]{1,62}$`, and the one the credential is for.
  - `features.workspace` declares that it serves workspaces (§10, optional). A harness declares
    no tools: each tool call names what runs it (§4).
  - The answer is `{api: 4, tenantId, sandbox: {backend}, renewEveryMs}`.
  - Core refuses another `api` and a name that is not the credential's harness.
- `lease {}` waits until core offers a run, then answers `{run: RunGrant, input: TurnStart}`.
  - Core offers a session's runs only to connections of the harness the session pinned when it
    opened: its Environment's `harness`, else `nylorun`.
  - `RunGrant` is `{runId, sessionId, turnId, epoch, token, tokenExpiresAt}`; `token` is the
    run token for the gates (§5).
  - Keep one `lease` waiting for each run you can take.
- `lease.renew {runId}` every `renewEveryMs`. It answers `{ok: true, token?, tokenExpiresAt?}`
  (switch to a new token when one comes) or `{ok: false}` (the run is over: stop it).
- `lease.release {runId, reason}` gives a run back without an output. Reasons: `shutdown`,
  `ownership.lost`, `connection.lost`.

## §3 Input: TurnStart

`TurnStart` (`TurnStartSchema`) carries:

- `type` and `engine`: `turn.start` or `approval.answer`; `agent` or `flow`. A custom harness
  gets agent turns only: flows run in our harness.
- `manifest`: the turn's agent manifest (v7: the session's definition as registered, or a variant
  a message named). It is flat: the agent's own `instructions`, `tools`, `skills` and
  `mcpServers`. A skill or a server that came from an Agent Plugin carries
  `plugin: {name, version?}`. It carries nothing of the Runtime's: what the model reads and which
  tools it is offered are yours to write, from the facts below. Our engine's helpers are in
  `@nylorun/harness`: `engineToolsFor` (all of it, in our order), `sandboxTools` and
  `sandboxInstructions`, `skillCatalogText`, `skillFolderNote` and `skillTools`, and
  `runSkillTool`.
  - Skills: each skill's `name`, `description` and `files` (path to `sha256:<hex>`). Read a
    file's bytes with `definition.file {runId, sha256, offset?, length?}`, at most
    `limits.chunkBytes` a range. With a sandbox, the Runtime mounts each skill's files read-only
    at `/skills/<name>@<hash>/` (`skillFolderOf`).
  - Artifacts: reading and saving them is yours to offer, over the artifact seam (§4b).
- `checkpoint` (`HarnessCheckpointSchema`): `sessionId`, `turnId`, `segment`, `manifestHash`,
  `input` and `state`.
  - `input` is the turn's message: a string, `{text, metadata?}`, `{content, metadata?}`, or
    `{kind: "continue"}` for the next segment of a yielded turn.
  - `state` is yours, as your last output left it (§7).
- `outcomes`: the completed outcomes of this segment, with their request hashes. Replay them
  without asking core again.
- `transcript: {cursor}`: read the transcript with `transcript.read {runId}`, which answers
  `{cursor, entries}`. Entries are `TranscriptEntrySchema` (§6).
- `mcp` (`McpFactsSchema`, optional): the session's MCP discovery as this turn sees it, once a
  run recorded it. It is facts, not tools: naming them for the model, and deciding which to
  defer, is yours.
  - `servers`: each server of the agent tree that connected, `{agentId?, name, instructions?,
    tools}`. `agentId` names the agent used as a tool that declares it (absent for the root);
    `instructions` are the server's own, scrubbed and uncut.
  - Each tool is as the server listed it: `name` (its raw name on the server, which you call it
    by), `description?`, `inputSchema`, `outputSchema?` and `annotations?`, plus `enabled` (false
    when the turn's manifest disables it: skip it, since core refuses its calls as
    `tool.disabled`) and `deferred?` (the manifest's setting, a hint; absent, you decide).
  - Name each tool within 64 characters, the ceiling every provider accepts. Our engine's names,
    `server__tool` with a hash suffix when needed, are `mcpToolName` and `mcpToolNames` in
    `@nylorun/harness`, and `mcpToolSet` builds our whole MCP tool list.
  - Absent until the session's MCP servers are discovered: connect them through the Tool Gate
    (§5) and record what they listed with `session.mcp {runId, snapshot?, diagnostics}`
    (`McpSnapshotSchema`, `snapshotSchemaVersion: 2`). The first snapshot recorded wins; the
    answer is `{mcp?}`, the facts this turn runs with.
- `routing`: where tool calls go.
  - `rootManifest`: the session's pinned manifest.
  - `sandbox`: the session's sandbox: `ownerId` and `environmentId`, which key its workspace,
    `spec`, the sandbox spec the session pinned when it opened (absent without a sandbox), and
    `environment`, the variables every command gets.
- `environment` (`TurnEnvironmentSchema`, optional): the Environment the session runs in,
  `{id, kind, sandbox?: {workspace}}`. `sandbox` is there when the session has a sandbox, and
  `workspace` is the directory its commands start in (`/workspace`). Offer sandbox tools, and
  write a note on the sandbox, only then. It is absent when the session names no Environment.
- `options.fixtureModel`: informational. With the Tenant's fixture model on, the Model Gate
  answers model calls itself, so call it as usual.
- `trace`: optional W3C trace context (`{traceparent, tracestate?}`).
  - Send it as `traceparent` on your gate calls, and as `TRACEPARENT` to processes you start.
  - The Runtime never ingests a harness's spans; send them to your own collector.
- `limits` (`RuntimeLimitsSchema`): the Tenant's Runtime limits when the segment started, in
  bytes. The operator sets them (`PUT /v1/tenant/limits`); keep within them, or core refuses
  what passes one with `limit_exceeded`:
  - `recordEntryBytes`: one entry of the record, as JSON: an `effect.outcome` value, a
    transcript update (§6), a claimed event. Default 960 KiB, its ceiling (S2's 1 MiB record
    less room for the event's envelope).
  - `modelCallBytes`: a Model Gate call's body (default 32 MiB; past it, `400`).
  - `modelFileBytes`: one file the Model Gate sends a model, and the largest a harness should
    show it (default 8 MiB).
  - `toolAnswerBytes`: an MCP or HTTP tool's answer the Tool Gate keeps (default 8 MiB; past it,
    `mcp.too-large` or `http.too-large`), and the tool bodies it reads.
  - `harnessStateBytes`: your state (§7), as JSON (default 256 KiB).
  - `chunkBytes`: one `definition.file` range, `artifact.read` answer or `artifact.write` chunk
    (§4b): ask for and send at most this many bytes (default 16 MiB).
- `model` (`ModelDescriptorSchema`, optional): the model the Model Gate uses for a call that
  names no `model.id`, as the segment started: `{provider, id, inputs, contextWindow,
  maxOutputTokens, reasoning?}`. `inputs` is what it reads (`text` always, and `image`, `pdf`,
  `office`, `audio`, `video` as its catalog and the operator say), and the window and output
  limit are in tokens. The fixture model is `provider: "fixture"` and reads every input. It is
  absent for a flow and when the Tenant has no model. Decide from it how each file of the turn
  reaches the model (§5): the Runtime accepts any file a message names, within the artifact size
  limits.

## §4 Record: intent, outcome, hash, effect ids

Every effect is journaled before it runs.

- **`effect.intent {runId, effect, requestHash}`** (`EffectIntentSchema`). Core decides the
  Tenant's tool policy here, for MCP and HTTP tools: a denied call is answered `completed` with a
  `tool.denied` failure, and a call held for a person is answered `pending`. It answers:
  - `{status: "execute"}`: run it.
  - `{status: "execute", rejoin: true}`: a previous owner left this call running at a gate.
    Send it again with the same key and body to join it or collect its outcome.
  - `{status: "completed", outcome}`: it already ran. Use the outcome.
  - `{status: "pending" | "uncertain"}`: stop the segment with `turn.waiting`.
- **`effect.outcome {runId, effectId, value}`**, or `{..., error}` when you could not learn
  what happened. It answers `completed` with the recorded outcome. A tool call whose fate is
  unknown fails to the model; a model call becomes `uncertain`. A `value` larger than
  `limits.recordEntryBytes` as JSON is refused with `limit_exceeded`, and nothing is recorded:
  core shapes no result, so store the rest with `artifact.write` and report a preview (§5b).

Re-sends:

- Tool calls are delivered at least once. When a gate hop is lost, ask the same intent again.
- An intent for a row still `invoking` is a re-send. Core counts it, up to 3 attempts, and
  answers `execute`, or `completed` with a `tool.interrupted` failure.
- A `sandbox` or `harness` call that a crash interrupted gets `tool.interrupted` at once.

What an intent carries:

- **The effect id** is `<turnId>:<segment>:<kind>:<identity>` (`effectIdOf`). `identity` must
  name the effect stably within the segment, never by call order: a run that starts over must
  ask for the same ids. Core replays to a run only outcomes whose id has its segment's prefix.
- **The request hash** is `effectRequestHash(intent)` over the whole request. For a model
  effect, hash the intent with `input` set to its `ModelCall`, and send the intent without
  `input`. A replay that asks for the same id with another hash is `effect_drift`.
- **`context`** carries the ids the record derives its events from:
  - a model effect needs `invocationId` (the step);
  - a tool effect needs `callId` (the model's tool call id) and `invocationId`, or no
    `tool.completed` is written;
  - a tool effect may name its `stepId`.
- **Kinds:**
  - `model`;
  - `tool` with `toolName`, the name the model called it by (for display only), and `target`,
    what runs it, by identity. Core routes a call by its target, never by its name, and no name
    is reserved. The target is in the request hash, so a replay that names another tool is
    `effect_drift`:
    | `target` | Runs when | Who runs it |
    | --- | --- | --- |
    | `{kind: "mcp", server, tool}` | the call's agent declares `server`, the session discovered `tool` (the server's raw name) on it, and the turn's manifest leaves it enabled | you, through the Tool Gate |
    | `{kind: "http", tool}` | the call's agent declares an HTTP tool named `tool` | you, through the Tool Gate |
    | `{kind: "sandbox"}` | the session has a sandbox and `toolName` is one of `bash`, `read`, `write`, `edit`, `grep`, `glob` | you, in the session's sandbox |
    | `{kind: "harness"}` | always: your own process, whose egress gate is its only control | you |
    Each refusal is answered `completed` with a failure and never runs: an MCP tool the session
    did not discover is `tool.unknown`, one the turn disabled `tool.disabled`, and a call with no
    target, or an HTTP tool or sandbox the session lacks, `tool.unavailable`. Core runs no tool
    itself: `tool_search` over deferred tools is yours (ours is a `harness` call), and the
    deferred tool's call names its own MCP target. A tool of yours may take any name; a name two
    of the model's tools share is yours to refuse. `skill` (optional) names the skill the call
    ran.
  - The tool policy matches the identity too: a rule's `server` and `tool` are the MCP server and
    its raw tool name, or `tool` an HTTP tool's declared name. The name you gave the model never
    matches.
  - `delegation` and `agent` belong to our engine's subagents and flows.
- **What the log records of a tool call.** Each one ends in one `tool.completed`, and a row at
  `GET /v1/sessions/{id}/calls/tool`:
  - `kind`: the target's kind;
  - `server`: the MCP server, or the HTTP tool's URL host;
  - `tool`: the target's identity, an MCP tool's raw name or an HTTP tool's declared name
    (`toolName` stays the model's name);
  - `skill`: the skill the intent named, when the agent has it. Our engine names a skill tool's
    and a sandbox call's whose input names its folder, `/skills/<name>@<hash>/`;
  - `plugin`: `{name, version?}`, the Agent Plugin that brought its MCP server or skill.

## §4b Artifacts

A harness reads and writes the artifacts of the run it holds over two requests. The client
helpers `readArtifact`, `openArtifactWrite` and `writeArtifactBytes` in
`@nylorun/core/harness-api` do the chunking.

**Scope.** Everything is the run's session's, never one you name. Agents used as tools share it.

- You may read the session's own artifacts, and the Tenant-wide ones its messages named.
  Another session's, a Tenant-wide one never named, an Environment's disk versions and a
  missing one are all the same `not_found`, so nothing tells you which exist.
- You may write a new file artifact of the session, or a new version of one of its own file
  artifacts.

**`artifact.read {runId, artifactId, version?, offset?, length?}`** (`ArtifactMetaSchema`):

- It answers `{artifact, offset, base64, eof}`:
  - `artifact` is `{artifactId, kind, name, version, contentType, size, sha256, tenantWide}`, for
    `version` (default the latest);
  - `base64` is the bytes from `offset` (default 0), at most `length`;
  - `eof` says no bytes are left past this chunk.
- `length` defaults to `turn.start.limits.chunkBytes`, and is held to it. `length: 0` asks for
  the metadata alone.
- An `offset` past the end is `invalid`; one at the end answers no bytes and `eof: true`.
- A folder answers its metadata, with no bytes.
- Ask for later chunks with the version the first answer named, since a new one may land.

**`artifact.write`** is an upload in steps, each a request with `op`:

| `op` | Params | Answer |
| --- | --- | --- |
| `begin` | `key`, then `name` (a new artifact) or `artifactId` (a new version); optional `contentType` (default: from the name), `size`, `effectId`, `base64` | `{status: "open", uploadId, maxBytes, received: 0}`, or `written` |
| `chunk` | `uploadId`, `offset`, `base64` | `{status: "open", uploadId, maxBytes, received}` |
| `commit` | `uploadId` | `{status: "written", artifact, created}` |
| `abort` | `uploadId` | `{status: "aborted"}` |

- **One chunk** carries at most `turn.start.limits.chunkBytes`; a larger one is
  `limit_exceeded`. A `begin` with `base64` sends the whole body at once and commits it.
- **Offsets.** Each chunk's `offset` must be `received`. A repeat of the last chunk, whose answer
  you lost, is acknowledged and not taken twice; any other offset is `invalid`.
- **Limits.** `maxBytes` is what the upload may hold when it opens: the file limit, or what is
  left of the Tenant's or the Environment's total. A declared `size` past it, or bytes past it,
  are `limit_exceeded`, with `limitBytes` in the message. The totals are checked again at commit.
- **Idempotency.** `key` makes the write idempotent within the session: a `begin` with a key
  already written answers `{status: "written", created: false}` with that version, and sends
  nothing more. Our harness uses a tool call's effect id as its key.
- **Provenance.** `effectId` names a tool effect of the run's turn, journaled first. The
  artifact's `artifact.created` (or `artifact.version.created`) event then carries that call's
  `callId`, which core reads from its journal. Any other effect is `invalid`.
- **Ends.** An upload your run leaves open ends with the run, and nothing of it is stored.
  `abort` ends one now, and answers `aborted` for one already gone.

Errors:

| Code | When |
| --- | --- |
| `not_found` | The artifact is not there for the run, or `artifactId` is not one of the session's file artifacts |
| `limit_exceeded` | A chunk past `chunkBytes`; a file or total artifact limit |
| `invalid` | A bad name or media type, no name, an offset other than `received`, an unknown `uploadId`, an `effectId` not a tool call of the turn |
| `run_not_held`, `turn_cancelled`, `ownership_lost` | As for every run request |

## §5 Gates

The gates run on the gateway, at `NYLORUN_GATES_URL`, and hold every model and tool credential.
A harness never sees one.

- Send `Authorization: Bearer <run token>` and `Idempotency-Key: <effect id>` on every call.
  The gate hands a tool the same key: `Idempotency-Key` to an HTTP tool, and
  `_meta["nylorun/idempotency-key"]` on an MCP `tools/call`. A tool that must act once checks it.
- A tool call must be journaled first (`effect.intent` answered `execute`), or the gate refuses
  it: `400 key_required` or `409 effect_not_journaled`.
- Gate errors are `{error: {code, message}}` with `GATE_ERROR_CODES`. `409 run_stale` means the
  run is over.

The calls:

- **Model.** `POST /nylorun/v1/model-calls` with `ModelCallBodySchema`:
  `{effectId, invocationId, call: ModelCall}`. A `ModelCall` carries
  `{prompt, tools, model?, executionId}`, where `executionId` is the session id.
  - A media part's `reference` names an artifact version (`{artifactId, version}`); the gate
    fetches it under the session's read rule (§4b) and sends it in the provider's own format: an
    image as image input, a PDF, Office document, audio or video as the API's native block.
  - The gate decides nothing about files and writes no text of its own. It refuses, before
    anything is sent and never retried: a text file as a media part, or a kind the model or its
    API does not read (`unsupported_input`; inline text yourself, and tell the model about a file
    it cannot read); a reference it cannot fetch (not the session's, missing, a folder, past
    `limits.modelFileBytes`: `invalid_request`).
  - It adds no output-schema instruction and repairs no JSON: for a structured answer, write the
    instruction yourself and parse the model's text.
  - It answers `200 {outcome}`: a `ModelCandidate` (`output` blocks, `finishReason`, `usage`) or
    a failure `{kind: "failed", code, message, retryable}`.
  - The gate meters every call: one `model_usage` row per effect id, readable with its
    `effectId` at `GET /v1/sessions/{id}/calls/model`.
  - `POST /nylorun/v1/model-calls/{key}/cancel` aborts a call.
- **MCP.** `mcp/connect`, `mcp/list`, `tool-calls` (`ToolCallBodySchema`) and `mcp/close` name
  a server the agent declares, never a URL: `server: {agentId?, serverName}`. A `tool-calls`
  body is `{server, effectId, name, arguments}`, with `name` the tool's raw name on the server,
  `target.tool`. The gate runs it only when the journaled row's target names the same agent,
  server and tool.
- **HTTP tools.** `http-calls` (`HttpCallBodySchema`) names a manifest tool.
- **Answers.** MCP and HTTP calls answer `200 {ok: true, result}` or `{ok: false, error}`; a
  tool's failure is an answer, not a gate error. `tool-calls/{key}/cancel` aborts either. The
  gate replaces the credential values it sent that an answer echoes with `[redacted]`, and
  refuses an answer past `limits.toolAnswerBytes` (`mcp.too-large`, `http.too-large`). It shapes
  nothing else: the whole result is yours to fit (§5b). A re-send under the same key returns the
  same bytes.

## §5b Tool results

A tool's answer can be far larger than one record entry. Fitting it is the harness's job.

- **What must fit.** Each `effect.outcome` value, and each transcript entry (§6), is at most
  `limits.recordEntryBytes` as JSON. A step's results are one `tool-results` entry, so they
  share it.
- **Spill the rest.** Store what does not fit as file artifacts with `artifact.write` (§4b),
  with the call's `effectId`, so `artifact.created` names the call. Report a preview the model
  can act on, and let it read the rest (ours: `read_artifact`).
- **Key each store by the call.** A crash can run a call again, and the gate answers it with
  the same bytes. A key made from the effect id and the bytes' hash writes nothing new then.
- **Binary parts.** An MCP `image`, `audio` or blob `resource` part is base64 in the answer.
  Store it, and send an image to the model as a file only when `turn.start.model` reads images.
- **Our shaping is reusable.** `@nylorun/harness` exports what our engine does:
  - `shapeToolOutcome(value, ctx)`: one outcome, shaped to a cap;
  - `StepBudget`: one step's budget, `stepBudgetBytes` (256 KiB) held under
    `recordEntryBytes` less `entryEnvelopeBytes` (4 KiB). Each MCP or HTTP result gets at most
    `resultInlineBytes` (32 KiB), and a result once the budget is spent a 512-byte stub naming its
    artifact;
  - `spillKey(effectId, index | "whole", bytes)`: the store's key;
  - `DEFAULT_TOOL_RESULT_CONFIG` and `ToolResultConfig`.
- **What our engine sends the model.** Text or JSON past the cap becomes `{truncated: true,
  artifactId, size, preview}`, the first 4 KiB and the last 1 KiB. A store refusal keeps the
  preview, with `dropped` saying why. A result that still cannot fit fails as
  `tool.result-too-large`.

## §6 Transcript

The session's transcript is shared by every turn. A segment reads it once and reports its edits
as `TranscriptUpdate`s, `{keep, entries, length}`, made with `transcriptUpdates(before, after)`.
Entries are one of five kinds (`TranscriptEntrySchema`):

- `input`: the turn's input event;
- `candidate`: the model's answer, by `stepId`;
- `tool-results`: the step's tool results;
- `final`: the turn's output;
- `compaction`: a summary that replaced the older part. It is always first.

History, `transcript.read` and the next turn's cursor fold these edits, so write these kinds
only.

## §7 Output

End each segment with one output request (`TurnOutputSchema`):

| Status | Method | Meaning |
| --- | --- | --- |
| `completed` | `turn.completed` | The turn is done; `output` is its result. |
| `failed` | `turn.failed` | With `error: {code, message}`, or `thrown` for a loop that threw. |
| `cancelled` | `turn.failed` | Report this after a cancel. |
| `waiting` | `turn.waiting` | An effect is `pending`: core waits for it. |
| `uncertain` | `turn.waiting` | An effect is `uncertain`. |
| `yielded` | `checkpoint` | The turn goes on in a new segment: same turn, next segment. |
| `paused` | `turn.paused` | Our engine only, in v4. |

The output also carries:

- `state`: what you want back next segment. It is stored as you send it and never read.
  - A custom harness's state is at most `limits.harnessStateBytes` (256 KiB by default), or the
    turn fails (`limit_exceeded`).
  - Return some state on every segment.
- `transcript`: your edits (§6).
- `effectIds`: the effects a waiting segment waits on. When they are calls the tool policy holds,
  core pauses the turn with one `approval` interaction per call, whose id is the effect id. An
  MCP call's interaction names its `server` and `tool` (`Approve <server> / <tool>?`), and
  `toolName` stays the model's name. Once
  a person answers, a new segment replays: an approved call's intent answers `execute`, a denied
  one's `completed` with `tool.denied`. A harness needs nothing more for approvals.

The answer is `{cursor}`: the transcript's new cursor, for your cache.

## §8 Cancel and abort

- Core sends `cancel {runId, reason, message?}` as a message, with `reason` one of `cancel`,
  `shutdown`, `deadline` and `ownership.lost`.
- On `cancel` and `deadline`: stop, cancel the gate calls you started (their `cancel` routes),
  and report `turn.failed` with status `cancelled`.
- On `shutdown` or `ownership.lost`: send `lease.release`. Another owner replays the segment
  from its journal.
- `{t: "abort", id}` cancels one request in flight.

## §9 Pod host

A harness in a pod sandbox is the pod: a pod Environment whose `harness` is not ours runs its
`image`'s own entrypoint, with nothing of ours copied in.

The pod's environment:

| Variable | What it is |
| --- | --- |
| `NYLORUN_SANDBOX_ID` | The sandbox to join as |
| `NYLORUN_POD_UID` | The pod's UID |
| `NYLORUN_SANDBOX_JOIN_FILE` | The mounted join token; read it afresh at each join |
| `NYLORUN_HARNESS_URL` | `http://host:port`, without the path |
| `NYLORUN_GATES_URL` | The gates |
| `NYLORUN_EGRESS_PROXY` | The egress proxy every command must use |
| `HOME` | `/harness/home` |

How it joins and stays joined:

1. `POST /nylorun/harness/v1/host/join` with `{sandboxId, podUid, joinToken, volumeId?}`
   (`HostJoinRequestSchema`). Keep `volumeId` on the volume (`/harness/volume-id`), so a volume
   recreated empty is told apart.
2. The answer (`HostJoinAnswerSchema`) is `{hostToken, egressToken, sandboxId, epoch,
   expiresAt, caCertificate}`. On a new disk, a join also carries the Environment's `setup`:
   its input files and setup commands. Our engine runs them before it takes turns, and a custom
   harness runs them itself or ignores them. `seeded: true` means the disk starts from a disk
   version, so there is no setup to run.
3. Connect with the host token as the WebSocket bearer. Say `hello` with the Environment's
   harness id; any other is refused.
4. Every 5 minutes, `POST .../host/renew` with the host token as bearer. Join again when a
   renewal is refused.

Every command the harness starts uses the egress proxy, with the egress token as its password
and the CA certificate added to its trust bundle. The workload runs as uid 1000, on a read-only
root, with `/workspace`, `/harness`, `/tmp` and `/skills` writable.

## §10 Workspace (optional)

A harness that declares `features.workspace` serves sandbox workspaces: core sends it
`workspace.read`, `workspace.write`, `workspace.exec`, `workspace.report`, `workspace.sweep` and
`workspace.remove`.

- A pod's host serves its own pod.
- A session's workspace off a pod is served by its own harness, if that harness declared the
  feature: our harness's workspaces are never a custom harness's files. Sweeps and removes go
  to ours.
- Without the feature, core answers the turn-end export and the session sandbox routes with
  "missing", and turns still run.

## §11 Versioning

There are three numbers:

- the transport (path and header): 1;
- the messages: `HARNESS_API_VERSION`, 4;
- the Runtime protocol, which only the Runtime and Management APIs carry.

v4's schemas are strict, and v4 is frozen: a change to a message is a new version. Core speaks
one version: a harness that says `api: 3` is refused.

What v4 changed (protocol 15, the harness boundary):

- the artifact seam: `artifact.read` and `artifact.write` (§4b), and the error code `not_found`;
- the manifest has no `runtime` block: the harness writes the model's instructions and defines
  its tools from the facts in `turn.start` (§3): `environment`, `routing.sandbox.spec` and the
  agent's `skills`. Core runs neither the artifact tools nor the skill tools; ours run in our
  harness, over the artifact seam and `definition.file`;
- a tool call names its `target` and may name its `skill` (§4): core routes by the target's
  kind, and a call without one runs nothing. `hello.features.tools` is gone, and no tool name is
  reserved;
- `turn.start.model` (§3), and files are the harness's to show: the Model Gate only fetches and
  translates, refusing what the provider cannot take (`unsupported_input`), and `ModelCall` has no
  `outputSchema` (§5);
- the MCP surface: `turn.start.mcp` (raw facts, with `enabled` and a `deferred` hint) replaced
  `sessionTools` and `routing.mcpSnapshot`, `session.mcp` answers `{mcp?}`, and the snapshot is
  `snapshotSchemaVersion: 2` with raw names (§3). The harness names, defers and searches MCP
  tools; core runs no `tool_search`, and the target kind `platform` is gone;
- a tool call's target is its identity, `{kind: "mcp", server, tool}` or `{kind: "http", tool}`,
  in the request hash; the record refuses an undiscovered MCP tool as `tool.unknown`; the tool
  policy and approvals key on the identity; tool rows and `tool.completed` carry `tool` (§4);
- tool results are the harness's to fit: core shapes nothing and refuses an outcome past
  `recordEntryBytes`; spill with `artifact.write` (§5b).

v3 renamed `hello.capabilities` to `features`, removed `capabilityId` from effects, gate calls and
MCP records, and gave the harness flat manifests (protocol 13); `definition.file`'s
`offset`/`length` and `turn.start.limits` came within it. The next version adds a window of
supported versions (N and N−1).

What a custom harness cannot do in v4:

- pause the turn itself (the tool policy's approvals work without it, §7);
- run flows;
- receive another harness's workspace requests.

## Build your own harness

1. **Start from the example.** Copy
   [`examples/harness-minimal`](../examples/harness-minimal/README.md). It shows each section
   above in one loop: hello, lease, read the transcript, call the Model Gate, run `bash`, and
   journal every effect before running it.
2. **Run it beside ours.** The operator makes its token and names it on an Environment:

   ```bash
   docker compose exec runtime nylorun-operate harness token put minimal
   ```

   Run the harness on the Compose project's harness network with that token as
   `NYLORUN_HARNESS_TOKEN`. Create an Environment with `harness: "minimal"`
   (`PUT /v1/environments/{id}`) and open sessions on it. Sessions on other Environments keep
   running ours.
3. **Check it.** On a Tenant for testing, turn on the fixture model
   (`PUT /v1/tenant/config/seed {fixtureModel: true}`, a management key) and send scripted turns:
   `fixture:text` answers `fixture ok`, and `fixture:tool bash {"command":"echo hi"}` calls
   `bash` once. Then read what the Runtime recorded: the turn ends `turn.completed` with
   `source: {kind: "harness", id: "minimal"}`, `GET /v1/sessions/{id}/calls/model` has one
   metered call per model answer, and `GET /v1/sessions/{id}/calls/tool` has one journaled call
   per command.
4. **Ship it as a pod image.** Build the harness into the image your agents' tools need (uid
   1000, read-only root, `HOME=/harness/home`), push it, and use a pod Environment:
   `{kind: "pod", image: "<your image>", harness: "minimal"}`. Then send the same turns to a
   session on it.
5. **Restrict where harnesses run.** The Tenant's placement
   (`PUT /v1/tenant/sandbox {placement}`) maps harness ids to hosts. `"*": {hosts: []}`
   refuses any harness it does not name.

The log marks what a harness reported: its events say `source: {kind: "harness", id}`, its
`runId` and evidence `claimed`. The gate's usage row, keyed by the same effect id, is the
measured record of each model call.
