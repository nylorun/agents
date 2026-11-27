# The record: the one write path into a Tenant's event log

A session's events are written here and nowhere else. This folder builds each event on the
`nylorun.event/2` envelope, checks it against the event catalog, and holds the only inserts into
`nylorun_streams.session_events` and `session_log_heads`; the store runs those statements in the
caller's transaction. The stream relay then copies the committed rows to S2
([`streams/relay`](../streams/relay/README.md)), so a stream never holds an event that did not
commit.

## Interface

- `appendEvent` (`append.ts:99`): appends one session event, allocating its `seq` from the
  session's log head and writing the row through a `RecordWriter`.
- `RecordWriter` (`append.ts:62`): the store's writer, called inside the caller's transaction.
- `AppendInput` (`append.ts:78`): the event's session, turn, type, payload, writer and the `epoch`
  read under the session's lock.
- `RecordEntryTooLargeError`, `checkEntry`, `entryBytes` (`append.ts:31`–`append.ts:56`): the
  per-entry size limit and the error a write past it throws.
- `buildEvent`, `EventInput`, `InvalidEventError`, `CORE` (`envelope.ts:21`–`envelope.ts:49`): the
  envelope builder, its input, its refusal, and core's own writer identity.
- `encodeCursor`, `decodeCursor` (`cursor.ts:8`, `cursor.ts:13`): `base64url("<sessionId>:<seq>")`.
- `buildAgentEvent`, `appendAgentEvent`, `AgentRecordWriter`, `AgentAppendInput` (`agent.ts`): the
  Agent's lifecycle stream, `nylorun.agent-event/1` (`agent.ts:1`).
- `buildTenantEvent`, `appendTenantEvent`, `TenantRecordWriter`, `TenantAppendInput` (`tenant.ts`):
  the Tenant's audit stream (`tenant.ts:1`).

## Rules

- Every event is built on the envelope and checked against the catalog before any store writes it,
  so no event outside the catalog reaches the record or a stream (`envelope.ts:1`).
- The session's log head allocates the next `seq`, and the row is written in the caller's
  transaction; the caller holds the session row lock, which orders the appends, and passes the
  `epoch` it read under that lock (`append.ts:2`).
- The database holds one Tenant, so session rows are keyed by session alone; the Tenant id lives in
  the envelope (`append.ts:2`).
- An entry past the Tenant's `recordEntryBytes` is refused with `RecordEntryTooLargeError`
  (`limit_exceeded`, 413) before anything is written, which keeps every record under S2's 1 MiB
  (`append.ts:2`, `core/src/utils/runtime-limits.ts:361`).
- A cursor names the last event a client saw, and its `seq` is both the per-session sequence and
  the S2 sequence number of `sessions/<sessionId>` (`cursor.ts:1`).
- Agent and Tenant events are numbered from 0 per Agent id and per Tenant, are written under their
  own row lock, and stay in the record: neither is published to the stream relay (`agent.ts:1`,
  `tenant.ts:1`).
- Other folders import `index.ts`, never this module's own files, and
  `scripts/check-boundaries.mjs` refuses an insert into these tables anywhere else (`index.ts:1`).

## Side effects

- Inserts into `nylorun_streams.session_events` and `nylorun_streams.session_log_heads` through the
  store's `RecordWriter` (`../store/postgres/record-writer.ts`), and the Agent and Tenant
  equivalents (`agent_events`, `tenant_events`).
- Nothing here calls the network, reads a file or appends to S2.

## Verification

- Run: `npm test` (vitest, `runtime/server/package.json`)
