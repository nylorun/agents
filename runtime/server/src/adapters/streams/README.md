# The S2 adapter

One file implements `DurableStreams` on the S2 stream store: `s2.ts`. It is the only file in the
Runtime that imports the S2 SDK, and the only one that knows a basin name from a Tenant id.

## Interface

- `createS2Streams` (`s2.ts:104`): builds a `DurableStreams` from an `endpoint`, an optional
  `token` and an optional `basinPrefix`; `createStreams` (`../../infra/streams.ts:26`) is what the
  Host calls, and it chooses this adapter exactly when `NYLORUN_S2_ENDPOINT` is set
  (`infra/streams.ts:22`).

## Rules

- One basin per Tenant per generation, named `<prefix>tn-<ulid>`, with `-<generation base36>`
  appended from generation 1 (`../../streams/basin.ts:4`); a Tenant id that is not canonical maps
  to `<prefix>x-<slug>-<hash>` (`basin.ts:4`).
- The basin is created with `createStreamOnAppend` and `createStreamOnRead`, and its default stream
  config sets infinite retention (`s2.ts:203`–`s2.ts:207`). A Tenant's session streams therefore
  keep every record; s2-lite would otherwise default a stream to seven days (`s2.ts:22`).
- `runs` is the one stream whose retention is set: `ensureStream` gives it
  `RUNS_STREAM_RETENTION_SECS` (`s2.ts:258`, `../../streams/types.ts:148`).
- Bodies are JSON text in string records, and a record's timestamp is when S2 took it, not when the
  event was written (`s2.ts:15`).
- Appends use `appendRetryPolicy: "noSideEffects"`: the SDK retries only failures where nothing was
  written (`s2.ts:17`, `s2.ts:123`).
- A read pages its history with `S2_BATCH_MAX_RECORDS` (`s2.ts:102`).
- `deleteTenant` with `allGenerations` also deletes every later generation's basin, matched by
  `<basin>-<base36>` (`s2.ts:232`).

## Side effects

- Network calls to the S2 endpoint: basin create, list and delete, stream append, read, tail and
  delete (`s2.ts`).
- Reads `NYLORUN_S2_ENDPOINT` and `NYLORUN_S2_TOKEN` through the stack configuration
  (`../../host/stack-config.ts:716`); the token is passed to the SDK, never logged.

## Verification

- Run: `npm test` (vitest, `runtime/server/package.json`)
