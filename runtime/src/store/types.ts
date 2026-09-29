/**
 * The Session Store seam (architecture §12.2).
 *
 * The Session Store records what happened. It is async, transactional and
 * tenant-scoped: one `SessionStore` per Tenant. Postgres is the supported
 * implementation; `store/memory.ts` is the in-memory fake for unit tests.
 *
 * ## Invariants every implementation keeps
 *
 * 1. **One transaction per `tx` call, READ COMMITTED or stronger.** Nothing a
 *    transaction wrote is visible to others before it commits, and nothing is
 *    kept when `fn` throws: document writes, event sequences, outbox rows,
 *    `afterCommit` callbacks and `signalWork` are all discarded, and `tx`
 *    rejects with the error `fn` threw.
 * 2. **Session-scoped writes lock the session row first.** `lockSession` takes
 *    a row lock (`SELECT … FOR UPDATE`) held until the transaction ends. Effect
 *    intent and outcome, Action transitions, checkpoint settlement and event
 *    writes for one session are serialized through it. Idempotency comparisons
 *    (`canonical(...)`) run inside the same locked transaction. `event` and the
 *    ownership methods take the lock themselves.
 * 3. **Per-session event sequence.** `event` allocates the session's next
 *    sequence under the session lock, starting at 0, without gaps across
 *    committed transactions. The sequence is also the S2 sequence number of the
 *    event in the session's stream (`sessions/<id>/<incarnation>`,
 *    `streams/types.ts`), and the cursor is `base64url("<sessionId>:<seq>")`
 *    (see `store/cursor.ts`).
 * 4. **No external I/O inside `fn`.** No model, tool, MCP, sandbox, Restate or
 *    S2 call, and no `fetch`, runs inside a transaction. Wakes go through
 *    `afterCommit`, executor notifications through `signalWork`, and events are
 *    delivered to commit listeners after commit (seam rule 1 and 2).
 * 5. **No nested transactions.** Calling `store.tx` from inside `fn` rejects.
 *    A `Tx` must not be used after its `tx` call settles.
 * 6. **Post-commit order.** After a commit, the store first calls every commit
 *    listener once with the transaction's events (in allocation order) and its
 *    `signalWork` flag, then runs the `afterCommit` callbacks in registration
 *    order and awaits them. Listener and callback failures are reported to the
 *    store's error hook; they never reject `tx`, because the commit stands.
 *    Recovery from a lost post-commit step is the Tenant sweep's job.
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
 * method on `Tx` (`sessionsWithStatus`, `expiredClaims`, `pendingActions`,
 * `effectsForTurn`, `linkedSessions`, `counts`, …) that an implementation can
 * back with an index, and principals, executors, vaults and Tenant settings
 * have their own methods rather than raw SQL outside the store. Session history
 * is not read from the store: the relay moves events from the outbox to
 * Durable Streams, and history and SSE read them there (`tenant/streams.ts`).
 */
import type { Action, LiveEvent } from "@nylorun/core/contracts";
import type { HostEffect } from "@nylorun/harness/run";

// ---------------------------------------------------------------------------
// Documents

/** Tables holding JSON documents keyed by `id`. */
export type DocTable =
  | "definitions"
  | "sessions"
  | "commands"
  | "checkpoints"
  | "effects"
  | "actions"
  | "sandboxes"
  | "links";

export const DOC_TABLES: readonly DocTable[] = [
  "definitions",
  "sessions",
  "commands",
  "checkpoints",
  "effects",
  "actions",
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
  | "completed"
  | "uncertain"
  | "queued"
  | "cancelled";

export type ActionStatus = Action["status"];
export type ActionKind = Action["kind"];
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
  /**
   * Names the session's event stream (`sessions/<id>/<incarnation>`, `streams/types.ts`).
   * Set when the session is created; `event` reports it with each event (`Commit`).
   */
  streamIncarnation?: string;
}

/** The fields of an effect document the store indexes (`request.sessionId`, `request.turnId`, `request.kind`, `status`). */
export interface EffectDoc {
  request: HostEffect;
  status: EffectStatus | (string & {});
}

/** Actions are stored as the wire `Action`. Indexed: `sessionId`, `turnId`, `agentId`, `status`, `kind`, `leaseExpiresAt`. */
export type ActionDoc = Action;

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
// Events and outbox

/** One committed-but-not-yet-relayed event (§12.4). Deleted once S2 has it. */
export interface OutboxRow {
  sessionId: string;
  seq: number;
  event: LiveEvent;
}

export interface OutboxStats {
  /** Unrelayed events. */
  depth: number;
  /** ISO `createdAt` of the oldest unrelayed event, or null when the outbox is empty. */
  oldestCreatedAt: string | null;
}

/** What one commit produced, delivered to commit listeners after commit. */
export interface Commit {
  /** Events written by the transaction, in allocation order. */
  readonly events: readonly LiveEvent[];
  /**
   * The `streamIncarnation` of each event's session when the event was allocated (under the
   * session lock), aligned with `events`; null for a session without one. The relay appends
   * each event to that incarnation's stream.
   */
  readonly incarnations: readonly (string | null)[];
  /** True when the transaction called `signalWork()`. */
  readonly workAvailable: boolean;
}

export type CommitListener = (commit: Commit) => void;

// ---------------------------------------------------------------------------
// Typed tables

/** Executors carry a bearer secret hash, so they use typed columns with a unique token hash. */
export interface ExecutorRow {
  agentId: string;
  tokenHash: string;
  implementationVersion: string;
  manifestHash?: string;
  principalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrincipalRow {
  id: string;
  role: "application" | (string & {});
  tokenHash: string;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface VaultRow {
  id: string;
  name: string;
  ownerUserId: string;
  /** JSON text, or null. */
  metadataJson: string | null;
  createdAt: string;
  scope: "user" | "host";
}

/** Envelope-encrypted secret material. Always in columns, never inside a JSON body. */
export interface SealedSecret {
  kekId: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  wrappedDek: Uint8Array;
}

/** A Tenant signing key (subject tokens). The private key is sealed; the public JWK is not. */
export interface SigningKeyRow extends SealedSecret {
  id: string;
  state: "standby" | "current" | "previous" | "revoked";
  alg: "ES256";
  /** JSON text of the public JWK. */
  publicJwk: string;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  revokedAt: string | null;
}

/** A subject's turn bucket (subject limits): tokens left and when they were last refilled. */
export interface SubjectUsageRow {
  subject: string;
  turnTokens: number;
  refilledAt: string;
}

export interface VaultCredentialRow extends SealedSecret {
  id: string;
  vaultId: string;
  name: string;
  type: "bearer" | "oauth" | "model";
  /** JSON text of the non-secret binding (url, or provider and model). */
  bindingJson: string;
  expiresAt: string | null;
  createdAt: string;
  rotatedAt: string | null;
}

/** Fields `updateCredential` may change. */
export type VaultCredentialPatch = Partial<
  Omit<VaultCredentialRow, "id" | "vaultId" | "createdAt">
>;

export interface VaultAuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  vaultId: string | null;
  credentialId: string | null;
  sessionId: string | null;
  target: string | null;
  outcome: string;
}

export interface VaultIdempotencyRow {
  id: string;
  bodyHash: string;
  /** JSON text of the original response. */
  response: string;
}

// ---------------------------------------------------------------------------
// Queries

export interface SessionEffectFilter {
  /** Only this turn. Absent means every turn. */
  turnId?: string;
  statuses?: readonly (EffectStatus | (string & {}))[];
}

export interface SessionActionFilter {
  /** Only this turn. Absent means every turn. */
  turnId?: string;
  statuses?: readonly ActionStatus[];
}

/** Counts used by Tenant status, `summary` and `drain`. */
export interface StoreCounts {
  sessions: number;
  /** Sessions `running` or `runnable`. */
  runningSessions: number;
  /** Actions `pending` or `claimed`. */
  pendingActions: number;
  /** Effects `uncertain`. */
  uncertainEffects: number;
  sandboxes: number;
  definitions: number;
}

export type ResetScope = "sessions" | "sandboxes" | "all";

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
   * events or signalled work. Returns an unsubscribe function. The outbox
   * relay (`streams/relay.ts`) subscribes here.
   */
  onCommit(listener: CommitListener): () => void;
  /** Reachability and schema check for Tenant status and `/ready`. Never throws. */
  health(): Promise<StoreHealth>;
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
  /** Clock for event `createdAt`. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Receives listener and `afterCommit` failures, which never reject `tx`. */
  onError?: (error: unknown) => void;
}

/** The transaction handle. Valid only inside its `tx` callback. */
export interface Tx {
  // --- documents -----------------------------------------------------------

  get<T = any>(table: DocTable, id: string): Promise<T | undefined>;
  /** Insert or replace. For `sessions`, ownership fields in `body` are ignored. */
  put(table: DocTable, id: string, body: unknown): Promise<void>;
  /**
   * Deletes a document. Deleting a session also deletes its outbox rows, so a
   * session created again with the same id starts at sequence 0 without
   * colliding with rows the relay never took (its stream is a new incarnation).
   */
  delete(table: DocTable, id: string): Promise<void>;

  // --- ordering ------------------------------------------------------------

  /**
   * Locks the session row for the rest of the transaction and returns the
   * session (with ownership fields), or undefined when it does not exist.
   * Locking twice in one transaction is a no-op.
   *
   * Lock order, so concurrent transactions cannot deadlock (Postgres takes row
   * locks in statement order; the in-memory fake serializes whole transactions):
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
   * writes the event to the outbox and buffers it for commit listeners.
   * Rejects when the session does not exist. The returned cursor is final.
   */
  event(
    sessionId: string,
    turnId: string | null,
    type: string,
    payload: unknown,
  ): Promise<LiveEvent>;

  /** Runs `fn` after a successful commit (never on rollback). Used for wakes. */
  afterCommit(fn: () => void | Promise<void>): void;

  /** Signals `work_available` to executors after a successful commit. */
  signalWork(): void;

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

  // --- typed queries (ordered by id unless stated) -------------------------

  sessionsWithStatus<T extends SessionDoc = SessionDoc>(
    statuses: readonly (SessionStatus | (string & {}))[],
  ): Promise<StoredSession<T>[]>;
  /**
   * Sessions `running` or `runnable` with no owner or an owner whose lease
   * ended at or before `now`, oldest lease first. The sweep re-wakes these.
   */
  orphanedSessions<T extends SessionDoc = SessionDoc>(
    now: Date,
    limit: number,
  ): Promise<StoredSession<T>[]>;
  /** Sessions, optionally of one agent and one owner (`ownerUserId`), by id. */
  listSessions<T extends SessionDoc = SessionDoc>(filter?: {
    agentId?: string;
    ownerUserId?: string;
  }): Promise<StoredSession<T>[]>;
  listDefinitions<T extends DefinitionDoc = DefinitionDoc>(): Promise<T[]>;
  listSandboxes<T extends SandboxDoc = SandboxDoc>(): Promise<T[]>;

  /** Claimed actions whose lease ended at or before `now`, earliest lease first. */
  expiredClaims(now: Date, limit: number): Promise<ActionDoc[]>;
  /** `pending` actions offered to one agent's executor. */
  pendingActions(agentId: string): Promise<ActionDoc[]>;
  actionsForSession(
    sessionId: string,
    filter?: SessionActionFilter,
  ): Promise<ActionDoc[]>;
  actionsWithStatus(
    statuses: readonly ActionStatus[],
    filter?: { kinds?: readonly ActionKind[] },
  ): Promise<ActionDoc[]>;

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

  // --- outbox (§12.4) ------------------------------------------------------

  /** Unrelayed events, ordered by session id then sequence. */
  outbox(limit: number, filter?: { sessionId?: string }): Promise<OutboxRow[]>;
  /**
   * Deletes a session's outbox rows with `seq <= throughSeq`. Returns the number deleted.
   * With `incarnation`, deletes only while the session exists with that `streamIncarnation`
   * (null: none), in one statement: a relay that appended to an abandoned incarnation's
   * stream never deletes the rows of a session created again with the same id.
   */
  deleteOutbox(
    sessionId: string,
    throughSeq: number,
    incarnation?: string | null,
  ): Promise<number>;
  /** How many events are unrelayed, and the `createdAt` of the oldest (Tenant status). */
  outboxStats(): Promise<OutboxStats>;

  // --- executors -----------------------------------------------------------

  listExecutors(): Promise<ExecutorRow[]>;
  getExecutor(agentId: string): Promise<ExecutorRow | undefined>;
  /**
   * Inserts or updates by `agentId`, keeping `createdAt` on update. Rejects
   * when another agent already uses `tokenHash`.
   */
  putExecutor(row: Omit<ExecutorRow, "createdAt">): Promise<void>;
  deleteExecutor(agentId: string): Promise<void>;

  // --- principals ----------------------------------------------------------

  /** Rejects when the id or token hash already exists. */
  insertPrincipal(row: PrincipalRow): Promise<void>;
  principalByTokenHash(tokenHash: string): Promise<PrincipalRow | undefined>;
  principalById(id: string): Promise<PrincipalRow | undefined>;
  applicationTokenHashes(): Promise<string[]>;

  // --- vault ---------------------------------------------------------------

  /** Rejects on a duplicate id, or a second `host` vault. */
  insertVault(row: VaultRow): Promise<void>;
  getVault(id: string): Promise<VaultRow | undefined>;
  /** User vaults of one owner, ordered by `createdAt`, then id. */
  vaultsByOwner(ownerUserId: string): Promise<VaultRow[]>;
  updateVaultMetadata(id: string, metadataJson: string | null): Promise<void>;
  /** Deletes the vault and its credentials. */
  deleteVault(id: string): Promise<void>;

  /** Rejects on a duplicate id or an unknown vault. */
  insertCredential(row: VaultCredentialRow): Promise<void>;
  /** Looks a credential up by id alone (attachment checks); callers compare `vaultId`. */
  getCredential(id: string): Promise<VaultCredentialRow | undefined>;
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

  // --- subject tokens ------------------------------------------------------

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
  /** The subject's revocation epoch; 0 when it was never revoked. */
  subjectEpoch(subject: string): Promise<number>;
  /** The epochs of several subjects; subjects never revoked are absent. */
  subjectEpochs(subjects: readonly string[]): Promise<Map<string, number>>;
  /** Adds one to the subject's epoch and returns the new value. */
  bumpSubjectEpoch(subject: string, at: string): Promise<number>;
  /**
   * The subject's turn bucket, created from `initial` when missing, locked until the
   * transaction ends so concurrent commands of one subject serialize.
   */
  lockSubjectUsage(initial: SubjectUsageRow): Promise<SubjectUsageRow>;
  putSubjectUsage(row: SubjectUsageRow): Promise<void>;
  /** How many sessions of `ownerUserId` are in one of `statuses`. */
  countOwnerSessions(
    ownerUserId: string,
    statuses: readonly string[],
  ): Promise<number>;

  // --- tenant settings (non-secret) -----------------------------------------

  getSetting(key: string): Promise<string | undefined>;
  putSetting(key: string, value: string): Promise<void>;

  // --- reset ---------------------------------------------------------------

  /**
   * Deletes Tenant state by scope, in this transaction:
   * - `sessions`: sessions, commands, checkpoints, effects, actions, links, the outbox and
   *   subject turn buckets;
   * - `sandboxes`: sandbox records;
   * - `all`: both, plus definitions, executors and user vaults with their
   *   credentials. The host vault, principals, signing keys, subject epochs, settings,
   *   audit and vault idempotency rows stay.
   */
  reset(scope: ResetScope): Promise<void>;
}
