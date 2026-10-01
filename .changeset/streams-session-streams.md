---
"@nylorun/runtime": patch
---

**`LiveHub` is now `SessionStreams`.** Internal rename, no behaviour change: a process's readers of Durable Streams are `ctx.sessionStreams` (`tenant/session-streams.ts`), with one `SessionStream` per observed session.
