# Session events over S2

A session's events are written to the Runtime's Postgres record inside the transaction that makes
them true, and copied from there to an S2 stream, one stream per session. History and live followers
are served from S2; nothing in the Runtime waits on it. This page follows that path in the code at
commit `3491b9456591e29cd333e7050dfc120e16435449`, and says plainly where the code stops short of
what the rest of the docs suggest.

## §0 What a session event is

Every session event is one record of the `nylorun.event/2` envelope with an open `type` and
`payload` (`core/src/contracts.ts:3689`–`core/src/contracts.ts:3731`). The fields that matter here:

- `seq`: the event's position in its session's log, from 0, in commit order
  (`core/src/contracts.ts:3701`).
- `cursor`: `base64url("<sessionId>:<seq>")` — the same string a client sends back as
  `Last-Event-ID` or `?cursor=` (`core/src/contracts.ts:3703`, `runtime/server/src/record/cursor.ts:8`).
- `tenantId`, `sessionId`, `turnId`, `runId`, `epoch`, `incarnation`: which session, turn and lease
  wrote it (`core/src/contracts.ts:3691`–`core/src/contracts.ts:3700`).
- `visibility` (`public` | `internal` | `restricted`) and `retention` (`full` | `metadata`)
  (`core/src/contracts.ts:3720`): an `internal` event is recorded and streamed but never served to a
  client (`runtime/server/src/tenant/session-streams.ts:499`).

An event is produced by business code inside a store transaction: a Tenant module calls
`t.event(...)` on the transaction, never a stream (`runtime/server/src/tenant/context.ts:1`). The
loop does not write events itself. Our harness reports a model call, tool call or artifact over the
Harness API, and core journals the effect and writes the resulting event in the transaction that
completes it (`runtime/server/src/harness-api/record.ts:1`,
`runtime/server/src/tenant/transcript.ts:1`); a completed tool call becomes `tool.completed` or
`node.completed` there (`runtime/server/src/harness-api/tool-journal.ts:214`–
`runtime/server/src/harness-api/tool-journal.ts:234`).

## §1 The write path, hop by hop

| # | Hop | Where |
| --- | --- | --- |
| 1 | a command, turn or effect calls `t.event(sessionId, turnId, type, payload)` | `runtime/server/src/tenant/context.ts:1` |
| 2 | `appendEvent` builds the envelope, checks the event catalog, takes the next `seq` from the session's log head and writes the row through `RecordWriter`, in the caller's transaction | `runtime/server/src/record/append.ts:99`, `runtime/server/src/record/envelope.ts:1` |
| 3 | Postgres commits; the `nylorun_stream_relay` publication publishes the insert of `nylorun_streams.session_events` | `runtime/server/src/store/postgres/drizzle/0002_stream_relay.sql:1` |
| 4 | the stream relay reads those commits over logical replication | `runtime/server/src/adapters/replication/pgoutput.ts:2`, `runtime/server/src/streams/relay/core.ts:84` |
| 5 | per session, one pump appends the contiguous rows to `sessions/<sessionId>` with `matchSeq` = the first row's `seq` | `runtime/server/src/streams/relay/core.ts:145`, `runtime/server/src/streams/relay/core.ts:170` |
| 6 | the basin is the Tenant's, for the generation the row carries | `runtime/server/src/streams/basin.ts:43`, `runtime/server/src/adapters/streams/s2.ts:104` |
| 7 | history and SSE read the stream back | `runtime/server/src/tenant/session-streams.ts:255`, `runtime/server/src/tenant/session-streams.ts:312` |
| 8 | routes, SDK and Studio serve it to a client | `runtime/server/src/api/http/routes/sessions.ts:331`, `sdks/agents/src/session-client.ts:502`, `studio/src/proxy.ts:406` |

The relay is started with the Tenant, once per process that runs core, and only when S2 is
configured (`runtime/server/src/host/main.ts:381`–`runtime/server/src/host/main.ts:408`). The
replication slot lets one process be active; the others retry and take over
(`runtime/server/src/adapters/replication/pgoutput.ts:7`). The slot is acknowledged only up to what
S2 holds (`pgoutput.ts:10`), so a crash replays what S2 may not have.

There is no Go hop. The Go code in `sandboxes/` and `images/computer` does not import an S2 client or
read a stream at this commit; a search for `s2` in `*.go` finds only an unrelated identifier
conversion. A harness in a sandbox writes events only by calling the Harness API.

## §2 What is written to the stream

- **Stream name:** `sessions/<sessionId>` (`runtime/server/src/streams/types.ts:144`,
  `runtime/server/src/streams/types.ts:150`). One stream per session, created on first append or read
  (`runtime/server/src/adapters/streams/s2.ts:203`).
- **Record body:** the event itself, as JSON (`runtime/server/src/streams/relay/core.ts:117`,
  `runtime/server/src/adapters/streams/s2.ts:15`). There is no extra wrapper: the envelope's `seq` is
  the stream's sequence and the envelope's `cursor` is the resume token.
- **Keys:** the session id is in the name; the Tenant is in the basin, not the stream; the basin is
  `<prefix>tn-<ulid>` with `-<generation base36>` from generation 1
  (`runtime/server/src/streams/basin.ts:4`, `runtime/server/src/streams/basin.ts:66`).
- **Ordering:** a session numbers its records from 0 with no gaps, and the tail is the sequence the
  next record gets (`runtime/server/src/streams/types.ts:28`). One queue and one pump per session
  keep a session's rows in `seq` order (`runtime/server/src/streams/relay/core.ts:109`).
- **Dedupe:** every append is conditional on `matchSeq` (`core.ts:174`). A tail past the batch means
  S2 already held those rows and the batch is a replay (`core.ts:178`); a tail behind the batch
  means S2 lost rows and the gap is read from the record and sent first (`core.ts:184`). A
  transaction is acknowledged only when all its rows are settled, in commit order (`core.ts:290`).
- **Reconciliation:** a fresh slot compares every session's S2 tail with its record head and re-sends
  the difference from the record (`core.ts:300`, `core.ts:341`).

The Tenant's other stream, `runs`, is written differently: a run's row commits first, then
`appendRuns` appends it and marks it `streamed_at`; a run left unmarked is appended by the sweep
after `RUNS_STREAM_GRACE_MS`, so it can arrive twice and a reader drops an id it has seen
(`runtime/server/src/tenant/runs-stream.ts:2`, `runtime/server/src/tenant/runs-stream.ts:33`).

## §3 Reading it back

- **History:** `readHistory` reads from the cursor with `follow: false`, up to the tail seen when the
  read started, drops `internal` events and applies the `agent` filter
  (`runtime/server/src/tenant/session-streams.ts:255`, `session-streams.ts:284`,
  `session-streams.ts:296`). A failed stream read is a `503`.
- **Live:** `GET /v1/sessions/{sessionId}/events` is SSE; each frame's `id` is the event's cursor and
  its `event` is the event's type, so a browser's `Last-Event-ID` resumes exactly where it stopped
  (`runtime/server/src/tenant/session-streams.ts:107`, `runtime/server/src/api/http/routes/sessions.ts:331`).
- **Shared read:** one stream read per session per process is shared by all its observers, and each
  observer keeps the next sequence it needs, so a client resuming sees no gap and no duplicate
  (`runtime/server/src/tenant/session-streams.ts:5`). An observer behind the feed restarts the shared
  read from its own position (`session-streams.ts:454`).
- **Reconnect:** after a dropped read the feed retries from where it stopped (`session-streams.ts:509`);
  the SDK reconnects from the last event it saw, including after keepalives, for `idleTimeoutMs`
  (`sdks/agents/src/session-client.ts:502`, `sdks/agents/src/sse.ts:158`).
- **Ending:** a feed follows one basin generation and ends when its session is gone or the Tenant
  moves generation, checked when a client joins, when a read fails, on a `sessions.reset` signal and
  every `streams.feedCheckMs` (`30 000`) (`runtime/server/src/tenant/session-streams.ts:5`,
  `runtime/server/src/tenant/session-streams.ts:566`, `runtime/server/src/tuning.ts:352`). A trusted
  issuer's token ends the stream with `event: nylorun.closed`
  (`runtime/server/src/api/http/routes/sessions.ts:331`).

## §4 Who consumes it

| Consumer | Reads | Where |
| --- | --- | --- |
| `GET /v1/sessions/{sessionId}/items` | history, paged by cursor | `runtime/server/src/api/http/routes/sessions.ts:300` |
| `GET /v1/sessions/{sessionId}/events` | live, from `cursor` or `Last-Event-ID` | `runtime/server/src/api/http/routes/sessions.ts:331` |
| A2A | history | `runtime/server/src/api/a2a/list.ts:138`, `runtime/server/src/api/a2a/routes.ts:316` |
| AG-UI | history | `runtime/server/src/api/ag-ui/routes.ts:371` |
| Agents SDK `observe()` | SSE, then reconnects | `sdks/agents/src/session-client.ts:502`, `session-client.ts:524` |
| Studio | proxies the SSE, forwarding `last-event-id` | `studio/src/proxy.ts:406` |
| `GET /v1/runs/stream` | the `runs` stream | `runtime/server/src/tenant/runs-stream.ts:148` |

Nothing inside the Runtime signals through S2: inter-process signals go over the Postgres control bus
(`runtime/server/src/tenant/control.ts:1`).

## §5 Auth and tenancy

- **Route access:** session routes accept an `application`, `subject` or `token` credential and need
  the scope `sessions:own` (`runtime/server/src/api/http/routes/sessions.ts:49`). A bearer resolves to
  an application principal or a trusted issuer's token; `requireScopes` decides from the route alone
  (`runtime/server/src/tenant/auth.ts:1`).
- **Tenancy:** one Tenant per database, and one basin per Tenant per generation. The stream name
  carries no Tenant, and a session cursor carries only session id and sequence, because the basin
  already scopes both (`runtime/server/src/tenant/session-streams.ts:5`,
  `runtime/server/src/streams/types.ts:4`). A reset moves the Tenant to the next generation; an older
  generation's basin is deleted after a grace period (`runtime/server/src/tenant/streams.ts:4`).
- **The runs cursor** names the generation, `base64url("runs:<generation>:<seq>")`, so a cursor from
  before a reset is refused (`runtime/server/src/tenant/runs-stream.ts:119`).
- **S2 credentials:** the Host is configured with one endpoint and one optional token
  (`runtime/server/src/host/stack-config.ts:716`), passed to the S2 client for every basin
  (`runtime/server/src/infra/streams.ts:38`). The basin name is therefore the only Tenant boundary
  inside S2: the code does not scope an S2 credential to a Tenant, and nothing in the adapter checks
  a Tenant against a basin beyond deriving the name.

## §6 Retention, limits, backpressure, failure

**Retention.**

- The basin's default stream config sets infinite retention, so `sessions/<id>` keeps every record;
  s2-lite would otherwise default a stream to seven days (`runtime/server/src/adapters/streams/s2.ts:10`,
  `runtime/server/src/adapters/streams/s2.ts:203`).
- `runs` is ensured with seven days' retention (`runtime/server/src/streams/types.ts:148`,
  `runtime/server/src/adapters/streams/s2.ts:258`).
- A basin goes when its generation is retired (`streams.retireGraceMs`, 60 s, minimum 0) or the
  Tenant is deleted, with every generation's basin (`runtime/server/src/tuning.ts:354`,
  `runtime/server/src/adapters/streams/s2.ts:224`).

**Size and rate.**

- One record entry may hold at most `recordEntryBytes`: S2's 1 MiB minus a 64 KiB envelope reserve
  (`core/src/utils/runtime-limits.ts:20`, `core/src/utils/runtime-limits.ts:26`,
  `core/src/utils/runtime-limits.ts:361`). A larger payload is refused before anything is written,
  with `limit_exceeded` (413) (`runtime/server/src/record/append.ts:2`).
- The relay sends at most `streams.relayBatchRecords` (500) records or `streams.relayBatchBytes`
  (768 KiB) per append (`runtime/server/src/tuning.ts:362`, `runtime/server/src/streams/relay/core.ts:145`).
- No rate limit on appends was found; the ordering lock is the session row's, taken by the writer.

**Backpressure.**

- An SSE client whose response holds more than its high-water mark is paused, and the shared read goes
  on without it; once it drains, it reads on from its own position
  (`runtime/server/src/tenant/session-streams.ts:119`, `session-streams.ts:495`,
  `session-streams.ts:465`).
- A client that takes nothing for `api.eventStreamStallMs` (60 s) has its response destroyed
  (`runtime/server/src/tenant/session-streams.ts:129`, `runtime/server/src/tuning.ts:145`).
- Keepalives go out every `api.eventStreamKeepaliveMs` (15 s) (`runtime/server/src/tuning.ts:140`).

**When S2 is unreachable or slow.**

- A history or SSE read that fails answers `503` and ends the feed; the SDK then reconnects from its
  last event (`runtime/server/src/tenant/session-streams.ts:296`,
  `sdks/agents/src/session-client.ts:502`).
- A failed relay append retries with backoff from 50 ms, doubling to 2 s, ensuring the basin first
  (`runtime/server/src/streams/relay/core.ts:190`, `runtime/server/src/tuning.ts:360`). A row whose
  generation is no longer the Tenant's is dropped instead of retried (`core.ts:193`).
- The S2 client retries its own calls from 100 ms to 2 s (`runtime/server/src/tuning.ts:368`); basin
  creation is retried up to `streams.basinRetryMaxMs` (5 s) (`tuning.ts:346`).
- The readiness probe allows `streams.probeTimeoutMs` (2 s) (`tuning.ts:358`). Basin state is
  reported by `streamsStatus`, never by readiness (`runtime/server/src/tenant/streams.ts:1`).
- Without S2 the Host keeps in-memory streams: history does not survive a restart
  (`runtime/server/src/infra/streams.ts:1`).

## §7 What this page does not show

- **Precedent missing.** The brief for this page cites `docs/reference/plugins.md` as a precedent. It
  does not exist at this commit: `docs/README.md` lists only Packages and Harness API under
  `reference/`. The page's shape therefore follows `docs/reference/packages.md` and
  `docs/reference/harness-api.md`.
- **A non-README page.** The `/document` skill changes `README.md` files only. This page and one row
  in `docs/README.md` are the documented exception, asked for by the brief.
- **s2-lite behaviour** is stated from the adapter's own comment (`s2.ts:22`), which reports it as
  verified against `s2:0.43.0`; it was not re-run for this page.
- **Run logs and deployed stacks** were not read: that needs a token and a live deployment.
- **The high-water mark** is Node's own `writableHighWaterMark`; the code uses
  `response.write`'s return value and `writableNeedDrain` (`runtime/server/src/tenant/session-streams.ts:119`)
  rather than a constant of its own.
- **Ordering across sessions** is not defined: events commit in one database, and each session's
  stream is ordered only against itself.
