---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

The Runtime saves agent folders (track T6). `PUT /v1/agent-manifests/{name}` with `Content-Type: application/vnd.nylorun.folder+json` takes a folder by hash (`PutAgentFolderRequestSchema`): the files uploaded first, the Markdown and JSON read back from the definition file store and compiled with `compileAgentFolder`. A folder that does not compile is `422 folder_invalid`, with the compiler's diagnostics by file, line and column in `details.diagnostics`. A save keeps the folder as the version's source: `AgentManifestView.source` summarises it, `GET /v1/agent-manifests/{name}/versions/{v}/source` lists its files and `.../source/files/{path}` returns one. With `?dryRun=true` the plan adds the compiled `manifest`, the `diagnostics` and the `compiler`. A folder whose manifest is unchanged saves no version, and says so (`source_not_saved`). New Host feature `agent-folders`; new error code `folder_invalid`.
