/**
 * Host tuning (B15): the timings, retries, poll intervals and internal sizes of the Runtime's
 * processes, one typed schema with a default each. An operator sets any of them in
 * `NYLORUN_TUNING`, a JSON object of the groups below (`{"tenant":{"openTimeoutMs":60000}}`),
 * read once when a process starts (`parseStackConfig`, then `useHostTuning` in `host/main.ts`).
 * What is left out keeps its default, which is the value the Runtime used before it was
 * configuration. An unknown key, or a value past its ceiling, stops the process naming it.
 *
 * Every service reads the parts it uses: the gateway (`gates`, `keys`, `egress`), core and loop
 * (the rest), a harness container or a pod's engine (`harness`, `engine`). Core hands a pod
 * sandbox's engine the `harness` and `engine` groups the operator set (`podTuningEnv`), so a pod
 * runs with the timings of the Runtime that started it.
 *
 * Tenant-facing limits (sizes a client meets, request and turn deadlines) are not here: they are
 * Runtime limits and Tenant settings. `engine` is our harness's own configuration: the options
 * of `createHarness` in `@nylorun/harness`, whose defaults stay there.
 */
import { z } from "zod";
import { TIMER_MAX_MS } from "@nylorun/core/contracts";

/**
 * The longest delay Node's timers take (`setTimeout`, `setInterval`): 2^31 - 1 ms, a signed
 * 32-bit integer. A longer one fires at once. Fixed by the platform, so a ceiling, not a setting.
 */
export const MAX_TIMER_MS = TIMER_MAX_MS;

/** S3's smallest multipart part but the last (5 MiB), and its largest part (5 GiB). */
export const S3_MIN_PART_BYTES = 5 * 1024 * 1024;
export const S3_MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * How long a wake's dedupe key merges repeated wakes, at least (Durable Session Execution
 * §12.3): a wake sent again within a day must not start a second advance. A floor of the
 * design, so a setting may only raise it.
 */
export const DEDUPE_RETENTION_MIN_MS = 24 * 60 * 60_000;

/** The longest `?wait=` the sandboxes service takes (`MaxWait` in its API): a dependency's ceiling. */
export const SANDBOXES_MAX_WAIT_MS = 30_000;

/**
 * The most bind parameters one Postgres statement takes: the extended protocol's `Bind` message
 * counts them in a 16-bit integer. A dependency's ceiling.
 */
export const POSTGRES_MAX_PARAMETERS = 65_535;
/** The most columns one batched content row binds (`artifact_content`: id, version, hash, size). */
const CONTENT_ROW_PARAMETERS = 4;

/** The most records, and bytes, one S2 append takes and one S2 read returns: S2's ceilings. */
export const S2_BATCH_MAX_RECORDS = 1000;
export const S2_BATCH_MAX_BYTES = 1024 * 1024;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KIB = 1024;
const MIB = 1024 * KIB;

/** A delay or timeout in milliseconds: a whole number, at most `MAX_TIMER_MS`. */
const ms = (value: number, min = 1) => z.number().int().min(min).max(MAX_TIMER_MS).default(value);
/** A count: a whole number of at least `min`. */
const count = (value: number, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  z.number().int().min(min).max(max).default(value);
/** A size in bytes. */
const bytes = (value: number, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  z.number().int().min(min).max(max).default(value);

/** Exponential backoff: the first wait, doubled after each failure up to the longest. */
const backoff = (minMs: number, maxMs: number) =>
  z
    .strictObject({ minMs: ms(minMs), maxMs: ms(maxMs) })
    .refine((value) => value.minMs <= value.maxMs, { message: "minMs must be at most maxMs" })
    .prefault({});

// Every field of a group has a default, so an empty group is all defaults.
const group = <T extends Record<string, z.ZodType>>(shape: T) => z.strictObject(shape).prefault({} as never);

/** A partial engine option group: each number validated, the rest left to `createHarness`. */
const enginePart = <T extends Record<string, z.ZodType>>(shape: T) => z.strictObject(shape).partial().optional();
const positiveInt = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const positiveShare = () => z.number().gt(0).max(1);

export const HostTuningSchema = z
  .strictObject({
    /** The keys service and its client (F4.2), and the egress CA's certificates (R2c). */
    keys: group({
      /** The largest request body the keys service reads. */
      bodyBytes: bytes(MIB),
      /** How long core waits for the keys service to answer one call. */
      timeoutMs: ms(30_000),
      /** How far before now a leaf certificate is valid from, for clocks that differ. */
      leafBackdateMs: ms(5 * MINUTE, 0),
      /** How long a leaf egress-gate presents is valid. */
      leafLifetimeMs: ms(HOUR),
      /** How far before now the egress CA is valid from. */
      caBackdateMs: ms(HOUR, 0),
      /** How many days the egress CA is valid. */
      caLifetimeDays: count(3650),
      /**
       * The longest life of a token the Runtime signs (a user's access token, a capability link): a
       * link asked for longer gets this, and a key rotation waits this long for the old key's tokens.
       */
      tokenTtlMaxSeconds: count(15 * 60),
      /** How long a run token lives, and how little of its life is left when the lease re-mints it. */
      runTokenTtlSeconds: count(15 * 60),
      runTokenRenewSeconds: count(5 * 60),
      /** How long a host or an egress token lives; a pod's engine renews them before. */
      hostTokenTtlSeconds: count(15 * 60),
      /** How far a token's `exp` may be past its `iat` beyond its lifetime, for clocks that differ. */
      tokenLifetimeSlackSeconds: count(60, 0),
      /** The clock skew accepted when a token's times are checked (the Runtime's and an issuer's). */
      clockToleranceSeconds: count(30, 0),
    }),
    /** Core's Harness API listener and server (F6.2). */
    harnessApi: group({
      /** The largest `host/join` or `host/renew` body. */
      joinBodyBytes: bytes(8 * KIB),
      /** The largest setup report a pod's engine posts. */
      reportBodyBytes: bytes(64 * KIB),
      /** How long the listener waits for connections to close before it ends them. */
      closeGraceMs: ms(1_000, 0),
      /** How long a run offered to the harnesses waits for one to take it. */
      offerWaitMs: ms(10_000),
      /** How long a pod sandbox's segment waits for its engine to take it. */
      podOfferWaitMs: ms(MINUTE),
      /** How long the Tenant's own harness has to connect to its loopback listener. */
      loopbackConnectTimeoutMs: ms(10_000),
      /** How the Tenant's own harness reconnects to its loopback listener. */
      loopbackBackoff: backoff(50, 500),
      /**
       * Segment rollover (Model Calls §10): a turn ends its segment at a step boundary after this
       * many steps or this long, and continues in a new one, well inside the advance deadline.
       */
      rolloverSteps: count(50),
      rolloverMs: ms(20 * MINUTE),
    }),
    /** The Runtime API's long-lived responses. */
    api: group({
      /** How often an AG-UI event stream sends a heartbeat comment. */
      agUiHeartbeatMs: ms(15_000),
      /** How often a session event stream sends a keepalive comment. */
      eventStreamKeepaliveMs: ms(15_000),
    }),
    /** The Host process. */
    host: group({
      /** How long shutdown waits for requests in progress before it closes their connections. */
      shutdownGraceMs: ms(10_000, 0),
      /** The bound on one `/ready` pass. Compose probes it every 2 s with a 5 s timeout. */
      readinessTimeoutMs: ms(2_000),
      /** How long `nylorun-operate status` waits for the running Host's `/ready`. */
      operateReadyTimeoutMs: ms(5_000),
      /**
       * The project credential store (`ProjectCredentialStore`): how often a writer checks its lock,
       * and how many times before it gives up.
       */
      credentialLockPollMs: ms(25),
      credentialLockAttempts: count(100),
    }),
    /** The Object store (`NYLORUN_OBJECT_STORE_*`). */
    objectStore: group({
      /** The size of each part of a multipart upload but the last: S3 takes 5 MiB to 5 GiB. */
      partSizeBytes: bytes(8 * MIB, S3_MIN_PART_BYTES, S3_MAX_PART_BYTES),
      /** Tries of a request answered `5xx` or `429`, or unreachable, the first included. */
      attempts: count(3),
      /** The wait after the first failed try, doubled after each. */
      retryBaseMs: ms(100),
      /** How core retries creating the bucket while the store starts. */
      bucketRetry: backoff(1_000, 5_000),
      bucketAttempts: count(10),
    }),
    /** The Tenant: opening it, its advances, its sweep and its record. */
    tenant: group({
      /** The bound on opening the Tenant; a slower open fails with `open-timeout`. */
      openTimeoutMs: ms(30_000),
      /** Retries of an open that failed outside the Tenant. */
      openRetry: backoff(1_000, 30_000),
      /** The ownership lease of an advance (§10.6); renewed every third while it runs. */
      ownerLeaseMs: ms(30_000),
      /** The shortest `busy` retry, so a lease about to lapse is not polled in a tight loop. */
      busyRetryMinMs: ms(25),
      /** How soon an advance whose segment no harness took is tried again. */
      unavailableRetryMs: ms(1_000),
      /** How long draining waits for running turns before a reset or a close goes on. */
      drainTimeoutMs: ms(30_000),
      /** How long status waits for the execution to list stuck invocations. */
      statusTimeoutMs: ms(5_000),
      /** The grace added to the longest token lifetime before a previous signing key may go. */
      signingKeyRotationGraceMs: ms(MINUTE, 0),
      /**
       * The `Retry-After` of a request refused while its Environment is busy, or while the
       * sandboxes service is not ready.
       */
      retryAfterSeconds: count(5),
      /** How long a pending Environment seed holds the disk before another process may take it over. */
      seedLeaseMs: ms(10 * MINUTE),
      /**
       * The longest a pod Agent waiting to start on a new version (track T3) stays idle before it
       * stops, so its next start applies the version: its own `lifecycle.idle` when shorter.
       */
      upgradeIdleMs: ms(MINUTE),
      /** How long a pod may take to start on a new version before it goes back to the one it ran (T3). */
      upgradeStartMs: ms(10 * MINUTE),
    }),
    /** The Tenant's sweep (`tenant/sweep.ts`): outbox, orphaned sessions, stale pods. */
    sweep: group({
      /** The delay between sweep passes of one Tenant. */
      intervalMs: ms(5_000),
      /** Rows one sweep query reads at a time. */
      batchSize: count(100),
      /** How long a control signal is kept after it was written. */
      signalRetentionMs: ms(HOUR),
      /** How old an outbox row is before the sweep delivers it. */
      outboxGraceMs: ms(30_000, 0),
      /** How often the orphan scan and the stale pod check run. */
      orphanScanMs: ms(MINUTE),
      /** How long one pass may spend on the outbox, and on orphaned sessions. */
      drainBudgetMs: ms(2_000),
      /** Tenant sweeps the Host arms at once when it starts. */
      armConcurrency: count(16),
      /** Delivery attempts of one outbox row before it is parked. */
      outboxAttempts: count(10),
      /** The wait after an outbox row's failed delivery, doubled after each. */
      outboxRetry: backoff(5_000, 10 * MINUTE),
      /** How long a pod row may go unchanged before the sweep checks it. */
      stalePodMs: ms(MINUTE),
    }),
    /** The A2A server's push notifications (Host feature `a2a-profile-v2`). */
    a2a: group({
      /** The wait after a push's failed delivery, doubled after each. */
      pushRetry: backoff(5_000, 10 * MINUTE),
      /** How long a push is tried before it is dropped: the change feed covers what it said. */
      pushMaxAgeMs: ms(24 * HOUR),
      /** How long one push's request may take. */
      pushTimeoutMs: ms(10_000),
      /** How long a finished task's push configs are kept, for `GetTaskPushNotificationConfig`. */
      pushConfigRetentionMs: ms(7 * 24 * HOUR),
    }),
    /** Triggers (track T4, D74): server timing; the Tenant's own bounds are its Runtime limits. */
    triggers: group({
      /**
       * How long after it was due a fire counts as late (the server was down or asleep), and how
       * overdue an active trigger is before the sweep arms it again.
       */
      lateGraceMs: ms(2 * MINUTE),
      /** How many upcoming fires the save check reads to find a cron's smallest gap. */
      intervalCheckFires: count(100, 2, 10_000),
      /** The clock skew a webhook delivery's `webhook-timestamp` may have, either way (D75). */
      webhookToleranceMs: ms(5 * MINUTE),
    }),
    /** Durable Session Execution: Restate, or the in-process execution. */
    execution: group({
      /**
       * How long one advance may run before its signal aborts; below Restate's inactivity and abort
       * timeouts (`restate.inactivityMs`), so an advance always ends before Restate gives up on it.
       */
      advanceDeadlineMs: ms(50 * MINUTE),
      /** How long an aborted advance has to settle before it is abandoned. */
      advanceGraceMs: ms(30_000, 0),
      /** How long stopping waits for running handlers after aborting them. */
      stopGraceMs: ms(30_000, 0),
      /** How long a wake's dedupe key merges repeated wakes. At least 24 hours (§12.3). */
      dedupeRetentionMs: ms(DEDUPE_RETENTION_MIN_MS, DEDUPE_RETENTION_MIN_MS),
      /** The in-process execution: the first retry of a handler that throws, doubled after each. */
      memoryRetryMs: ms(50),
      /** The in-process execution: attempts before a throwing handler is reported. */
      memoryAttempts: count(5),
    }),
    /** Restate (`NYLORUN_RESTATE_*`). */
    restate: group({
      /** How long one send through the ingress keeps retrying. Shorter than `sweep.outboxGraceMs`. */
      sendRetryMs: ms(10_000),
      sendBackoff: backoff(100, 2_000),
      /** How long the ingress may take to accept one send. */
      sendTimeoutMs: ms(10_000),
      /** How long an invocation may run without journal progress before Restate suspends it. */
      inactivityMs: ms(HOUR),
      /** How long after the inactivity timeout Restate aborts the attempt. */
      abortMs: ms(HOUR),
      /** Retries of a handler that throws; after `handlerAttempts` the invocation is paused. */
      handlerRetry: backoff(100, 30_000),
      handlerAttempts: count(70),
      /** How long `start` keeps registering the Worker while Restate comes up. */
      registrationDeadlineMs: ms(MINUTE),
      registrationBackoff: backoff(100, 2_000),
      /** How long one registration request may take. */
      registrationRequestTimeoutMs: ms(30_000),
      /** How long one admin query may take. */
      queryTimeoutMs: ms(10_000),
      /** How long stopping lets Restate read answers before it drops the connections. */
      closeGraceMs: ms(2_000, 0),
      /** A sweep chain is stale past this many sweep intervals, and never sooner than `staleSweepMinMs`. */
      staleSweepIntervals: count(3),
      staleSweepMinMs: ms(MINUTE),
      /** Stuck invocations one status lists by default, and at most. */
      stuckListDefault: count(100),
      stuckListMax: count(1_000),
    }),
    /** Postgres (`NYLORUN_DATABASE_URL`). */
    postgres: group({
      /** The Tenant pool's size. */
      poolSize: count(10),
      /** The Tenant pool's statement timeout; 0 turns it off. */
      statementTimeoutMs: ms(MINUTE, 0),
      /** The Tenant pool's idle-in-transaction timeout; 0 turns it off. */
      idleInTransactionTimeoutMs: ms(MINUTE, 0),
      /** Seconds closing a pool waits for its queries before it ends their connections. */
      closeTimeoutSeconds: count(5, 0),
      /** Seconds an idle pooled connection stays open. */
      idleTimeoutSeconds: count(30),
      /** Seconds a connection may take to open. */
      connectTimeoutSeconds: count(10),
      /** The pool of the replication service (the stream relay, the trace projector). */
      replicationPoolSize: count(2),
      /** The read pool (`nylorun-reads`): its size and its timeouts. */
      readPoolSize: count(4),
      readConnectTimeoutSeconds: count(2),
      readStatementTimeoutMs: ms(2_000),
      readCloseTimeoutSeconds: count(2, 0),
      /** The control bus: how often it reads back signals it may have missed. */
      controlPollMs: ms(5_000),
      /** How far back a read-back looks; longer than the poll. */
      controlWindowSeconds: count(120),
      /** How the control bus listens again after its connection ends. */
      controlRetry: backoff(100, 5_000),
      /** How soon the stream relay and the trace projector try again to take their replication slot. */
      replicationRetryMs: ms(5_000),
      /**
       * Rows one statement writes or looks up when a folder version or a definition names many
       * files: Postgres binds at most 65,535 parameters a statement, four a row.
       */
      contentBatchRows: count(1_000, 1, Math.floor(POSTGRES_MAX_PARAMETERS / CONTENT_ROW_PARAMETERS)),
    }),
    /** Durable Streams (S2) and the stream relay. */
    streams: group({
      /** Reads, basin checks and deletions retried by the Tenant's streams. */
      retry: backoff(100, 2_000),
      /** The longest wait between two basin repairs. */
      basinRetryMaxMs: ms(5_000),
      /** A repair within this long after the last one waits for the next failure. */
      basinRepairCooldownMs: ms(1_000, 0),
      /** A repair that keeps failing is logged on its first failure and on every this many after. */
      basinLogEveryFailures: count(10),
      /** How often every session stream is checked against its session. */
      feedCheckMs: ms(30_000),
      /** How long a retired basin stays for readers that have not moved yet. */
      retireGraceMs: ms(MINUTE, 0),
      /** Attempts to delete a retired basin before it waits for the Tenant's next open. */
      retireAttempts: count(5),
      /** How long a streams probe waits. */
      probeTimeoutMs: ms(2_000),
      /** The stream relay's retries of a failed append. */
      relayRetry: backoff(50, 2_000),
      /** The most records and bytes one relay append holds: S2 takes 1000 records and 1 MiB a batch. */
      relayBatchRecords: count(500, 1, S2_BATCH_MAX_RECORDS),
      relayBatchBytes: bytes(768 * KIB, 1, S2_BATCH_MAX_BYTES),
      /** Sessions the relay reconciles at once, and the session heads it reads a page at a time. */
      relayReconcileConcurrency: count(8),
      relayHeadsPage: count(500),
      /** S2: retries of a read. */
      s2Retry: backoff(100, 2_000),
      /** S2: attempts of an append that loses a `transaction_conflict` race, and its first wait. */
      s2ConflictAttempts: count(6),
      s2ConflictRetryMs: ms(25),
      /** S2: the first wait while a basin's deletion finishes, and how long it may take. */
      s2BasinRetryMs: ms(500),
      s2BasinDeletionWaitMs: ms(2 * MINUTE),
    }),
    /** The Model Gate, the Tool Gate and their clients in the loop. */
    gates: group({
      /** How long the loop's connection to the gate may stay silent; above the provider timeout. */
      clientTimeoutMs: ms(630_000),
      /** How long a cancel, or a short Tool Gate request, may take. */
      shortTimeoutMs: ms(2_000),
      /** The TCP keepalive of the loop's connections to the gate. */
      keepAliveMs: ms(30_000),
      /** The gate listener's request timeout; above the client's. */
      requestTimeoutMs: ms(660_000),
      /** How long the gate's database probe may take. */
      probeTimeoutMs: ms(2_000),
      /** How long the gate's MCP connections may sit unused. */
      mcpIdleMs: ms(15 * MINUTE),
      /** How much of an MCP connection's unexpected error message the loop is told. */
      errorMessageChars: count(2_000),
      /** How often idle MCP connections are swept: the idle time, within these bounds. */
      mcpSweepMinMs: ms(1_000),
      mcpSweepMaxMs: ms(MINUTE),
      /** How long a settled tool call crossing is kept, and how often old ones are pruned. */
      toolCrossingTtlMs: ms(24 * HOUR),
      toolCrossingPruneMs: ms(HOUR),
      /** How long the gate drains calls in progress when it stops, checking this often. */
      drainMs: ms(10_000, 0),
      drainPollMs: ms(50),
      /** How long a settled model call's outcome is kept for a retry to join, and how many. */
      inflightTtlMs: ms(30 * MINUTE),
      inflightMax: count(10_000),
    }),
    /** egress-gate (F7.2): sandbox pods' CONNECT proxy. */
    egress: group({
      /** Tunnels one sandbox may hold open at once. */
      maxTunnelsPerSandbox: count(64),
      /** A tunnel with no traffic either way for this long is closed. */
      idleMs: ms(5 * MINUTE),
      /** How long a sandbox's epoch and allowlist are reused, and how many are kept. */
      cacheMs: ms(5_000, 0),
      cacheEntries: count(4_096),
      /** How long the gate waits for the upstream connection. */
      connectTimeoutMs: ms(10_000),
      /** The proxy listener's header and request timeouts. */
      headersTimeoutMs: ms(10_000),
      requestTimeoutMs: ms(15_000),
      /** The header timeout of a tunnel whose TLS the gate terminates for a bound secret. */
      credentialsHeadersTimeoutMs: ms(MINUTE),
      /** The upstream sockets one such tunnel opens at once. */
      credentialsMaxSockets: count(8),
    }),
    /**
     * The outside credential provider (`NYLORUN_CREDENTIAL_PROVIDER_URL`), which egress-gate asks
     * for an Agent's connected hosts and core for its variables (`gates/credential-provider.ts`).
     */
    credentialProvider: group({
      /** How long an Agent's answer (hosts, or variables) is reused. */
      cacheMs: ms(15_000, 0),
      /** How long a failed answer (nothing) is reused before the provider is asked again. */
      retryMs: ms(5_000, 0),
      /** How long one `hosts` or `environment` call may take. */
      timeoutMs: ms(3_000),
      /** How many Agents' answers are kept. */
      cacheEntries: count(4_096),
    }),
    /** Sandbox pods through the sandboxes service (F7.2). */
    pods: group({
      /** How long a pod may take to be ready before its start fails. */
      readyDeadlineMs: ms(5 * MINUTE),
      /** How often a pod that is changing is checked. */
      pollMs: ms(2_000),
      /** How soon a pod whose service did not answer is checked again. */
      unreachableRetryMs: ms(5_000),
      /** How long the sandboxes service's readiness answer is reused. */
      readyCacheMs: ms(5_000, 0),
      /** How soon a reconcile that could not decide runs again. */
      reconcileRetryMs: ms(5_000),
      /** How often a disk copy or a seed checks whether a pod's engine has connected. */
      enginePollMs: ms(250),
      /** The least memory a sandbox gets, in MiB: a manifest or a Tenant limit asking less rounds up. */
      memoryFloorMiB: count(128),
      /** The sandboxes service: one request's timeout, and its `/ready` probe's. */
      requestTimeoutMs: ms(20_000),
      readyProbeTimeoutMs: ms(3_000),
      /** How long a `?wait=` request waits when its caller names no time; the service takes 30 s at most. */
      waitMs: z.number().int().min(1).max(SANDBOXES_MAX_WAIT_MS).default(SANDBOXES_MAX_WAIT_MS),
      /** Added to a `?wait=` request's timeout for the answer to arrive. */
      waitSlackMs: ms(10_000, 0),
    }),
    /**
     * A harness process (`--service harness`), a pod's engine, and the Tenant's own harness: the
     * harness host's timings.
     */
    harness: group({
      /** How often the WebSocket pings, and how long it may stay silent before it is closed. */
      pingMs: ms(30_000),
      silenceMs: ms(90_000),
      /** How the harness reconnects to core's Harness API. */
      reconnect: backoff(500, 10_000),
      /** How long the WebSocket handshake may take. */
      handshakeTimeoutMs: ms(10_000),
      /** How long a run has to give its lease back when the connection closes. */
      reconnectStopMs: ms(5_000, 0),
      /** How long stopping the process waits for runs: a harness container, a pod's engine. */
      stopMs: ms(10_000, 0),
      podStopMs: ms(7_000, 0),
      /** The run tokens a harness keeps, the oldest dropped first. */
      runTokensMax: count(10_000),
      /** How often idle MCP connections are swept, and how long one may sit unused. */
      mcpSweepMs: ms(MINUTE),
      mcpIdleMs: ms(15 * MINUTE),
      /**
       * The most `tools/list` pages one MCP server's listing reads (discovery, and a preview), so a
       * server whose cursor never ends cannot hold a turn; the tools on later pages are left out.
       */
      mcpListPages: count(100),
      /** How much of an MCP connection's error message its discovery diagnostic keeps. */
      mcpDiagnosticChars: count(500),
      /**
       * The Runtime's own commands in a sandbox (making folders, mounting skills, the tools'
       * helpers): how long one may take, and how much of one a failure quotes.
       */
      helperCommandTimeoutMs: ms(MINUTE),
      helperCommandExcerptChars: count(120),
      /**
       * The shortest credential value scrubbed from what a tool, a command or a model returns
       * (every process that scrubs reads it): a shorter one would blank out ordinary text that
       * happens to contain it.
       */
      scrubMinChars: count(8),
      /** How much of a command an `environment.exec` event keeps. */
      execCommandChars: count(500),
      /** The local sandbox backend: the most bytes kept of each of a command's output streams. */
      commandStreamBytes: bytes(4 * MIB),
      /** A pod's engine: how often it renews its host and egress tokens, and how early. */
      podRenewMs: ms(5 * MINUTE),
      podRenewEarlyMs: ms(MINUTE, 0),
      /** A pod's engine: how long `host/join` and `host/renew`, and other host calls, may take. */
      podJoinTimeoutMs: ms(15_000),
      podRequestTimeoutMs: ms(5 * MINUTE),
      /**
       * A pod's engine, before it joins: how long it waits for its NetworkPolicy, each probe of an
       * address the policy blocks, the pause after a probe that connected, and the failed probes
       * in a row that prove an address blocked.
       */
      networkPolicyTimeoutMs: ms(2 * MINUTE),
      networkProbeMs: ms(1_000),
      networkPauseMs: ms(250, 0),
      networkConfirmations: count(3),
      /** Environment setup: how often a failed setup is checked for a retry, and after a seed. */
      setupRetryPollMs: ms(5_000),
      setupAfterSeedPollMs: ms(1_000),
      /** How many characters of a failed setup command's output its report keeps (the end). */
      setupReportTailChars: count(4 * KIB),
    }),
    /** Traces (R7.2): the OTLP exporter. */
    traces: group({
      /** How long one OTLP request may take. */
      timeoutMs: ms(10_000),
      /** Tries after the first, and the wait before the first retry, doubled for each after. */
      retries: count(3, 0),
      backoffMs: ms(500),
      /** The trace projector: spans per post, how long a span waits for its batch to fill, the spans
       * that may wait while a post is out (the rest are dropped), the turns whose trace it keeps,
       * and how soon it reads again when Postgres did not answer. */
      batchSpans: count(512),
      batchDelayMs: ms(2_000),
      queuedSpansMax: count(8_192),
      turnCacheSize: count(1_024),
      retryMs: ms(1_000),
    }),
    /**
     * Our engine (`createHarness` in `@nylorun/harness`): each left out is the engine's default.
     * A harness host passes these to the engine it runs.
     */
    engine: z
      .strictObject({
        /** The transcript cache's budget, in MiB. */
        transcriptCacheMb: positiveInt().optional(),
        /** The most bytes one `read_artifact` page holds. */
        artifactPageBytes: positiveInt().optional(),
        /** The most bytes of one skill file read into the model's context. */
        skillReadBytes: positiveInt().optional(),
        /** How soon a failed lease is asked for again. */
        leaseRetryMs: z.number().int().positive().max(MAX_TIMER_MS).optional(),
        /** The waits before each resend of an effect core has not answered; the last repeats. */
        resendDelaysMs: z.array(z.number().int().positive().max(MAX_TIMER_MS)).min(1).optional(),
        /** How much of a failed agent-as-tool's last output its parent sees. */
        partialOutputChars: positiveInt().optional(),
        /** How much of a value a flow's failure message quotes. */
        flowValueChars: positiveInt().optional(),
        compaction: enginePart({
          keepTokens: positiveInt(),
          keepShare: positiveShare(),
          reserveTokens: positiveInt(),
          maxReserveTokens: positiveInt(),
          maxReserveShare: positiveShare(),
          clipChars: positiveInt(),
          summaryOverheadTokens: positiveInt(),
          imageTokens: positiveInt(),
          fileTokensMax: positiveInt(),
          minChunkTokens: positiveInt(),
          minSummaryTokens: positiveInt(),
          summaryShare: positiveShare(),
          charsPerToken: positiveInt(),
        }),
        sandboxTools: enginePart({
          outputChars: positiveInt(),
          defaultTimeoutS: positiveInt(),
          maxTimeoutS: positiveInt(),
          readLines: positiveInt(),
          maxReadLines: positiveInt(),
          lineChars: positiveInt(),
          grepResults: positiveInt(),
          maxGrepResults: positiveInt(),
          globResults: positiveInt(),
          globScan: positiveInt(),
        }),
        mcpTools: enginePart({
          deferShare: positiveShare(),
          charsPerToken: positiveInt(),
          fallbackContextWindow: positiveInt(),
          serverInstructionsMaxChars: positiveInt(),
          toolSearchDefaultLimit: positiveInt(),
          toolSearchMaxLimit: positiveInt(),
        }),
        toolResults: enginePart({
          resultInlineBytes: positiveInt(),
          previewHeadBytes: positiveInt(),
          previewTailBytes: positiveInt(),
          stepBudgetBytes: positiveInt(),
          stubBytes: positiveInt(),
          smallBytes: positiveInt(),
          minPreviewBytes: positiveInt(),
          entryEnvelopeBytes: positiveInt(),
        }),
        outputs: enginePart({
          dir: z.string().startsWith("/"),
          maxBytes: positiveInt(),
        }),
      })
      .prefault({}),
  })
  .superRefine((tuning, issues) => {
    // Settings that only work against another.
    const rule = (ok: boolean, path: string[], message: string) => {
      if (!ok) issues.addIssue({ code: "custom", path, message });
    };
    rule(
      tuning.gates.requestTimeoutMs > tuning.gates.clientTimeoutMs,
      ["gates", "requestTimeoutMs"],
      "must be above gates.clientTimeoutMs: the gate must not end a call its client still waits for",
    );
    rule(
      tuning.gates.mcpSweepMinMs <= tuning.gates.mcpSweepMaxMs,
      ["gates", "mcpSweepMinMs"],
      "must be at most gates.mcpSweepMaxMs",
    );
    rule(
      tuning.postgres.controlWindowSeconds * 1000 > tuning.postgres.controlPollMs,
      ["postgres", "controlWindowSeconds"],
      "must be longer than postgres.controlPollMs, so a read-back catches a missed notification",
    );
    rule(
      tuning.execution.advanceDeadlineMs < tuning.restate.inactivityMs,
      ["execution", "advanceDeadlineMs"],
      "must be below restate.inactivityMs, so an advance ends before Restate suspends it",
    );
    for (const key of ["runTokenTtlSeconds", "hostTokenTtlSeconds"] as const)
      rule(
        tuning.keys[key] <= tuning.keys.tokenTtlMaxSeconds,
        ["keys", key],
        "must be at most keys.tokenTtlMaxSeconds, which a key rotation waits for",
      );
    rule(
      tuning.keys.runTokenRenewSeconds < tuning.keys.runTokenTtlSeconds,
      ["keys", "runTokenRenewSeconds"],
      "must be below keys.runTokenTtlSeconds",
    );
    rule(
      tuning.keys.hostTokenTtlSeconds * 1000 > tuning.harness.podRenewMs,
      ["keys", "hostTokenTtlSeconds"],
      "must be longer than harness.podRenewMs, so a pod's engine renews its tokens before they end",
    );
    rule(
      tuning.restate.stuckListDefault <= tuning.restate.stuckListMax,
      ["restate", "stuckListDefault"],
      "must be at most restate.stuckListMax",
    );
  });

export type HostTuning = z.infer<typeof HostTuningSchema>;
/** What an operator sets: any part of the tuning. */
export type HostTuningInput = z.input<typeof HostTuningSchema>;
export type EngineTuning = HostTuning["engine"];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** The tuning with every default: the Runtime's values when nothing is set. */
export const DEFAULT_HOST_TUNING: HostTuning = deepFreeze(HostTuningSchema.parse({}));

export class HostTuningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostTuningError";
  }
}

/** `input` over the defaults; throws `HostTuningError` naming each refused key. */
export function hostTuningOf(input: unknown, source = "NYLORUN_TUNING"): HostTuning {
  const parsed = HostTuningSchema.safeParse(input ?? {});
  if (!parsed.success)
    throw new HostTuningError(
      `${source}: ${parsed.error.issues
        .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  return deepFreeze(parsed.data);
}

/** The tuning `NYLORUN_TUNING` names (JSON), and the overrides as set; the defaults when unset. */
export function parseHostTuning(raw: string | undefined): { tuning: HostTuning; overrides?: Record<string, unknown> } {
  if (raw === undefined || raw.trim() === "") return { tuning: DEFAULT_HOST_TUNING };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new HostTuningError(
      `NYLORUN_TUNING must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HostTuningError("NYLORUN_TUNING must be a JSON object of tuning groups, e.g. {\"tenant\":{\"openTimeoutMs\":60000}}");
  const set = value as Record<string, unknown>;
  const tuning = hostTuningOf(set);
  const pod = podTuningOf(set);
  if (pod !== undefined && Buffer.byteLength(pod) > POD_ENV_VALUE_MAX_BYTES)
    throw new HostTuningError(
      `NYLORUN_TUNING's ${POD_GROUPS.join(" and ")} groups take ${Buffer.byteLength(pod)} bytes as JSON; a sandbox pod's engine gets them in one environment variable, of at most ${POD_ENV_VALUE_MAX_BYTES} bytes (the sandboxes service's limit)`,
    );
  return { tuning, overrides: set };
}

/** The groups a pod's engine reads. */
const POD_GROUPS = ["harness", "engine"] as const;

/**
 * The longest environment variable value the sandboxes service puts in a pod's spec (its `env`
 * validation): a dependency's ceiling, not a setting.
 */
const POD_ENV_VALUE_MAX_BYTES = 4096;

/** The pod groups of `set` as JSON, or undefined when it sets neither. */
function podTuningOf(set: Record<string, unknown>): string | undefined {
  const picked = Object.fromEntries(
    POD_GROUPS.filter((name) => set[name] !== undefined).map((name) => [name, set[name]]),
  );
  return Object.keys(picked).length === 0 ? undefined : JSON.stringify(picked);
}

let current: HostTuning = DEFAULT_HOST_TUNING;
let overrides: Record<string, unknown> | undefined;

/**
 * The process's tuning: what `useHostTuning` set when the process started, or the defaults. Read
 * where a value is used, never kept at module load, so what the process was started with applies.
 */
export function hostTuning(): HostTuning {
  return current;
}

/**
 * Sets the process's tuning, once at start (`host/main.ts`); tests set and reset it. `set` is the
 * overrides as the operator wrote them, which a pod's engine is handed (`podTuningEnv`).
 */
export function useHostTuning(tuning: HostTuning, set?: Record<string, unknown>): void {
  current = tuning;
  overrides = set;
}

/**
 * `NYLORUN_TUNING` for a pod sandbox's engine: the `harness` and `engine` groups the operator
 * set, or nothing when they set neither.
 */
export function podTuningEnv(): Record<string, string> {
  const pod = overrides && podTuningOf(overrides);
  return pod === undefined ? {} : { NYLORUN_TUNING: pod };
}

/** Every setting's dotted path (`tenant.openTimeoutMs`), for the docs check. */
export function hostTuningPaths(): string[] {
  const paths: string[] = [];
  const walk = (value: unknown, prefix: string) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 && !("minMs" in value))
      for (const [key, item] of Object.entries(value)) walk(item, prefix ? `${prefix}.${key}` : key);
    else paths.push(prefix);
  };
  walk(DEFAULT_HOST_TUNING, "");
  return paths;
}
