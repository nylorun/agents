---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/admin": patch
"nylorun": minor
---

Agent memory, storage and API (track T5, D72). An agent manifest's `harness.memory` (`access`: `read_write` or `read_only`; `instructions`, at most 4,096 characters) turns on the Agent's memory: Markdown files under `/memories` it keeps across sessions, wakes and upgrades. The Runtime keeps them in Postgres (`memories`, `memory_versions`, migration 0036) with a version per change and who made it. `GET /v1/agents/{id}/memories` lists them (`pathPrefix`), `GET`, `PUT` (whole content, with an optional `contentSha256` precondition: `409 memory_conflict`) and `DELETE /v1/agents/{id}/memories/{path}` read, write and delete one (or a folder), and `GET /v1/agents/{id}/memory_versions` and `.../memory_versions/{versionId}` page the versions. A fork copies the memories (the fork plan adds `memories`); a delete removes them. `@nylorun/core` adds `memoryPathOf`, `memoryDescriptionOf` and the memory contracts; new Runtime limits `memoryBytes` (100 KB) and `memoriesPerAgent` (10,000); new error code `memory_conflict`. The SDK adds `client.agents.memories`; the CLI adds `nylorun agents memories ls|cat|put|rm|versions`. The model's `memory` tool arrives in the next steps of T5.
