---
"@nylorun/runtime": patch
---

**A session's first events reach readers at once.** Tenant basins now create a stream on read, so a client that opens SSE before a session's first event follows the stream live instead of polling for it with a backoff of up to 2 s. Existing basins are updated when their Tenant opens.
