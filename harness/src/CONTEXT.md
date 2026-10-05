# Agent execution

Agent definitions describe capabilities. The engine advances execution; a host
persists progress and connects it to external systems.

## Language

**Manifest**: The serializable description of an agent's declared capabilities.
Its canonical hash identifies the definition used by an execution.

**Binding**: The local pairing of a manifest with ordered declarations, executable
tool snapshots and live schema validators. Functions in a binding stay local.

**Turn loop**: The progression from model calls through tool outcomes to a final
result or a durable wait. A supplied checkpoint is not mutated by a new invocation.
(The workflow primitive named **Loop** is separate; see below.)

**Step**: One model call together with its middleware and tool plan.

**Host**: The OSS or Cloud runtime that owns persistence, scheduling,
authentication and provider access around the shared engine.

**Action endpoint**: The URL of the customer's process that the host delivers
actions to, signed with a delivery token; it runs the developer's tool implementations
(`createActionHandler`).
_Avoid_: Runtime, when referring to customer code execution; "executor"
(removed in protocol 3).

**HTTP tool**: A tool the manifest describes as one HTTP request (`http`, built with
`http()`), which the host's Tool Gate makes; the engine runs it as a `tool` effect like any
hosted tool. With `approval: "always"` (also on a remote MCP server's tools) the engine pauses
each call for approval before the effect, as a code tool's `approval` does.

**SDK client**: The shared application interface for communicating with a host.
Authoring and the Action endpoint handler accompany it in the agents SDK.

**Failure outcome**: A model call that failed in a known way (`{kind: "failed", code, …}`),
returned by the adapter instead of a candidate. The step fails with `model.<code>`; it is a
completed outcome, never `uncertain`.

**Compaction**: Replacing the older part of the transcript with a summary the model wrote,
so the next prompt fits the model's window. Recorded as a `compaction` entry, always first.

**Segment rollover**: A long turn ending its durable segment at a step boundary (`yielded`)
and continuing in the next segment of the same turn.

## Flow (workflows)

**Flow engine**: Interprets a workflow manifest (`harness/src/flow/`). It returns
effects only — no model, provider, sandbox, or storage calls. The Runtime journals
and dispatches them the same way as the turn loop's effects.

**Workflow**: A registered runnable (`kind: "workflow"`, workflow manifest v3): the
manifest of a flow agent. It uses the same session API as an agent (`createSession`,
`input`, `observe`, `approve`, `cancel`). A flow is data: the Runtime never calls the
developer's code to run one; only its tool nodes reach the Action endpoint.

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
root (`@1.default.1`). The Action endpoint routes a tool node's Action by its key, with the
workflow id.

**Iteration vector**: Enclosing Loop iteration numbers, outermost first. Not part
of the path.

**Verdict**: A verifier agent's output: `{ pass: true }` or `{ pass: false, feedback }`,
each with optional `data`. Anything else fails the Loop (`loop.verify-failed`).

**Flow interaction**: A tool node that asks (`ctx.approve`, `ctx.ask`) pauses the flow on its
own session once nothing else is pending. The answer goes into the checkpoint (`resumes`, same
segment), so the flow replays its journal and runs the tool again as a new effect (role
`resume.<n>`) with the answer and the resume token from the journaled outcome. A rejected
approval settles the node `denied`.

**Turn manifest**: Optional `message.manifest` for one agent turn. Must be a
validated variant of the session's pinned manifest; it does not latch.
