---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
---

**Harness API v1, in process (F6.1).** Every segment now runs in a harness: the advance takes the session's lease and offers the segment as a run, and the Tenant's own harness, in the same process, runs the engine and reports how it ended. Core settles it exactly as before. Nothing changes on the wire: protocol 5, durable checkpoint 1, engine `hosted-3` and the Action endpoint wire are the same.

- `@nylorun/core/harness-api`: the protocol (messages, Zod schemas, the effect request hash, transcript edits, an RPC channel with an in-process memory transport).
- `@nylorun/harness/api`: `createHarness({ channel, executors })`, a harness that leases runs, renews their leases, replays a run's recorded outcomes without asking, keeps transcripts by record cursor, and runs model, MCP and sandbox calls through the executors it is given.
- `@nylorun/runtime`: the Harness API server per Tenant (`TenantHandle.attachHarness`), the in-process harness, and the journal as the Record seam. A model call's journal row now stores the request's hash without its prompt, so a replay never sends a prompt twice. `NYLORUN_HARNESS_API=0` runs the engine in the advance as before, until F6.2 removes it. A Runtime older than this one may fail a turn that was in flight across a downgrade with drift.
