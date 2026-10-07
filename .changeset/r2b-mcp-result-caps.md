---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/studio": minor
---

**MCP and HTTP tool results that fit** (R2b C11). MIGRATION.md (protocol 10, "Tool results that fit") has the details.

- `@nylorun/core`: a completed `ToolOutcome` may carry `files` (`ToolResultFile`: a media type and the host's reference) and `truncated`; a completed `ToolResult` carries the `files`. `artifactsCapabilityManifest({ save, read })` adds the built-in `read_artifact` (`READ_ARTIFACT_TOOL`, `READ_ARTIFACT_MAX_BYTES`), and `codeToolsOf` leaves it alone. `SessionView` gains `definitionHash`, the definition the session was opened from. Transcript edits are split at 48 KiB, down from 256 KiB, so each `transcript.updated` event stays under 64 KiB when no entry is larger.
- `@nylorun/harness`: a tool result's files go to the model after its output, as media parts; an outcome marked `truncated` is not checked against the tool's output schema.
- `@nylorun/runtime`: an agent's remote MCP or HTTP tool result past 32 KiB is stored as a file artifact of the session, and the model gets `{ truncated: true, artifactId, size, preview }` (the first 4 KiB and the last 1 KiB). Image, audio and blob resource parts become artifacts too, an image also shown to a model that reads images (a note for one that does not); each part of a mixed result is shaped alone, and a `resource_link` stays a link. One step's results share a 256 KiB budget, so many parallel results never make an event near S2's 1 MiB record: past it, a result is a stub naming its artifact. When an artifact cannot be stored, the preview stays and `dropped` says why. An MCP answer past 8 MiB is `mcp.too-large`. `read_artifact { artifactId, offset?, length? }` reads 32 KiB of the session's own artifact a call, with or without a sandbox: a session gets it for each agent with an MCP server or an HTTP tool. The session view names its `definitionHash`.
- `@nylorun/studio`: a session is shown as running an older manifest only when the definition it was opened from is not the registered one, not because the Runtime pinned its own tools (a sandbox's, `save_artifact`, `read_artifact`) beside it.
