---
"@nylorun/harness": minor
"@nylorun/runtime": minor
"nylorun": patch
---

**Host timings, retries and engine settings are configuration with defaults (B15).** Still protocol 15 and Harness API 4. See MIGRATION.md and DEPLOYMENT.md ("Host tuning").

- **Host tuning.** The Runtime processes' timeouts, retries, poll intervals and internal sizes are one typed schema with a default each (`HostTuningSchema`, `runtime/server/src/tuning.ts`): keys, the Harness API, the API's streams, the Host, the Object store, the Tenant, its sweep, Durable Session Execution, Restate, Postgres, Durable Streams and the relay, the gates, egress-gate, sandbox pods, harnesses and traces. An operator sets any part in `NYLORUN_TUNING` (JSON), parsed with the stack configuration and read once at start; every default is the value before. An unknown key or a value past its ceiling (Node's longest timer, S3's part sizes, S2's batch, the sandboxes service's wait) stops the process naming the key. Core hands a sandbox pod's engine the `harness` and `engine` groups the operator set. `nylorun start` passes `NYLORUN_TUNING` to the runtime, gateway and harness containers.
- **Our engine's loop is configuration.** `createHarness` takes `compaction` (`CompactionConfig`, `DEFAULT_COMPACTION_CONFIG`: the kept tail, the reply's reserve, the estimate), `partialOutputChars` (a failed agent-as-tool's output its parent sees), `resendDelaysMs` and `leaseRetryMs`; `runDurable` takes `loop` (`LoopConfig`), which an invocation hands its agents used as tools. `EngineToolConfig` is `EngineConfig`. The Runtime's harness host passes the tuning's `engine` group to `createHarness`.
- **Kept as constants**, each justified where it is defined: Node's longest timer, S3's part sizes and object key, S2's batch, the sandboxes service's longest wait and pod variable, the `environment.egress` event's 16 running turns, W3C's 512-character `tracestate`, and the 24-hour floor of a wake's dedupe key.
