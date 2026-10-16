# Agent execution

Agent definitions describe what an agent has. The engine advances execution; a host
persists progress and connects it to external systems.

## Language

**Manifest**: The serializable description of an agent: its instructions, tools, skills and MCP
servers. A session pins it as registered (protocol 15: no `runtime` block), and its canonical hash
identifies the definition used by an execution.

**Binding**: The local pairing of a manifest with its ordered parts, executable
tool snapshots and live schema validators. Functions in a binding stay local.

**Turn loop**: The progression from model calls through tool outcomes to a final
result or a durable wait. A supplied checkpoint is not mutated by a new invocation.
(The workflow primitive named **Loop** is separate; see below.)

**Step**: One model call together with its tool plan.

**Host**: The OSS or Cloud runtime that owns persistence, scheduling,
authentication and provider access around the shared engine.

**Manifest-only agent**: The host runs the agent from its manifest alone and never calls
the developer's code during a session (track R2): a tool is an HTTP tool, a remote MCP
server's, an agent used as a tool or a host built-in. A tool with an implementation
(`tool({ run })`) runs only in the local engine (`/run`); a host refuses it at save.
_Avoid_: "Action endpoint" and "executor" (removed in protocols 8 and 3).

**HTTP tool**: A tool the manifest describes as one HTTP request (`http`, built with
`http()`), which the host's Tool Gate makes; the engine runs it as a `tool` effect like any
hosted tool. The engine never asks for approval of an HTTP or MCP call: the host's tool policy
does, as it journals the effect (a `pending` intent while a person decides).

**MCP tools**: The session's remote MCP tools as our engine offers them (protocol 15,
`mcpToolSet` in `tools/mcp.ts`), made from the facts the Runtime states (`turn.start.mcp`: each
server's tools by their raw names and schemas, with `enabled` and the manifest's `deferred` hint).
Our engine skips a tool the turn disables (`enabled: false`; the record would refuse it as
`tool.disabled`) and one whose input schema does not compile, names the rest (**MCP tool name**),
and makes each call an effect of the tool's identity (`target: {kind: "mcp", server, tool}`,
`tool` the raw name). They come after the agent's own tools and our **engine tools**: the listed
ones in the servers' order, then per agent with deferred tools `tool_search` (with its note),
`tool_call` and the deferred tools. `runDurable({ mcp })` takes the set (it replaced
`sessionTools`); not hashed.
_Avoid_: "session tools" for them; the Runtime states facts, our engine makes the tools.

**MCP tool name**: What the model calls an MCP tool: ours to choose, since the Runtime never names
one (`mcpToolName`, `mcpToolNames`; R2b C6). `server__tool` with each character outside
`[A-Za-z0-9_-]` replaced by `_`; a name over `MODEL_TOOL_NAME_MAX` (64, a provider ceiling), or a
renamed one that collides, keeps 55 characters and adds `_` and 8 hex characters of the SHA-256
of `server/tool`. Names that need no change go first, so a renamed tool never takes another's;
a name the agent's own tools, our engine's or an earlier server's already took leaves the tool
out. The Management API's MCP tool preview shows these names (`modelName`, `renamed`).

**Deferred session tool**: An MCP tool out of the model's tool list (R2b C10): the model finds it
with **tool search** and runs it with `tool_call`, which checks the arguments against the tool's
`inputSchema` and makes the call as the tool's own effect (its identity `target` included), so
the host's tool policy, the record's routing and the result's shaping are a direct call's
(`deferredToolCall`, `run/durable.ts`). Ours to decide (protocol 15): the manifest's `deferred`
setting when it says (`McpToolFact.deferred`, a hint), else every tool of an agent whose listed
MCP tools (their name, description and `inputSchema` as JSON) pass `deferShare` of the model's
context window at `charsPerToken` characters a token (the window is `turn.start.model`'s, else
`fallbackContextWindow`). Decided once per facts and kept (**MCP layout**).

**Tool search**: `tool_search { query, limit? }` (`tools/tool-search.ts`, `TOOL_SEARCH_TOOL`):
our engine's tool, a `harness` effect the API host runs itself over the run's MCP tools
(`runToolSearch`, `api/host.ts`), never core. It ranks an agent's deferred tools with BM25 over
their name tokens and the server's own tool name and description (`tokens`, `rank`), returns
each match's name, description and `inputSchema` (`toolSearchDefaultLimit` 8, at most
`toolSearchMaxLimit` 20), and reads only the layout's deferred tools, so the same query finds the
same tools while it stands; a tool the turn disables is never there. Its note
(`deferredToolsNote`) names each server with deferred tools, how many, and its instructions cut
to `serverInstructionsMaxChars` with `…`. `deferredToolsTools(config)` gives both tools'
definitions to a harness of your own.
_Avoid_: "platform tool" (core ran it before protocol 15).

**MCP layout**: Which of the session's MCP tools our engine defers (`McpLayout`,
`ExecutionState.mcpLayout = {factsHash, deferred}`, `deferred` the identity keys
`mcpToolKey(agentId, server, tool)`): decided the first time the facts are seen, written into the
state the segment ends with, and followed while the facts' hash matches, so every model call of
the session lists the same tools (a stable prompt prefix) and a switch of the Tenant's model
neither changes the list nor drifts a replayed model call. New facts (a turn variant that
disables a tool, a rediscovery) decide it again.

**Spilled tool result**: A tool result our engine stored as file artifacts of the session so its
outcome fits the record (R2b C11, protocol 15; `tools/results.ts`, exported for a harness of
your own). The API host shapes every `mcp`, `http` and `sandbox` outcome before `effect.outcome`
(`shapeToolOutcome`; not our `harness` tools, which size their own; a cancel skips it), since the
record refuses an entry past `limits.recordEntryBytes` and a step's results are one transcript
entry. One step's results (`[agent, stepId]`) share a **step budget** (`StepBudget`):
`max(stubBytes, min(stepBudgetBytes, recordEntryBytes − entryEnvelopeBytes))`; each result's cap
is what its step has left, at most `resultInlineBytes` for an MCP or HTTP tool and at least
`stubBytes`; shaping is serialized per step, and replayed and completed answers count. Text or
JSON past the cap is stored and the model gets `{truncated: true, artifactId, size, preview}`
(`previewHeadBytes` and `previewTailBytes`); each part of an MCP result is shaped alone, the
largest text first. An `image`, `audio` or blob `resource` part always becomes an artifact; an
image also goes to the model as a file when the turn's model reads it (`fileView`). Each store is
`writeArtifactBytes` under the **spill key** `spillKey(effectId, index | "whole", bytes)` =
`tr:` + SHA-256 of `${effectId}\n${index}\n${sha256(bytes)}`, named `${toolName}-result[-n].ext`,
in `limits.chunkBytes` chunks, linked to the call (`effectId`): a call the gate answers again with
the same bytes after a crash writes nothing new. A store refusal keeps the preview with `dropped`;
a result still past the budget becomes `{kind: "failed", code: "tool.result-too-large"}`.
_Avoid_: "stored tool result" (core no longer shapes results).

**Engine tool config**: The harness's configuration of our engine's tools (`EngineToolOptions`,
from `createHarness`): `artifactPageBytes`, `sandboxTools` (**sandbox tool limits**),
`skillReadBytes`, `mcpTools` (`McpToolConfig`, `DEFAULT_MCP_TOOL_CONFIG`: `deferShare` 0.1,
`charsPerToken` 4, `fallbackContextWindow` 32,768, `serverInstructionsMaxChars` 2,000,
`toolSearchDefaultLimit` 8, `toolSearchMaxLimit` 20) and `toolResults` (`ToolResultConfig`,
`DEFAULT_TOOL_RESULT_CONFIG`: `resultInlineBytes` 32 KiB, `previewHeadBytes` 4 KiB,
`previewTailBytes` 1 KiB, `stepBudgetBytes` 256 KiB, `stubBytes` 512, `smallBytes` 1 KiB,
`minPreviewBytes` 64, the smallest preview a stub keeps, `entryEnvelopeBytes` 4 KiB). `createHarness({ mcpTools?, toolResults? })` takes partial ones over
the defaults. Not Runtime limits: those the run states (`turn.start.limits`), and these stay under
them.

**Engine config**: Everything a harness sets of our engine (`EngineConfig`, `createHarness`; B15):
the engine tool config, the **loop config** (`LoopConfig`: `compaction`, a `CompactionConfig` over
`DEFAULT_COMPACTION_CONFIG`, and `partialOutputChars`, how much of a failed agent-as-tool's last
output its parent sees, 4,000 by default), and `resendDelaysMs` (the waits before each resend of
a tool call whose gate hop lost its answer, `DEFAULT_RESEND_DELAYS_MS` 1, 2 and 4 s, the last
repeated). `createHarness` also takes `transcriptCacheMb` (256 MiB), `leaseRetryMs` (100 ms) and
`flowValueChars`, how much of a value a flow's failure message quotes
(`DEFAULT_FLOW_VALUE_CHARS`, 80).
The loop config reaches the engine through `runDurable({ loop })` (`ExecuteInternals.loop`), and an
invocation hands its own to each agent it uses as a tool; a local `run()` uses the defaults. The
Runtime's harness host passes the Host tuning's `engine` group (`NYLORUN_TUNING`) here.
_Avoid_: hard-coding any of them in the loop.

**Engine tool**: A tool our engine adds to each agent of a session's tree (protocol 15),
with the text that goes with it (`engineToolsFor`, `tools/engine-tools.ts`), from the facts
`turn.start` states: the Environment (`environment.sandbox.workspace`) and the agent's `skills`.
In one order, which keeps the prompt's prefix stable (`test/prompt-prefix.test.ts`):
instructions are the skills' usage and catalog, the sandbox note, the skills' folder note, then
the artifact notes; tools are the six sandbox tools (`tools/sandbox.ts`), `load_skill` and
`read_skill_resource` (`tools/skills.ts`), `save_artifact` and `read_artifact`
(`tools/artifacts.ts`). Their names, descriptions, schemas and text are ours; they are offered
like the MCP tools (`runDurable({ engineTools })`: after the agent's own tools, before the
session's MCP tools, with their text before the MCP tools' own, not hashed). Each names its calls'
**effect target**: a sandbox tool `sandbox` (the host runs it in the session's sandbox, through
`executors.tool`), the skill and artifact tools `harness` (the API host runs them itself,
`api/host.ts`: the skill tools over `definition.file`, the artifact tools over the artifact
seam; `tool_search` over the run's MCP tools). An author tool of the same name fails the turn
(`agentFrom`, `agent.build-failed`).

**Effect target**: What runs a tool effect, by identity (`HostEffect.target`, protocol 15):
`{kind: "mcp", server, tool}` (`tool` the server's own name), `{kind: "http", tool}` (the
declared name), `{kind: "sandbox"}` or `{kind: "harness"}`; `platform` is gone. Core routes,
decides policy and journals the call by it, never by the name the model used (`toolName`, for
display); it is in the request hash, so a replay with another identity is `effect_drift`. An
author's code tool names none, and the record fails it to the model. A tool effect also names
the `skill` it ran (`skillOfToolCall`, `tools/trace.ts`: a skill tool's, or a sandbox call whose
input names a skill's folder), which the record keeps when the agent has that skill.

**Sandbox tool limits**: The harness's configuration of its sandbox tools (`SandboxToolLimits`,
`DEFAULT_SANDBOX_TOOL_LIMITS`; `createHarness({ sandboxTools })`): the `bash` timeouts, the `read`
line counts, the `grep` and `glob` counts and the characters of output and of a line. Our engine
writes the schema maxima and defaults from it, and the host runs the calls with the same
(`harnessExecutors({ sandboxTools })`). Not Runtime limits: the Runtime holds what crosses it.

**Skill read bytes**: The most bytes of one skill file the skill tools read into the model's
context (`createHarness({ skillReadBytes })`, 10 MiB by default), held also to the run's
`limits.recordEntryBytes`, since an answer is one record entry; a larger file is
`skill.resource_too_large`, used in the sandbox when there is one.

**Skill folder**: Where one skill version's files are in the sandbox, read-only:
`/skills/<name>@<hash>/` (`skillFolderOf`). Our engine decides the folders and when (protocol 15):
before each `sandbox` call it mounts each skill version of the turn's tree (`sandboxSkillsOf`,
the agent and the agents it uses as tools) with `executors.files.mount`, the bytes read over
`definition.file` a `chunkBytes` range at a time (`definitionFileChunks`, `mountSkills` in
`tools/skills.ts`). The host only writes them, once per open sandbox: a folder it holds answers
`present`, and a reopened sandbox gets them again on its next call. One that cannot be written is
the sandbox call's failed outcome (`sandbox.skills_unavailable`), and the call never runs.

**Outputs folder**: Our engine's convention (Q5, protocol 15, `tools/outputs.ts`): when an agent's
segment ends its turn `completed` in a session with a sandbox, it saves the outputs directory
(`/workspace/outputs`) as a version of the session's `outputs` folder artifact over the artifact
seam (`artifact.write` with `kind: "folder"`, key `outputs:<turnId>`), before `turn.completed`:
`files.list`, then each file's bytes (`files.read`) with its SHA-256, whole in its `file` request
or in `chunk`s naming it, then `commit`. A version equal to the latest is not added. At most the
Runtime limit `folderEntries` files, each within the seam's per-file limit, within the seam's
total and **outputs config** `maxBytes`; past one it claims `artifact.export.skipped`, and a
failure `artifact.export.failed`. It never fails the turn.

**Outputs config**: The harness's configuration of the outputs folder (`OutputsConfig`,
`DEFAULT_OUTPUTS_CONFIG`; `createHarness({ outputs })`): its directory, and the most bytes one
save reads and sends (1 GiB by default).

**Artifact seam**: How the harness reads and writes the artifacts of the run it holds
(`artifact.read`, `artifact.write`; the client helpers `readArtifact`, `openArtifactWrite`,
`writeArtifactBytes` in `@nylorun/core/harness-api`), in chunks of at most the run's
`turn.start.limits.chunkBytes`. `read_artifact` reads a page (`artifactPageBytes`, harness
configuration, 32 KiB by default; whole UTF-8 characters, held to its size escaped as JSON) or,
with `path`, streams the whole artifact into the sandbox (`executors.files.write`);
`save_artifact` writes text, or a sandbox file it reads within the upload's room
(`executors.files.read`), keyed by its effect id so a repeat stores nothing twice. A refusal
(`not_found`, `limit_exceeded`, `invalid`) is a failed outcome the model sees. A non-text file
`read_artifact` loads goes to the model as a file of the result when its **file view** is media,
and is `artifact.unsupported` (with the view's reason) when it is a note.

**SDK client**: The shared application interface for communicating with a host.
Authoring accompanies it in the agents SDK.

**Failure outcome**: A model call that failed in a known way (`{kind: "failed", code, …}`),
returned by the adapter instead of a candidate. The step fails with `model.<code>`; it is a
completed outcome, never `uncertain`.

**Compaction**: Replacing the older part of the transcript with a summary the model wrote,
so the next prompt fits the model's window. Recorded as a `compaction` entry, always first,
with the reference lines of the files it summarized away (`files`). Its model calls say
`purpose: "summary"` (no assistant message is recorded for them), and the segment's transcript
edit that replaced the history says so (`kind: "compaction"`, Q4, protocol 15): its trigger and
token estimates, and the root agent's summary calls of the segment (`summaryEffectIds`), from
which core writes one `context.compacted`. A compaction of an agent used as a tool lives in our
state, not the session's transcript, and writes no event. The window and reply reserve
are the latest candidate's (`evidence.extras`), or, before any answer, the **model descriptor**'s
(`contextBudget(transcript, model)`). The estimate counts the turn's files as the model gets
them (`fileView`): a note nothing, inlined text a quarter of its bytes, an image 1 600 tokens,
another file an eighth of its bytes up to a cap. Every figure here is `CompactionConfig`: `keepTokens`
20,000 and `keepShare` 0.3 of the kept tail, `reserveTokens` 8,192 without a reported output limit,
`maxReserveTokens` 16,384 and `maxReserveShare` 0.25, `clipChars` 2,000, `summaryOverheadTokens`
1,024, `imageTokens` 1,600, `fileBytesPerToken` 8, `fileTokensMax` 100,000, `minChunkTokens` 1,000,
`minSummaryTokens` 256 and `summaryShare` 0.8 of the reserve, `charsPerToken` 4.

**Model descriptor**: The model a turn's calls use when they name none (`turn.start.model`,
protocol 15): provider, id, what it reads (`inputs`), its context window and output limit.
`runDurable({ model, files })` hands it to the root agent and every agent used as a tool. Absent
for a flow and when the Tenant has no model; our engine then takes the model to read text and
images.

**Reference line**: How a file stands in a prompt (protocol 12, `mediaReferenceLine` in
`loop/model/files.ts`, exported from `@nylorun/harness`): `[Uploaded artifact "name" ·
<artifactId> v<n> · read_artifact to view]`, or `[Tool <name> returned artifact …]` for a tool
result's file. It names `read_artifact`, our tool, so it is ours, not core's.

**File view**: How one file of the turn reaches the model (protocol 15, `fileView(part, model,
limits)` in `loop/model/files.ts`): `media` (the part goes as its artifact reference, which the
Model Gate fetches: an image the model reads as PNG, JPEG, GIF or WebP, a PDF, Office document,
audio or video it reads), `text` (we read it over the **artifact seam** and inline it as a
`<file name=… type=…>` block, `fileBlock`) or `note` (`(File "name", type, is not shown: why.)`,
`fileNote`): a file past `limits.modelFileBytes`, a kind the model does not read, a type no model
reads. `representFiles` reads the text in chunks of `limits.chunkBytes`, strictly as UTF-8 (else
a note), turns an `artifact.read` refusal into a note, and stops inlining once the turn's inlined
text would pass `limits.modelCallBytes`. Without a file context (a local `run()`), every file
goes as its media part and the adapter decides. A BYO harness may reuse these, or decide
otherwise: the gate refuses only what the provider cannot take (`unsupported_input`).
_Avoid_: sending a text file, or a kind the model does not read, as a media part.

**Turn files**: The files of the turn in progress (protocol 12): a message's media parts, a tool
result's `files` (`liveFilesOf`). The model call names every file by its **reference line**, and
sends the turn's own once more, each its line then its **file view**, in one user message after
the conversation and the context (`loop/model/project.ts`). A file of an earlier turn is its line
only. Inlined text is inside the hashed model call: a replay reads it again, and an artifact
deleted between attempts changes the call (`effect_drift`).

**Structured answer**: A turn with an output schema (protocol 15): our engine appends `Return the
final answer as JSON matching this schema: … Use tools when needed before returning the final
JSON.` to the system text, and reads a final answer that calls no tool and has no `json` block as
JSON (`structuredAnswer` in `loop/model/json-answer.ts`): the text blocks joined, one Markdown
fence stripped, raw control characters and bad escapes repaired (`parseJsonWithRepair`, ported
from pi-ai). The candidate becomes one `json` block after its reasoning; text that is not JSON
stays in the transcript and fails the step `model.invalid_output`. `ModelCall` carries no schema.

**Segment rollover**: A long turn ending its durable segment at a step boundary (`yielded`)
and continuing in the next segment of the same turn.

## Flow (workflows)

**Flow engine**: Interprets a workflow manifest (`runtime/harness/src/flow/`). It returns
effects only — no model, provider, sandbox, or storage calls. The Runtime journals
and dispatches them the same way as the turn loop's effects. It holds a map stage to
`maxMapItems` and a loop to `maxLoopIterations`, the Tenant's Runtime limits `flowMapItems` and
`flowLoopIterations` that a flow's `turn.start.options.flowLimits` carries (their defaults when it
carries none).

**Workflow**: A registered runnable (`kind: "workflow"`, workflow manifest v3): the
manifest of a flow agent. It uses the same session API as an agent (`createSession`,
`input`, `observe`, `approve`, `cancel`). A flow is data: the Runtime never calls the
developer's code to run one. A tool node runs only in the local engine: a host refuses a flow
with one at save.

**Flow agent**: An `Agent` whose body is a flow (`.pipe()`, `.switch()`, `.parallel()`,
`.map()`, `.loop()`); compiles to workflow manifest v3, which embeds its agents. The first
stage gets the flow's input and every later stage the previous stage's output, so each
agent's output schema is what the next stage takes. A nested flow agent runs inline with
its own input.

**Pipe**: Stages in order (`.pipe(a, b, c)`, a `chain` node). Each stage's output is the
next stage's input.

**Switch**: Runs the one case the previous output names: a string, or its `route` field.
The chosen case gets the whole output; `default` catches the rest.

**Parallel**: Runs a fixed set of named branches at the same time on the same input.
Output is an object keyed by branch name.

**Map**: Runs one child per item of the previous output: an array, or its `items` array.
Output is an array in item order.

**Loop**: Workflow primitive: run the body, ask a verifier agent for a verdict, and stop
on a pass or run the body again with the feedback, up to `max` attempts. The body keeps
its session; the verifier gets `{ task, response, iteration }` in a fresh one per attempt.
Distinct from the **Turn loop** above.

**Original request**: The flow agent's input, shown to an agent stage beside its own input
when the two differ (`flowInput` on the `agent` effect).

**Path** (**leaf path**): Address of an agent or tool session: its id, `[index]` per
enclosing Map item, under the ids of nested flow agents; control stages add nothing.

**Key** (**stage key**): A leaf's id, a control stage's `id`, or its position from the flow
root (`@1.default.1`). Effect ids and tool node bindings use it.

**Iteration vector**: Enclosing Loop iteration numbers, outermost first. Not part
of the path.

**Verdict**: A verifier's output, an agent's or an HTTP verifier's answer: `{ pass: true }` or
`{ pass: false, feedback }`, each with optional `data`. Anything else fails the Loop
(`loop.verify-failed`).

**HTTP stage**: A tool node with `http`, built from an `http()` tool: one request the host
makes through its Tool Gate. The engine checks the input against the tool's input schema
(`tool.invalid-input`) before the `tool` effect; a failed outcome fails the stage. A Loop body
that starts with one is retried with the Loop's input, since it takes an object, not feedback.

**HTTP verifier**: A Loop's `verify: { http }`, from `http({ url })`: a `tool` effect at the
verify position's stage key (`@0.verify`) with input `{ input, output, iteration }` and
`context.role: "verify-http"`, whose answer must be a verdict.

**Flow interaction**: A tool node that asks (`ctx.approve`, `ctx.ask`) pauses the flow on its
own session once nothing else is pending. The answer goes into the checkpoint (`resumes`, same
segment), so the flow replays its journal and runs the tool again as a new effect (role
`resume.<n>`) with the answer and the resume token from the journaled outcome. A rejected
approval settles the node `denied`.

**Turn manifest**: Optional `message.manifest` for one agent turn. Must be a
validated variant of the session's pinned manifest; it does not latch.
