---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

**Folder artifacts and the turn-end outputs export (F8.2).** Part of protocol 6, with file artifacts.

- **`@nylorun/runtime`: the turn-end export.** When an agent's turn completes, the Runtime reads `/workspace/outputs` of the session's sandbox and keeps it as a version of the session's folder artifact `outputs`: the first export creates it, and each later turn whose outputs changed adds a version (`artifact.created` / `artifact.version.created` with `kind: "folder"`, `source: "export"`, `fileCount` and `claimed: true`, since the listing and bytes are what the sandbox supplied). Nothing is exported without a sandbox or without outputs. An export past 10,000 files, 1 GiB, the per-file limit or the Tenant total stores nothing and records `artifact.export.skipped` with its reason; a failure records `artifact.export.failed`. Neither fails the turn. Core reads the workspace through one seam, `WorkspaceReader`, which the Harness API and pod sandboxes will implement later.
- **`@nylorun/runtime`: folder artifacts.** A folder version is a manifest of paths to content-addressed files: each file's bytes are stored once at `blobs/sha256/<hex>`, so an unchanged file is never stored again, and the Tenant total (`GET /v1/tenant/artifacts` `usedBytes`) counts it once. New routes: `GET /v1/artifacts/{id}/versions/{n|latest}/tree` (the manifest), `…/files/{path}` (one file by its percent-encoded path, with Range), `…/diff?from=n` (files added, removed and changed) and `…/zip` (a streamed zip). `POST /v1/artifacts/{id}/links` takes `file` to link one file of a folder; a folder's link without it opens the zip. A folder's `/content`, a new version uploaded to a folder, and a message part naming a folder are `400`. Deleting a folder removes the files no other version names. Migration `0006_folder_artifacts` allows the `folder` kind and adds the `artifact_content` table.
- **`@nylorun/core`:** `ArtifactKindSchema` (`file`, `folder`), the `export` source, `FolderEntrySchema`, `FolderManifestSchema`, `ArtifactTreeSchema`, `ArtifactDiffSchema`, the `artifact.export.skipped` and `artifact.export.failed` events, and `fileCount` and `claimed` on `artifact.created` / `artifact.version.created`.
- **`@nylorun/agents`:** `client.artifacts.tree()`, `file()`, `diff()` and `zip()`, and `link(id, { file })`.
