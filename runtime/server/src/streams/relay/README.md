# The stream relay: the record into S2

The relay is the only writer of a session's stream. It reads the Tenant's committed record rows
over Postgres logical replication and appends each session's events, in commit order, to
`sessions/<sessionId>` in the basin generation the row carries. A stream write is a sink on this
path: nothing inside the Runtime waits on it, and no business code appends to a stream.

## Interface

- `createStreamRelay` (`core.ts`): builds the relay from a `ChangeSource`, a record reader and
  `DurableStreams`; the relay it returns starts and stops the reading.
- `StreamRelayOptions` (`types.ts`): the three collaborators, a `log`, and batch overrides
  (`maxBatchRecords`, `maxBatchBytes`, `reconcileConcurrency`); each falls back to `hostTuning().streams`.
- `RecordRow` (`types.ts`): one committed record row — `tenantId`, `sessionId`, `seq`, the basin
  `generation` it belongs to, and the event as stored (`body`).
- `CommittedTx` (`types.ts`): one transaction's rows in commit order, and the `endLsn` the source
  resumes from once it is acknowledged.
- `ChangeSource` (`types.ts`): the commits, kept until acknowledged — `start`, `acknowledge`,
  `reconciled`, `stop`, `lag`.
- `ChangeHandlers` (`types.ts`): what the source calls — `onActive({ fresh })`, `onTx`,
  `onKeepalive`, `onInactive`.

## Rules

- One queue and one pump per session, so a session's rows reach S2 in `seq` order (`core.ts:109`).
  A batch is the contiguous rows at the front of the queue and stops at a gap, a generation
  change, `maxRecords` or `maxBytes` (`core.ts:145`).
- Every append is conditional: `matchSeq` is the first row's `seq` (`core.ts:174`).
- An append whose tail is past the batch settles every row below that tail: S2 already held them,
  so the batch was a replay (`core.ts:178`). An append whose tail is behind the batch reads the gap
  from the record and sends it first (`core.ts:184`).
- A row whose generation is no longer the Tenant's, or whose Tenant is gone, is settled and
  dropped (`core.ts:193`); the basin is ensured before an append is retried (`core.ts:205`).
- A failed append retries with exponential backoff from `streams.relayRetry.minMs`, doubling to
  `maxMs` (`core.ts:206`, `tuning.ts:360`).
- A transaction is acknowledged only when every row it holds is settled, in commit order, so an
  incomplete transaction holds the position back (`core.ts:290`).
- A fresh source — a new or lost slot — reconciles every session's S2 tail against its record head
  and sends the difference from the record (`core.ts:300`, `core.ts:341`); `matchSeq` makes the
  overlap with live rows harmless.
- The relay never writes the record and never deletes a stream; `sessions.reset` and Tenant
  deletion retire basins elsewhere (`../README.md`).

## Side effects

- Opens a Postgres logical replication connection on the `nylorun_stream_relay` publication
  (`../../adapters/replication/pgoutput.ts:2`), holding one slot: one process per Tenant is active
  and the others retry and take over (`pgoutput.ts:7`).
- Acknowledges the slot only up to what S2 holds (`pgoutput.ts:10`).
- Appends to and reads from S2 through `DurableStreams` (`streams.append`, `streams.tail`).

## Verification

- Run: `npm test` (vitest, `runtime/server/package.json`)
