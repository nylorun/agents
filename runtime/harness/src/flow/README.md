# The durable flow engine

Runs a workflow manifest (manifest v3, `flow-3`): a tree of agent, tool, chain, switch, parallel, map and loop stages whose values come from the flow's input and the outputs before them. Every agent turn and tool call is a `tool` or `agent` effect the host journals, so a flow that stops on a pending effect resumes from its checkpoint.

## Interface

- `runFlowDurable(options)` (`engine.ts`): runs a flow from a `FlowCheckpoint` and returns `completed`, `paused`, `cancelled`, `failed`, `waiting` or `uncertain`.
- `FlowCheckpoint`, `FlowResume`, `createFlowCheckpoint`, `resumeFlowCheckpoint` (`checkpoint.ts`): the flow's private persistence contract, with the answers to its interactions.
- `createFlowContext`, `FlowContext`, `FlowEffectKind` (`context.ts`): the effect, interaction and cancellation state of one flow run.
- `suspendedResult`, `failureOf`, `markFailFastCancels`, `settleInFlight` (`context.ts`): the result of an unwound flow, and the effects it leaves behind.
- `runToolEffect` (`tool.ts`): one tool node, with its waits and resume token.
- `FlowNodeError`, `FlowPause`, `failedValueOf`, `FlowInteraction`, `FlowRunResult`, `FlowDurableResult`, `FlowFailure` (`types.ts`): a node's failure, a pause, and the flow's result.
- `flowEffectId`, `nodeKeyOf`, `iterationsOf` (`paths.ts`): an effect's id, a node's key, and a Loop's iteration vector.
- `FlowOperatorLimits`, `FLOW_OPERATOR_DEFAULTS`, `resolveOperatorLimits`, `assertMapItemCount`, `assertLoopIteration`, `DEFAULT_FLOW_VALUE_CHARS` (`limits.ts`): the operator's ceilings and how much of a value a failure quotes.

## Rules

- The manifest is parsed by `WorkflowManifestSchema` before it runs (`engine.ts`).
- A checkpoint whose version, engine version or manifest hash differs fails `execution.incompatible` (`engine.ts`).
- A Map stops at `maxMapItems` and a Loop at `maxLoopIterations` (`limits.ts`).
- An effect id is `turnId:segment:flow:path:kind(:role):iterations`, and `nodeKeyOf` drops the Map indices (`paths.ts`).
- A tool node that asks pauses the flow; once its answer is in the checkpoint the node runs again as an effect with role `resume.<n>`, and a denied approval settles it `denied` without running the tool (`tool.ts`).
- A failed or cancelled flow cancels the effects still in flight, and its result names their ids (`context.ts`, `markFailFastCancels`).
- An agent node whose subagent is not embedded fails `flow.unknown-agent` (`engine.ts`).
- A scope's agent and tool sessions are named by leaf paths: the leaf's id, `[i]` per Map item, under the enclosing flow agents' ids (`engine.ts`).

## Side effects

- Every node's work is a `HostEffect` the host resolves: `agent` for a leaf agent, `tool` for a tool node (`context.ts`, `effect`).
- A flow's own interactions are carried to the caller as `paused` with their `FlowInteraction`s (`context.ts`, `suspendedResult`).

## Verification

- Run: `npm test` from `runtime/harness/`
