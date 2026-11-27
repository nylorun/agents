# The run entry points and durable execution

`run` is the surface a Runtime or a test calls to run one turn: it resolves a definition from a manifest and its implementations and hands it to the loop. `durable.ts` runs the same loop with every outside call journaled as a host effect, so a segment can end on one process and go on in another. The package's `./run` subpath is this folder.

## Interface

- `run(options)` (`index.ts`): runs a turn from a `RunBinding`, checking a saved state's manifest hash first.
- `RunBinding`, `BoundRunOptions` (`index.ts`): a manifest with its `implementations` (and optionally the authoring binding), and the run's options.
- `bindingFromAgent(agent)` (`index.ts`): a `RunBinding` from an authored agent.
- `createRunState(binding, options?)` (`index.ts`): a fresh `ExecutionState` bound to the manifest's hash.
- `runDurable(options)` (`durable.ts`): runs a segment from a `DurableCheckpoint` and returns `waiting`, `uncertain`, `completed`, `paused`, `cancelled`, `failed` or `yielded`.
- `createDurableCheckpoint(input)` (`durable.ts`): a checkpoint at `CHECKPOINT_VERSION` and `ENGINE_VERSION`, carrying the manifest's hash and the segment number.
- `DurableHost` (`durable.ts`): `resolveEffect(effect)` — load or create an effect by `effectId`, check a replayed request, return the recorded outcome.
- `HostEffect` (`durable.ts`): a journaled call, `kind` `model`, `tool`, `delegation`, `agent` or `inputs`, with `target`, `toolName`, `skill`, `purpose`, `path`, `key` and `iterations` where they apply.
- `DurableCheckpoint`, `DurableResult`, `EffectResolution`, `DurableSessionTool` (`durable.ts`).
- `createFlowCheckpoint`, `resumeFlowCheckpoint`, `runFlowDurable` and the flow types (`index.ts`): the flow engine's entry, re-exported here.

## Rules

- A checkpoint whose `version`, `engineVersion` or `manifestHash` differs is refused with `execution.incompatible`, and so is a state whose hash, agent id or execution id differs from its checkpoint (`durable.ts`).
- Effect ids come from stable names — `effectIdOf(turnId, segment, kind, identity)` — never from call order, so a replay lines up (`durable.ts`).
- An effect the host leaves `pending` or `uncertain` ends the segment as `waiting` or `uncertain`; the resumed segment reads recorded outcomes and never runs an effect twice (`durable.ts`).
- No continuation survives a suspension: the checkpoint is the segment's start and the host's journal is the rest (`durable.ts`).
- Pinned text stays at the head of the conversation and is replaced only with `refreshPinned` (`durable.ts`).
- `yieldAfter` ends the segment at a step or millisecond count and the result is `yielded` (`durable.ts`).

## Side effects

- Every model call, tool call, delegated agent, flow node and steered input goes to `host.resolveEffect` (`durable.ts`).
- The engine's own tools reach the outside through the same seam, as `harness` effects (`durable.ts`).

## Verification

- Run: `npm test` from `runtime/harness/`
