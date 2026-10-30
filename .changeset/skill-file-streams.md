---
"@nylorun/core": minor
"@nylorun/agents": minor
---

A skill file can be uploaded from a stream, so a client never holds a large one in memory (ADR-93).

- **`SkillFileSource.stream()`**, optional: each call opens a new stream of the file's bytes. When a source has it, `client.files.ensure` (and so `agentManifests.save`) sends the stream instead of `read()`'s bytes.
- **`client.files.uploadStream(stream, { sha256 })`** sends one file half-duplex, up to the Tenant's skill limit (2 GiB by default). The Runtime already streams the body to its hash.
- **A stream is never sent twice by the transport.** After an expired token or a protocol check, `ensure` opens a new stream and sends it once more.
