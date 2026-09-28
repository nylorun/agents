---
"@nylorun/agents": patch
---

The AG-UI handler answers `400` (`invalid_request`) when the Runtime refuses what the client sent, such as a `Last-Event-ID` it cannot read, instead of `502`.
