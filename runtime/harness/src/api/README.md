# A harness over the Harness API

The entry a Runtime process uses: `createHarness` says `hello` on the Harness API's channel, leases runs, and gives each one the executors that reach the model, the tools, the sandbox, the artifacts, the definition's files and the events. `apiHost` is the `DurableHost` those runs resolve their effects through, and `runTurn` is one leased run from start to its result.

## Interface

- `createHarness(options)`, `Harness`, `HarnessOptions`, `HarnessLogger` (`harness.ts`): `start()`, `stop(waitMs?)` and `runs`, over the channel and the executors.
- `apiHost(options)`, `EngineConfig` (`host.ts`): a `DurableHost` over the Harness API: effect intents and resolutions, artifacts, skill mounts and events.
- `runTurn(ctx, run)`, `RunContext`, `agentLoopOf` (`run.ts`): one leased run, from `turn.start` to its recorded result.
- `HarnessExecutors`, `HarnessFiles`, `HarnessRun`, `PreparedRun`, `ToolCallContext`, `McpRecorder`, `HarnessFileEntry`, `FailedFileOutcome` (`executors.ts`): what runs a model call, a tool, a sandbox call, a file read and a write.
- `RunAbort`, `ABORT_MESSAGES`, `runAbortKind` (`abort.ts`): a run stopped as `cancel`, `ownership.lost` or `shutdown`.
- `TranscriptCache` (`transcript-cache.ts`): the transcripts held between segments.
- `DEFAULT_TRANSCRIPT_CACHE_MB` (256), `DEFAULT_LEASE_RETRY_MS` (100), `DEFAULT_RESEND_DELAYS_MS` (1, 2 and 4 s), `DEFAULT_ARTIFACT_PAGE_BYTES` (32 KiB) (`harness.ts`).
- `index.ts`: the folder's public surface, including the engine tool, memory and trace exports it shares with the package root.

## Rules

- The harness holds one pending `lease` at a time and starts again `leaseRetryMs` after a refused one (`harness.ts`).
- A lease is renewed every `renewEveryMs` with a new run token, and a run that loses it is aborted with `ownership.lost` (`harness.ts`, `abort.ts`).
- `stop()` aborts the runs with `shutdown` and waits for them to finish, at most `waitMs` (`harness.ts`).
- A tool call whose gate hop lost its answer is sent again after `resendDelaysMs`, the last delay repeating (`harness.ts`).
- A harness holds no more than `maxRuns` live runs, and any number when it is unset (`maxRuns = options.maxRuns ?? Infinity`, `harness.ts`).
- An effect is recorded before the work it stands for is done, and an `uncertain` one is never run again (`host.ts`).
- An effect request is checked by its hash, so a replay of a different request is refused (`host.ts`, `effectRequestHash`).

## Side effects

- The channel carries `hello`, `lease`, `renew`, `event`, `artifact.read`, `artifact.write` and `definition.file` requests (`harness.ts`, `host.ts`).
- A tool result too large for the record is written as an artifact of the session (`host.ts`, executors).
- The turn's skills are mounted in the sandbox before a sandbox call (`host.ts`).
- The transcript cache holds up to `transcriptCacheMb` MiB of transcripts (`harness.ts`, `transcript-cache.ts`).

## Verification

- Run: `npm test` from `runtime/harness/`
