---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/harness": minor
"@nylorun/agents": minor
"@nylorun/admin": minor
"@nylorun/studio": minor
"nylorun": minor
---

**Each model says what it reads, a file it does not read is refused before a turn starts, and a file is an artifact the model reads again after its turn (protocol 12).** A message could name any file, and a model that could not read it failed the turn at its model call; every later turn sent the file's bytes again. Now the Runtime knows what the Tenant's model reads, checks a message's files when it is accepted, and sends a file's bytes only in the turn that brought it. Protocol 12 only adds to 11: the Runtime serves both.

- **Model inputs.** A model reads `text`, and `image`, `pdf`, `office`, `audio` or `video` when its catalog says so or the operator adds it where its API carries it natively (images everywhere; PDFs on the Anthropic, OpenAI, Azure and Google APIs; Office documents on the OpenAI Responses APIs; audio and video on Google's APIs and OpenAI-compatible completions). `GET /v1/tenant/models` gives each model `inputs` and `addableInputs`, `GET /v1/tenant/providers` each provider's `inputs`, and **`PUT /v1/tenant/models/inputs`** (the Management API; `admin.models.setInputs({ provider, model, inputs })`) sets the added ones, kept in the Tenant setting `model.inputs`. The Model Gate gives the provider adapter a model with an added image, so it is sent.
- **A custom endpoint reads text only by default.** It used to be sent images. Set `settings.inputs` on `PUT /v1/tenant/model` (`image`, `pdf`, `audio`, `video`) for what yours reads; `office` is refused there. See MIGRATION.md.
- **The accept check.** A message naming a file of a type the Tenant's model does not read is `422 attachment_unsupported`, with `details.parts` (`artifactId`, `name`, `mediaType`, `reason`), and no turn starts. Only the type is checked, never the size. Without a model in the vault nothing is refused.
- **Files as artifacts.** After its turn a file is a reference line, `[Uploaded artifact "name" · <artifactId> v<n> · read_artifact to view]` (a tool's: `[Tool <name> returned artifact …]`). Our harness sends the turn's own files once more, as media, in one user message after the conversation, so a message reads the same in every later call. At the gate, an image the model reads is an image, a text file a `<file>` block, and any other file, or one that cannot be read, a note: no file fails a call. PDFs, Office documents, audio and video are notes until the gate sends them natively.
- **`read_artifact` for every agent.** Every agent's session has it (an agent that declares its own keeps it), so every agent session pins its definition with it added. It takes a `version`, reads the Tenant-wide artifacts the session's messages named, and shows any file the Tenant's model reads; one it does not read fails `artifact.unsupported`.
- **Compaction** keeps the summarized part's reference lines (`files` on the compaction entry), and counts the turn's files by type and size in its token estimate.
- `@nylorun/core`: `PROTOCOL_VERSION` 12, required feature `model-inputs`, `HOST_PROTOCOL` `{ min: 11, max: 12 }`, error code `attachment_unsupported`; `MODEL_INPUTS`, `ModelInputSchema`, `PutModelInputsRequestSchema`, `ModelInputsViewSchema`, `CustomModelSettings.inputs`; `mediaReferenceLine` and `mediaReferenceOf` in `/define`; `TranscriptCompactionEntry.files`.
- `@nylorun/agents`, `@nylorun/studio` and `nylorun` send protocol 12.
