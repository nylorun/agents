---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/agents": patch
"@nylorun/admin": patch
"nylorun": patch
---

**The harness mounts skills and saves outputs; the in-process harness uses the gates; compaction is a transcript edit (protocol 15).** The fifth step of the harness boundary, still protocol 15 and Harness API 4. See MIGRATION.md.

- **Skill folders are our engine's.** Before each sandbox call our engine mounts each skill version of the turn's tree at `/skills/<name>@<hash>/` with `executors.files.mount`, reading the bytes over `definition.file`; the SandboxManager only writes them (`mountFolder`), once per open sandbox (`present` after). `SandboxManager.mountSkills`, its `definitionFile` port and `SandboxSessionRef.manifest` are gone, and the operator sandbox route mounts nothing.
- **The outputs folder is our engine's (Q5).** At a completed turn's end in a sandbox our engine saves `/workspace/outputs` as the session's `outputs` folder before `turn.completed`, over the new folder mode of `artifact.write` (`kind: "folder"`, `file`, chunks named by hash, `unchanged`, `refused`). Core takes every byte, checks each file's hash before content is stored under it, dedupes, and keeps the content epoch and quotas. Versions say `source: "engine"`; `artifact.export.skipped` and `artifact.export.failed` are harness claims. Core's export (`artifacts/export.ts`, the `WorkspaceReader`, `workspace.read` listing and bytes calls) is removed.
- **No limit literals.** The new Runtime limit `folderEntries` (10,000; a count, its ceiling from the manifest's one string) replaces `EXPORT_MAX_FILES`, and `createHarness({ outputs: { dir, maxBytes } })` (`/workspace/outputs`, 1 GiB) replaces `EXPORT_MAX_BYTES`. `RUNTIME_LIMIT_CEILINGS` entries are `{value, unit, why}`.
- **In-process parity.** Every model call goes through the Model Gate: a scripted model is served by `providerModelGate`, metered like any. The MCP pool opens every server through the Tool Gate (`openRemote` is required; the in-process gate's `openMcp` finds the server in the session's pinned manifest and authorizes it with the vault). `ModelRoute` is `{tenantId, modelGate}`; `TenantContext.modelProvider`, `useVaultModel` and `workspaces` are gone.
- **Compaction is a transcript edit (Q4).** Summary calls say `purpose: "summary"` (no `message.assistant`), and the segment's edit that replaced the history says `kind: "compaction"` with its facts and summary calls (`CompactionFactsSchema`, `transcriptUpdates(..., compaction)`). Core checks the calls and writes one `context.compacted`, which loses `partial`.
