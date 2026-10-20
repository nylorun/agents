---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/admin": patch
---

Compare two versions' agent folders, and set what a folder may hold per Tenant (track T7).

- **`GET /v1/agent-manifests/{name}/source/diff?from=<v>&to=<v>`** answers the files added, removed and changed (by SHA-256) from one version's source to another's, each list sorted by path, and how many stayed the same (`AgentManifestSourceDiff` in `@nylorun/core/contracts`). A version saved as JSON has no source (`404`); a `from` or `to` that is not a version number is `400`. `client.agentManifests.sourceDiff(name, from, to)` in `@nylorun/agents` calls it.
- **Folder limits are Tenant settings**: the Runtime limits `folderFiles` (2,000), `folderBytes` (50 MiB) and `folderTextFileBytes` (1 MiB), T6's fixed values, set with `PUT /v1/tenant/limits` like the others. A folder save with more files or bytes is `413 limit_exceeded` (`details.limit` names the limit), and the compiler holds each Markdown or JSON file to `folderTextFileBytes` (`422 folder_invalid`).
- `compileAgentFolder({ entries, files, name, limits })` takes the limits as an optional input (`AgentFolderLimits`); each left out is `AGENT_FOLDER_LIMITS`'.
- `@nylorun/agents` also exports the types `AgentManifestSource`, `AgentManifestSourceDiff`, `AgentManifestSourceSummary` and `AgentFolderDiagnostic`, and `AGENT_FOLDER_MEDIA_TYPE`.
