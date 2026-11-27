# The turn loop

Runs one turn of an agent: it takes the saved state, builds and sends each model call, settles the tool calls the model asks for, and returns the turn's result or the state to continue from. A `HostSuspension` leaves the loop when an effect the host has not settled interrupts it, and the same turn goes on from the saved state.

## Interface

- `execute(agent, options, internals?)` (`run.ts`): runs a turn: validates the options, opens the execution, applies a resume, then steps until the turn settles, compacts history when it must, and records.
- `LoopConfig`, `loopConfigOf`, `DEFAULT_LOOP_CONFIG`, `DEFAULT_PARTIAL_OUTPUT_CHARS` (`config.ts`): the loop's settings: compaction and the partial output a failed child shows.
- `Invocation`, `createInvocation` (`invocation.ts`): one invocation's state, signal, observer and `record`.
- `dispatchPlan` (`dispatch.ts`): runs the plan of a step and reports a pause.
- `DelegationHost`, `localDelegation`, `runDelegation`, `INTERACTION_UNSUPPORTED`, `ExecuteInternals` (`delegation.ts`): an agent used as a tool, run as a child.
- `HostSuspension` (`host-suspension.ts`): the signal that an effect is `pending` or `uncertain`.
- `initializeExecutionState`, `createSessionStateBag` (`initial-state.ts`): the state a run starts from.
- `createObservationSink`, `emitObserve`, `ObserveEmit`, `ExecutionOutcomeEvent` (`observe.ts`): the events a run reports.
- `validateRunOptions`, `openExecution` (`options.ts`): the options checked and the execution opened.
- `applyResume` (`resume.ts`): a paused state moved on by the input it receives.
- `createExecutionState`, `validateExecutionState`, `normalizeInput`, `MessagesInput` (`state.ts`): the state made, checked and given its input.
- `toolResult` (`tool-result.ts`): a tool's answer as the transcript keeps it.
- `validateTranscript` (`transcript.ts`): the transcript checked before it is used.
- `WaitSignal`, `isWaitSignal` (`waits.ts`): the answer a tool waits for.
- [compaction](./compaction/README.md): the estimate, the cut and the summary that keep the transcript in context.
- [model](./model/README.md): the model call, the turn's files and the parsing of the model's reply.
- [step](./step/README.md): one model call and the plan its tool calls are sealed into.

## Rules

- A `HostSuspension` is control leaving the loop, not a failure: the state keeps the effect `pending` or `uncertain` (`host-suspension.ts`, `run.ts`).
- An `approve`, `respond` or `settle` input with no paused operation fails `execution.invalid-input` (`run.ts`).
- One compaction and one retry happen per context overflow, and the allowance returns after a step succeeds (`run.ts`).
- A delegated agent's interaction call settles as unsupported, never as a pause (`delegation.ts`, `INTERACTION_UNSUPPORTED`).
- A failed child's partial output reaches its parent cut to `DEFAULT_PARTIAL_OUTPUT_CHARS` (4,000) (`config.ts`).
- A `record` failure rethrows as `execution.record-failed`, and no later record runs (`run.ts`).
- Mutable progress belongs to one invocation and is dropped when it settles (`run.ts`, `execute`).

## Side effects

- The state is written through the caller's `record` at each durable boundary (`run.ts`).
- Each event goes to the run's observer, with `runId`, `executionId` and a sequence number (`observe.ts`).
- Tool calls reach the outside through the invocation's effect seam: a host, or `internals` when a host runs the loop in process (`invocation.ts`, `delegation.ts`).

## Verification

- Run: `npm test` from `runtime/harness/`
