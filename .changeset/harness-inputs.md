---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/studio": patch
---

**The harness decides how files reach the model; the Model Gate only fetches and translates (protocol 15).** The second step of the harness boundary, still protocol 15 and Harness API 4. See MIGRATION.md.

- **Any file may be sent.** A message naming a file the model does not read is accepted: `422 attachment_unsupported` and its error code are gone, and AG-UI and A2A accept such files too. Files are still held to the artifact size limits at upload.
- **`turn.start.model`** is the model descriptor (`ModelDescriptorSchema`): the provider, id, inputs, context window and output limit of the model the turn's calls use, absent for flows and without a model. One resolution (`model/descriptor.ts`) serves it, the catalog's inputs and the gate.
- **Our engine shows each file.** An image or document the model reads goes as its artifact reference, a text file is read over the artifact seam and inlined as a `<file>` block, and anything else (past `modelFileBytes`, a kind the model does not read) is a note it writes. `fileView`, `representFiles`, `fileBlock`, `fileNote` and `mediaReferenceLine` (moved from `@nylorun/core/define`) are exported from `@nylorun/harness`. A budget from the descriptor bounds the prompt before the first answer, and compaction counts files as the model gets them.
- **The Model Gate refuses instead of writing notes.** A text file as a media part, or a kind the model or its API does not read, fails the call with the new model failure code `unsupported_input`; a reference it cannot fetch fails `invalid_request`. Nothing is sent, and neither is retried.
- **Structured answers are the engine's.** `ModelCall.outputSchema` is removed: our engine writes the JSON instruction and parses the answer (fenced, with control characters repaired; `parseJsonWithRepair` ported from pi-ai). `message.assistant` for a structured answer now carries its JSON text.
- **`read_artifact`** refuses a file the turn's model does not read (`artifact.unsupported`, with the reason).
- `unreadableReason` is removed; `isOffice` joins the media type helpers in `@nylorun/core/contracts`.
- Studio's file picker accepts every file, and the refusal chips are gone.
