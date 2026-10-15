---
"@nylorun/core": minor
"@nylorun/agents": minor
"@nylorun/runtime": minor
---

**A skill may hold up to 2 GiB, with no limit per file or on the number of files.**

- A skill's files may hold at most 2 GiB together (`SKILL_MAX_BYTES`). The 10 MiB limit per file and the 500-file limit are gone, and `SKILL_FILES_MAX` is no longer exported. A file at two paths counts twice, since a sandbox holds both copies.
- `@nylorun/agents`: loading a skills folder fails with `skills.too-large` when its files hold more than 2 GiB together. The `skills.file-too-large` and `skills.too-many-files` errors are gone. Files are hashed and read a chunk at a time.
- `PUT /v1/files/sha256:<hex>` takes up to 2 GiB (`DEFINITION_FILE_MAX_BYTES`) and streams the body to the Object store instead of holding it in memory. Only bytes that match the named hash reach the file's key. This also raises the limit for each Environment file named by hash.
- `PUT /v1/agents/{id}` refuses a definition whose skill's files hold more than 2 GiB together, an agent used as a tool included: `413 limit_exceeded`, with `details.skills` listing each skill and its size.
- Sandboxes get skill files as a stream. A harness fetches them from core 16 MiB at a time: `definition.file` takes optional `offset` and `length` (at most `DEFINITION_FILE_CHUNK_BYTES`).
- `load_skill` and `read_skill_resource` read files of up to 10 MiB into the model's context. A larger file fails with `skill.resource_too_large`, and the error names the file's path in the sandbox when there is one.
