/**
 * The Session Store seam (architecture §12.2).
 *
 * The Session Store records what happened. It is async, transactional and
 * tenant-scoped: one `SessionStore` per Tenant. Postgres is the
 * implementation (`store/postgres/store.ts`); tests run on it too.
 *
 * ## Invariants every implementation keeps
 *
 * 1. **One transaction per `tx` call, READ COMMITTED or stronger.** Nothing a
 *    transaction wrote is visible to others before it commits, and nothing is
 *    kept when `fn` throws: document writes, event sequences, record rows,
 *    and outbox requests are all discarded, and `tx` rejects with the error `fn`
 *    threw.
 * 2. **Session-scoped writes lock the session row first.** `lockSession` takes
 *    a row lock (`SELECT … FOR UPDATE`) held until the transaction ends. Effect
 *    intent and outcome, checkpoint settlement and event
 *    writes for one session are serialized through it. Idempotency comparisons
 *    (`canonical(...)`) run inside the same locked transaction. `event` and the
 *    ownership methods take the lock themselves.
 * 3. **Per-session event sequence.** `event` allocates the session's next
 *    sequence under the session lock, starting at 0, without gaps across
 *    committed transactions. The sequence is also the S2 sequence number of the
 *    event in the session's stream (`sessions/<id>` in the Tenant's basin
 *    generation, `streams/basin.ts`), and the cursor is
 *    `base64url("<sessionId>:<seq>")` (see `record/cursor.ts`).
 * 4. **No external I/O inside `fn`.** No model, tool, MCP, sandbox, Restate or
 *    S2 call, and no `fetch`, runs inside a transaction. What a transaction asks of
 *    Durable Session Execution (a wake, a pod sandbox's reconcile or timer) is written
 *    to the outbox in the transaction (`Tx.wake`, `Tx.signalSandbox`) and delivered
 *    after commit; what it tells the other processes goes on the control bus
 *    (`Tx.signal`); and events are delivered to commit listeners after commit (seam
 *    rule 1 and 2).
 * 5. **No nested transactions.** Calling `store.tx` from inside `fn` rejects.
 *    A `Tx` must not be used after its `tx` call settles.
 * 6. **Post-commit order.** After a commit, the store first calls every commit
 *    listener once with the transaction's events (in allocation order), then hands
 *    the transaction's outbox requests to the delivery (`deliverTo`), in the order
 *    they were written, without the caller waiting. Listener and delivery failures
 *    are reported to the store's error hook; they never reject `tx`, because the
 *    commit stands. A request whose delivery fails, or that a crash cuts off, stays
 *    in the outbox, which the Tenant sweep delivers again. Nothing else runs after
 *    commit: a step that is not written down is lost to a crash.
 * 7. **Documents are values.** `get` and queries return fresh copies; mutating
 *    them changes nothing until `put`.
 * 8. **Ownership columns are store-managed.** `owner`, `epoch` and
 *    `ownerExpiresAt` on a session are read with the session but written only
 *    through `takeOwnership`, `renewOwnership` and `releaseOwnership`; `put`
 *    ignores them. A session starts with no owner and epoch 0.
 *
 * ## Typed queries, no scans
 *
 * There is no generic table scan. Every read the Runtime needs is a typed
 * method on `Tx` (`sessionsWithStatus`, `effectsForTurn`, `linkedSessions`,
 * `counts`, …) that an implementation can back with an index, and principals,
 * vaults and Tenant settings
 * have their own methods rather than raw SQL outside the store. Session history
 * is not read from the store: every event is written to the record (Postgres
 * `nylorun_streams.session_events`) in its transaction, the stream relay
 * (`streams/relay/`) feeds Durable Streams from it, and history and SSE read
 * them there (`tenant/session-streams.ts`).
 */
import type { KeyRole } from "@nylorun/core/compatibility";
import type { RecordReader } from "../streams/relay/types.js";
import type { SandboxSignal, Wake } from "../execution/types.js";
import type {
  EventPayload,
  EventType,
  EventWriter,
  LiveEvent,
  EnvironmentEvent,
  EnvironmentEventPayload,
  EnvironmentEventType,
  EnvironmentKind,
  EnvironmentManifest,
  EnvironmentRecipe,
  PodDesired,
  PodObserved,
  SessionEventOf,
} from "@nylorun/core/contracts";
import type { HostEffect } from "@nylorun/harness/run";
import type {
  ArtifactRow,
  ArtifactVersionRow,
  DefinitionFileRow,
  ModelBudgetRow,
  ModelUsageRow,
  ModelUsageWrite,
  PrincipalRow,
  ToolCrossingRow,
  SigningKeyRow,
  VaultAuditRow,
  VaultCredentialRow,
  VaultIdempotencyRow,
  VaultRow,
} from "./postgres/schema.js";

// ---------------------------------------------------------------------------
// Documents

/** Tables holding JSON documents keyed by `id`. */
export type DocTable =
  | "definitions"
  | "sessions"
  | "commands"
  | "effects"
  | "sandboxes"
  | "links";

export const DOC_TABLES: readonly DocTable[] = [
  "definitions",
  "sessions",
  "commands",
  "effects",
  "sandboxes",
  "links",
];

/** Session lifecycle (architecture §10.2). */
export type SessionStatus =
  | "idle"
  | "runnable"
  | "running"
  | "waiting"
  | "paused"
  | "uncertain"
  | "completed"
  | "failed"
  | "cancelled";

/** Effect states (§10.3), plus the flow host's `queued` and `cancelled`. */
export type EffectStatus =
  | "pending"
  | "invoking"
  /** A tool call the Tool Gate held for a person's approval (R5 step 2): nothing was sent. */
  | "held"
  | "completed"
  | "uncertain"
  | "queued"
  | "cancelled";

export type EffectKind = HostEffect["kind"];

/**
 * Ownership of a session by a Worker (§10.6). Read with the session; written
 * only through the ownership methods on `Tx`.
 */
export interface SessionOwnership {
  /** Worker id holding the lease, or null. */
  owner: string | null;
  /** Incremented by every successful `takeOwnership`. Starts at 0. */
  epoch: number;
  /** ISO time the owner's lease ends, or null without an owner. */
  ownerExpiresAt: string | null;
}

/** A session's lease epoch, status and active turn: what a run token must still match. */
export interface SessionRunState {
  readonly epoch: number;
  readonly status: string;
  readonly activeTurnId: string | null;
}

/**
 * The fields of a session document that the store indexes. The
 * Runtime's own session type extends this; everything else in the body is
 * opaque to the store.
 */
export interface SessionDoc {
  id: string;
  agentId: string;
  status: SessionStatus | (string & {});
  activeTurnId: string | null;
}

/** The fields of an effect document the store indexes (`request.sessionId`, `request.turnId`, `request.kind`, `status`). */
export interface EffectDoc {
  request: HostEffect;
  status: EffectStatus | (string & {});
}

/** A workflow → agent session link, keyed by the linked agent session id. Indexed: `workflowSessionId`. */
export interface LinkDoc {
  workflowSessionId: string;
  path: string;
  effectId: string;
  turnId: string;
}

/** A definition document. Indexed: `manifest.id`. */
export interface DefinitionDoc {
  manifest: { id: string };
}

/** A sandbox record, keyed by sandbox key. */
export interface SandboxDoc {
  key: string;
}

/** An Environment (`environments`, D55): what `PUT /v1/environments/{id}` created. */
export interface Environment {
  id: string;
  kind: EnvironmentKind;
  labels: Record<string, string>;
  /** What the app asked for, resolved against the Tenant's limits. */
  recipe: EnvironmentRecipe;
  /** The recipe the current pod or workspace runs (copied from `recipe` at the next wake). */
  applied: EnvironmentRecipe;
  version: number;
  appliedVersion: number;
  /** The owner guard: only this owner's sessions may name it. */
  ownerUserId?: string;
  /** ISO time it was last used (`lifecycle.deleteAfter` counts from it). */
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Kind `pod`: the pod's lifecycle (F7.2). Absent otherwise. */
  pod?: SandboxPodState;
  /** The disk lease while a snapshot, restore or seed copies the disk (R2d step 3). */
  diskOp?: DiskOperation;
  /**
   * The disk version the next volume starts from (R2d step 3). `setup` (a fork onto other setup,
   * Q17): the setup runs once the version is written (`written`), and the seed stays until it is done.
   */
  diskSeed?: DiskSeed;
  /** The environment manifest it was made from and its version (D63); absent for an inline one. */
  manifestName?: string;
  manifestVersion?: number;
  /** The hash of what it runs (`recipe`), recorded at creation (protocol 14). */
  manifestHash?: string;
  /** The Environment it was forked from and the disk version it started from (Q15). */
  forkedFrom?: { environment: string; disk: number | null };
}

/** A pending seed of an Environment's disk (`disk_seed`). */
export interface DiskSeed {
  artifactId: string;
  version: number;
  /** Run the setup on the seeded disk (a fork onto other setup, Q17). */
  setup?: true;
  /** The version is written; with `setup`, the seed waits for the setup to be done. */
  written?: true;
}

/** One version of an environment manifest (`environment_manifests`, D63). */
export interface EnvironmentManifestRow {
  name: string;
  version: number;
  body: EnvironmentManifest;
  hash: string;
  savedBy: { actor: string };
  createdAt: string;
}

/** A disk lease (R2d step 3): what holds the disk, since when, and until when unless renewed. */
export interface DiskOperation {
  kind: "snapshot" | "restore" | "seed";
  version?: number;
  /** ISO times. */
  startedAt: string;
  until: string;
}

/**
 * A pod Environment's lifecycle columns (`environments`, F7.2, D34): what the Runtime wants
 * (`desired`), what it last saw (`observed`), and the fences of its incarnations.
 */
export interface SandboxPodState {
  /** The agent-sandbox Sandbox's name (`podName`), of generation `volumeGen`. */
  k8sName: string;
  volumeGen: number;
  desired: PodDesired;
  observed: PodObserved;
  /** The UID of the pod that last joined. */
  podUid?: string;
  /** Bumped by every join, relaunch, loss and reset; host and egress tokens carry it. */
  hostEpoch: number;
  /** sha256 hex of the incarnation's join token. */
  joinTokenHash?: string;
  /** Bumped by every change asked of the pod (the sandboxes service's `opId`). */
  rev: number;
  /** ISO times. */
  lastActiveAt?: string;
  startedAt?: string;
  reason?: string;
  /** An earlier incarnation's Sandbox still to delete (after a reset or a loss). */
  retiring?: string;
  /** The id the engine keeps on the volume, from the first join. */
  volumeId?: string;
  /**
   * The workload image by digest (`repo@sha256:…`), recorded the first time a pod of the
   * Environment is ready (Q14): every later pod, after a stop, a relaunch or a reset, runs it.
   */
  imageDigest?: string;
}

/** A change to a pod's columns: `null` clears an optional one. */
export type SandboxPodPatch = {
  [K in keyof SandboxPodState]?: undefined extends SandboxPodState[K]
    ? SandboxPodState[K] | null
    : SandboxPodState[K];
};

/** A session as read from the store: its document plus the store-managed ownership fields. */
export type StoredSession<T extends SessionDoc = SessionDoc> = T &
  SessionOwnership;

/** A link row together with the agent session it names. */
export interface LinkedSession<S extends SessionDoc = SessionDoc> {
  agentSessionId: string;
  link: LinkDoc;
  session: StoredSession<S>;
}

// ---------------------------------------------------------------------------
// Events

/** What one commit produced, delivered to commit listeners after commit. */
export interface Commit {
  /** Events written by the transaction, in allocation order. */
  readonly events: readonly LiveEvent[];
  /**
   * The basin generation of each event, aligned with `events`: the stream relay appends it to
   * `sessions/<id>` in that generation's basin.
   */
  readonly generations: readonly number[];
}

/** A Tenant's basin generations (Durable Streams §8.1). */
export interface BasinGenerations {
  /** The basin session streams are written to and read from. */
  current: number;
  /** Earlier generations whose basins are still to be deleted. */
  retired: number[];
}

export type CommitListener = (commit: Commit) => void;

// ---------------------------------------------------------------------------
// Typed tables

/**
 * The rows of the typed tables, inferred from the tables Drizzle defines
 * (`store/postgres/schema.ts`): a principal, a vault and its credentials (secrets sealed in
 * `bytea` columns, never inside a JSON body), the vault's audit and idempotency records, the
 * Tenant's signing keys, a model call in the usage ledger and a model budget.
 */
export type {
  ArtifactRow,
  ArtifactVersionRow,
  DefinitionFileRow,
  ModelBudgetRow,
  ModelUsageRow,
  ModelUsageWrite,
  ToolCrossingRow,
  PrincipalRow,
  SigningKeyRow,
  VaultAuditRow,
  VaultCredentialRow,
  VaultIdempotencyRow,
  VaultRow,
};

/** Which rows of the usage ledger a total covers. */
export interface ModelUsageQuery {
  scope: "tenant" | "agent" | "turn";
  /** The agent or turn id; ignored for `tenant`. */
  id?: string;
  /** Only rows created at or after this ISO time. */
  since?: string;
}

export interface ModelUsageTotals {
  calls: number;
  tokens: number;
  costUsd: number;
}

/** Fields `updateCredential` may change. */
export type VaultCredentialPatch = Partial<
  Omit<VaultCredentialRow, "id" | "vaultId" | "createdAt">
>;

// ---------------------------------------------------------------------------
// Queries

export interface SessionEffectFilter {
  /** Only this turn. Absent means every turn. */
  turnId?: string;
  statuses?: readonly (EffectStatus | (string & {}))[];
}

/** Counts used by Tenant status, `summary` and `drain`. */
export interface StoreCounts {
  sessions: number;
  /** Sessions `running` or `runnable`. */
  runningSessions: number;
  /** Effects `uncertain`. */
  uncertainEffects: number;
  sandboxes: number;
  definitions: number;
}

export type ResetScope = "sessions" | "environments" | "all";

/** Result of `takeOwnership`. */
export type TakeOwnership =
  | {
      status: "owned";
      /** The new epoch every later transaction of this advance must present. */
      epoch: number;
      /** True when a previous owner's lease had expired without release: run takeover (§10.5 step 2). */
      takeover: boolean;
      previous: SessionOwnership;
    }
  | { status: "busy"; owner: string; ownerExpiresAt: string }
  | { status: "missing" };

// ---------------------------------------------------------------------------
// The seam

/** One tenant's Session Store. */
export interface SessionStore {
  /** The Tenant this store serves; stamped on every event. */
  readonly tenantId: string;
  /**
   * Runs `fn` in one READ COMMITTED transaction and commits when it resolves.
   * Session-scoped writes call `lockSession` first. See the module invariants.
   */
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
  /**
   * Registers a listener called once per committed transaction that wrote
   * events. Returns an unsubscribe function. A Tenant without the Host's stream
   * relay relays its own commits from here (`tenant/streams.ts`).
   */
  onCommit(listener: CommitListener): () => void;
  /** Reads the record back, for the stream relay's refills and reconciliation. */
  record(): RecordReader;
  /** Reachability and schema check for Tenant status and `/ready`. Never throws. */
  health(): Promise<StoreHealth>;
  /**
   * Follows the control bus (D21): calls `onSignal` once for each signal committed after the
   * returned promise resolves, on every process that follows. Delivery is by notification,
   * backed by a poll of recent signals (every `pollMs`, and each time the listener connects
   * again) that catches the notifications a dropped connection missed. `onSignal` must not
   * throw; what it throws goes to `onError`, as do listener failures.
   */
  followSignals(
    onSignal: (signal: ControlSignal) => void,
    options?: FollowSignalsOptions,
  ): Promise<SignalFollower>;
  /**
   * Sets where committed outbox requests go (`Tx.wake`, `Tx.signalSandbox`): after each
   * commit the store hands them to `deliver` without waiting for it, so a slow execution
   * never holds up the caller. Without one, they wait in the outbox for the Tenant sweep.
   */
  deliverTo(deliver: OutboxDelivery | undefined): void;
  /** Resolves once every delivery started so far has settled (`close` waits for them too). */
  delivered(): Promise<void>;
  close(): Promise<void>;
}

/** A wake as the outbox delivers it: its `dedupeKey` is the request's idempotency key. */
export type OutboxWake = Wake & { dedupeKey: string };

/**
 * What a committed transaction asked of Durable Session Execution, as the outbox delivers it:
 * a wake (`Tx.wake`), or a pod sandbox's reconcile or timer (`Tx.signalSandbox`; a reconcile
 * carries its idempotency key, `signal:<row id>`).
 */
export type OutboxRequest =
  | { kind: "wake"; sessionId: string; wake: OutboxWake }
  | { kind: "sandbox"; sandboxId: string; signal: SandboxSignal };

/**
 * Hands an outbox request to Durable Session Execution (`SessionStore.deliverTo`). Resolving
 * means the execution accepted it; `false` means it was not delivered and stays in the
 * outbox, due at the sweep's next pass, as after a rejection, which also goes to the store's
 * error hook.
 */
export type OutboxDelivery = (
  request: OutboxRequest,
) => boolean | void | Promise<boolean | void>;

/** An outbox row: which table (`kind`) and its id. */
export type OutboxRef = { kind: OutboxRequest["kind"]; id: string };

/** An outbox request not yet delivered (`Tx.pendingOutbox`). */
export interface PendingRequest extends OutboxRef {
  request: OutboxRequest;
  /** ISO time it was written. */
  createdAt: string;
  /** The sweep's failed deliveries of it so far (`failOutbox`). */
  attempts: number;
}

/**
 * A signal on the control bus (D21, D48): one process tells the others with the Tenant open.
 * Signals are not events: they are never recorded in a session's log or streamed, and a
 * lost one costs latency, never correctness. They never go through S2.
 */
export type ControlSignal =
  | {
      /** The process running the session's advance aborts it. */
      type: "session.cancel";
      sessionId: string;
      /** The cancelled turn: an advance of another turn keeps running. Absent: any advance. */
      turnId?: string;
    }
  | {
      /** The Tenant's sessions were reset and it moved to basin generation `generation`. */
      type: "sessions.reset";
      generation: number;
    }
  | {
      /**
       * Pod sandbox `sandboxId`'s host epoch moved to `epoch` (a join, a stop, a reset, a
       * deletion, a loss): every process closes its connections hosting it at an older epoch
       * (`HarnessApiServer.revokeHost`).
       */
      type: "host.revoked";
      sandboxId: string;
      epoch: number;
    };

export interface FollowSignalsOptions {
  /** How often recent signals are read back. Default `postgres.controlPollMs` (Host tuning, 5 s). */
  pollMs?: number;
  onError?: (error: unknown) => void;
}

export interface SignalFollower {
  /** Stops following and ends the listener's connection. */
  close(): Promise<void>;
}

export interface StoreHealth {
  ok: boolean;
  schemaVersion: number;
  expectedSchemaVersion: number;
}

/** Options every implementation accepts. */
export interface SessionStoreOptions {
  tenantId: string;
  /** Clock for event `time`. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Receives listener and outbox delivery failures, which never reject `tx`. */
  onError?: (error: unknown) => void;
}

/** The transaction handle. Valid only inside its `tx` callback. */
export interface Tx {
  // --- documents -----------------------------------------------------------

  get<T = any>(table: DocTable, id: string): Promise<T | undefined>;
  /** Insert or replace. For `sessions`, ownership fields in `body` are ignored. */
  put(table: DocTable, id: string, body: unknown): Promise<void>;
  /**
   * Deletes a document. Deleting a session keeps its record rows and log head
   * (per-session record deletion is deferred, Durable Streams §15), so a session
   * created again with the same id continues its log and stream.
   */
  delete(table: DocTable, id: string): Promise<void>;

  // --- ordering ------------------------------------------------------------

  /**
   * Locks the session row for the rest of the transaction and returns the
   * session (with ownership fields), or undefined when it does not exist.
   * Locking twice in one transaction is a no-op.
   *
   * Lock order, so concurrent transactions cannot deadlock (Postgres takes row
   * locks in statement order):
   * - a linked agent (child) session is locked before its workflow (parent)
   *   session, never after it. `t.event` on a session takes its lock, so an
   *   event on a child after the parent is locked breaks the rule too. Work
   *   that starts from the parent and must touch children locks the children
   *   first, or splits into one transaction per session;
   * - unrelated sessions touched by one transaction are locked in ascending
   *   id order (`lockSessions` in `store/postgres/locking.ts`), or split.
   */
  lockSession<T extends SessionDoc = SessionDoc>(
    id: string,
  ): Promise<StoredSession<T> | undefined>;

  /**
   * Allocates the session's next sequence (from 0) under the session lock,
   * builds the event on the `nylorun.event/2` envelope, checks it against the
   * event catalog (`InvalidEventError` when it does not match), writes it to
   * the record in the Tenant's current basin generation and buffers it for
   * commit listeners. Rejects when the session does not exist. The returned
   * cursor is final.
   */
  event<T extends EventType>(
    sessionId: string,
    turnId: string | null,
    type: T,
    payload: EventPayload<T>,
    /** Who wrote it (R4.9): absent, core, observed. */
    writer?: EventWriter,
  ): Promise<SessionEventOf<T>>;

  // --- outbox (architecture §12.3) ------------------------------------------

  /**
   * Asks for an advance of `sessionId` once this transaction commits. The request is a row
   * of the wake outbox written in this transaction, so it commits, or rolls back, with what
   * caused it: a commit never loses its wake. After commit the store hands it to the
   * delivery (`SessionStore.deliverTo`, `DurableExecution.wake` through the Tenant) without
   * waiting, and deletes the row once that resolves to anything but `false`. A request the
   * delivery declines or rejects is due at the sweep's next pass; one a crash cut off, or
   * still being sent, is due once it is older than the sweep's grace (`pendingOutbox`). The
   * delivery gets the request's idempotency key as `dedupeKey`: the wake's own, or
   * `wake:<row id>` without one, so a request delivered twice still causes one advance.
   */
  wake(sessionId: string, wake: Wake): Promise<void>;
  /**
   * Asks for a pod sandbox's reconcile, or sets one of its timers, once this transaction
   * commits (`DurableExecution.sandbox`): a row of the sandbox signal outbox, delivered as a
   * wake's is. A reconcile is delivered with the key `signal:<row id>`, so one delivered
   * twice runs once.
   */
  signalSandbox(sandboxId: string, signal: SandboxSignal): Promise<void>;
  /**
   * Outbox requests that are due, by the database's clock: written more than `graceMs` ago,
   * or whose delivery failed and whose retry time has come (`failOutbox`), and not parked.
   * Oldest first, a retried one by its retry time, so a request that keeps failing never
   * holds the head of the queue.
   */
  pendingOutbox(graceMs: number, limit: number): Promise<PendingRequest[]>;
  /** Deletes delivered outbox requests. */
  deleteOutbox(rows: readonly OutboxRef[]): Promise<void>;
  /**
   * Records a failed delivery of outbox request `row`: one more attempt, due again `retryInMs`
   * from now (the database's clock). With `park` it is never due again: it stays in the
   * outbox, with when it was parked, for an operator to send again or delete.
   */
  failOutbox(row: OutboxRef, retry: { retryInMs: number; park: boolean }): Promise<void>;

  // --- ownership (§10.6) ---------------------------------------------------

  /**
   * Locks the session and takes ownership when it has no owner or the owner's
   * lease ended at or before `now`; then increments `epoch` and sets the lease
   * to `now + leaseMs`. A live lease (including this owner's own) is `busy`.
   */
  takeOwnership(
    sessionId: string,
    claim: { owner: string; now: Date; leaseMs: number },
  ): Promise<TakeOwnership>;

  /** Extends the lease when `owner` and `epoch` still match. Returns false when ownership was lost. */
  renewOwnership(
    sessionId: string,
    owner: string,
    epoch: number,
    until: Date,
  ): Promise<boolean>;

  /** Clears the owner (keeping the epoch) when `owner` and `epoch` still match. */
  releaseOwnership(
    sessionId: string,
    owner: string,
    epoch: number,
  ): Promise<boolean>;

  /**
   * Locks the session and throws `OwnershipLostError` (`ownership.lost`) when
   * its epoch is not `epoch` or the session is gone. Every transaction of an
   * advance calls this first; see `ownedTx` in `store/ownership.ts`.
   */
  assertEpoch<T extends SessionDoc = SessionDoc>(
    sessionId: string,
    epoch: number,
  ): Promise<StoredSession<T>>;

  /**
   * What a run token's live check reads of a session (F5 gate trust): its lease epoch, status
   * and active turn, without the body. Undefined when the session is gone. Does not lock.
   */
  runState(sessionId: string): Promise<SessionRunState | undefined>;

  // --- typed queries (ordered by id unless stated) -------------------------

  sessionsWithStatus<T extends SessionDoc = SessionDoc>(
    statuses: readonly (SessionStatus | (string & {}))[],
  ): Promise<StoredSession<T>[]>;
  /**
   * Sessions `running` or `runnable` with no owner or an owner whose lease
   * ended at or before `now`, by id, the first `limit` after `after` (a page:
   * pass the last id of the previous one). The sweep re-wakes these.
   */
  orphanedSessions<T extends SessionDoc = SessionDoc>(
    now: Date,
    limit: number,
    after?: string,
  ): Promise<StoredSession<T>[]>;
  /** Sessions, optionally of one agent and one owner (`ownerUserId`), by id. */
  listSessions<T extends SessionDoc = SessionDoc>(filter?: {
    agentId?: string;
    ownerUserId?: string;
  }): Promise<StoredSession<T>[]>;
  listDefinitions<T extends DefinitionDoc = DefinitionDoc>(): Promise<T[]>;
  listSandboxes<T extends SandboxDoc = SandboxDoc>(): Promise<T[]>;

  // --- Environments (D55, protocol 11) ---------------------------------------

  /** Environment `id`; with `lock`, its row is locked until the transaction ends. */
  environment(id: string, options?: { lock?: boolean }): Promise<Environment | undefined>;
  /**
   * Creates the Environment unless one with its id exists, while the Tenant holds fewer than
   * `limit`: `exists` and `limit` write nothing. Serialized with every other create.
   */
  createEnvironment(row: Environment, limit: number): Promise<"created" | "exists" | "limit">;
  /**
   * Changes an Environment's columns other than its pod's (the caller holds the row's lock):
   * labels, recipe and version, the applied recipe and its version, the owner guard (`null`
   * clears it), and when it was last used.
   */
  updateEnvironment(
    id: string,
    patch: {
      labels?: Record<string, string>;
      recipe?: EnvironmentRecipe;
      version?: number;
      applied?: EnvironmentRecipe;
      appliedVersion?: number;
      ownerUserId?: string | null;
      lastUsedAt?: string;
      diskOp?: DiskOperation | null;
      diskSeed?: DiskSeed | null;
    },
    updatedAt: string,
  ): Promise<void>;
  /** Changes a pod Environment's lifecycle columns (the caller holds the row's lock). */
  updateEnvironmentPod(id: string, patch: SandboxPodPatch, updatedAt: string): Promise<void>;
  /** Deletes the Environment; its vault and credentials go with it (foreign key). */
  deleteEnvironment(id: string): Promise<void>;
  /** Environments by id, those with every label in `labels` when it is given. */
  listEnvironments(filter?: { labels?: Record<string, string> }): Promise<Environment[]>;
  /** Sessions that name Environment `environmentId` (`Session.environmentId`), by id. */
  sessionsOnEnvironment<T extends SessionDoc = SessionDoc>(
    environmentId: string,
  ): Promise<StoredSession<T>[]>;
  /**
   * Appends an event to the Environment's lifecycle stream through the record module. The
   * caller holds the Environment row's lock (or created the row in this transaction).
   */
  environmentEvent<T extends EnvironmentEventType>(
    environmentId: string,
    type: T,
    payload: EnvironmentEventPayload<T>,
  ): Promise<EnvironmentEvent>;
  /**
   * The Environment's stream, from `fromSeq` on, at most `limit` events: only `types` when given,
   * and only events recorded at or after `since` and before `until` (ISO times) when given.
   */
  environmentEvents(
    environmentId: string,
    options?: EnvironmentEventsQuery,
  ): Promise<EnvironmentEvent[]>;

  // --- Environment manifests (D63, protocol 14) --------------------------------

  /** Holds manifest `name`'s save lock until the transaction ends, so saves of one name are serial. */
  lockEnvironmentManifest(name: string): Promise<void>;
  /** Version `version` of manifest `name`, or its latest when `version` is omitted. */
  environmentManifest(name: string, version?: number): Promise<EnvironmentManifestRow | undefined>;
  /** Writes a new version (the caller holds the name's lock and chose the next number). */
  insertEnvironmentManifest(row: EnvironmentManifestRow): Promise<void>;
  /** Each manifest's latest version, by name. */
  listEnvironmentManifests(): Promise<EnvironmentManifestRow[]>;
  /** Every version of manifest `name`, newest first. */
  environmentManifestVersions(name: string): Promise<EnvironmentManifestRow[]>;
  /** Deletes every version of manifest `name`; how many there were. */
  deleteEnvironmentManifest(name: string): Promise<number>;
  /** How many Environments were made from each version of manifest `name` (deleting ones too). */
  environmentsOfManifest(name: string): Promise<Map<number, number>>;

  /** `invoking` effects of one session; takeover turns them `uncertain`. */
  invokingEffects<T extends EffectDoc = EffectDoc>(
    sessionId: string,
  ): Promise<T[]>;
  effectsForSession<T extends EffectDoc = EffectDoc>(
    sessionId: string,
    filter?: SessionEffectFilter,
  ): Promise<T[]>;
  effectsForTurn<T extends EffectDoc = EffectDoc>(
    sessionId: string,
    turnId: string,
    statuses?: readonly (EffectStatus | (string & {}))[],
  ): Promise<T[]>;
  effectsWithStatus<T extends EffectDoc = EffectDoc>(
    statuses: readonly (EffectStatus | (string & {}))[],
    filter?: { kinds?: readonly EffectKind[] },
  ): Promise<T[]>;

  /** Links of one workflow session joined to their existing agent sessions, ordered by agent session id. */
  linkedSessions<S extends SessionDoc = SessionDoc>(
    workflowSessionId: string,
  ): Promise<LinkedSession<S>[]>;

  counts(): Promise<StoreCounts>;

  // --- control bus (D21) ---------------------------------------------------

  /**
   * Puts `signal` on the control bus: a row, and a notification Postgres sends every
   * following process when this transaction commits (and never on rollback).
   */
  signal(signal: ControlSignal): Promise<void>;
  /** Deletes signals written before `before`. Returns how many. */
  pruneSignals(before: Date): Promise<number>;

  // --- basin generations (Durable Streams §8.1) ----------------------------

  basinGenerations(): Promise<BasinGenerations>;
  /** Forgets a retired generation once its basin is deleted. */
  forgetRetiredGeneration(generation: number): Promise<void>;

  // --- principals ----------------------------------------------------------

  /** Rejects when the id or token hash already exists. */
  insertPrincipal(row: PrincipalRow): Promise<void>;
  principalByTokenHash(tokenHash: string): Promise<PrincipalRow | undefined>;
  principalById(id: string): Promise<PrincipalRow | undefined>;
  /** Every principal, ordered by id. */
  listPrincipals(): Promise<PrincipalRow[]>;
  /**
   * Creates principal `id` with `tokenHash` and `role` (default `application`), or gives an
   * existing one this hash (and `createdAt`): its previous key stops authenticating. Rejects
   * when another principal holds the hash, and with `PrincipalRoleConflict` when `id` holds
   * another role.
   */
  putPrincipal(
    id: string,
    tokenHash: string,
    createdAt: string,
    role?: KeyRole,
  ): Promise<PrincipalRow>;
  /** Deletes principal `id`; false when there was none. */
  deletePrincipal(id: string): Promise<boolean>;

  // --- vault ---------------------------------------------------------------

  /** Rejects on a duplicate id, or a second vault for one Environment. */
  insertVault(row: VaultRow): Promise<void>;
  getVault(id: string): Promise<VaultRow | undefined>;
  /** The vault of Environment `environmentId` (D56). */
  vaultOfEnvironment(environmentId: string): Promise<VaultRow | undefined>;
  updateVaultMetadata(id: string, metadataJson: string | null): Promise<void>;
  /** Deletes the vault and its credentials. */
  deleteVault(id: string): Promise<void>;

  /** Rejects on a duplicate id or an unknown vault. */
  insertCredential(row: VaultCredentialRow): Promise<void>;
  /** Looks a credential up by id alone; callers compare `vaultId`. */
  getCredential(id: string): Promise<VaultCredentialRow | undefined>;
  /** The credential named `name` in vault `vaultId` (names are unique per vault). */
  credentialByName(vaultId: string, name: string): Promise<VaultCredentialRow | undefined>;
  /** Credentials of one vault, ordered by `createdAt`, then id. */
  credentialsForVault(
    vaultId: string,
    filter?: { type?: VaultCredentialRow["type"] },
  ): Promise<VaultCredentialRow[]>;
  /** Updates a credential of `vaultId`. Returns false when it does not exist. */
  updateCredential(
    vaultId: string,
    id: string,
    patch: VaultCredentialPatch,
  ): Promise<boolean>;
  /** Returns false when it does not exist. */
  deleteCredential(vaultId: string, id: string): Promise<boolean>;
  countCredentials(): Promise<number>;

  insertVaultAudit(row: VaultAuditRow): Promise<void>;
  /** Audit rows, oldest first. */
  vaultAudit(filter?: {
    vaultId?: string;
    limit?: number;
  }): Promise<VaultAuditRow[]>;

  getVaultIdempotency(id: string): Promise<VaultIdempotencyRow | undefined>;
  /** Rejects when the id exists. */
  insertVaultIdempotency(row: VaultIdempotencyRow): Promise<void>;

  // --- signing keys --------------------------------------------------------

  /**
   * Serializes signing key changes: held until the transaction ends. Take it before reading
   * the keys a change depends on, so concurrent first uses or rotations do not collide.
   */
  lockSigningKeys(): Promise<void>;
  /** Rejects on a duplicate id, or a second key in `standby`, `current` or `previous`. */
  insertSigningKey(row: SigningKeyRow): Promise<void>;
  signingKey(id: string): Promise<SigningKeyRow | undefined>;
  /** Keys in the given states (all when omitted), ordered by `createdAt`, then id. */
  signingKeys(
    states?: readonly SigningKeyRow["state"][],
  ): Promise<SigningKeyRow[]>;
  /**
   * Moves a key from `from` to `to` and stamps the matching time (`activatedAt` for
   * `current`, `retiredAt` for `previous`, `revokedAt` for `revoked`). Returns false when the
   * key is not in `from`.
   */
  setSigningKeyState(
    id: string,
    from: SigningKeyRow["state"],
    to: SigningKeyRow["state"],
    at: string,
  ): Promise<boolean>;
  countSigningKeys(): Promise<number>;
  // --- model usage ---------------------------------------------------------

  /** Appends a row, setting `duplicate` when one with the same `effectKey` exists; returns it. */
  recordModelUsage(row: ModelUsageWrite): Promise<ModelUsageRow>;
  /**
   * The first row the gate recorded for the model call `effectKey` (R7.1), never a `duplicate`;
   * undefined when no gate metered it.
   */
  modelUsageOf(effectKey: string): Promise<ModelUsageRow | undefined>;
  modelUsageTotals(query: ModelUsageQuery): Promise<ModelUsageTotals>;
  /** Every budget, ordered by scope, then scope id. */
  listModelBudgets(): Promise<ModelBudgetRow[]>;
  /** Replaces every budget with `rows`. */
  putModelBudgets(rows: readonly ModelBudgetRow[]): Promise<void>;

  // --- tool crossings (F4.1) ------------------------------------------------

  toolCrossing(key: string): Promise<ToolCrossingRow | undefined>;
  /** Inserts the running call's row; false when a row with `key` already exists. */
  startToolCrossing(row: Pick<ToolCrossingRow, "key" | "hash" | "startedAt">): Promise<boolean>;
  /**
   * Starts a lost call's row again (R5.3): `startedAt` moves on, on a row with no answer and
   * `hash`. False when the row is gone, settled, or another request's.
   */
  restartToolCrossing(row: Pick<ToolCrossingRow, "key" | "hash" | "startedAt">): Promise<boolean>;
  /** Records the call's answer. */
  settleToolCrossing(key: string, answer: unknown, settledAt: string): Promise<void>;
  /** Deletes rows that settled before `before`; returns how many. */
  pruneToolCrossings(before: string): Promise<number>;

  // --- file artifacts (blueprint D35, F8.1) ----------------------------------

  /** The artifact `id`; with `lock`, its row is locked until the transaction ends. */
  artifact(id: string, options?: { lock?: boolean }): Promise<ArtifactRow | undefined>;
  /** The folder artifact that holds Environment `environmentId`'s disk versions (R2d step 3). */
  diskArtifact(environmentId: string, options?: { lock?: boolean }): Promise<ArtifactRow | undefined>;
  /** Artifacts by creation time, then id: those of one session when `sessionId` is given. */
  listArtifacts(filter?: { sessionId?: string }): Promise<ArtifactRow[]>;
  /** Writes a new artifact with its first version. Rejects on a duplicate id. */
  insertArtifact(row: ArtifactRow, version: ArtifactVersionRow): Promise<void>;
  /**
   * Adds the next version of a locked artifact and makes it the latest (its content type and
   * `updatedAt` follow the version).
   */
  insertArtifactVersion(version: ArtifactVersionRow): Promise<void>;
  /** One version, or every version oldest first. */
  artifactVersion(artifactId: string, version: number): Promise<ArtifactVersionRow | undefined>;
  artifactVersions(artifactId: string): Promise<ArtifactVersionRow[]>;
  /** The version a harness write with this key stored (`artifact_versions.write_key`), if any. */
  artifactVersionByWriteKey(writeKey: string): Promise<ArtifactVersionRow | undefined>;
  /** Deletes the artifact and its versions; returns the versions' blob keys (empty when none). */
  deleteArtifact(id: string): Promise<string[]>;
  /**
   * Deletes one version of a locked artifact (its content rows go with it) and returns its blob
   * key; the latest version becomes the newest one left. The artifact itself stays, even empty.
   */
  deleteArtifactVersion(artifactId: string, version: number): Promise<string | undefined>;
  /**
   * Serializes the Tenant's artifact writes: held until the transaction ends. Take it before
   * reading the total a new version must fit under.
   */
  lockArtifactQuota(): Promise<void>;
  /**
   * The bytes the artifacts store: every file version, plus each distinct content-addressed file
   * of the folders once (F8.2). With `environmentId`, only that Environment's artifacts: its disk
   * versions and its sessions' artifacts.
   */
  artifactBytes(scope?: { environmentId: string }): Promise<number>;
  /**
   * The blob keys of every artifact version (a folder's: its manifests): of session artifacts
   * only, or of all of them.
   */
  artifactBlobKeys(scope: "sessions" | "all"): Promise<string[]>;
  /** Records the distinct content-addressed files a folder version references (F8.2). */
  insertArtifactContent(
    artifactId: string,
    version: number,
    files: readonly { sha256: string; size: number }[],
  ): Promise<void>;
  /**
   * Those of `shas` some committed folder version references; with `environmentId`, a version
   * of one of that Environment's artifacts.
   */
  referencedArtifactContent(shas: readonly string[], scope?: { environmentId: string }): Promise<Set<string>>;
  /**
   * The distinct content-addressed files folder versions reference: of one artifact, of session
   * artifacts only, or of all of them.
   */
  artifactContentShas(scope: "sessions" | "all" | { artifactId: string }): Promise<string[]>;

  // --- definition files (track R2 M4) ---------------------------------------

  /** The definition file `sha256` (`sha256:<hex>`) names, once its bytes are stored. */
  definitionFile(sha256: string): Promise<DefinitionFileRow | undefined>;
  /** Records a stored definition file; false when the Tenant held it already. */
  insertDefinitionFile(row: DefinitionFileRow): Promise<boolean>;
  /** Those of `shas` the Tenant holds, with each one's size in bytes. */
  heldDefinitionFiles(shas: readonly string[]): Promise<Map<string, number>>;
  /** Records that version `manifestHash` of definition `agentId` names each of `shas`. */
  insertDefinitionFileUses(agentId: string, manifestHash: string, shas: readonly string[]): Promise<void>;

  // --- tenant settings (non-secret) -----------------------------------------

  getSetting(key: string): Promise<string | undefined>;
  putSetting(key: string, value: string): Promise<void>;

  // --- reset ---------------------------------------------------------------

  /**
   * Deletes Tenant state by scope, in this transaction:
   * - `sessions`: sessions, commands, effects, links, the artifacts of sessions (their blobs are the caller's to delete) and the
   *   Tenant's record rows and log heads. The Tenant moves to the next basin
   *   generation and the current one is retired, so session ids it frees start again in an
   *   empty basin;
   * - `environments`: sandbox records, Environments with their vaults, and their lifecycle
   *   streams;
   * - `all`: both, plus definitions (and which definition files they use),
   *   the model usage ledger, the model budgets and Tenant-wide artifacts. The host vault, principals, signing keys,
   *   settings, audit and vault idempotency rows stay.
   */
  reset(scope: ResetScope): Promise<void>;
}

/** Which of an Environment's events to read (`Tx.environmentEvents`). */
export interface EnvironmentEventsQuery {
  readonly fromSeq?: number;
  readonly limit?: number;
  readonly types?: readonly string[];
  readonly since?: string;
  readonly until?: string;
}
