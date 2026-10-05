---
"@nylorun/core": major
"@nylorun/runtime": major
"@nylorun/agents": major
"@nylorun/harness": patch
"@nylorun/studio": patch
---

**Skills are files the Runtime holds and serves itself (track R2 M4).** Breaking: a skill's manifest names every file of its folder, and the skill tools no longer run in the developer's process. The protocol stays at 8 until the track ships.

- `@nylorun/core`: `SkillManifest` gains `files`, each path of the skill's folder (`SKILL.md` required, `/`-separated, no `..`, at most 500 files) mapped to `sha256:<hex>`, so the manifest hash pins them. `skillRecords` and `SkillRecord` are gone; a declaration's `skillFiles` holds the bytes to upload (`SkillFileSource`). `load_skill` and `read_skill_resource` keep their names and input schemas but fail with `skills.runtime-only` outside a Runtime. New `DefinitionFileViewSchema`, error code `definition_files_missing`, Harness API request `definition.file`, and `definitionFilesOf`, `isSkillTool` and the definition-file limits. A top-level `functions` key is reserved and refused ("Functions are not available yet").
- `@nylorun/runtime`: `PUT /v1/files/sha256:<hex>` stores a definition file (application key; at most 10 MiB; a body of another hash is `400`; `201` stored, `200` held already) in the Object store at `definitions/sha256/<hex>`, and `HEAD` says whether the Tenant holds one. New tables `definition_files` and `definition_file_uses` (migration `0013_definition_files`). `PUT /v1/agents/{id}` refuses a definition, nested agents and flow agents included, that names a file the Tenant lacks (`400 definition_files_missing`). Core serves `load_skill` (the `SKILL.md` body, the other files' paths, and `sandboxPath` with a sandbox) and `read_skill_resource` (text files only) from those files, with no Action. A session's sandbox gets each skill's files read-only under `/skills/<name>/` before the first call that opens it, and the sandbox's instructions name them; pod sandboxes mount an `emptyDir` at `/skills`. Unused files are not deleted yet.
- `@nylorun/agents`: `.skills()`, `skills()` and `.plugin()` read every file of a skill's folder, binary included (not `.git/`, `node_modules/`, OS files or `.env` files), and hash it; a file over 10 MiB or more than 500 files fail the build. `saveAgent` uploads the files the Runtime lacks before the definition; `client.files` (`has`, `upload`, `ensure`) does it by hand.
- `@nylorun/harness`: tests only.
- `@nylorun/studio`: the agent's manifest lists each skill's files.
