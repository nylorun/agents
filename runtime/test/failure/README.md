# Failure suite (architecture §17)

Every failure case in the Runtime architecture's §17 has a named test on the real
infrastructure: a Tenant schema in Postgres, advances through Restate, and events
relayed to s2-lite, all on the Docker test stack (`test/stack/compose.yaml`). The
tests in this directory run all three together. The table also lists the tests
that cover each case lower down, against one component or against the in-memory
execution and streams (the unit tests run every Tenant on Postgres too).

```sh
npm run test:stack:up -w @nylorun/runtime
NYLORUN_TEST_STACK=1 npm run test:integration -w @nylorun/runtime
npm run test:stack:down -w @nylorun/runtime
```

The files skip unless `NYLORUN_TEST_STACK=1`. CI runs them in the `integration`
job. §17.3 also runs against a real `nylorun up` stack, where the `runtime`
container is killed with `docker compose kill` (`npm run test:failure`,
`scripts/smoke-failure.mjs`, in the `stack` job).

| § 17 case | On Postgres + Restate + S2 | Also covered by |
| --- | --- | --- |
| 1. Duplicate wake | `wakes.integration.test.ts` › "§17.1 duplicate wakes, deduped or not, during and after a turn run it once" | `tenant/ownership.test.ts` › "treats duplicate wakes as harmless"; `contracts/execution.contract.ts` › "dedupes wakes with the same dedupe key" (on Restate in `execution/restate.integration.test.ts`) |
| 2. A wake lost between commit and send | `wakes.integration.test.ts` › "§17.2 a wake lost between commit and send: the Tenant sweep on Restate recovers it" | `tenant/ownership.test.ts` › "recovers a wake lost between commit and send through the sweep"; `tenant/sweep.test.ts` › "wakes running or runnable sessions that have no live owner" |
| 3. A Worker killed during a model effect (`uncertain` after takeover; through the gateway, recovered) | `workers.integration.test.ts` › "§17.3 a Worker killed during a model effect: …" (in-process model, still `uncertain`); `scripts/smoke-failure.mjs` (the `runtime` container killed, or stopped, mid-call: the turn completes with one provider call, P1.2) | `host/execution.integration.test.ts` › "takes over from a Worker stopped mid-advance: …"; `tenant/ownership.test.ts` and `tenant/sweep.test.ts` › "takes over from a dead owner: …" |
| 4. Two advances racing for one session (`ownership.lost`, no duplicate event) | `workers.integration.test.ts` › "§17.4 two advances racing for one session: …" | `tenant/ownership.test.ts` › "runs one of two racing advances; …" and "keeps a second Worker on the same Tenant out …"; `contracts/store.contract.ts` › "aborts an epoch-checked transaction with ownership.lost and no write"; `tenant/sweep.test.ts` › "a stale epoch writes nothing" |
| 5. No sequence gap under concurrent writers | `streams.integration.test.ts` › "§17.5 no sequence gap under concurrent writers on two nodes while turns run" | `store/postgres.integration.test.ts` › "has no sequence gaps with 20 concurrent writers on two pools"; `contracts/store.contract.ts` › "has no sequence gaps under 20 concurrent transactions"; `tenant/streams.suite.ts` › "resumes SSE from Last-Event-ID with no gap or duplicate under concurrent commits" |
| 6. A relay append retried after an unacknowledged success (one event) | `streams.integration.test.ts` › "§17.6 relay appends retried after unacknowledged successes land exactly once" | `streams/relay-core.test.ts` › "acknowledges nothing it has not appended: an append whose ack was lost is retried once", "replays unacknowledged transactions after a crash without duplicating them"; on Postgres logical replication in `streams/relay-pg.integration.test.ts` › "replays what a crashed relay received but S2 never got" |
| 7. S2 unavailable (state commits, history `503`, complete stream after recovery) | `streams.integration.test.ts` › "§17.7 S2 unavailable: …" (s2-lite behind a TCP proxy that is taken down) | `tenant/streams.suite.ts` › "commits while streams are down, answers history 503, …"; `streams/relay-core.test.ts` › "keeps commits while S2 is down and delivers them in order when it returns"; `streams/relay-pg.integration.test.ts` › "holds the slot while S2 is down and catches up in order" |
| 8. An SSE client reconnecting to a different API node (no gap) | `streams.integration.test.ts` › "§17.8 an SSE client reconnecting to a different API node resumes without a gap" | `tenant/streams.suite.ts` › "resumes SSE on another node without a gap" |
| 9. Cancel delivered to another Worker | `workers.integration.test.ts` › "§17.9 cancel delivered to another Worker: …" | `host/execution.integration.test.ts` › "cancels a long model call on the Worker from another node through the control stream"; `tenant/streams.suite.ts` › "delivers a cancel to the node running the advance through the control stream" |
| 10. A Restate abort during a long advance | `workers.integration.test.ts` › "§17.10 …" › "retries an advance Restate aborted without calling the model again: …" and "bounds a runaway advance with its deadline and grace; …" | `execution/restate.integration.test.ts` › "fails and retries an advance that outlives short timeouts, without overlapping it"; `host/execution.test.ts` › "settles a runaway model call as uncertain at the deadline" and "abandons an advance that ignores the deadline; the next advance takes over" |
| 11. Restate state wiped (sweeps re-armed, runnable sessions resumed) | `wakes.integration.test.ts` › "§17.11 Restate state wiped: …" (the test stack's `restate` container is recreated) | `host/execution.integration.test.ts` › "re-arms sweeps after Restate state is lost and resumes runnable sessions" (a fresh service prefix) |
| 12. Cancel while S2 is down (the cancel commits; nothing of the cancelled turn is written after it) | `workers.integration.test.ts` › "§17.12 cancel while S2 is down: …" (both nodes reach s2-lite through a TCP proxy that is taken down) | — |

## How the cases are staged

- **Nodes and Workers** (`support.ts`). A node is one process's view of the
  Tenant: its own Tenant runtime, Postgres pool, S2 client and Worker id. A
  Worker is one process's Restate endpoint, served on the host and reached by
  Restate as `http://host.docker.internal:<port>`. Worker ports start at
  `NYLORUN_TEST_FAILURE_WORKER_PORT_BASE` (default 9230) and use offsets 0–11.
- **A killed Worker** (§17.3) stops its endpoint and closes its Tenant while its
  model call is still blocked, so its lease lapses. A second Worker at the same
  URL takes the session over. The real kill is in `scripts/smoke-failure.mjs`.
- **A stalled owner** (§17.4) is a lease expired in Postgres while the owner's
  advance still runs, as after a long pause.
- **A Restate abort** (§17.10) uses inactivity and abort timeouts of 0.3 s each,
  standing in for the adapter's one-hour defaults. The runaway case adds a 1 s
  advance deadline and a 0.2 s grace period.
- **S2 down** (§17.7) puts a TCP proxy between the node and s2-lite and takes it
  down, so connections fail as against a dead endpoint. s2-lite on the test
  stack keeps its streams in memory, so stopping its container would lose them.
- **Restate wiped** (§17.11) recreates the test stack's `restate` container
  (`docker compose up --force-recreate`). It has no volume, so every
  deployment, queued invocation, sweep chain and idempotency key is gone. The
  test needs the `docker` CLI and the same `COMPOSE_PROJECT_NAME` and port
  variables as `test:stack:up`.

## Durable Streams (Durable Streams §13, §20)

`durable-streams.integration.test.ts` runs the stream relay on the test stack's Postgres
(logical replication) and s2-lite, and checks after each case that every S2 stream equals its
record, `0..head-1` in order. It needs only `NYLORUN_TEST_STACK=1`.

| Case | Test |
| --- | --- |
| The relay crashes mid-stream | "keeps S2 equal to the record when the relay crashes mid-stream" (20 sessions, a second relay takes the slot) |
| S2 unreachable | "keeps committing while S2 is unreachable for 10 s, then catches up in order" (the slot's confirmed position does not move while S2 is down) |
| The slot is invalidated by `max_slot_wal_keep_size` | "recreates a slot Postgres invalidated for holding too much WAL, and reconciles" (sets a 1 MB cap with `ALTER SYSTEM`, restored afterwards) |
| Another process takes over | "hands the slot to another process when the active relay's connection dies" |

Lower down: `streams/relay-core.test.ts` (the relay over the in-memory record) and
`streams/relay-pg.integration.test.ts` (crash before append, dropped slot, two relays,
concurrent writers).

The latency gate, commit to S2 under 200 ms at p99 with 50 sessions, is
`streams/relay-bench.integration.test.ts`; it runs only with `NYLORUN_BENCH=1`:

```sh
NYLORUN_TEST_STACK=1 NYLORUN_BENCH=1 npx vitest run -c vitest.integration.config.ts test/streams/relay-bench
```

## Model Gate (blueprint P1)

Model calls of the loop cross the gates service (the stack's `gateway` container). A failure
of that hop is a failure outcome, never an uncertain effect, and cancel still reaches the
provider. The real cases run on a `nylorun up` stack in `scripts/smoke-failure.mjs`
(`npm run test:failure`), after §17.3, with the stub model holding calls open:

| Case | `scripts/smoke-failure.mjs` | Also covered by |
| --- | --- | --- |
| Every call crosses the gateway | step 6: a `model_call` line per call in `nylorun logs gateway`, never the key; the runtime logs `modelGate` | `gates/tenant-model-gate.test.ts` (a Tenant served by the gate never builds the in-process gate) |
| The gateway is down | step 7: `model.transient`, no new `effect.uncertain`; the next turn completes once it is back | `gates/http-client.test.ts` › "is a transient, retryable failure when the gate is unreachable" |
| The gateway dies mid-call | step 8: `model.transient`, no new `effect.uncertain`, the provider request closed | `gates/http-client.test.ts` › "…when the connection is lost mid-call" |
| Cancel mid-call | step 9: the provider request aborted within 2 s; the turn ends `cancelled` | `contracts/model-gate.contract.ts` › "throws and aborts the provider request when cancelled during the call" (both gates); `gates/gates-host.test.ts` › "aborts the provider request when the caller goes away mid-call" |
| The runtime dies or stops mid-call | steps 3–5: the gateway keeps the keyed call; after takeover the runtime re-sends it and joins it; the turn completes, nothing `uncertain`, one provider call (P1.2) | `tenant/recovery.test.ts`; `gates/inflight.test.ts`; `gates/gates-host.test.ts` › "keyed calls (P1.2)" |
| A wrong gates token | step 10: `401` | `gates/gates-host.test.ts` › "refuses a missing or wrong token…"; `gates/http-client.test.ts` › "is an auth failure naming NYLORUN_GATES_TOKEN…" |
| A runaway loop reaches its cap | step 11: a Tenant day cap fails the next turn with `model.budget_exhausted`, and the provider sees no call (P1.3) | `model-budget.test.ts` › "stops a runaway loop at the turn's token cap" (both gates); `gates/meter.test.ts` › "caps" |

The hop's cost, 50 calls through the HTTP gate against the in-process gate, is
`gates/hop-latency.test.ts`; it runs only with `NYLORUN_BENCH=1`.
