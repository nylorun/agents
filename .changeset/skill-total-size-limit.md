---
"@nylorun/core": minor
"@nylorun/agents": minor
"@nylorun/admin": minor
"@nylorun/runtime": minor
"nylorun": minor
---

**Skill and artifact limits are set per Tenant and per Environment manifest; a skill holds up to 2 GiB by default, with no limit per file or on the number of files.**

- The 10 MiB limit per skill file and the 500-file limit are gone. A skill's files may hold up to the Tenant's skill limit together: 2 GiB by default (`SKILL_TOTAL_BYTES_DEFAULT`). A file at two paths counts twice, since a sandbox holds both copies. `SKILL_FILES_MAX` and `DEFINITION_FILE_MAX_BYTES` are no longer exported.
- The Tenant's skill limit is the new Management API setting `GET`/`PUT /v1/tenant/skills` (`{ limits: { totalBytes } }`), also available as `admin.settings.skills` and `nylorun tenant settings skills [get | put <file|->]`.
  - `PUT /v1/files/sha256:<hex>` takes a file up to that limit.
  - `PUT /v1/agents/{id}` refuses a skill over it, an agent used as a tool included: `413 limit_exceeded`, with `details.skills` listing each skill and its size.
- An environment manifest, or the inline fields of `PUT /v1/environments/{id}`, may set `limits`: `artifacts.fileBytes`, `artifacts.totalBytes` and `skills.totalBytes`. Like the manifest's other fields, they are fixed for the Environment's life.
  - Each limit must be at most the Tenant's. A higher one is refused with `400` when the Environment is made or the manifest is saved.
  - A limit left out is the Tenant's at the time it is checked. A Tenant that lowers a limit lowers it for every Environment.
  - The Environment view's new `limits` field gives the limits in force.
- An Environment's artifacts are its sessions' artifacts and its disk versions. Uploads, `save_artifact`, turn-end exports and disk snapshots hold them to the Environment's per-file limit and to its own total, as well as to the Tenant's total. A turn-end export past the Environment's total is skipped with the new reason `environment_total`, and a disk snapshot past it is `413` with `details.limit: "environment_total"`.
- A session opens on an Environment only when its agent's skills fit the Environment's skill limit; otherwise it is `409 environment_unsuitable`, with `details.skills`.
- `PUT /v1/files` streams the body to the Object store instead of holding it in memory. Only bytes that match the named hash reach the file's key. Environment files named by hash are held to the same per-file maximum.
- `@nylorun/agents`: loading a skills folder no longer checks a size, since the limit is the Tenant's; the Runtime refuses an oversized skill. The `skills.file-too-large` and `skills.too-many-files` errors are gone. Files are hashed and read a chunk at a time.
- Sandboxes get skill files as a stream. A harness fetches them from core 16 MiB at a time: `definition.file` takes optional `offset` and `length` (at most the Runtime limit `chunkBytes`).
- `load_skill` and `read_skill_resource` read files of up to 10 MiB into the model's context. A larger file fails with `skill.resource_too_large`, and the error names the file's path in the sandbox when there is one.
