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
  `effect_drift`, `invalid`, `unavailable`, `internal`.

Which token:

- A harness container uses its own token, made by the operator with
  `nylorun-operate harness token put <id>` and bound to that harness id. Our harness uses
  `NYLORUN_HARNESS_TOKEN`, bound to `nylorun`.
- A harness in a pod sandbox holds no token: it joins (§9).

## §2 Work: hello, lease, renew, release

- `hello {api: 3, name, version, features}` is the first request.
  - `name` is the harness id: `^[a-z][a-z0-9-]{1,62}$`, and the one the credential is for.
  - `features.tools` declares tools the harness runs itself (§4).
  - `features.workspace` declares that it serves workspaces (§10, optional).
  - The answer is `{api: 3, tenantId, sandbox: {backend}, renewEveryMs}`.
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
- `manifest`: the turn's agent manifest (v7: the session's, or a variant a message named). It is
  flat:
  - the agent's own `instructions`, `tools`, `skills` and `mcpServers`. A skill or a server that
    came from an Agent Plugin carries `plugin: {name, version?}`;
  - `runtime`, which the Runtime wrote when the session pinned the agent: the session's
    `sandbox` spec, the `tools` the Runtime serves (the sandbox tools, `save_artifact`,
    `read_artifact`, `load_skill` and `read_skill_resource`) and the `instructions` that go
    with them (the skill catalog, the sandbox's and the artifacts' notes). Offer the model the
    agent's tools and `runtime.tools`, and put `instructions` before `runtime.instructions`.
  - A variant never sets `runtime`: the turn runs with the pin's.
- `checkpoint` (`HarnessCheckpointSchema`): `sessionId`, `turnId`, `segment`, `manifestHash`,
  `input` and `state`.
  - `input` is the turn's message: a string, `{text, metadata?}`, `{content, metadata?}`, or
    `{kind: "continue"}` for the next segment of a yielded turn.
  - `state` is yours, as your last output left it (§7).
- `outcomes`: the completed outcomes of this segment, with their request hashes. Replay them
  without asking core again.
- `transcript: {cursor}`: read the transcript with `transcript.read {runId}`, which answers
  `{cursor, entries}`. Entries are `TranscriptEntrySchema` (§6).
- `sessionTools`: the session's MCP tools, as the model should see them.
- `routing`: where tool calls go.
  - `rootManifest`: the session's pinned manifest.
  - `mcpSnapshot`: the session's MCP tools by server (`McpSnapshotSchema`).
  - `sandbox`: the session's sandbox, and `environment`, the variables every command gets.
- `options.fixtureModel`: informational. With the Tenant's fixture model on, the Model Gate
  answers model calls itself, so call it as usual.
- `trace`: optional W3C trace context (`{traceparent, tracestate?}`).
  - Send it as `traceparent` on your gate calls, and as `TRACEPARENT` to processes you start.
  - The Runtime never ingests a harness's spans; send them to your own collector.

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
  unknown fails to the model; a model call becomes `uncertain`.

Re-sends:

- Tool calls are delivered at least once. When a gate hop is lost, ask the same intent again.
- An intent for a row still `invoking` is a re-send. Core counts it, up to 3 attempts, and
  answers `execute`, or `completed` with a `tool.interrupted` failure.
- A sandbox call, or a call core serves, that a crash interrupted gets `tool.interrupted` at
  once.

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
  - a tool effect may name its `stepId`, which shares one result budget among the step's calls.
- **Kinds:**
  - `model`;
  - `tool` with `toolName`. Tools are known by name: a manifest tool (`tools` or
    `runtime.tools`), an MCP tool from the snapshot (`server__tool`), or a tool you declared in
    `hello`. Any other tool is answered `completed` with a `tool.unavailable` failure and never
    runs. A tool you declare may not take a name the agent or the Runtime already uses: the
    turn fails at its start.
  - `delegation` and `agent` belong to our engine's subagents and flows.

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
  `{prompt, tools, outputSchema?, executionId}`, where `executionId` is the session id.
  - It answers `200 {outcome}`: a `ModelCandidate` (`output` blocks, `finishReason`, `usage`) or
    a failure `{kind: "failed", code, message, retryable}`.
  - The gate meters every call: one `model_usage` row per effect id, readable with its
    `effectId` at `GET /v1/sessions/{id}/calls/model`.
  - `POST /nylorun/v1/model-calls/{key}/cancel` aborts a call.
- **MCP.** `mcp/connect`, `mcp/list`, `tool-calls` (`ToolCallBodySchema`) and `mcp/close` name
  a server of the snapshot, never a URL.
- **HTTP tools.** `http-calls` (`HttpCallBodySchema`) names a manifest tool.
- **Answers.** MCP and HTTP calls answer `200 {ok: true, result}` or `{ok: false, error}`; a
  tool's failure is an answer, not a gate error. `tool-calls/{key}/cancel` aborts either.

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
| `paused` | `turn.paused` | Our engine only, in v3. |

The output also carries:

- `state`: what you want back next segment. It is stored as you send it and never read.
  - A custom harness's state is at most 256 KiB (`MAX_HARNESS_STATE_BYTES`), or the turn fails.
  - Return some state on every segment.
- `transcript`: your edits (§6).
- `effectIds`: the effects a waiting segment waits on. When they are calls the tool policy holds,
  core pauses the turn with one `approval` interaction per call, whose id is the effect id. Once
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
- Without the feature, core answers `save_artifact`, the turn-end export and the session
  sandbox routes with "missing", and turns still run.

## §11 Versioning

There are three numbers:

- the transport (path and header): 1;
- the messages: `HARNESS_API_VERSION`, 3;
- the Runtime protocol, which only the Runtime and Management APIs carry.

v3 is frozen: its schemas are strict, so a field is added only in a new version. Core speaks one
version: a harness that says `api: 2` is refused. v3 renamed `hello.capabilities` to `features`,
removed `capabilityId` from effects, gate calls and MCP records, and gives the harness flat
manifests (protocol 13). The next version adds a window of supported versions (N and N−1).

What a custom harness cannot do in v3:

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
