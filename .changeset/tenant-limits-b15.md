---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/admin": patch
"nylorun": patch
"@nylorun/studio": patch
---

**The remaining request, upload, token and sandbox limits are Tenant settings (harness boundary B15).** Still protocol 15 and Harness API 4. See MIGRATION.md and DEPLOYMENT.md's Runtime limits.

- **27 more Runtime limits** in `GET`/`PUT /v1/tenant/limits`, each with today's value as its default and a ceiling from a dependency (a JavaScript string or timer, a request read as one string, a Harness API frame, a JavaScript number): request bodies and inline files (`requestBodyBytes`, `inlineFileBytes`), `a2aWaitMs`, `errorExcerptChars`, `traceContentBytes`, an Environment's labels, setup and input files (`environmentLabels`, `environmentSetupCommands`, `environmentFiles`, `environmentFilesPerEntry`, `environmentSecretSlots`, `setupCommandMs`, `setupOutputChars`), disk versions (`diskVersionEntries`, `diskVersionBytes`, `diskLeaseMs`, `diskPodWaitMs`; an Environment's manifest may lower the first two with `limits.disk`), model calls (`modelRequestMs`, `modelIdleMs`, `modelAttempts`, `modelRetryDelayMs`, `modelProviderRetries`, `modelRetryDelayMaxMs`, read by the gates for each call) and tools (`toolAttempts`, `httpToolTimeoutMs`, `mcpPreviewMs`, `mcpMetadataBytes`, and the new `mcpSnapshotBytes`: what a session pins of its MCP servers' tools and instructions, past which a server is left out with a diagnostic).
- **Schema maxima are checked against the Tenant's limits**: an Environment's labels, setup commands, input files, files per entry, secret slots and setup timeout, and an HTTP tool's `timeoutMs` (at deploy and at each call). `limits.environments` and `lifecycle.stopGrace` lose their arbitrary caps; an identity file's issuer takes any number of grants and `jwksFetch` settings.
- **`turn.start.limits` carries only a harness's limits** (`HarnessLimitsSchema`, `harnessLimitsOf`), and a harness drops one it does not know. `transcriptUpdates` takes `recordEntryBytes` and fills each event up to it; `CHUNK_BYTES` is gone.
- **Constants a dependency or a standard fixes stay, named for it**: a token is read up to Node's `http.maxHeaderSize`; artifact names and folder paths keep `FILE_NAME_MAX` (255) and `FILE_PATH_MAX` (1,024); a skill file's path is what `FILE_PATH_MAX` leaves under its mount folder; `tracestate` keeps W3C's 512.
- **Removed**: `ENVIRONMENT_LABELS_MAX`, `ENVIRONMENT_SETUP_MAX`, `ENVIRONMENT_SETUP_TIMEOUT_MAX_MS` (now `ENVIRONMENT_SETUP_TIMEOUT_DEFAULT`), `ENVIRONMENT_FILES_MAX`, `ENVIRONMENT_SECRET_SLOTS_MAX`, `TOKEN_ENVIRONMENT_GRANTS_MAX`, `HTTP_TOOL_MAX_TIMEOUT_MS`, `READ_ARTIFACT_MAX_BYTES` and `CHUNK_BYTES` from `@nylorun/core`; the image checks (`decodeImageBase64`, `validateImageBytes`, `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`), the Tenant configuration's `modelCall` and `TrustedIssuersOptions`' `refetchMs`/`maxAgeMs` from `@nylorun/runtime`. Studio's Environment form no longer caps setup commands and input files at 16: the Runtime checks the Tenant's limit.
