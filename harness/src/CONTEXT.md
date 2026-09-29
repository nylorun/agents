# Agent execution

Agent definitions describe capabilities. The engine advances execution; a host
persists progress and connects it to external systems.

## Language

**Manifest**: The serializable description of an agent's declared capabilities.
Its canonical hash identifies the definition used by an execution.

**Binding**: The local pairing of a manifest with ordered declarations, executable
tool snapshots, hooks and live schema validators. Functions in a binding stay local.

**Turn loop**: The progression from model calls through tool outcomes to a final
result or a durable wait. A supplied checkpoint is not mutated by a new invocation.
(The workflow primitive named **Loop** is separate; see below.)

**Step**: One model call together with its middleware, hooks and tool plan.

**Hook**: Developer code the loop calls at a named point: `before` or `after`, scoped to
a `turn` (once per turn) or a `step` (every model call). It returns data that the engine
validates and applies. All capabilities registered at one point run as one host effect.

**Host**: The OSS or Cloud runtime that owns persistence, scheduling,
authentication and provider access around the shared engine.

**Executor**: The customer process that claims host-issued actions and runs the
developer's tool and hook implementations.
_Avoid_: Runtime, when referring to customer code execution.

**SDK client**: The shared application interface for communicating with a host.
Authoring and executor capabilities accompany it in the agents SDK.

## Flow (workflows)

**Flow engine**: Interprets a workflow manifest (`harness/src/flow/`). It returns
effects only — no model, provider, sandbox, or storage calls. The Runtime journals
and dispatches them the same way as the turn loop's effects.

**Workflow**: A registered runnable (`kind: "workflow"`) built by nesting primitives.
It uses the same session API as an agent (`createSession`, `input`, `observe`,
`approve`, `cancel`).

**Chain**: Steps in order. Each step's output is the next step's input unless a
slot reshapes it.

**Switch**: Runs the one case whose key a pure `on` function computes from the input.

**Parallel**: Runs a fixed set of named branches at the same time on the same input.
Output is an object keyed by branch name.

**Map**: Runs one child per item of a list from pure `over(input)`. Output is an
array in item order.

**Loop**: Workflow primitive: run → verify → decide, repeating until decide returns
an output. Distinct from the **Turn loop** above.

**Slot** (manifest v1): `{ run, id?, input? }` — the only way to rename a child or
reshape data between nodes. Manifest v2 has no slots: any node carries `id` and `input`.

**Path**: Address of a node in the tree. v1: `parent/child`, Map items append
`[index]`. v2 (**leaf path**): an agent's or tool's id, `[index]` per enclosing Map
item, under the ids of nested flow agents; control stages add nothing.

**Key**: What the executor routes `tool`, `fn`, and `verify` actions by, with the
workflow id. v1: the path without Map indices. v2 (**stage key**): a leaf's id, a
control stage's `id`, or its position from the flow root (`@1.default.1`), plus
`:input`, `:on`, `:verify` or `:decide` for functions.

**Flow agent**: An `Agent` whose body is a flow; compiles to workflow manifest v2,
which embeds its agents. A nested flow agent runs inline with its own `flowInput`.

**Iteration vector**: Enclosing Loop iteration numbers, outermost first. Not part
of the path.

**Verdict**: Loop verify outcome: `{ pass: true }` or `{ pass: false, feedback }`,
each with optional `data`.

**Turn manifest**: Optional `message.manifest` for one agent turn. Must be a
validated variant of the session's pinned manifest; it does not latch.
