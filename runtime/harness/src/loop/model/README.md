# The model's view of a step

Turns the engine's request into the call the model receives, and the model's reply into what the loop can act on: the provider-neutral `ModelCall`, the turn's files, the plan reminder, the directive check and the parsing of a structured answer. `files.ts` is exported from the package root, since a host states how its files reach the model.

## Interface

- `projectModelCall`, `liveFilesOf`, `schemaInstruction` (`project.ts`): the call to make, the files it carries, and the instruction an output schema adds.
- `representFiles`, `fileView`, `fileBlock`, `fileNote`, `mediaReferenceLine`, `fileKeyOf`, `FileContext`, `FileViewContext`, `FileView`, `FilePart`, `FileChunk`, `LiveFile`, `FILES_MESSAGE_HEADER`, `MODEL_CALL_TOOL_MEDIA` (`files.ts`).
- `structuredAnswer`, `parseJsonWithRepair`, `repairJson`, `withoutCodeFence` (`json-answer.ts`): the answer to an output schema, parsed.
- `normalizeDirective`, `normalizeCandidate`, `sameDirective`, `textFromOutput` (`normalize.ts`): a model's directive checked, compared and read for its text.
- `planReminder`, `PLAN_REMINDER_CALLS` (`plan-reminder.ts`): the reminder that the agent keeps a plan.

## Rules

- A file reaches the model as media, text or a note, decided from the turn's `model` and `limits` (`files.ts`, `fileView`).
- The files message is headed `FILES_MESSAGE_HEADER`, "Files for this turn:" (`files.ts`).
- `normalizeDirective` answers a `ModelDirective` or a `HarnessError`; nothing else leaves it (`normalize.ts`).
- A fenced answer, or JSON with a fault in it, is repaired before it is parsed (`json-answer.ts`, `parseJsonWithRepair`).
- The plan reminder is derived from the request alone and never written to the transcript (`plan-reminder.ts`, `planReminder`).
- One call carries at most `MODEL_CALL_TOOL_MEDIA` (6) files from tool results as media; past that the oldest go as a note that `read_artifact` brings back, and a person's own files are never capped (`files.ts`).

## Side effects

- None found.

## Verification

- Run: `npm test` from `runtime/harness/`
