# Failure suite (architecture §17)

Every failure case in the Runtime architecture's §17 has a named test on the real
infrastructure: a Tenant schema in Postgres, advances through Restate, and events
relayed to s2-lite, all on the Docker test stack (`test/stack/compose.yaml`). The
tests in this directory run all three together. The table also lists the tests
that cover each case lower down, against one component or against the in-memory
fakes.

```sh
npm run test:stack:up -w @nylorun/runtime
NYLORUN_TEST_STACK=1 NYLORUN_TEST_STORE=postgres npm run test:integration -w @nylorun/runtime
npm run test:stack:down -w @nylorun/runtime
```

The files skip unless both variables are set. CI runs them in the `integration`
job. §17.3 also runs against a real `nylorun start` stack, where the `runtime`
container is killed with `docker compose kill` (`npm run test:failure`,
`scripts/smoke-failure.mjs`, the `failure` job).

| § 17 case | On Postgres + Restate + S2 | Also covered by |
| --- | --- | --- |
| 1. Duplicate wake | `wakes.integration.test.ts` › "§17.1 duplicate wakes, deduped or not, during and after a turn run it once" | `tenant/ownership.test.ts` › "treats duplicate wakes as harmless"; `contracts/execution.contract.ts` › "dedupes wakes with the same dedupe key" (on Restate in `execution/restate.integration.test.ts`) |
| 2. A wake lost between commit and send | `wakes.integration.test.ts` › "§17.2 a wake lost between commit and send: the Tenant sweep on Restate recovers it" | `tenant/ownership.test.ts` › "recovers a wake lost between commit and send through the sweep"; `tenant/sweep.test.ts` › "wakes running or runnable sessions that have no live owner" |
| 3. A Worker killed during a model effect (`uncertain` after takeover) | `workers.integration.test.ts` › "§17.3 a Worker killed during a model effect: …"; `scripts/smoke-failure.mjs` (the `runtime` container killed mid-call) | `host/execution.integration.test.ts` › "takes over from a Worker stopped mid-advance: …"; `tenant/ownership.test.ts` and `tenant/sweep.test.ts` › "takes over from a dead owner: …" |
| 4. Two advances racing for one session (`ownership.lost`, no duplicate event) | `workers.integration.test.ts` › "§17.4 two advances racing for one session: …" | `tenant/ownership.test.ts` › "runs one of two racing advances; …" and "keeps a second Worker on the same Tenant out …"; `contracts/store.contract.ts` › "aborts an epoch-checked transaction with ownership.lost and no write"; `tenant/sweep.test.ts` › "a stale epoch writes nothing" |
| 5. No sequence gap under concurrent writers | `streams.integration.test.ts` › "§17.5 no sequence gap under concurrent writers on two nodes while turns run" | `store/postgres.integration.test.ts` › "has no sequence gaps with 20 concurrent writers on two pools"; `contracts/store.contract.ts` › "has no sequence gaps under 20 concurrent transactions"; `tenant/streams.suite.ts` › "resumes SSE from Last-Event-ID with no gap or duplicate under concurrent commits" |
| 6. A relay append retried after an unacknowledged success (one event) | `streams.integration.test.ts` › "§17.6 relay appends retried after unacknowledged successes land exactly once" | `streams/relay.suite.ts` › "yields exactly one event when an append is retried after an unacknowledged success", "recovers a lost acknowledgement …", "relays exactly once when several processes relay the same outbox" (on s2-lite in `streams/relay.integration.test.ts`) |
| 7. S2 unavailable (state commits, history `503`, complete stream after recovery) | `streams.integration.test.ts` › "§17.7 S2 unavailable: …" (s2-lite behind a TCP proxy that is taken down) | `tenant/streams.suite.ts` › "commits while streams are down, answers history 503, …"; `streams/relay.suite.ts` › "keeps events in the outbox while S2 is down …" |
| 8. An SSE client reconnecting to a different API node (no gap) | `streams.integration.test.ts` › "§17.8 an SSE client reconnecting to a different API node resumes without a gap" | `tenant/streams.suite.ts` › "resumes SSE on another node without a gap" |
| 9. Cancel delivered to another Worker | `workers.integration.test.ts` › "§17.9 cancel delivered to another Worker: …" | `host/execution.integration.test.ts` › "cancels a long model call on the Worker from another node through the control stream"; `tenant/streams.suite.ts` › "delivers a cancel to the node running the advance through the control stream" |
| 10. A Restate abort during a long advance | `workers.integration.test.ts` › "§17.10 …" › "retries an advance Restate aborted without calling the model again: …" and "bounds a runaway advance with its deadline and grace; …" | `execution/restate.integration.test.ts` › "fails and retries an advance that outlives short timeouts, without overlapping it"; `host/execution.test.ts` › "settles a runaway model call as uncertain at the deadline" and "abandons an advance that ignores the deadline; the next advance takes over" |
| 11. Restate state wiped (sweeps re-armed, runnable sessions resumed) | `wakes.integration.test.ts` › "§17.11 Restate state wiped: …" (the test stack's `restate` container is recreated) | `host/execution.integration.test.ts` › "re-arms sweeps after Restate state is lost and resumes runnable sessions" (a fresh service prefix) |

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
