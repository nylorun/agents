# Durable Streams: the seam between the Runtime and a stream store

The Runtime keeps every session event in its Postgres record, and serves history and live
followers from a stream store beside it. This folder is the seam: one interface, the rules a stream
keeps, the basin naming a Tenant's streams live under, and an in-memory implementation for tests.
S2 is the production implementation, in [`adapters/streams`](../adapters/streams/README.md); the
record feeds it through [`relay`](./relay/README.md).

## Interface

- `DurableStreams` (`types.ts:88`): the seam — `append`, `read`, `tail`, `ensureTenant`,
  `deleteTenant`, `deleteStream`, `ensureStream?`, `listStreams`, `close`, `probe?`.
- `StreamRecord` (`types.ts:49`): one record as read — `seq`, `timestamp`, `body`.
- `AppendOptions`, `AppendAck`, `SeqMismatch`, `AppendResult` (`types.ts:56`–`types.ts:76`): the
  conditional append, its acknowledgement and its refusal.
- `ReadOptions` (`types.ts:78`): a `signal`, and `follow` (history only, or live after it).
- `SESSION_STREAM_PREFIX`, `RUNS_STREAM`, `RUNS_STREAM_RETENTION_SECS`, `sessionStream()` (`types.ts:144`–`types.ts:153`): the stream names.
- `basinOf`, `parseBasin`, `tenantBasinName`, `validateBasinPrefix`, `MAX_BASIN_PREFIX_LENGTH`
  (`basin.ts:24`–`basin.ts:66`): the basin name of a Tenant and generation, and back.
- `MemoryStreams` (`memory.ts:22`): the in-process `DurableStreams`.
- [relay](./relay/README.md): the record's committed rows into the streams.

## Rules

- A stream numbers its records from 0 with no gaps; the tail is the sequence the next appended
  record gets, and 0 for a stream that does not exist (`types.ts:28`).
- An append writes every record or none, needs at least one record, and rejects when the Tenant has
  no basin (`types.ts:89`, `memory.ts:36`).
- `matchSeq` makes an append conditional: it writes only when the tail equals it, and otherwise
  answers `seq_mismatch` with the tail and writes nothing (`types.ts:56`, `memory.ts:46`).
- A read from `fromSeq` gives history first and, with `follow: false`, stops at the tail observed
  when the read started; `follow` defaults to true (`types.ts:78`, `types.ts:99`).
- Reading a stream that does not exist yet waits for its first record (`types.ts:99`).
- A basin name is 8 to 48 characters of lowercase letters, digits and hyphens, and cannot begin or
  end with one; `_` is not allowed, so a Tenant id's underscore becomes a hyphen (`basin.ts:4`).
- A basin prefix is at most 16 characters and must match the same alphabet (`basin.ts:24`,
  `basin.ts:29`); it is what keeps two deployments sharing one S2 account apart (`basin.ts:4`).
- `MemoryStreams` keeps the seam's sequence, conditional-append and resume semantics and is not
  durable: history does not survive a restart (`memory.ts:17`).

## Side effects

- `MemoryStreams` keeps everything in its own maps and reaches nothing outside the process
  (`memory.ts:24`); this folder itself does no I/O.
- `basinOf` and `tenantBasinName` derive the name that decides which basin on S2 a Tenant's records
  land in (`basin.ts:43`, `basin.ts:66`).

## Verification

- Run: `npm test` (vitest, `runtime/server/package.json`)
