# Changelog

## 0.15.1-beta

### Patch Changes

- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [4b9906f]
- Updated dependencies
  - @nylorun/core@0.11.0-beta
  - @nylorun/harness@0.21.2-beta

## 0.15.0-beta

### Major Changes

- 5ca1923: **One Tenant per installation: a database per Tenant, protocol 5.** A Runtime serves exactly one Tenant, the one its Postgres database holds. Two Tenants are two installations.

  - **Breaking: fresh start.** The Tenant's state is in the fixed schema `nylorun` of its own database and its record in `nylorun_streams`, keyed by session (no `tenant_id`). A database written by an earlier Runtime (`tenant_<id>` schemas, or a record keyed by Tenant) is refused: the Host stays up but not ready, and `/v1/admin/status` names the cause `database-layout-old`. Point the Runtime at a new database (with the local stack, a new stack); the old one is never changed.
  - **The Host creates its Tenant** on first start, in the migration transaction: `NYLORUN_TENANT_ID` (default a new id), `NYLORUN_TENANT_NAME` (default `default`), the Studio principal and the derived principals of `NYLORUN_DERIVED_PRINCIPALS` (comma-separated, default `project`), whose keys the admin key derives (`deriveTenantKey`). Later starts open the same Tenant and add derived principals configured since.
  - **Breaking: no Tenant catalog.** `/v1/admin/tenants` and `/v1/admin/tenants/{tenantId}` are gone (404). `AdminStatus.tenants[]` is replaced by `AdminStatus.tenant` (`id`, `name`, `state: open | unavailable`, `envelope`, and `cause` when it could not be opened). `CreateTenantRequestSchema`, `AdminTenantSchema`, `AdminTenantStatusSchema`, `AdminTenantListSchema` and `QuarantineSchema` leave `@nylorun/core`; `HostTenantSchema` and `TenantCauseSchema` replace them. `@nylorun/admin`'s `listTenants`, `getTenant`, `deleteTenant` and `createTenant` are removed (see below).
  - **Readiness instead of quarantine.** A Tenant that cannot be opened (`schema-too-new`, `kek-missing`, `migration-failed`, `envelope-invalid`, `database-layout-old`, …) fails `/ready` (check `tenant`, which replaces `discovery`) and is reported with its repair in `/v1/admin/status` and the log; every Tenant request gets the opaque 404. A failure outside it (Postgres unreachable) is retried.
  - **Protocol 5.** `PROTOCOL_VERSION = 5`; the Host serves protocols 4 and 5 for one release. Clients no longer require `runtime-tenants`; the Host still advertises it. No request needs `Nylorun-Tenant`: a request without it reaches the Host's Tenant, and one naming another Tenant (or a malformed one), or a publishable key of another Tenant, gets the opaque 404. The OpenAPI documents drop the header parameter and the Admin Tenant routes.
  - **Paths.** The Tenant directory is `<Host root>/tenant/` (was `tenants/<id>/`); `trash/` and the SQLite move to it are gone. The gates service serves its database's Tenant, and its `Nylorun-Tenant` header is optional (when sent, it must name that Tenant).
  - **Breaking: `startEphemeralRuntime` needs a database; the in-memory Session Store is removed.** `StartEphemeralRuntimeOptions.database` is required: a Postgres URL, for which the Runtime opens a pool and ends it on `close()`, or a pool the caller ends. It creates its Tenant in that database through the same bootstrap as a Host, or serves the Tenant the database already holds; the data stays after `close()`, so give each test Tenant a database of its own. Durable Streams and scheduling stay in process. See `MIGRATION.md`.

### Minor Changes

- ee9e471: **The vault key leaves the runtime container (F4.2).** A new `keys` service, run in the gateway's process (`--service gates,keys`), is the only process that reads the vault key. Vault writes that touch a secret (creating and rotating a credential, setting and selecting the host model) and all token signing (subject tokens, delivery tokens, signing-key rotation) run there. A Runtime with `NYLORUN_KEYS_URL`, which defaults to `NYLORUN_GATES_URL`, never reads, creates or holds the key. The Tenant API answers as before, with the same statuses, codes and details.

  - The vault key file moves to `<Host root>/keys/vault-kek`. A gateway that runs keys is not ready until the file is there, and it never creates one.
  - The anonymous `GET /v1/access/jwks` reads the public keys, and asks the keys service only when the current or standby key is missing.
  - While the keys service is down, vault writes and token minting answer `503 keys_unavailable`.

- fed780d: **Hard caps on model spend.** A Tenant can cap what its model calls use, per turn, per agent per UTC day or month, or for the whole Tenant per day or month, in USD, tokens or both. Before each call the model gate checks the scope's recorded spend, plus its calls in flight, against the cap. Once a cap is reached the call fails with the new `budget_exhausted` code, which is never retried, and the turn fails with `model.budget_exhausted`. A runaway loop stops there, at most one call over its cap.

  - `PUT /v1/tenant/budgets` replaces the budgets and `GET /v1/tenant/budgets` reads them. Both need the application key or `tenant:settings`.
  - `@nylorun/core` adds `budget_exhausted` to `ModelFailureCode` and `MODEL_FAILURE_CODES`, plus `ModelBudgetSchema`, `PutModelBudgetsRequestSchema` and `ModelBudgetsSchema`. Code that switches over failure codes exhaustively needs the new case.
  - Custom endpoints are priced at $0, so only a token limit stops them.
  - Budgets survive a `sessions` reset. A reset of scope `all` clears them.

- 744208d: **A runtime that dies or restarts mid-call no longer strands the session (P1.2).** The loop sends each model call with its effect id as the `Idempotency-Key`, and the gate runs a keyed call under its own control: if the caller disconnects, the call finishes and its outcome is kept for 30 minutes. The runtime that takes the session over re-sends the journaled call and joins it, or collects its outcome, so the turn completes with one provider call instead of becoming `uncertain`. A shutdown no longer marks the call `uncertain` either.

  - A re-send with the same key and a different request answers `409 gate_conflict`.
  - A user cancel sends `POST /nylorun/v1/model-calls/{key}/cancel`, which stops the provider request, and marks the turn's model call `uncertain`.
  - Outcomes live in the gateway's memory: a gateway restart forgets them. A Runtime that calls models in its own process (embedding, tests) keeps the previous behaviour.

- 744208d: **Model calls leave the loop through the Model Gate (P1.1).** Every vault-backed model call of the loop goes through one `ModelGate` (`runtime/src/gates/`). `--service gates` serves it over HTTP: one listener (`NYLORUN_GATES_LISTEN_HOST`, `NYLORUN_GATES_LISTEN_PORT`, default port 4100, `NYLORUN_GATES_ALLOWED_HOSTS`) answering `POST /nylorun/v1/model-calls` to callers presenting `NYLORUN_GATES_TOKEN`, with one JSON body once the call has finished. The gate reads the Tenant's host model from its vault and calls the provider with the same adapter, retries, idle watchdog, failure classification and redaction as before.

  - **Breaking:** in a container, a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and `NYLORUN_GATES_TOKEN`; it then never reads a model credential. Outside a container (embedding, `startEphemeralRuntime`), a loop without `NYLORUN_GATES_URL` runs the gate in its own process, as before. See `DEPLOYMENT.md`.
  - **Breaking:** the `gateway` model kind is removed from `TenantConfig.model` and `StartEphemeralRuntimeOptions.model`. Nothing set it, and it read the Tenant's model credential inside the loop. The exported `gatewayModel` provider is unchanged.
  - The gate needs only `NYLORUN_DATABASE_URL` and the Host's Tenant directory (`tenant/`), which it never writes: it runs no migration and opens no Tenant runtime. It refuses a Tenant whose schema is at another version, so the gateway and the runtime must run the same build. gates never shares a process with core or loop: `--service core,gates` is refused.
  - The client speaks `node:http` with a 630 s idle timeout, so calls longer than five minutes are not cut off. It never retries; the gate does. A failure of the hop is a failure outcome: an unreachable gate, a connection lost mid-call, a timeout or a 5xx is `transient` and retryable; a refused token is `auth`, naming `NYLORUN_GATES_TOKEN`.
  - The `host_stack_config` startup log names the gate (`modelGate`).

- fed780d: **Every model call is recorded in the Tenant's usage ledger.** The model gate writes one row per call that answers: the session, turn and agent, the provider and model, the tokens (input, output, cached, cache write, reasoning) and pi-ai's price in USD. Custom endpoints count as $0. A call the gateway ran twice after a restart is recorded twice and flagged as a duplicate, since the provider billed both.

  - `GET /v1/tenant/usage?scope=tenant|agent|turn&id=&period=day|month|total` totals the ledger. It needs the application key or `tenant:settings`, like the other Tenant settings.
  - `@nylorun/core/contracts` adds `ModelUsageScopeSchema`, `ModelUsageQuerySchema` and `ModelUsageTotalsSchema`.
  - The ledger survives a `sessions` reset. A reset of scope `all` clears it.
  - The gateway and the runtime must run the same build, as before.

- 7f4c3f1: **One history: a session's transcript is folded from its record.** The own loop's model-facing transcript is no longer stored on the session row, where up to three copies of it lived (`state`, `turnStartState` and the checkpoint). After each segment that keeps its state, the Runtime records the change as an internal `transcript.updated` event: the new entries, or a snapshot after compaction. Each segment folds the transcript back from the record, and a cancelled or failed turn's entries are undone, as before.

  - **Internal events.** `transcript.updated` is in the event catalog with `visibility: "internal"`. SSE, history, AG-UI and A2A never serve it. Served events can therefore skip the seq numbers internal events hold; cursors resume as before. `TranscriptUpdatedPayloadSchema` is exported from `@nylorun/core/contracts`, and catalog entries may declare `visibility`.
  - **No checkpoints table.** Every settle used to write a copy of the session's checkpoint to a `checkpoints` table that nothing read; it is gone. The checkpoint a session resumes from stays on the session row.
  - **Storage.** A long session's row no longer grows with its transcript (a 10-turn, 300-step session on a 16k window: under 16 KB instead of up to 196 KB).

- 7bd38d6: **`--service` names what a Runtime process runs.** The image now starts as `--service core,loop` (the default without a flag): `core` serves the Tenant and Admin APIs and runs the stream relay, and `loop` runs the agent loop and serves the Worker endpoint Restate calls. A container may run several services, which is how the local stack packs them.

  - `--role api|worker|all` still works for one release as a deprecated alias of `--service core`, `loop` and `core,loop`, and logs `deprecated_flag` at startup.
  - `--service all` is refused: name the services, e.g. `--service core,loop`.
  - The `host_stack_config` startup log names `services` instead of `role`.

- 5ca1923: **Drizzle defines the Session Store's schema, migrations and queries.** An internal storage change: the tables, columns and indexes of a Tenant database are the same as before.

  - The tables are defined in `src/store/postgres/schema.ts`; drizzle-kit generates the migrations from it, and they ship in the package (`dist/store/postgres/drizzle/`). At startup the Host applies the missing ones in one transaction under an advisory lock and records them in `nylorun.__drizzle_migrations` (Drizzle's journal format). A database whose journal holds a migration this Runtime does not ship still fails readiness with `schema-too-new`. The schema version reported by `/ready` and Admin status is the number of applied migrations.
  - Statements are prepared again (one Tenant per database makes every statement the same for the whole pool).
  - `drizzle-orm` is a new dependency.

- 7bd38d6: **The local stack runs a gateway container: model calls leave the Runtime.** `nylorun up` now runs the Runtime image twice, the combined packing: `runtime` (`--service core,loop`: the APIs and the agent loop) and `gateway` (`--service gates,keys`: the Model Gate, the Tool Gate and the keys service). Every model call, remote MCP call and Action delivery of the loop crosses the gateway, which alone reads the Tenant's credentials and the vault key. A new stack starts with the gateway.

  - **Breaking for hand-written Compose files:** in a container, a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and `NYLORUN_GATES_TOKEN`. Run the image a second time with `--service gates,keys` (see `DEPLOYMENT.md`). The image's default command is now `--service core,loop`.
  - The gateway has no published port, mounts only the Host's Tenant directory (`tenant/`) and `keys/`, both read-only, and reaches model servers on this machine at `host.docker.internal`. `docker/.env` holds `NYLORUN_GATES_TOKEN`, generated once and kept across starts.
  - `nylorun status` shows a Gateway line, `nylorun doctor` fails when the gateway is unhealthy and names `nylorun logs gateway`, and `nylorun logs gateway` is accepted.
  - An image set with `NYLORUN_RUNTIME_IMAGE` must be this release or newer: older Runtimes don't know `--service`.

- 31cfec0: **Action deliveries leave through the gateway (F4.1).** With the gates service, every delivery and endpoint ping is POSTed by the gateway (`POST /nylorun/v1/deliveries`) under the gateway's own `NYLORUN_ENDPOINT_*` policy. The delivery state machine is unchanged. A gateway that cannot be reached counts as a delivery that was not sent, so it is retried, and its failure code is `gateway.unreachable`.

  - `nylorun`: the `gateway` container now sets `NYLORUN_ENDPOINT_LOOPBACK=docker-host`, so Action endpoints on this machine stay reachable.
  - A process that runs only `core` also reads `NYLORUN_GATES_URL`, for endpoint pings.

- 31cfec0: **Remote MCP servers run behind the Tool Gate (F4.1).** With the gates service (the local stack's `gateway` container), the gateway holds each session's connection to a `streamable-http` or `sse` MCP server, authorizes it from the session's attached vaults (OAuth refresh included), and runs `tools/list` and `tools/call`. The runtime names the server and never sees its credential. Stdio MCP servers still run beside the loop.

  - New internal routes on the gates service: `POST /nylorun/v1/mcp/connect`, `/mcp/list`, `/mcp/close` and `/tool-calls`.
  - The loop now passes its abort signal to every MCP call, in and out of process.

- 31cfec0: **Remote MCP calls outlive the runtime that sent them, and never run twice (F4.1).** The loop sends each remote MCP call with its effect id as the `Idempotency-Key`. The gateway keeps a keyed call running after its caller goes away, and a restarted or new owner re-sends the journaled call and joins it, so the turn completes with one call to the server and nothing `uncertain`.

  - The gateway records each keyed call before it reaches the server and stores the answer after. After a gateway restart, a call that was in flight answers `uncertain` and is never run again. Rows are deleted a day after they settle.
  - A user cancel stops the call at the gateway (`POST /nylorun/v1/tool-calls/{key}/cancel`).

### Patch Changes

- 1a38e0e: **A late cancel signal no longer stops the next turn.** The `session.cancel` signal on `tenant/control` now names the turn it cancelled, and a Worker aborts only an advance of that turn. Before, a signal delivered after S2 came back (an append the SDK retried, or a control reader catching up) aborted whatever advance the session was running, which could be a turn started after the cancel.
- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [fed780d]
- Updated dependencies [fed780d]
- Updated dependencies [7f4c3f1]
- Updated dependencies [5ca1923]
- Updated dependencies [5ca1923]
- Updated dependencies
  - @nylorun/core@0.10.0-beta
  - @nylorun/harness@0.21.1-beta

## 0.14.0-beta

### Major Changes

- 9546ac7: **Postgres is the record of every session event; S2 delivers it.** Durable Streams v1.

  - **The record.** Each event is written to `nylorun_streams.session_events` in the transaction that causes it, with the session's log head. The per-Tenant outbox, its relay, its drain in the Tenant sweep and `StreamGapError` are gone: losing S2's data, the relay or its replication slot now costs delay, never events.
  - **The stream relay.** With S2, every `api` or `all` Runtime process runs the relay; its Postgres replication slot (`nylorun_stream_relay`) lets exactly one be active. It appends with `matchSeq`, acknowledges the slot only after S2 has the events, refills gaps from the record, and reconciles the record with S2 after a new or lost slot. Without S2 (a local development Host), each Tenant relays its own commits.
  - **Postgres needs logical replication.** The Runtime refuses to start an `api` or `all` process with S2 unless `wal_level = logical` and its role may replicate; the error names the setting. The local stack is configured for it. See `DEPLOYMENT.md`.
  - **No incarnations.** A session's stream is `sessions/<id>`. A sessions reset moves the Tenant to a new **basin generation**: the old basin gets a `sessions.reset` signal, every process moves its readers, and the old basin is deleted after a grace period. Tenant deletion deletes every generation's basin and the Tenant's record rows.
  - **Status.** Tenant status `streams` reports `generation` and the Tenant's `relay` instead of the outbox; the Host aggregate reports the process's `relay` (with its slot lag in bytes) instead of `outboxDepth` and `relayLagMs`.
  - **Session history does not survive the upgrade.** Installs are in beta, so Tenant schema migration 8 is a fresh start for session data: a Tenant with sessions loses them, with their commands, checkpoints, effects, Actions and links, as a sessions reset does, and moves to basin generation 1; its settings, agents, Action endpoints, keys, policy and vaults stay. Clients holding cursors start again.

- 9546ac7: **Protocol 4: every session event is typed, on the `nylorun.event/2` envelope.**

  - **The catalog.** `EVENT_CATALOG` in `@nylorun/core/contracts` lists every event type the Runtime writes, with its payload schema, its schema version and its source. `SessionEventSchema` is their union, discriminated on `type`; `parseSessionEvent` types a known event and returns an unknown one as the bare envelope.
  - **The envelope.** Events carry `schema`, `seq`, `epoch`, `runId`, `incarnation`, `schemaVersion`, `source`, `evidence`, `visibility`, `retention` and an optional `trace`. `createdAt` is renamed `time`. The envelope is no longer strict, so later fields never break a client.
  - **Validated writes.** `Tx.event` is typed by the catalog, and both Session Stores check each event against it before it commits (`InvalidEventError`). Workflow `action.pending` payloads may carry `path` and `key`.
  - **OpenAPI.** Each event type is a component (`MessageAssistantEvent`, …), `SessionEvent` is their union, and the session SSE and history responses refer to them.
  - **Clients.** `@nylorun/agents` reads events with `parseSessionEvent`, so a newer Runtime's event types reach your code instead of failing the stream. Studio reads `time`.

  See `MIGRATION.md`.

### Minor Changes

- c7614a4: **A2A: serve agents to other agents (v1, gateway mode).** The Runtime answers [A2A](https://a2a-protocol.org) 1.0 over JSON-RPC for the Tenant's agents (optional Host feature `a2a-endpoint`), and the app server publishes them with `createA2aHandler`.

  - **Runtime.** `POST /v1/a2a/agents/:agent` acts for a subject with `sessions:own`. It serves `SendMessage` (blocking up to 5 minutes, or `returnImmediately`), `GetTask` and `CancelTask`. A context is one session per subject, agent and `contextId`, and a task is one turn. A question pauses the task as `TASK_STATE_INPUT_REQUIRED` until the caller replies on the same task. The `messageId` is the idempotency key. `ListTasks`, streaming, push notifications and the extended card answer with their A2A errors, and approvals cannot be answered over A2A yet. `GET /v1/a2a/agents/:agent/card` returns the card built from the manifest, without interfaces. `observeSession` lets in-process readers join a session's shared event feed.
  - **Agents SDK.** `@nylorun/agents/a2a`: `createA2aHandler({ agents, subject, publicUrl, card })` forwards each partner's JSON-RPC request to the Runtime as that partner's subject, and serves the Agent Card with its own URL, provider and security schemes. It loads no A2A package. `Transport.forward` returns the Runtime's raw response.

- 77807ad: **Action endpoints: background outcomes.** An endpoint can answer a delivery with `202`, keep it alive, use the session's sandbox, and post the outcome later, all with the delivery token.

  - **`POST /v1/actions/:id/heartbeat` with a delivery token** extends the delivery by a lease (`leaseMs`) and returns a fresh token (`{ token, deadlineAt }`). It answers `409` once the delivery was cancelled, lost or sent again, which tells the endpoint to stop. Executors keep their claim heartbeat on the same route.
  - **`POST /v1/actions/:id/result` (new, delivery token only)** records the outcome. The same result again returns the first receipt; a different one is `409`.
  - **`POST /v1/actions/:id/sandbox/:tool` with a delivery token** runs the session's sandbox tools for that Action while it is being delivered. The body is the tool's input, with no claim fields.
  - **Deadline.** A `202` delivery that stops heartbeating is lost at its deadline: a tool becomes `uncertain`; a hook, `fn` or `verify` is delivered again.
  - The heartbeat and sandbox routes are no longer marked deprecated in the OpenAPI document. Their executor use is.

- 679c488: **Action endpoints: the Runtime delivers Actions (Host feature `action-endpoints`).** For an agent with a registered endpoint, each tool call, hook and workflow `fn`, `verify` or tool node is POSTed to the endpoint and the answer settles it. Agents without one keep their executors.

  - **The request.** `{ type: "action", action, sandbox }`, with a delivery token in `Nylorun-Signature` (for this Tenant, URL, Action, generation and body) and the Action id as `Idempotency-Key`. Deliveries of one Action never overlap, and at most `maxConcurrent` are in flight per endpoint.
  - **The answer.**
    - `200` with `Nylorun-Outcome: 1` is the outcome. A plain `200` is a tool's output, or what an `fn` or `verify` returned; the tool's output schema still applies.
    - `202` means the result comes later.
    - `429` and `503` (honouring `Retry-After`), a version mismatch (`409`) and anything that never reached the endpoint are retried, backing off from 250 ms to 30 s. The failure is reported as `action.delivery_failed` at most every 10 s.
    - Any other `4xx`, or a `3xx` (redirects are not followed), fails the Action with `endpoint.rejected`.
    - No answer after sending (timeout, reset, `5xx`) loses it: a tool becomes `uncertain`; a hook, `fn` or `verify` is delivered again. A delivery whose deadline passes (a Worker died) is lost the same way, by the Tenant sweep.
  - **Cancel.** A cancelled turn aborts the request at once. The code may have run, so the Action becomes `uncertain`, as a claimed one does.
  - **Events and health.** `action.delivered` and `action.delivery_failed` are new events. Endpoint health records successes and failures.
  - **Ping.** `POST /v1/endpoints/:agentId/ping` sends a signed ping and records what the endpoint serves. It answers `502` when the endpoint doesn't answer.
  - **Host settings.**
    - `NYLORUN_ENDPOINT_LOOPBACK=docker-host`: in the local stack, `localhost` means the Docker host.
    - `NYLORUN_ENDPOINT_PRIVATE` (`allow`/`refuse`): checked on the address actually connected to.
    - `NYLORUN_ENDPOINT_HTTP` (`allow`/`refuse`).
  - **Executors unchanged.** Executor results and deliveries record outcomes through one function, so the two paths behave the same.

- 706b3f0: **Action endpoints: delivery tokens (groundwork; no route accepts them yet).** The Runtime can sign a token for one delivery of one Action, and recognises it when it comes back as a bearer.

  - **The token.** An ES256 JWT signed with the Tenant's current signing key. Its `typ` is `nylorun-delivery+jwt`, `iss` is the Tenant, `aud` is the endpoint URL, `sub` is the Action id (or `ping`), and `agt`, `gen` and `bdy` carry the agent, generation and body hash. It lives at most 900 s.
  - **As a bearer.**
    - A delivery token reaches only the routes that list it, and none does yet (every other route answers `403`).
    - It is refused from browsers (`origin_rejected`) and cannot act for a subject.
    - An expired token or a revoked key is `401 token_expired`; anything else, a ping token included, is the opaque `404`.
  - **Key rotation.** It now waits for the longest token either kind may have signed, so a delivery token is never revoked while it is live, even under a short subject-token policy.
  - Subject tokens share their header checks with delivery tokens (`tenant/jwt.ts`), with no change in behaviour.

- ab1eab7: **The Tenant's public keys are public.** `GET /v1/access/jwks` answers with `Nylorun-Tenant` alone, with no credential, so an Action endpoint can verify delivery tokens (and anyone can verify subject tokens) without holding a key.

  - A credential that is sent is still checked: a wrong one is still the opaque `404`. A browser still needs a publishable key.
  - Routes declare this with `anonymous: true`, which only the JWKS route uses. In the OpenAPI document it appears as an empty security requirement (`{}`).

- c85cd9e: **Action endpoints: register them (nothing is delivered yet).** An application registers, for each agent, the URL that will run its Actions. The Runtime stores the registration and its health; deliveries follow in a later release.

  - **Routes (application key only).**
    - `PUT /v1/endpoints` registers or updates up to 64 endpoints: `agentId`, `url` (http or https, no credentials or fragment), `implementationVersion`, optional `manifestHash`, `timeoutMs` (default 60 000, at most 840 000) and `maxConcurrent` (default 16).
    - `GET /v1/endpoints` lists them with their health: last delivery, last success, last error, consecutive failures, and what the last ping reported.
    - `DELETE /v1/endpoints/:agentId` removes one.
    - Subjects, subject tokens and executors are refused.
  - **One path per agent.** Registering an endpoint removes the agent's executor and ends its streams. `PUT /v1/executors` for an agent with an endpoint is `409`, naming the endpoint to remove first.
  - **Health.** Registering the same URL again keeps an endpoint's health; a new URL starts with none.
  - **Store.** Postgres migration 5 adds the `endpoints` table and a `deadline_at` column on Actions.
  - **Core.** Adds `DeleteEndpointResponseSchema`. The endpoint response schemas are strict.

- 4282d5f: **Breaking: executors are removed; protocol 3.** The Runtime delivers every Action (tool, hook, `fn`, `verify`) to the Action endpoint an agent registers. It no longer offers Actions for executors to claim. See `MIGRATION.md`, "Action endpoints replace executors".

  - **Core.** `PROTOCOL_VERSION` is 3 and a Host serves only protocol 3. `action-endpoints` is a protocol feature instead of an optional Host feature. Removed:

    - the executor, claim and Action-list schemas;
    - `action_result` from `SessionCommandSchema`;
    - the `claimed` Action status, `claimId` and `leaseExpiresAt`.

    New: `ActionResultReceiptSchema`, the receipt of `POST /v1/actions/:id/result`, which is `AcceptedResponse` without `requestId`.

  - **Runtime.** Removed:

    - `PUT`/`GET /v1/executors`, `DELETE /v1/executors/:agentId`, `GET /v1/executors/connect`;
    - `GET /v1/actions`, `POST /v1/actions/:id/claim`, and the executor form of `POST /v1/actions/:id/heartbeat`;
    - the `tenant/work` stream;
    - claim expiry;
    - executor credentials.

    `POST /v1/actions/:id/sandbox/:tool` takes the delivery token only. Tenant summaries report `inFlightDeliveries` instead of `connectedExecutors`. Tenant status lists each agent's endpoint and has an `endpoints` check instead of `executors`.

    Postgres migration 6 drops the `executors` table. Actions an executor had claimed are handled like lost deliveries: a tool becomes `uncertain`, and a hook, `fn` or `verify` is delivered again.

  - **Agents.** Removed: `connectAgents`, the `@nylorun/agents/executor` subpath, derived executor keys and `NYLORUN_EXECUTOR_KEY`. Serve agents with `createActionHandler` and call `register({ url })`.
  - **CLI.** Executor keys are gone from Project credentials. `nylo tenant endpoints` shows each endpoint and its health.

- 50d0fb5: **AG-UI in the Runtime.** The Runtime serves AG-UI itself at `/v1/ag-ui/agents/:agent` (optional Host feature `ag-ui-endpoint`), and pages reach it directly with a subject token. `@nylorun/agents` no longer contains or depends on any AG-UI package.

  - **Runtime.** `POST /v1/ag-ui/agents/:agent` runs (a `RunAgentInput` in, server-sent AG-UI events out); `GET …/threads/:thread/messages`, `GET …/threads/:thread/events` (reattach) and `POST …/threads/:thread/cancel`. For a person named by a subject token (limited to the role's agents) or by subject headers; an application key alone is `400`. A thread's session (`sessionIdFor`, unchanged, so existing threads keep their sessions) is created on its first run with `forwardedProps.nylorun.session` (`vaultIds`, `credentialSelections`, and `info` from app servers only) and never changed afterwards. Limits and a busy session are streamed as `RUN_ERROR`. A stream opened with a token ends at the token's expiry or revocation with `CUSTOM nylorun.stream_closed`. The translation moves here from `@nylorun/agents`, and `@ag-ui/core` becomes a Runtime dependency.
  - **Agents SDK.** `createAgUiHandler` keeps its options and routes and forwards each request to the Runtime acting for the signed-in person; it now needs a Runtime with `ag-ui-endpoint` (`502 runtime_feature_missing` otherwise). `session()` options apply when a thread's session is created; whatever the browser sends in `forwardedProps.nylorun` is replaced. `@ag-ui/core` is no longer a dependency. `@nylorun/agents/browser` adds `agUi(agentId)`, a `{ url, fetch }` for `HttpAgent` that adds the key and a current token and reattaches a run the Runtime ended at token expiry, so the agent sees one run, and `agUiHistory()`. The transport gains `forward()`, which returns the Runtime's response as it is.

- 50d0fb5: **Browser access: web pages and apps call the Runtime with a publishable key.** A page ships a publishable key and gets subject tokens from its app server; the Runtime answers it directly, with CORS (optional Host feature `browser-access`).

  - **Publishable keys.** `nr_pub_<tenantId>_…`, sent in `Nylorun-Key`, name the Tenant and one app, with an origin allowlist (exact origins, or `http://localhost:*` and `http://127.0.0.1:*` for development; none for native apps). `GET`/`POST /v1/access/publishable-keys`, `PUT`/`DELETE …/:id`. A key alone grants the policy's `anon` role, at most the public agent list, and reaches no session or vault. Postgres migration 4.
  - **Host.** With browser access on, requests with an `Origin` reach Tenant routes; `/health`, `/ready` and admin routes still refuse them. Preflights for browser routes (agents, sessions, vaults, AG-UI, JWKS) are answered from the route alone and grant no credentials; the actual request must carry a publishable key whose allowlist names the origin, and only then do responses (JSON, errors, `401`, `429`, event streams) carry CORS headers. A disallowed origin or unknown key gets the opaque `404`. Tenant and executor keys sent with an `Origin` are refused before they are looked up. `Nylorun-Tenant` may be left out when `Nylorun-Key` names the Tenant; both must agree when both are sent. Browser access is on in the stack (`NYLORUN_BROWSER_ACCESS=off` turns it off) and off for a Host started from `host.json` unless `browserAccess` is true.
  - **JWKS.** `GET /v1/access/jwks` is readable by any caller that reaches the Tenant.
  - **Agents SDK.** `@nylorun/agents/browser`: `createBrowserClient({ url, publishableKey, token })` keeps subject tokens in memory, refreshes them a minute before expiry or after `401 token_expired`, one fetch at a time, and creates sessions and vaults owned by the token's subject; it loads no Node module. `createTokenEndpoint()` is the app server's token route. `client.access.publishableKeys` manages keys. The transport accepts a `token` source and a `publishableKey`, and event streams the Runtime ends at token expiry reconnect at once. The Tenant API client classes move to a module with no Node imports; `@nylorun/agents` and `/client` export the same names.
  - **CLI.** `nylo access keys list|create|set-origins|revoke`.

- c121144: **Definitions no longer declare a sandbox.** `.sandbox()` on ReAct and flow agents, and the `sandbox`, `SandboxError`, `SandboxOptions` and `SandboxCapability` exports, are removed. Open the session with one instead, `createSession({ sandbox: { … } })`, or set the Tenant's default; see `MIGRATION.md`.

  - **Build and registration.** A capability that still carries `sandbox` fails the build (`sandbox.in-definition`), and `PUT /v1/agents/:id` refuses such a definition with a `400` that names it. Definitions stored before this release keep their sandbox.
  - **Trees.** `sandbox.mismatch` and `workflow.sandbox-mismatch` are gone, with the workflow manifest's derived `sandbox`: a tree shares the sandbox its session was opened with.
  - **Executors.** The action claim reports whether the session has a sandbox (`ActionClaim.sandbox`), and `ctx.sandbox` follows it.

- 28c6115: **Every Tenant route is a Hono route, and paths are strict.** The Tenant API's hand-written router is gone. Each route is declared once with who may call it (credentials, subject scopes, browser access), in `api/http/routes/`, `api/ag-ui/` and `api/a2a/`. That one declaration now decides what the router's own tables (`routeAccess`, `isBrowserRoute`) decided: a subject's scopes and which browser preflights are allowed. Routes answer as before.

  A path or method that no route serves is now authenticated like any other request (an unknown credential is still the opaque `404`) and then answered `404 request_rejected` "Route not found". Before, the router matched loosely, and some of these requests reached a route or got another answer:

  - **Extra path segments:** `POST /v1/sessions/:id/commands/…`, `GET /v1/sessions/:id/items/…` and `/events/…`, `GET /v1/executors/connect/…` and `POST /v1/actions/:id/claim/…` (and `/heartbeat/…`) no longer reach those routes.
  - **`GET /v1/actions/:id`** is `404`, not `400 Invalid JSON`.
  - **A trailing slash or an empty segment** (`/v1/sessions/`, `/v1//sessions`, `/v1/agents/`) is `404`. Before, it was served as the route without it.
  - **An unknown path under a known resource:**
    - An unknown sub-route of a session is `404 Route not found`, even when the session is missing (before: "Session not found").
    - A subject calling an unknown path under `/v1/executors`, `/v1/actions`, `/v1/tokens` or `/v1/access` gets `404` (before: `403 scope_required`).
    - An executor calling any path or method no route serves gets `404` (before: `403 Application credential required`).
  - **`HEAD`** is `404` for every caller.
  - **Browser preflights** for paths no route serves (for example `/v1/sessions/:id/unknown`, `/v1/ag-ui/anything`), or for a method a route lacks, are refused (`403`) instead of allowed.

  **`TenantHandle.handle` is removed**; the Host reaches a Tenant with `TenantHandle.fetch(request, { incoming, outgoing })`.

- 101bb6f: **The Runtime serves HTTP through Hono.** The Host's request pipeline (Origin, Content-Type, `/health`, `/ready`, the Admin API and Tenant resolution) is now a Hono app served by `@hono/node-server`. It answers byte for byte as before. `hono`, `@hono/zod-openapi` and `zod` are now dependencies. Routes move to Hono group by group in later releases.

  - **`TenantHandle.fetch(request, { incoming, outgoing })`** is how the Host reaches an open Tenant. `TenantHandle.handle(request, response, url)` is deprecated and optional, and will be removed once every Tenant route is on Hono. Code that implements `TenantHandle` must add `fetch`.
  - **The process's globals are left alone.** An app that embeds the Runtime (`startEphemeralRuntime`) keeps its own `Request` and `Response`. The Runtime also answers correctly in a process where `@hono/node-server`'s `serve()` has already replaced them.
  - **A request target that is not a path** (such as `OPTIONS *`) is `400 invalid_request` "Invalid request target".

- 6ab4c59: **Long sessions on any model: compaction.** A session whose history outgrows the model's context window keeps going, on a 16k local model as on a 1M hosted one.

  - **Compaction.**
    - **When.** Before each model call the engine estimates the prompt: the last reported usage, plus about four characters per token for what came after. If the estimate would not leave room for the reply, the engine first compacts: it asks the model to summarize the older history, then keeps about the newest 20,000 tokens (at most 30% of the window) verbatim.
    - **What it keeps.** The cut never separates a tool call from its result. The current turn's request is always kept. A later compaction merges with the earlier summary.
    - **Overflow.** If a provider still reports a context overflow, the engine compacts once and asks again.
    - **Storage.** The summary is a `compaction` transcript entry that replaces the older entries in the session state; the event log keeps the full history. The summary call is a journaled model effect, so replays are deterministic.
    - **New event.** `context.compacted` (`trigger`, `tokensBefore`, `tokensAfter`).
  - **Custom endpoints.**
    - **Settings.** Model Settings take `settings: { contextWindow, maxTokens, reasoning, compat }` for a custom OpenAI-compatible provider (vLLM, SGLang, llama.cpp, Ollama, LM Studio). `compat` is passed to pi-ai: `thinkingFormat`, `thinkingTokenBudgetField`, `chatTemplateKwargs` and the rest.
    - **Defaults.** Without settings, a custom endpoint is assumed to have a 32k window and an 8k output limit. They used to be 128k and 16k.
    - **Where to set them.** `nylo configure` asks for the window and output limit. Studio's Model Settings shows all four fields.
  - **Storage.**
    - Model effects no longer journal the model request next to the call, so each call's prompt is stored once.
    - When a turn ends, its model effects are slimmed to their identity and status; the transcript holds the answers.
    - Session storage now grows with the window, not with the square of the session's length.
  - **Core.**
    - `TranscriptEntry` adds `compaction` (`TranscriptCompactionEntry`).
    - `ModelAdapterContext.compaction` marks a summary call.
    - `CustomModelSettings` / `CustomModelSettingsSchema` describe the custom endpoint settings.

- 6ab4c59: **Model calls don't strand sessions.** A model provider failure is now a known outcome, not a lost call. The Runtime retries what can be retried, and otherwise fails the turn with `model.<code>`, so the session accepts the next message instead of sitting `uncertain` until it is cancelled.

  - **Runtime.**

    - **Upgrade.** The model adapter moves to pi-ai 0.99.1 and always streams.
    - **Per-call settings.**
      - Every call carries the session id, so OpenAI and other providers reuse the prompt cache and route to the same backend.
      - Provider auth no longer reads the process environment.
      - Rate limits, overloads, timeouts and transient errors are retried: 3 attempts with backoff, honouring `Retry-After`.
      - A stream that produces nothing for 300 s is aborted and retried. `TenantConfig.modelCall` sets attempts, backoff, the idle timeout and the request timeout.
    - **Failures.** Anything else fails the turn with one of these codes:

      - `model.context_overflow`, `model.rate_limited`, `model.overloaded`, `model.timeout`, `model.transient`
      - `model.content_policy`, `model.auth` (whose message says where to fix the credential)
      - `model.invalid_request`, `model.invalid_output`

      Only a call whose outcome was lost, such as a Worker dying mid-call, is still `uncertain`.

    - **Structured output.** A structured final answer is repaired (control characters, a Markdown code fence) before it is parsed.
    - **Model history.** Replayed history keeps the model that produced each message, so a model switch no longer sends one model's signatures or tool-call ids to another. Reasoning from OpenAI-compatible servers (`reasoning_content`, `reasoning`) is sent back only within the turn that produced it.

  - **Events.**
    - `message.assistant` adds `model` (`provider`, `model`), `finishReason` and `usage`.
    - A new `model.failed` transcript event (`code`, `message`, `retryable`) is written instead of `message.assistant` when a call fails.
  - **Core and harness.**
    - New types and helpers: `ModelFailureOutcome`, `ModelFailureCode`, `MODEL_FAILURE_CODES`, `isModelFailureOutcome`, `ModelProducer`.
    - `PromptItem` assistant messages may carry `producer`.
    - `ModelUsage` adds `cacheWriteTokens`.
    - A model adapter may return a failure outcome.
    - The durable engine version is `hosted-3`: a turn that is running when the Runtime is upgraded fails once with `execution.incompatible`, and the next message works.
  - **CLI.**
    - `nylo configure` passes a stable installation id to OAuth logins that need one (OpenAI "Sign in with ChatGPT"), stored as `cli-installation-id` in the Host root.
    - A custom OpenAI-compatible provider now prompts for its API key instead of failing.

- 10c3bb9: **OpenAPI 3.2 documents for the Runtime's APIs.** Both documents are generated from the routes as declared for serving, so they can't drift from what the Runtime answers. Load either into any OpenAPI 3.2 tool, for example Scalar, to render API docs.

  - **Tenant API:** `@nylorun/runtime/openapi.json`, also served at `GET /openapi.json`. The document route needs no key and refuses a browser `Origin`, as `/health` does.
  - **Admin API:** `@nylorun/runtime/admin-openapi.json`, also served at `GET /v1/admin/openapi.json` with the admin key, on the operator listener when there is one.
  - **Who may call each operation:** its `security` (application key, subject token, publishable key, executor key, admin key), plus `x-nylorun-credentials`, `x-nylorun-scopes` and `x-nylorun-browser`.
  - **Event streams** are documented as `text/event-stream` with an `itemSchema`.
  - **Deprecation:** the executor routes are marked deprecated.
  - **Drift check:** committed snapshots in `runtime/openapi/` make every API change a reviewable diff, and `check-package` fails when the routes and the snapshots disagree.

- 50d0fb5: **The Admin API on its own listener.** A Runtime can serve the Admin API on an operator listener, so the port that faces browsers and reverse proxies serves the Tenant API alone. The stack does this by default.

  - **Runtime.** With an operator listener (`adminPort` in `host.json`, or `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST` and `NYLORUN_ADMIN_ALLOWED_HOSTS` in a container), the public listener answers `/v1/admin/**` with the opaque `404` and the operator listener serves the Admin API, Host shutdown and the Tenant API, never to browsers. Each checks `Host` against its own port. `/ready` needs both listening; a taken port on either exits with code 98. Without one, a single listener serves everything as before.
  - **Stack.** `nylorun start` publishes the operator port on loopback (`NYLORUN_ADMIN_PORT`, default 8788), writes it to `host.json` as `adminPort`, and points Studio at `runtime:4001`. `nylorun status` prints it.
  - **Admin client.** Reads `adminPort` from `host.json` and sends Admin API requests there (`admin.adminUrl`); `admin.url` stays the Tenant API URL. A `host.json` without `adminPort` keeps working.

- c121144: **Choose a session's sandbox when you open it.** `createSession({ sandbox })` (`PutSessionRequest.sandbox`) now takes `false`, `{ session }` to share, or an inline sandbox: `image`, `network.allow` and `resources`. Omit it for the Tenant's default. The agent definition needs no `.sandbox()`: the Runtime resolves the request against the Tenant's limits, pins it on the session and adds the six sandbox tools to that session only (capability `nylorun.sandbox`). The registered definition is unchanged.

  - **Tenant configuration.** `GET /v1/tenant/sandbox` adds `config`; `PUT /v1/tenant/sandbox` sets `default` (`none`, `virtual` or an inline sandbox) and `limits` (`network` ceiling, `resources` maximum, `defaultResources`, `idle`). Unset, a Tenant's default is `none` and its ceiling is the package registries and code hosts of today's `dev` preset. `SeedTenantConfigRequest.sandbox.config` seeds it.
  - **Checks at open.** A request outside the limits is a `400` that lists every problem. An inline sandbox from a caller acting for a subject is a `403`; such callers get the Tenant default or `false`. An `image` is refused: the virtual sandbox has no images. The sandbox is fixed for the session's life: a different one on a later `PUT` is a `409`.
  - **Trees inherit.** The agent sessions of a flow agent, the agents a session uses as tools, and sessions attached with `{ session }` use the sandbox the session was opened with, and get its tools.
  - **Compatible.** An agent that declares `.sandbox()` keeps working as before; opening its session with a `sandbox` value is a `400` that says to remove `.sandbox()` from the agent.

- 6ab4c59: **Long turns roll over.** A turn no longer fails when it runs past the 50-minute advance deadline.

  - **How it works.** At a step boundary with no open work, a long turn ends its segment and continues in the next one: same turn, a new checkpoint, woken at once. By default this happens after 50 steps or 20 minutes in a segment; `TenantConfig.rollover` changes both.
  - **What clients see.** A rolled-over turn emits no `turn.*` event, and clients still see one turn.
  - **Storage.** Each finished segment's model effects are slimmed.
  - **Harness.** `runDurable` takes `yieldAfter: { steps, ms }` and can return `yielded`, and `RunResult` adds `yielded`. The durable host writes the next checkpoint at `segment + 1` with `{ kind: "continue" }`. Agents used as tools never roll over.

- 9546ac7: **The stream relay, ready to wire in.** The Runtime gains the relay that will feed S2 from a Postgres record of session events over logical replication (Durable Streams v1); nothing uses it yet.

  - **Relay core** (`streams/relay/`): per-session pumps appending with `matchSeq`, acknowledgements only after S2 has the rows, refills from the record on a gap, reconciliation after a new or lost slot, and rows of an old basin generation dropped.
  - **Change source** (`adapters/replication/pgoutput.ts`): a persistent `pgoutput` slot, one active process per slot, always resumed from the confirmed position; a pending reconciliation is kept in `nylorun_streams.relay_slots` so a crash cannot skip it.
  - **Shared schema** (`nylorun_streams`): `session_events`, `session_log_heads`, `relay_slots` and the `nylorun_stream_relay` publication, migrated by the Host.
  - **Basin generations**: `basinOf(tenantId, generation)` names a Tenant's later basins (`<basin>-<g base36>`).
  - **Local stack**: Postgres runs with `wal_level=logical` and `max_slot_wal_keep_size=4GB`. `nylorun start` recreates the Postgres container once; its data volume is kept. `DEPLOYMENT.md` lists the settings for a Postgres you run yourself.

- 50d0fb5: **Subject tokens: a person's own credential for the Runtime.** An app server mints a short-lived token for one signed-in person, and their app calls the Runtime directly (optional Host feature `subject-tokens`). Requests with application keys and subject headers are unchanged.

  - **Runtime.** `POST /v1/tokens` (application key only) mints an ES256 JWT for a subject and a role, valid 60–900 seconds. The Tenant API accepts it as a bearer and resolves its scopes and agents from the role on every request. Forged, foreign or malformed tokens get the opaque `404`; an expired token, a revoked subject, a revoked key or a removed role gets `401 token_expired` with `WWW-Authenticate`. Tokens carry only `agents:read`, `sessions:own` and `vaults:own`; they may not set session `info`, send `message.manifest` or store OAuth refresh credentials, and `GET /v1/agents` shows them `{ agentId, name, description }` of their role's agents only.
  - **Access policy.** `GET`/`PUT /v1/access/policy`: roles with token scopes, an agent allowlist and limits (`turnsPerHour`, `concurrentTurns`, answered with `429 limit_exceeded` and `Retry-After`). Without roles nothing is minted.
  - **Signing keys.** Per Tenant, the private key sealed with the vault KEK: `GET /v1/access/signing-keys`, `POST …/rotate` (refused while the previous key may still verify live tokens; `force` for incidents), `POST …/:kid/revoke`, `GET /v1/access/jwks`. A Tenant with signing keys and no KEK is quarantined `kek-missing`.
  - **Revocation.** `POST /v1/access/revocations` ends a subject's tokens; their open event streams end with `event: nylorun.closed` on every process. A stream opened with a token also ends when the token expires.
  - Postgres migration 3 adds `signing_keys`, `subject_epochs`, `subject_usage` and an index on the session owner and status. New error codes `token_expired` and `limit_exceeded`.
  - **Agents SDK.** `client.tokens.create()`, `client.access.getPolicy()`/`putPolicy()`/`revokeSubject()`/`jwks()` and `client.access.signingKeys.list()`/`rotate()`/`revoke()`, each checking the Host feature first.
  - **CLI.** `nylo access policy get|set|init`, `nylo access signing-keys list|rotate|revoke`, `nylo access revoke <subject>` and `nylo access token` for trying the API.

### Patch Changes

- f82752e: **Action endpoints: Durable Session Execution can run deliveries (groundwork, unused yet).** The Worker endpoint registers a fourth Restate virtual object, `NylorunAction` (key `<tenantId>:<actionId>`), whose `deliver` handler runs one Action's delivery at a time and re-sends itself after a delay when the delivery asks to be retried. The in-process execution does the same. Nothing schedules deliveries yet. Operators will see the new service in Restate, and its paused invocations appear in the Tenant status with the others.
- 4135d23: **The Admin API is declared as Hono routes.** Each `/v1/admin/**` route is declared once, for serving and for the Runtime's OpenAPI document (`host/admin-api.ts`). Answers are unchanged, apart from strict paths:

  - A trailing slash (`/v1/admin/tenants/`) or an empty segment (`/v1//admin/tenants`) no longer reaches a route. With the admin key it is `404 not_found` "Route not found"; before, it was served as the route without the slash.

- 3da8769: **HTTP fixes ahead of the move to Hono.**

  - **Shutdown no longer waits for open streams.** Stopping the Runtime used to wait for every session-event, executor and AG-UI stream client to disconnect. It now ends open streams (clients see the stream end and reconnect), lets other requests in progress finish, and closes any connection still open after 10 seconds (`host_shutdown_forced` in the log).
  - **Sandbox tool calls stop when their caller leaves.** `POST /v1/sessions/:id/sandbox/:tool` and `POST /v1/actions/:id/sandbox/:tool` now see the client disconnect. Before, the abort signal never fired once the request body had been read.
  - **Multibyte request bodies.** A UTF-8 character whose bytes arrive in different chunks is no longer corrupted.
  - **Malformed paths.** A path with invalid percent-encoding (such as `%E0%A4%A`) is `400 request_rejected` "Malformed path", not `500`.
  - **Failures after a response started.** When a Tenant fails after starting its response, the Host ends that response instead of trying to send a second one.
  - **Listener errors** after the Runtime starts listening are logged (`listener_error`) instead of being dropped.

- 2ab8ed1: **Schemas for every Runtime answer.** `@nylorun/core/contracts` now has a Zod schema for each successful response of the Tenant and Admin APIs that lacked one, so clients can validate what they receive and the Runtime's OpenAPI document can be generated from them.

  - **Agents:** `ListAgentsResponseSchema` (`AgentDefinitionViewSchema`), `ListPublicAgentsResponseSchema` (`PublicAgentSchema`) and `PutAgentResponseSchema`.
  - **Sessions:** `ListSessionsResponseSchema` (`SessionSummarySchema`, `SESSION_STATUSES`) and `SessionViewSchema`.
  - **Executors and actions:** `ListActionsResponseSchema`, `ActionHeartbeatResponseSchema`, `DeleteExecutorResponseSchema` and `SandboxToolOutcomeSchema`.
  - **Tenant settings:** `ResetTenantResponseSchema`, `HostModelCatalogSchema`, `ListProvidersResponseSchema` (`HostModelProviderInfoSchema`), and `TenantSandboxViewSchema` with `EffectiveSandboxConfigSchema` (the configuration with defaults applied, sizes in MiB).
  - **Vaults:** `VaultInfoSchema`, `CredentialInfoSchema`, `ListVaultsResponseSchema`, `ListCredentialsResponseSchema` and `DeletedResponseSchema`. `VaultInfo`, `CredentialInfo` and `HostModelProviderInfo` are now inferred from their schemas; their fields are no longer `readonly`.
  - **Access:** `AccessPolicyResponseSchema` and `ListPublishableKeysResponseSchema`.
  - **Admin:** `AdminTenantListSchema` and `HostShutdownResponseSchema`.
  - **Streams:** `StreamClosedFrameSchema` (the `nylorun.closed` frame) and `AgUiRunErrorCodeSchema` (codes of an AG-UI `RUN_ERROR`, which add `session_busy` and `runtime_error`).

  `ERROR_CODES` gains `request_rejected`, `invalid_request`, `subject_required` and `internal_error`, codes the Runtime already sends. `RejectedResponseSchema` now accepts every rejection the Runtime makes. An exhaustive `switch` over `ErrorCode` needs the new cases.

- f296363: **Runtime lifecycle fixes.**

  - **Stream relay.** Stopping the relay while its change source was still preparing the replication slot no longer hangs shutdown with the slot held.
  - **MCP connections.** A connection a session has not used for 15 minutes is closed by the Tenant sweep, and the next call opens it again, as after a restart. Before, every stdio MCP server a session started kept running until the Tenant closed. Concurrent calls to a server that is not connected now share one connection instead of each opening one and leaking all but the last.
  - **Tenant close.** Every close step runs even when an earlier one fails, so a failing MCP or sandbox close no longer leaves the stream readers, the relay and the store open. The first error is still rethrown, and each failed step is logged as `tenant close step failed`.

- bb999c0: **Runtime robustness fixes.**

  - **Stream relay.** After a fresh replication slot, the relay marks the record reconciled only once every re-sent row is in S2. Before, it did so once the rows were queued, so losing the connection or the process before they reached S2 left those sessions' streams missing events until their next write.
  - **Vault OAuth refresh.** Concurrent uses of an expired grant in one process share one refresh, instead of each spending the refresh token. A refresh that loses a race with another process uses the token that process stored instead of failing with `refresh_failed`. A token endpoint that takes more than 30 s fails the refresh (`VaultServiceOptions.refreshTimeoutMs`).
  - **Postgres.** Connections of the Host's pool have `statement_timeout` and `idle_in_transaction_session_timeout` of 60 s, so a hung statement or abandoned transaction no longer holds a shared connection and its locks forever (`PostgresClientOptions.statementTimeoutMs` and `idleInTransactionTimeoutMs`; 0 turns either off). Schema migrations and Tenant deletion run without the statement timeout.
  - **Ephemeral runtime.** `startEphemeralRuntime` closes what it opened, and removes its Host root unless retained, when it fails to start.

- 9546ac7: **A session's first events reach readers at once.** Tenant basins now create a stream on read, so a client that opens SSE before a session's first event follows the stream live instead of polling for it with a backoff of up to 2 s. Existing basins are updated when their Tenant opens.
- 9546ac7: **Durable Streams failure suite and latency gate.** New integration tests run the stream relay on Postgres logical replication and s2-lite through a relay crash mid-stream, a 10 s S2 outage, a slot invalidated by `max_slot_wal_keep_size`, and a takeover by another process, checking that every S2 stream equals the record. An opt-in benchmark (`NYLORUN_BENCH=1`) holds commit to S2 under 200 ms at p99 with 50 sessions.
- 9546ac7: **`LiveHub` is now `SessionStreams`.** Internal rename, no behaviour change: a process's readers of Durable Streams are `ctx.sessionStreams` (`tenant/session-streams.ts`), with one `SessionStream` per observed session.
- 4b64d57: **The A2A endpoint on Hono.** `POST /v1/a2a/agents/:agent` (A2A JSON-RPC, for a subject) and `GET /v1/a2a/agents/:agent/card` are declared as Hono routes (`api/a2a/endpoint.ts`). The Runtime's OpenAPI document describes the JSON-RPC envelope and links the A2A specification. Answers are unchanged: the legacy dispatcher and the routes share one implementation.
- 7add998: **Access routes on Hono.** `POST /v1/tokens`, the access policy, signing keys, publishable keys, subject revocations and the public keys (`GET /v1/access/jwks`, open to any caller that reached the Tenant) are declared as Hono routes (`api/http/routes/access.ts`), with who may call each for the Runtime's OpenAPI document. Answers are unchanged.
- f4ca1c8: **The AG-UI endpoint on Hono.** Its four routes (run, thread messages, reattach, cancel under `/v1/ag-ui/agents/:agent`) are declared as Hono routes (`api/ag-ui/endpoint.ts`), documented with AG-UI's own schemas (`RunAgentInput`, the event union, `Message`). Answers and streams are unchanged: the legacy dispatcher and the routes share one implementation.
- 18468d9: **Tenant routes start moving to Hono.** The executor and Action routes and session commands (`/v1/executors/connect`, `/v1/actions/**`, `/v1/executors`, `/v1/executors/:agentId` and `POST /v1/sessions/:id/commands`) are declared as Hono routes (`api/http/routes/executors.ts`). Each says who may call it: its credentials, subject scopes and browser access. The Runtime's OpenAPI document shows this, and the executor routes are marked deprecated there, since Action endpoints replace them. Answers are unchanged. A path the new routes don't match exactly still goes to the router they replace, so its answer is unchanged too.

  **Core:** the recursive contract schemas (JSON values, workflow nodes and manifests, and an agent used as a tool) carry a Zod `id`, so documents generated from them refer back to the named schema instead of recursing. Parsing is unchanged.

- 43fcbee: **Agent and session routes on Hono.** `GET /v1/agents`, `PUT /v1/agents/:id`, `GET /v1/sessions`, `PUT` and `GET /v1/sessions/:id`, `GET /v1/sessions/:id/items`, the session event stream (`GET /v1/sessions/:id/events`) and `POST /v1/sessions/:id/sandbox/:tool` are declared as Hono routes (`api/http/routes/sessions.ts`), with who may call each for the Runtime's OpenAPI document. Answers are unchanged.
- 469b052: **Tenant settings and vault routes on Hono.** `/v1/tenant/**` (status, reset, config seed, models, providers, model and model selection, sandbox configuration) and `/v1/vaults/**` (vaults and credentials) are declared as Hono routes (`api/http/routes/tenant.ts`, `api/http/routes/vaults.ts`), with who may call each for the Runtime's OpenAPI document. Answers are unchanged: an executor calling them is still refused and recorded, and a subject's vault is still checked as theirs before anything else.
- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [c7614a4]
- Updated dependencies [679c488]
- Updated dependencies [c85cd9e]
- Updated dependencies [4282d5f]
- Updated dependencies [82d95ef]
- Updated dependencies [f48f12f]
- Updated dependencies [50d0fb5]
- Updated dependencies [50d0fb5]
- Updated dependencies [c121144]
- Updated dependencies [6ab4c59]
- Updated dependencies [6ab4c59]
- Updated dependencies [2ab8ed1]
- Updated dependencies [c121144]
- Updated dependencies [6ab4c59]
- Updated dependencies [9546ac7]
- Updated dependencies [9546ac7]
- Updated dependencies [9d52189]
- Updated dependencies [50d0fb5]
- Updated dependencies [18468d9]
- Updated dependencies
  - @nylorun/core@0.9.0-beta
  - @nylorun/harness@0.21.0-beta

## 0.13.0-beta

### Minor Changes

- 5278b4e: **Flow agents on workflow manifest v2.** A flow agent compiles to `workflowSchemaVersion: 2` and runs on the new `flow-2` engine; v1 workflows (`Chain`, `Switch`, `Parallel`, `Map`, `Loop`) keep running on `flow-1`, so in-flight runs finish as they began.

  - **Manifest (core).** Any node may carry `id` and `input`; there are no slots. `chain` and `parallel` are bare collections, a Map is `{ map: { each } }` over its input, and a Loop has `max?` and `decide?`. The header adds `name`, `description`, `metadata`, `inputSchema` and `outputSchema`, and `agents` embeds every agent the flow runs, so one manifest hash covers the whole flow. `Agent.from(json, { nodes, agents })` rebuilds a flow agent. Path and key helpers (`leafPath`, `stageKey`, `forEachFlowNode`, `embeddedAgent`, …) are exported from `@nylorun/core/define`.
  - **Paths (harness).** Linked agent sessions are named by the agent: its id, `[i]` per Map item, and a nested flow agent's id in front. Control stages add nothing, so wrapping a step in a Loop keeps its session. Functions are bound under stage keys (`route:on`, `@1.default.1:input`) and all receive `{ input, results, flowInput }`; `flowInput` works inside nested `flow()`. A Loop without `decide` retries with the verifier's feedback up to `max` and then fails with `loop.exhausted`. Nested flow agents run inline.
  - **Runtime.** Leaves of a v2 workflow resolve from its embedded `agents` (with the workflow's plugin roots, keyed `<agent>/<capability>`) instead of the registry. `loop.iteration` is emitted only for a Loop's own agent turns.
  - **Agents SDK.** `saveAgent(flowAgent)` PUTs one document; application mode registers the flow's executor with its manifest hash. An executor leaves `fn`, `verify` and tool actions of a v2 flow unclaimed when they belong to another manifest hash, because stage keys can shift between deploys; it reports each skipped action once through `onError`.
  - **Studio.** Draws v2 manifests: agents and tools at their session paths, control stages at their stage keys, nested flow agents inline, and lights a Map's agent from its item sessions.
  - Build diagnostics: `flow.duplicate-leaf`, `flow.duplicate-id`, `flow.agent-conflict`, `flow.v1-workflow`, `loop.invalid-verify`, `workflow.flow-agent-child`. Also fixes v1 flows passing an agent step's output to the next step still wrapped in the runtime's turn marker.

- 426fd27: **Flow agents as subagents.** `.subagents(flowAgent)` lets a ReAct agent delegate to a flow agent. The flow's workflow manifest v2 is inlined in the delegating tool (`ToolManifest.agent` may be a workflow manifest), so it is saved with the parent and served by the parent's executor, plugin roots included (`<flow>/<agent>/<capability>`).

  - **Engine (harness).** A call to a flow subagent is one durable `agent` effect (`role: "delegate"`) between the delegation's start and settle points; the flow's output is the tool result, and a failed flow is a failed tool result. Local `run()` refuses flow subagents, which need the Runtime.
  - **Runtime.** The effect starts a linked flow session from the parent's pinned manifest, fresh per call, and settles when the flow's turn ends. Cancelling any session now cascades to the linked sessions it started, not only a workflow's.
  - **Core.** `delegation.flow-unsupported` now only reports a workflow built with `Chain`, `Switch`, `Parallel`, `Map` or `Loop`. New helpers: `flowDelegatesOf`, `flowDelegateManifest`, `isFlowDelegate`; `delegatesOf` lists only the ReAct agents run in-process.

### Patch Changes

- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies [8cda500]
- Updated dependencies
  - @nylorun/core@0.8.0-beta
  - @nylorun/harness@0.20.0-beta

## 0.12.0-beta

### Minor Changes

- a322696: **Derived principals** (optional Host feature `derived-principals`): a client that holds the admin key no longer needs to store an application key.

  - `admin.createTenant({ name, principals: ["babai"] })` registers each named principal by the hash of its derived key, and `admin.deriveTenantKey(tenantId, principalId)` (or `deriveTenantKey(adminKey, tenantId, principalId)`) recomputes the key when needed.
  - `POST /v1/admin/tenants` accepts `derivedPrincipals: [{ id, credentialHash }]`. Ids match `^[a-z][a-z0-9-]{0,31}$` and `studio` is reserved; duplicate ids or credentials answer `400`. A retried create must name the same principals.
  - `createTenant` with `principals` throws `incompatible_host` before sending anything to a Host without the feature.

- 844bff3: **Act for a person: `Nylorun-Subject` and `Nylorun-Scopes`.** An app server that holds the Tenant key can name the person each request is for, and the Runtime enforces it (optional Host feature `subject-headers`).

  - `client.as(subject, { scopes })` in `@nylorun/agents` sends both headers on every call, event streams included. Scopes: `agents:read`, `agents:write`, `sessions:own`, `vaults:own`, `tenant:settings`; default `["sessions:own"]`.
  - The Runtime limits a subject to the routes its scopes allow (`403 scope_required`) and to its own sessions and vaults: another owner's session, vault or sandbox is the same `404` as a missing one, including `PUT` on its session id (was `409`). Reset, config seed, executors, actions and the sandbox tool routes are open to no subject. Only application keys may send the headers.
  - The AG-UI handler calls the Runtime as each person and requires `subject-headers`; new optional `scopes` option. The host's `session()` parameters can no longer replace a session's id, agent or owner.
  - Core exports `SUBJECT_HEADER`, `SCOPES_HEADER`, `SUBJECT_SCOPES` and `parseSubjectHeaders`. Postgres Tenant schemas migrate to version 2 (an indexed session owner column).

  Requests without `Nylorun-Subject` are unchanged.

- a322696: **The session log now carries what a chat UI shows** (optional Host feature `transcript-events`).

  - `message.assistant` for each completed model step: `{ invocationId, text, toolCalls: [{ callId, name, input }], agent? }`.
  - `tool.completed` for an MCP or sandbox tool: `{ invocationId, callId, capabilityId, toolName, output }`, or `error: { code, message }` for a tool error.
  - Tool `action.pending` and `action.completed` events, and `delegation.started` / `delegation.completed`, carry the model's `callId` (and `invocationId` on actions).
  - Events are written in the transaction that completes the effect, so a replay writes none.
  - `@nylorun/core/contracts` adds payload schemas and `parseTranscriptEvent(event)`; `LiveEvent.payload` stays `unknown`.

  Fix: a tool with both `approval` and an `output` schema now pauses for approval. The Runtime validated its `interaction-required` result against the output schema and failed the tool with `tool.invalid-output`; `denied`, `interaction-required` and `deferred` results are no longer validated.

### Patch Changes

- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies [a322696]
- Updated dependencies
  - @nylorun/core@0.7.0-beta
  - @nylorun/harness@0.19.2-beta

## 0.11.0-beta

### Minor Changes

- bf1c2da: **`nylorun dev --ephemeral` runs on the Docker stack, with a Tenant-level fixture model (breaking beta).**

  - `nylorun dev --ephemeral` creates a temporary Tenant through `@nylorun/admin` (no Project link written), seeds it from `.env` with the fixture model, opens Studio on it and runs the watcher; the Tenant is deleted with its active work cancelled when the watcher ends, Ctrl-C included. It needs a Runtime that advertises `tenant-fixture-model`.
  - `PUT /v1/tenant/config/seed` accepts `fixtureModel: true`, stored as Tenant setting `model.fixture`: that Tenant's model calls use the Runtime's fixture model while other Tenants on the Host keep theirs. `HOST_PROTOCOL` advertises the new optional feature `tenant-fixture-model` (`OPTIONAL_HOST_FEATURES` in `@nylorun/core/compatibility`); clients do not require it.
  - `startEphemeralRuntime()` keeps its signature but its Tenants live in memory instead of SQLite under the Host root; nothing survives `close()`.
  - Closing a Tenant waits for running advances at most the advance grace period (30 s by default) and then abandons them; their lease lapses and the next advance takes over.
  - A Worker stop, Tenant close or ended Restate attempt no longer fails or cancels the turn it interrupts: outcomes already returned are recorded, nothing is settled, and the next advance resumes the turn from its checkpoint. Only a user cancel settles `cancelled`; an advance deadline fails the turn with the deadline's message.

- bf1c2da: **The microsandbox backend is removed; the Runtime runs sandbox tools on the virtual backend only.** The optional `microsandbox` dependency is gone. `sandbox.backend` and `NYLORUN_SANDBOX` accept `auto` or `virtual`, and `auto` selects `virtual`. A Tenant that stored `microsandbox` reads it as `auto`. `nylorun doctor sandbox` and the `nylorun dev` banner report only the virtual shell.
- bf1c2da: **Tenants are Postgres schemas only; SQLite and the `nylorun-runtime` launcher are removed (breaking beta).**

  - The Runtime runs on Postgres (the Session Store, one schema per Tenant), Restate (Durable Session Execution: one advance per session, fenced by an ownership epoch, and a per-Tenant sweep) and S2 (Durable Streams: every event is written to a Postgres outbox and relayed to the session's stream, which history and SSE read). `--role api|worker|all` selects the process role; `/ready` covers Postgres, Restate and S2.
  - SQLite Tenants are not migrated. On first start the Runtime moves every `tenants/<id>/` directory that holds a `tenant.sqlite` to `trash/<id>-sqlite-<time>/` and logs `sqlite_tenant_moved_to_trash`; recreate those Tenants.
  - `@nylorun/runtime` has no bin: the `nylorun-runtime` launcher and `host-state.json` are gone. The Runtime runs as the `ghcr.io/nylorun/runtime` image (`nylorun start`); its Host entry requires `NYLORUN_DATABASE_URL`.
  - `openTenantRuntime(config, hooks)` requires the Tenant's opened `store` and `envelope`; `OpenTenantRuntime` receives them from the Tenant store. `HostStateFile` is no longer exported.
  - `@nylorun/core`: `LAUNCHER_PROTOCOL` and the launcher error codes are removed; `QuarantineSchema` drops `locked`, `lockPath` and `lockPid`; `TenantStatusSchema.checks.sqlite` is now `checks.store`. `TenantStatusSchema` gains optional `execution` (stuck invocations) and `streams` (basin, outbox depth, relay lag); `HostAggregateSchema` gains optional `outboxDepth` and `relayLagMs`.

- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.
- 1d84b3e: **Native Windows is no longer supported; Windows developers use WSL2.** Nylorun runs on macOS and Linux. On native Windows, `nylorun` and `npm create @nylorun/agent` stop with WSL2 guidance. Install Node 24 and Docker (Docker Desktop's WSL integration) inside your WSL distribution and keep projects in its Linux filesystem. The Windows-only process handling (`taskkill`, `.cmd` shims, `npm.cmd`) is removed. `nylorun doctor` reports WSL as `Linux (WSL: <distribution>)`.

### Patch Changes

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

- 262bded: A Tenant's stream wiring no longer logs after it stops. A basin repair that failed after the Tenant closed could write to a Tenant log directory that was already removed and end the process with an unhandled rejection.
- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [bf1c2da]
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies
  - @nylorun/core@0.6.0-beta
  - @nylorun/harness@0.19.1-beta

## 0.10.0-beta

### Minor Changes

- c49efed: **Runtime Clients and Admin API (supporting packages).**

  - **core:** `AdminStatusSchema`, Project-link schemas, `ERROR_CODES` (launcher codes include `platform_unsupported`, `launcher_failed`, `downgrade_refused`), `admin-status` feature, `newPrincipalId`, `compareVersions`.
  - **runtime:** `/v1/admin/status` (alias `/v1/admin/host`), loopback/`Origin`/content-type checks; the launcher ships as this package's `nylorun-runtime` bin (source under `src/launcher/`, not in `exports`) and runs the Host on the Node it runs on.
  - **studio:** `nylorun-studio` binary; connects via `resolveConnection`; waits for `dev`; never calls Admin API or writes `.nylorun/`.

  **Prerequisites:** developers install Node 24+ and `@nylorun/runtime` (`npm install --global @nylorun/runtime`) themselves; no package downloads Node or the Runtime, and there are no per-platform Runtime packages. Launcher commands: `version`, `up`, `down`, `restart`, `run`, `status`, `logs` (launcher protocol 1).

- c49efed: **Breaking (pre-1.0 minor):** Replace a single SQLite Runtime per Project or home directory with a **Runtime Host** that serves isolated **Tenants**, selected by `Nylorun-Tenant` and negotiated with `Nylorun-Protocol` (protocol `2`, feature `runtime-tenants`). Vocabulary: Host root + Tenant + Project link.

  - **core:** `PROTOCOL_VERSION = 2`, `HOST_PROTOCOL`, `TENANT_HEADER`, `PROTOCOL_HEADER`, `newTenantId` / `isTenantId`, `checkCompatibility`; health schema gains `hostId` + `protocol` (`service: "nylorun-runtime"`); Tenant/admin wire schemas; Tenant model routes under `/v1/tenant/*`.
  - **runtime:** Host process + Tenant module; Tenant model routes under `/v1/tenant/*`; `startEphemeralRuntime` for tests/embeds; executors via `PUT /v1/executors`; sandbox prefix `nylorun-<tenant-id>-`.
  - **agents:** `createClient({ url, key, tenant })`; Transport sends Tenant + protocol headers; `/health` compatibility cache; `IncompatibleRuntimeError` with upgrade remedies.
  - **cli:** Host root lifecycle (`runtime up|down|status|logs|restart|run`); Project link (`.nylorun/link.json` + `credentials.json`); `tenant` commands; `runtime status --env` exports `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, `NYLORUN_TENANT`; removed Project/home SQLite selectors.
  - **studio:** `startStudio({ …, tenant: { id, name } })`; proxy forwards Tenant + protocol headers; UI shows Tenant name/short id.

- fd9fd87: Add workflows: compose agents and `tool()` with `Chain`, `Switch`, `Parallel`, `Map`, and `Loop`. A workflow is a registered runnable (`kind: "workflow"`) with the same session API as an agent — `export const agents`, `saveAgent` (saves referenced agents first), `createSession`, `input` (`content` or `data`), `observe({ follow })`, `pending`, `approve`, `cancel`. Slots (`{ run, id?, input? }`) reshape data between nodes. The flow engine (`runFlowDurable`) returns effects only; `harness/src/loop/` and `runDurable` are unchanged.

  HostEffect gains flow kinds `agent`, `tool` (node), `fn`, and `verify`, each with `path`, `key`, and `iterations`. The Runtime drives agent nodes through the public session contract (linked sessions, shared sandbox via `PutSession.sandbox`), offers `fn` / `verify` again on lease expiry, and routes executor Actions by `(workflowId, key)` with claim-scoped `ctx.sandbox`. Optional `message.manifest` is a turn-only variant of the session pin (turn manifests). Studio shows the manifest tree, live node status, and session links. Examples under `examples/agents/{chain,switch,parallel,map,loop,ship-feature}/`.

### Patch Changes

- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
- Updated dependencies
  - @nylorun/core@0.5.0-beta
  - @nylorun/harness@0.19.0-beta

## 0.9.0-beta

### Minor Changes

- 1cd7dc7: Add subagents: put an agent in another agent's `tools` (`Agent({ tools: [lookupOrder, researcher] })` or `.use({ tools: [researcher] })`) and the model can delegate to it. The tool is named after the agent's id, takes `{ task: string }`, and its description is the agent's `description`, which is now required for an agent used as a tool. The engine runs the child inside the parent's turn as a durable branch: fresh context, its own tools and hooks served by the root agent's executor, its own MCP servers, the session's sandbox, and only its final output (or `outputSchema` result) returned. Empty output, failures (with partial output marked as evidence), and requests for input or approval inside a child reach the parent as failed tool results. Parallel delegation calls run concurrently, completed child work is never re-run on replay, and cancelling the session cancels every child.

  v1 is one level deep and non-interactive. Nested delegation, child tools that declare `approval`, and differing sandboxes across the tree fail the build with a named diagnostic. The manifest adds an optional `agent` body on a tool (schema version unchanged), actions and effects carry `agent: { id, path, delegationId }`, tool context gains `ctx.agent`, the durable host resolves a new `delegation` effect kind, and the Runtime emits `delegation.started` / `delegation.completed` events and filters history with `?agent=` (`session.history({ agent })`). Studio shows delegations, labels child actions with their agent, and filters events by agent.

### Patch Changes

- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [1cd7dc7]
- Updated dependencies
  - @nylorun/core@0.4.0-beta
  - @nylorun/harness@0.18.0-beta

## 0.8.0-beta

### Minor Changes

- b8d822a: Studio Model Settings lists multiple vault-stored providers, adds credentials through a sheet, and switches the active provider/model via Runtime host vault APIs.
- b8d822a: Let a running Runtime learn its executors instead of receiving them all at startup.
  `PUT /v1/executors` registers or rotates scoped executor credentials with the application
  credential, `DELETE /v1/executors/:agentId` removes one, and `GET /v1/executors` lists them
  without disclosing secrets. Registrations persist in SQLite with the token hashed at rest and
  are restored on the next start; scopes supplied through `NYLORUN_EXECUTORS_JSON` still apply
  to that process, take precedence for their agent, and are never written to the database. An
  unchanged registration is idempotent and keeps open streams, while a rotation ends the
  replaced token's work stream and stops it authorizing. Unauthenticated `/health` now also
  reports the Runtime version, a non-reversible scope digest of the database path, and the
  process id; all three are optional in the contract so an older host still parses. Token
  hashing is adequate only because these credentials are high-entropy values minted by the
  host; it is not a password derivation.
- b8d822a: Remove the legacy in-process host. `httpModel`, `HttpModelOptions`, and `ModelEnvironment` are no longer exported from `@nylorun/runtime`, `localSessions` is no longer exported from `@nylorun/runtime/node`, and `modelSelection` is no longer exported from `@nylorun/runtime/configuration`. The internal `Runtime`, `serveAgents`, `openSession`, and AG-UI route are deleted. Host agents with `nylorun dev` / `nylorun serve` and the standalone Runtime.
- b8d822a: Add `sandbox()`: one `.use(sandbox())` gives an agent Runtime-executed `bash`, `read`, `write`, `edit`, `grep` and `glob` tools on an isolated machine with a persistent `/workspace`. The Runtime selects a microsandbox microVM where available, otherwise an in-process virtual shell, enforces deny-by-default egress presets, owns sandbox lifecycle, and reports its choice through `GET /v1/host/sandbox`, the `nylorun dev` banner and `nylorun doctor sandbox`.
- b8d822a: Breaking beta: replace `beforeModelCall` / `afterModelCall` with scoped hooks. Register `before("turn" | "step", fn)` and `after("step" | "turn", fn)` on the agent, or `before: { turn, step }` / `after: { step, turn }` on a capability. `before("turn")` runs once per turn and its `Patch` applies to every model call in the turn; the new `after("turn")` returns a `TurnDecision` for the final answer. `after` hooks take one argument and receive `attempt`, and `retry` now retries instead of failing the run. The manifest moves to `manifestSchemaVersion: 4` with `capabilities[].hooks`, and `BeforeModelCallFn`, `AfterModelCallFn` and the `beforeModelCall` / `afterModelCall` action kinds are removed. Every capability registered at a hook point now runs in one `hook` executor action, an expired hook claim is offered again instead of becoming uncertain, and the durable engine version is `hosted-2`. Hook toggles now hide a capability's tools, or one tool of a multi-tool capability, instead of having no effect or failing. Studio lists each capability's hooks with how often they run and labels hook actions. See MIGRATION.md.

### Patch Changes

- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies
  - @nylorun/core@0.3.0-beta
  - @nylorun/harness@0.17.0-beta

## 0.7.0-beta

### Minor Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.

### Patch Changes

- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [3a88f51]
- Updated dependencies
  - @nylorun/core@0.2.0-beta
  - @nylorun/harness@0.16.0-beta

## 0.6.0-beta

### Major Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.

### Minor Changes

- 41e613c: Ship the local SDK registry workflow with an independent SQLite Runtime, connected tool executor, authenticated Studio proxy, and a text-and-tool starter. Replace the legacy Hono starter and AG-UI transport. Require Node 24 and include the SDK in exact release compatibility pins.

  Break the Harness execution import from `/engine` to `/run` and rename hosted execution APIs to durable execution APIs, including RunBinding, BoundRunOptions, and createRunState. Update all consumers without compatibility aliases; retain persisted checkpoint fields and version pins.

### Patch Changes

- Pin core to the tested release.
- Pin harness to the tested release.
- Updated dependencies [41e613c]
- Updated dependencies [2898d02]
- Updated dependencies
  - @nylorun/core@0.1.1-beta
  - @nylorun/harness@0.15.0-beta

## 0.5.0-beta

### Minor Changes

- Breaking beta: Runtime hosts use Harness `info` (`getInfo` / `SubmitOptions.info`) instead of
  `scope`. Session scheduling stays in Runtime; Node-only adapters remain under
  `@nylorun/runtime/node`. Compatible with Harness capability manifests and ToolDescriptor-only
  model requests.
- c5bbb1a: Breaking beta: make Harness `run()` a direct async state-in/state-out executor with
  serializable pauses, application `info`, cancellation signals, awaited recording, and
  agent-level output schemas. Runtime owns session scheduling with memory-default or exclusive
  local storage and imports Harness contracts. Isolate Node adapters under `runtime/node`, stream
  observations incrementally, and add opt-in bounded token previews with Studio reconciliation.
  Migrate consumers and deployment guidance together; legacy event records remain archived, not
  automatically replayed.

### Patch Changes

- Remove the experimental Cloud Agents API destination client and related
  `RuntimeConfig.cloud` / `NYLORUN_*` Cloud-mode wiring from OSS Runtime.
  Local `openSession` remains the only destination. Cloud upgrades published
  packages from npm independently.
- Ignore Hono Node `context.env` stream bindings (`incoming`/`outgoing`) when
  resolving model environment so Node `nylorun dev` uses process `.env` /
  `piModel` instead of an empty portable HTTP adapter.
- Update Runtime's canonical Harness dependency to the tested release.
- Updated dependencies [c5bbb1a]
  - @nylorun/harness@0.13.0-beta

## 0.4.0-beta

### Minor Changes

- fa1860a: Use standard MODEL_PROVIDER, MODEL, MODEL_PROVIDER_API_KEY, and MODEL_PROVIDER_BASE_URL environment configuration. Export starter Hono apps and provide CLI development and production Node launchers. Existing starters require manual migration. Release preparation must update the creator Runtime compatibility pin with this release.

## 0.3.0-beta

### Minor Changes

- 9c350be: Provide `nylorun dev` with optional Studio and browser opening, automatic development loopback CORS, and inferred Hono mount paths. Move local model selection to `.env/model.json` with legacy fallback and migration. Generate starters without copied launcher scripts, a top-level config directory, or a separate TypeScript build config. Release preparation must update the creator's Runtime compatibility pin together with these changes.

## 0.2.1-beta

### Patch Changes

- fd24b00: Flatten Runtime agent routes to `/:id/...` and pass matching `basePath` from the Hono mount so discovery, manifests, and AG-UI resolve at `/agents/:id/...` for Studio.

## 0.2.0-beta

### Minor Changes

- 4badb5b: Move model execution to session startup, provide Runtime as a mountable Hono router, and generate Hono-first projects with supervised application and Studio development. Studio now resolves root-relative Runtime endpoints correctly for custom mount paths.

## 0.1.2-beta

### Patch Changes

- d27242c: Show stopped guardrail and failed model requests as errors in Studio. Runtime now emits a terminal AG-UI error instead of marking failed requests successful, and Studio displays the reported message. The guardrails example also checks text content parts sent by Studio, including mixed media input, before invoking the model.
- d27242c: Preserve opaque provider continuation metadata through assistant conversation history. Gemini tool calls now retain thought signatures when sending tool results back to the model, including signed empty text and reasoning blocks. Only the originating provider and model receive their signatures.

## 0.1.1-beta

### Patch Changes

- 54ab304: Configure the provider and model after project installation and before development
  starts. Add --skip-config for deferred setup and require it for noninteractive
  creation. Retain the project with recovery instructions when setup fails or is
  cancelled, and cancel pending prompts, authentication, and child processes on
  shutdown.
- 54ab304: Add `--host` and `--allowed-hosts` to `nylorun dev` and `nylorun start`, with
  `HOST` and `ALLOWED_HOSTS` environment equivalents. Loopback binds now answer only
  to their own address on the chosen port, so local development needs no setup on
  any port while DNS-rebinding pages are rejected. Publish with `--host 0.0.0.0` or
  list proxy host names to deploy on your own servers.
- 54ab304: Support portable Runtime protocol version 2 while retaining legacy Studio
  manifest support. Move the Studio CLI into Runtime: use `nylorun studio
--agent-url <url>` instead of `nylo studio`. Applications should install Runtime
  directly and keep Studio as a development dependency.

  Retain session lists and media across development reloads, and recognize agent
  file changes on Windows. Validate noninteractive creator startup during release
  verification with deferred provider configuration.

  Include Harness in this release so the creator does not rely on an unpublished
  compatibility pin. Ship and verify all four packages together.

Release notes are maintained with Changesets.
