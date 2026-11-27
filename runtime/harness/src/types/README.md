# Execution and client types

The contracts between the engine and whoever runs it: a turn's input, the saved execution state, the events and the result, and the session and turn handles a client reads. The files hold types and no logic, so a change here changes what every host must write and read.

## Interface

- `ExecutionInput` (`execution.ts`): what starts a segment — a queued `messages` input, or `continue`, `settle` or `wait-resolve`.
- `ToolReference` (`execution.ts`): a reference to a tool call, which applications preserve intact.
- `SavedToolCall` (`execution.ts`): a tool call as the state saves it, with its status and its outcome.
- `ExecutionPlan`, `TurnState`, `ExecutionState` (`execution.ts`): the plan of a step, the state of a turn, and the whole saved state with its `manifestHash` and `agentId`.
- `ExecutionEvent` (`execution.ts`): what a run reports to its observer.
- `RunOptions`, `RunResult` (`execution.ts`): what a run takes — a `record` callback, an `onEvent` listener, an `info` value — and returns.
- `InputAccepted`, `Result`, `Turn`, `Event`, `AgentIdentity`, `Session` (`client.ts`): the session client's handles, inputs and results.

## Rules

- `SavedToolCall.status` is `pending`, `active`, `settled`, `interaction` or `deferred` (`execution.ts`); the loop resumes a saved call by that status.
- `RunOptions.record` receives the state at each durable boundary (`execution.ts`).
- A `ToolReference` reaches the engine as it was recorded; applications do not rewrite it (`execution.ts`).

## Side effects

- None found.

## Verification

- Run: `npm test` from `runtime/harness/`
