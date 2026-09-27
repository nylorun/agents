# OSS runtime implementation notes

Historical core-pass record. The subsequent local release migrated CLI/creator/Studio and ran focused functional acceptance. Prefer package READMEs, [src/CONTEXT.md](./src/CONTEXT.md), and changelogs for current **Runtime Host** / **Tenant** vocabulary and status.

**Build/startup verification only; functional correctness and end-to-end behavior remain unverified.**

New standalone implementation is a **Runtime Host** (`src/host/`) plus per-**Tenant** runtime (`src/tenant/`), using `@nylorun/harness` through the public workspace. Local candidate digests for this repo’s packs belong in release notes / changelogs; Cloud upgrades via npm after publish, not via in-repo vendor artifacts. Node 24 is required for `node:sqlite`.

Built capabilities (current Host + Tenant model):

- Independent standalone HTTP Host and `@nylorun/runtime/core` entry (`startEphemeralRuntime` for tests); no customer function bodies in execution manifests.
- Per-Tenant SQLite transactional definitions, pinned sessions, command receipts, immutable segment checkpoints, per-effect journal, actions, waits (within session checkpoint), canonical events and opaque resumable cursors.
- Scheduling behind Durable Session Execution, per-session ownership (lease and epoch) with takeover, a Tenant sweep that re-wakes orphaned sessions, conservative model-intent uncertainty, cancellation fencing and inspectable uncertain actions/effects.
- Separate application/executor credentials; SSE notifications, persisted discovery, exclusive claims, generations, heartbeats, expiry to uncertainty, matching duplicate result receipts and conflict rejection. Executors register via `PUT /v1/executors`.
- Cancellation fences the current turn and permits later messages in the same session. New turns resume the state preceding the cancelled turn, while canonical history retains its events. Claimed/model work with ambiguous external outcomes remains inspectable as uncertain; late old-turn settlement cannot mutate a later turn.
- Failed turns retain their failed checkpoint in the SQLite checkpoints table (keyed by session/turn/segment) and their effect/event journal, but restore the pre-turn session state for later messages so abandoned tool plans cannot run under a new turn.
- Message, approval, response, cancellation and action-result commands; command retry identity ignores requestId but binds semantic payload to idempotencyKey.
- Runtime-owned scripted provider and configured generic model gateway; health/readiness (`service: "nylorun-runtime"`, `hostId`, protocol), launch command and lifecycle shutdown.
- Local-only session host path. Cloud-specific Agents API client modules are not part of OSS Runtime.
- Clients send `Nylorun-Tenant` + `Nylorun-Protocol`; Tenant model routes live under `/v1/tenant/*`.

Pre-existing foundations: provider/media adapters, CLI launcher, Hono router, old session storage and Studio/example helpers. These are not represented as newly built standalone runtime capabilities.

| Target area / milestone                              | Implementation status | Built evidence                                              | Pending implementation                                                         | Verification required                                                    |
| ---------------------------------------------------- | --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| M0 consolidate shared contracts / definition imports | Partial               | Shared contracts and engine imports in core                 | Public legacy tooling migration and final cross-repo audit                     | Contract conformance; incompatible definition rejection                  |
| M1 public execution API in both execution hosts      | Built                 | runDurable and persisted individual model/tool/hook effects | Engine gaps tracked in harness package docs                                    | History, tools/hooks, schema/output and checkpoint behavior              |
| M2 customer tools and basic action recovery          | Partial               | SQLite transactions, commands, claims, history, SSE         | Administrative reconciliation, scalable indexes and bounded history pagination | Command retries, duplicate outcomes, fencing, transaction/event ordering |
| M3 durable session demonstration                     | Partial               | SSE, lease renewal, uncertainty and startup runnable work   | Reconciliation, timed sleep/wait-for wakeups, broader recovery acceptance      | Reconnects, expiry, cancellation races, interrupted intents, approvals   |
| M4 coherent developer distribution                   | Partial               | Host lifecycle + Project link (Runtime Tenants)             | Broader packaging acceptance                                                   | New launch/package installation acceptance                               |
| M5 portability and release discipline                | Not started           | Shared versions and manifest identity checked               | Runtime conformance suite, checkpoint/session migration and support matrix     | Cross-runtime behavior; migration/recovery gates                         |
| M6 managed design-partner pilot                      | Deferred              | No managed operations added to OSS                          | Out of scope for this OSS repo                                                 | Not an OSS release gate                                                  |

No milestone acceptance gate is marked complete by this table. The table maps the OSS portion of Target Architecture and Development Roadmap v1.1; shared harness and SDK work are covered in their package docs.

## Run and verification

Prefer `startEphemeralRuntime` with a temporary Host root for startup checks. Host environment is baseline-only (`PATH`, locale, `TZ`); Tenant config is not taken from ambient `NYLORUN_*` / model env. SDK environment: `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, `NYLORUN_EXECUTOR_KEY`, `NYLORUN_TENANT`, `NYLORUN_IMPLEMENTATION_VERSION`.

```sh
eval "$(npx nylorun runtime status --env)"
```

Startup health does not validate SQLite recovery, model gateway compatibility, tool execution or credentials against real user workloads.

## Functional testing handoff

1. Conversation history/instructions, tools and hook ordering, before/after state, structured output, action schema validation and stable replay identities.
2. Session/command idempotency (including changed requestId), conflicts, exact duplicate action results after expiry, stale claim rejection, observer/executor authorization and Tenant mismatch.
3. Subscribe-before-discovery, SSE reconnect and replay cursors, committed action notification ordering, concurrent results and multiple tools, slow/disconnected observers.
4. Human approval/response identity and type, denial, cancellation during model/tool dispatch, late results and waiting/uncertainty visibility; new messages after cancellation, repeated cancellation and old-turn settlement/recovery fencing.
5. Restart recovery of runnable/paused/waiting work, expired claims, model intent with missing outcome, process ownership and locked database behavior. No automatic repeated uncertain external effect should occur.
6. Cross-runtime protocol, manifests, behavior, event ordering and version rejection.
7. Cross-Tenant isolation: same agent id in two Tenants; opaque 404 for foreign credentials; sandbox prefix isolation.

## Missing implementation versus unverified behavior

Missing: operations for reconciling uncertain effects; timed sleep and external wait-for wakeup commands; bounded history pagination/retention; multi-replica scheduling; provider-specific gateway adapters for the new standalone host; administrative credential rotation; full conformance tooling. Session migration/export/import is deferred. A custom provider must honor AbortSignal for graceful draining. Executor registrations persist per Tenant via `PUT /v1/executors`.

Implemented but unverified: all durable model/action replay, claim/result fencing, approvals/responses, cancellation, SSE ordering, startup recovery, output validation and cross-runtime compatibility. SQLite storage is intentionally local and single-process per Tenant; no shared filesystem promise. All applicable functional gates remain open for the later testing agent.
