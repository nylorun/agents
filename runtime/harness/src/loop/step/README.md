# One step of the loop

A step is one model call and the tool calls it asks for. This folder builds the request from the state and the transcript, checks and canonicalizes what the model returned, and seals the calls into a plan the loop runs — so everything a step decides is decided before any effect is resolved.

## Interface

- `runStep(input)`, `StepRunResult` (`run.ts`): runs one step and reports the directive it settled.
- `StepRuntime`, `StepInput`, `ExecutionSnapshot` (`runtime.ts`): what a step sees of the run.
- `resolveModelRequest` (`resolve.ts`): the request a step sends.
- `ModelConfigurationDraft` (`model-configuration.ts`): the model configuration a step settles on, built part by part.
- `describeTool`, `describeConfiguration`, `InternalModelConfigurationSnapshot` (`describe.ts`): the tool and configuration descriptors the model reads.
- `canonicalizeCalls`, `canonicalizeOutput`, `memoryAliasCall`, `candidateFromCanonical`, `CanonicalCall` (`canonicalize.ts`): the model's calls made canonical, a memory call's alias resolved.
- `sealStep`, `SealedToolCall`, `ExecutablePlanEntry`, `InternalToolPlan`, `SealedStepOutput` (`seal.ts`): the checked plan of a step.
- `SlotDraft`, `slotOwner`, `slotKey`, `checkedSlot`, `checkedReason`, `withOrder`, `SlotOwner`, `SlotDeclaration` (`slot-assembly.ts`): the slots an agent's parts fill.
- `StepContext`, `messageContextOf` (`step-context.ts`): the context a step's messages and tools carry.

## Rules

- One prepared model call per invocation: a step that would prepare a second fails (`run.ts`).
- The step reports `model.requested` and `model.prepared`, and a failed model call ends the step as `model.<code>` (`run.ts`).
- Two calls with one id are made one before they are sealed (`canonicalize.ts`).
- A slot's key is its part id, part order and slot name, and two parts may not take the same key (`slot-assembly.ts`, `slotKey`, `checkedSlot`).
- A sealed step carries only calls the manifest's tools can run (`seal.ts`, `sealStep`).

## Side effects

- The step emits its observation events through the run's observer (`run.ts`).

## Verification

- Run: `npm test` from `runtime/harness/`
