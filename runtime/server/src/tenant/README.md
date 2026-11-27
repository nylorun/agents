# The Tenant: everything one Host's Tenant does

A Host serves one Tenant. This folder is that Tenant: its composition root, the services the API
routes call, its auth, its record and streams wiring, its sessions and turns, its agents and
triggers, and the sweep that reconciles it. Routes, the Harness API and the Worker handlers are
thin: they resolve a `TenantContext` here and call a module in this folder.

## Interface

Sessions and turns:

- `putSession`, `openSessionIn`, `listSessions`, `sessionView` (`sessions.ts`): `PUT /v1/sessions/:id`,
  the list and the view.
- `advance`, `takeOver` (`advance.ts`): the Tenant's `WorkerHandlers.advance` — one segment of a turn
  under the session's lease, settled into status, checkpoint, `turn.*` events and wakes.
- `command`, `acceptMessage`, `startQueuedTurn`, `retryQueuedStarts`, `cancelQueuedMessage`
  (`commands.ts`): `message`, `approve`/`respond` and `cancel`, with per-session idempotency keys.
- `readHistory`, `streamSessionEvents`, `observeSession`, `checkSessionStreams`, `openSse`,
  `requestCursor` (`session-streams.ts`): history, session SSE and their shared per-session read.
- `foldTranscript`, `transcriptShadow`, `checkParity` (`history.ts`): the model-facing transcript as
  a fold of the record.
- `startTurn`, `pauseTurn`, `resumeTurn`, `endTurn` (`turn-timing.ts`): a turn's timing and totals.
- `toolCompleted`, `modelOutcomeFacts` (`transcript.ts`): the transcript events an effect writes when
  it completes.

Agents, manifests and triggers:

- `putAgent`, `getAgent`, `listAgents`, `deleteAgent`, `forkAgent`, `resetAgent`, `stopAgent`,
  `restartAgent` (`agents.ts`): the Agent resource and its lifecycle stream.
- `saveAgentManifest`, `getAgentManifest`, `listAgentManifests`, `diffAgentManifestSources`
  (`agent-manifests.ts`): named and versioned manifests.
- `moveAgent`, `pinOf`, `applyPin` (`agent-versions.ts`): which manifest version an Agent and a
  session run.
- `putTrigger`, `listTriggers`, `setTriggerStatus`, `runTriggerNow`, `receiveWebhook`,
  `rotateWebhookSecret` (`triggers.ts`, `api-triggers.ts`): triggers a client puts, `serveRuntimeTool`
  and `serveTriggersTool` for the ones an agent makes (`agent-triggers.ts`).

Streams and the record:

- `wireStreams`, `tenantReset`, `streamsStatus` (`streams.ts`): Durable Streams for the Tenant, the
  generation move on reset, and the basin status.
- `appendRuns`, `streamMissedRuns`, `streamRuns`, `runsCursor` (`runs-stream.ts`): the `runs` stream
  and `GET /v1/runs/stream`.
- `wireControl`, `closeControl` (`control.ts`): the Postgres control bus (`session.cancel`,
  `sessions.reset`).
- `sweep`, `deliverOutbox`, `reconcileLinkedAgents`, `wakeOrphanedSessions` (`sweep.ts`): the
  Tenant's self-re-arming sweep.

Auth and access:

- `authenticate`, `requireScopes`, `accessOf`, `ownerOf`, `requirePrincipal`, `mayUseAgent`
  (`auth.ts`): a bearer to an application principal or an issuer token, and a route's scopes.
- `createTrustedIssuers`, `parseIdentityFile` (`issuers.ts`, `identity-file.ts`): the issuer tokens
  the Runtime accepts.
- `protectedResourceMetadata`, `bearerChallenge` (`resource-server.ts`): the API as an OAuth 2.1
  resource server.
- `mintRunToken`, `verifyRunToken` (`run-token.ts`), `createRunGrants` (`run-grants.ts`),
  `mintHostTokens` (`host-token.ts`), `signingKeyView` (`signing-keys.ts`): the ES256 tokens the
  Runtime signs for a run, a pod and a sandbox, and the keys behind them.
- `putHarnessToken`, `harnessOfToken` (`harness-tokens.ts`): per-harness credentials.
- `hostPrincipals`, `deriveStudioKey` (`principals.ts`), `operatorKeys` (`operator-keys.ts`): the
  principals a Tenant starts with, and the keys an operator puts.

Open, limits and housekeeping:

- `createTenantModule`, `openTenantRuntime` (`module.ts`, `runtime.ts`): the composition roots.
- `createPostgresTenantOpener` (`store-pg.ts`), `tenantPaths`, `hostPaths` (`paths.ts`),
  `tenantPaths` under `NYLORUN_HOME`.
- `readRuntimeLimits`, `writeLimitsConfig` (`runtime-limits.ts`), `readSkillsConfig`,
  `triggerLimitsInForce`, `limitsInForce` (`limits.ts`): the Tenant's limits and an Environment's.
- `slimModelEffects` (`slim.ts`), `readTenantAudit` (`audit.ts`), `buildTenantStatus`, `harnessStatusOf`
  (`status.ts`), `createTenantLogger` (`logger.ts`), `withTimeout` (`pool.ts`),
  `guardedFetch` (`outbound.ts`), `resetTenant` (`reset.ts`), `createWorkState`, `abortLocal`,
  `drain` (`scheduler.ts`), `startEphemeralRuntime` (`ephemeral.ts`).

## Rules

- Business code changes state only inside `ctx.store.tx(async (t) => …)`, writes events with
  `t.event(...)` and advances with `t.wake(...)`: an event reaches a stream only after its
  transaction commits, through the relay (`context.ts:1`).
- Nothing in the Tenant signals through S2; processes talk over the Postgres control bus
  (`control.ts:1`).
- An advance holds the session's lease and writes only under its epoch: a lost epoch writes nothing
  (`advance.ts:1`, `harness-api/record.ts:1`).
- A session's events live in `sessions/<id>` in the current basin generation, and its cursor carries
  only session id and sequence (`session-streams.ts:5`).
- One stream read per session per process is shared by its observers, and each observer keeps the
  next sequence it needs, so a client resuming from `Last-Event-ID` sees no gap and no duplicate
  (`session-streams.ts:5`).
- A feed follows one basin generation and ends when its session is gone or the Tenant moves
  generation (`session-streams.ts:5`, `streams.ts:1`).
- An SSE client that has not taken what it was sent is paused and the shared read goes on without it;
  one that takes nothing for `api.eventStreamStallMs` is cut off (`session-streams.ts:5`,
  `../tuning.ts:145`).
- A run reaches the `runs` stream after its commit and is marked `streamed_at`; a crash between the
  two leaves it for the sweep, so a run can arrive twice and a reader drops an id it has seen
  (`runs-stream.ts:2`).
- A reset moves the Tenant to the next generation: the reset's transaction signals `sessions.reset`,
  every process moves its readers, and the old basin is deleted after a grace period (`streams.ts:4`).

## Side effects

- Postgres: the record, sessions, agents, triggers, the outbox, the control bus and the Tenant's
  settings (`store/postgres/…`, `control.ts`, `triggers.ts`).
- S2 through `DurableStreams`: basin create, delete, stream append and read (`streams.ts`,
  `session-streams.ts`, `runs-stream.ts`).
- The Tenant's files under its root: `logs/tenant.log` (`logger.ts`) and its workspace
  (`paths.ts`).
- Outbound requests to developer URLs and remote MCP servers, through `guardedFetch`
  (`outbound.ts`).
- The vault: sealed credentials and signing keys (`signing-keys.ts`).

## Verification

- Run: `npm test` (vitest, `runtime/server/package.json`)
