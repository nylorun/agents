---
"@nylorun/runtime": minor
---

**`startEphemeralRuntime` needs a database; the in-memory Session Store is removed.** Every Session Store is Postgres now, in tests too.

- **Breaking:** `StartEphemeralRuntimeOptions.database` is required: a Postgres URL, for which the Runtime opens a pool and ends it on `close()`, or a pool the caller ends. Each Tenant is a schema in that database and stays after `close()`. Durable Streams and scheduling stay in process. See `MIGRATION.md`.
