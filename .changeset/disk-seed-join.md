---
"@nylorun/runtime": patch
---

A virtual Agent forked from another's version (`PUT /v1/agents/{id}` with a disk version) now returns once its workspace is written, even when the Tenant sweep started the seed first: the second caller waits for the copy already running instead of returning at once. Before, a read right after the fork could get `sandbox.not_found`.
