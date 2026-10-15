# Agent execution

Agent definitions describe what an agent has. The engine advances execution; a host
persists progress and connects it to external systems.

## Language

**Manifest**: The serializable description of an agent: its instructions, tools, skills and MCP
servers, and in a session's pin the Runtime's `runtime` block. Its canonical hash identifies the
definition used by an execution.

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

**Deferred session tool**: A session tool marked `deferred` (R2b C10): out of the model's tool
list, and run by `tool_call` (a session tool of the `runtime` part), which checks the arguments
against the tool's `inputSchema` and makes the call as the tool's own effect, which the host's
tool policy decides as it would a direct call. A session tool may carry `instructions`, which the model reads with the
Runtime's while it is advertised (`tool_search`'s note of the servers).

**Engine tool**: A tool our engine adds to each agent of a session's tree and runs in the
harness itself, not in the host (protocol 15): today `read_artifact` and `save_artifact`
(`tools/artifacts.ts`). Its name, description, schema and instructions are ours; it is offered
like a session tool (`runDurable({ engineTools })`: after the Runtime's tools, before the
session's, with its instructions first among theirs, not hashed) and journaled as a `tool`
effect our harness declares in `hello` (`features.tools`), which core records as kind `harness`.
The API host runs it instead of `executors.tool` (`api/host.ts`). An author tool of the same name
fails the turn.

**Artifact seam**: How the harness reads and writes the artifacts of the run it holds
(`artifact.read`, `artifact.write`; the client helpers `readArtifact`, `openArtifactWrite`,
`writeArtifactBytes` in `@nylorun/core/harness-api`), in chunks of at most the run's
`turn.start.limits.chunkBytes`. `read_artifact` reads a page (`artifactPageBytes`, harness
configuration, 32 KiB by default; whole UTF-8 characters, held to its size escaped as JSON) or,
with `path`, streams the whole artifact into the sandbox (`executors.files.write`);
`save_artifact` writes text, or a sandbox file it reads within the upload's room
(`executors.files.read`), keyed by its effect id so a repeat stores nothing twice. A refusal
(`not_found`, `limit_exceeded`, `invalid`) is a failed outcome the model sees.

**SDK client**: The shared application interface for communicating with a host.
Authoring accompanies it in the agents SDK.

**Failure outcome**: A model call that failed in a known way (`{kind: "failed", code, …}`),
returned by the adapter instead of a candidate. The step fails with `model.<code>`; it is a
completed outcome, never `uncertain`.

**Compaction**: Replacing the older part of the transcript with a summary the model wrote,
so the next prompt fits the model's window. Recorded as a `compaction` entry, always first,
with the reference lines of the files it summarized away (`files`).

**Turn files**: The files of the turn in progress (protocol 12): a message's media parts, a tool
result's `files`. The model call names every file by its reference line (`mediaReferenceLine`),
and sends the turn's own once more, as media, in one user message after the conversation and
the context (`loop/model/project.ts`). A file of an earlier turn is its line only.

**Segment rollover**: A long turn ending its durable segment at a step boundary (`yielded`)
and continuing in the next segment of the same turn.

## Flow (workflows)

**Flow engine**: Interprets a workflow manifest (`runtime/harness/src/flow/`). It returns
effects only — no model, provider, sandbox, or storage calls. The Runtime journals
and dispatches them the same way as the turn loop's effects.

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
