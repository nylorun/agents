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
 *    and `afterCommit` callbacks are all discarded, and `tx` rejects with the
 *    error `fn` threw.
 * 2. **Session-scoped writes lock the session row first.** `lockSession` takes
 *    a row lock (`SELECT … FOR UPDATE`) held until the transaction ends. Effect
 *    intent and outcome, Action transitions, checkpoint settlement and event
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
 *    S2 call, and no `fetch`, runs inside a transaction. Wakes and deliveries go
 *    through `afterCommit`, and events are delivered to commit listeners after
 *    commit (seam rule 1 and 2).
 * 5. **No nested transactions.** Calling `store.tx` from inside `fn` rejects.
 *    A `Tx` must not be used after its `tx` call settles.
 * 6. **Post-commit order.** After a commit, the store first calls every commit
 *    listener once with the transaction's events (in allocation order), then runs the `afterCommit` callbacks in registration
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
 * method on `Tx` (`sessionsWithStatus`, `expiredDeliveries`, `pendingActions`,
 * `effectsForTurn`, `linkedSessions`, `counts`, …) that an implementation can
 * back with an index, and principals, endpoints, vaults and Tenant settings
 * have their own methods rather than raw SQL outside the store. Session history
 * is not read from the store: every event is written to the record (Postgres
 * `nylorun_streams.session_events`) in its transaction, the stream relay
 * (`streams/relay/`) feeds Durable Streams from it, and history and SSE read
 * them there (`tenant/session-streams.ts`).
 */
import type { RecordReader } from "../streams/relay/types.js";
import type {
  Action,
  EventPayload,
  EventType,
  LiveEvent,
  SandboxEvent,
  SandboxEventPayload,
  SandboxEventType,
  SandboxKind,
  SessionEventOf,
} from "@nylorun/core/contracts";
import type { SandboxManifest } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import type {
  ModelBudgetRow,
  ModelUsageRow,
  PrincipalRow,
  ToolCrossingRow,
  PublishableKeyRow,
  SigningKeyRow,
  SubjectUsageRow,
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
  | "actions"
  | "sandboxes"
  | "links";

export const DOC_TABLES: readonly DocTable[] = [
  "definitions",
  "sessions",
  "commands",
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

/** Actions are stored as the wire `Action`. Indexed: `sessionId`, `turnId`, `agentId`, `status`, `kind`, `deadlineAt`. */
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

/** A sandbox resource (`sandbox_resources`): what `PUT /v1/sandboxes/{id}` created. */
export interface SandboxResource {
  id: string;
  kind: SandboxKind;
  /** The spec resolved against the Tenant's limits when the sandbox was created. */
  spec: SandboxManifest;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
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
 * An Action endpoint: the URL the Runtime delivers one agent's Actions to, and what recent
 * deliveries and the last ping say about it.
 */
export interface EndpointRow {
  agentId: string;
  url: string;
  implementationVersion: string;
  manifestHash?: string;
  timeoutMs: number;
  maxConcurrent: number;
  /** Application principal that registered it, when known. */
  principalId?: string;
  lastDeliveryAt?: string;
  lastSuccessAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  consecutiveFailures: number;
  /** What the endpoint reported serving on the last ping. */
  servedImplementationVersion?: string;
  servedManifestHash?: string;
  createdAt: string;
  updatedAt: string;
}

/** The registration part of an endpoint, as `putEndpoint` writes it. */
export type EndpointRegistrationRow = Pick<
  EndpointRow,
  | "agentId"
  | "url"
  | "implementationVersion"
  | "manifestHash"
  | "timeoutMs"
  | "maxConcurrent"
  | "principalId"
  | "updatedAt"
>;

/** One observation about an endpoint (`recordEndpointHealth`). */
export type EndpointHealthUpdate =
  /** A delivery was answered. */
  | { kind: "success"; at: string }
  /** A delivery failed: not reached, refused, or lost. */
  | { kind: "failure"; at: string; code: string; message: string }
  /** A ping was answered with what the endpoint serves. */
  | { kind: "served"; implementationVersion: string; manifestHash?: string };

/**
 * The rows of the typed tables, inferred from the tables Drizzle defines
 * (`store/postgres/schema.ts`): a principal, a vault and its credentials (secrets sealed in
 * `bytea` columns, never inside a JSON body), the vault's audit and idempotency records, the
 * Tenant's signing keys, a subject's turn bucket, a publishable key, a model call in the usage
 * ledger and a model budget.
 */
export type {
  ModelBudgetRow,
  ModelUsageRow,
  ToolCrossingRow,
  PrincipalRow,
  PublishableKeyRow,
  SigningKeyRow,
  SubjectUsageRow,
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
  /** Actions `pending` or `delivering`. */
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
   * events. Returns an unsubscribe function. A Tenant without the Host's stream
   * relay relays its own commits from here (`tenant/streams.ts`).
   */
  onCommit(listener: CommitListener): () => void;
  /** Reads the record back, for the stream relay's refills and reconciliation. */
  record(): RecordReader;
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
  /** Clock for event `time`. Defaults to `() => new Date()`. */
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
  ): Promise<SessionEventOf<T>>;

  /** Runs `fn` after a successful commit (never on rollback). Used for wakes. */
  afterCommit(fn: () => void | Promise<void>): void;

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

  // --- sandbox resources (blueprint D39, F7.1) -------------------------------

  /** The sandbox resource `id`; with `lock`, its row is locked until the transaction ends. */
  sandboxResource(id: string, options?: { lock?: boolean }): Promise<SandboxResource | undefined>;
  /**
   * Creates the sandbox resource unless one with its id exists, while the Tenant holds fewer
   * than `limit`: `exists` and `limit` write nothing. Serialized with every other create.
   */
  createSandboxResource(
    row: SandboxResource,
    limit: number,
  ): Promise<"created" | "exists" | "limit">;
  updateSandboxLabels(id: string, labels: Record<string, string>, updatedAt: string): Promise<void>;
  deleteSandboxResource(id: string): Promise<void>;
  /** Sandbox resources by id, those with every label in `labels` when it is given. */
  listSandboxResources(filter?: { labels?: Record<string, string> }): Promise<SandboxResource[]>;
  /** Sessions attached to sandbox resource `sandboxId` (`Session.sandboxId`), by id. */
  sessionsOnSandbox<T extends SessionDoc = SessionDoc>(
    sandboxId: string,
  ): Promise<StoredSession<T>[]>;
  /**
   * Appends an event to the sandbox's lifecycle stream through the record module. The caller
   * holds the sandbox row's lock (or created the row in this transaction).
   */
  sandboxEvent<T extends SandboxEventType>(
    sandboxId: string,
    type: T,
    payload: SandboxEventPayload<T>,
  ): Promise<SandboxEvent>;
  /** The sandbox's lifecycle stream, from `fromSeq` on, at most `limit` events. */
  sandboxEvents(
    sandboxId: string,
    options?: { fromSeq?: number; limit?: number },
  ): Promise<SandboxEvent[]>;

  /** One agent's `pending` actions, delivered when its endpoint is registered. */
  pendingActions(agentId: string): Promise<ActionDoc[]>;
  /** How many of one agent's actions are `delivering` (Action endpoints). */
  deliveringCount(agentId: string): Promise<number>;
  /** `pending` actions of agents that have an Action endpoint, by id. */
  pendingActionsWithEndpoint(limit: number): Promise<ActionDoc[]>;
  /** `delivering` actions whose deadline is at or before `now`, earliest first. */
  expiredDeliveries(now: Date, limit: number): Promise<ActionDoc[]>;
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

  // --- basin generations (Durable Streams §8.1) ----------------------------

  basinGenerations(): Promise<BasinGenerations>;
  /** Forgets a retired generation once its basin is deleted. */
  forgetRetiredGeneration(generation: number): Promise<void>;

  // --- Action endpoints -----------------------------------------------------

  listEndpoints(): Promise<EndpointRow[]>;
  getEndpoint(agentId: string): Promise<EndpointRow | undefined>;
  /**
   * Inserts or updates by `agentId`, keeping `createdAt`. Health is kept, except that a new
   * `url` starts with none.
   */
  putEndpoint(row: EndpointRegistrationRow): Promise<void>;
  deleteEndpoint(agentId: string): Promise<void>;
  /** Records one observation. Nothing happens when the endpoint does not exist. */
  recordEndpointHealth(agentId: string, update: EndpointHealthUpdate): Promise<void>;

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

  // --- publishable keys ----------------------------------------------------

  /** Rejects on a duplicate id, key or name. */
  insertPublishableKey(row: PublishableKeyRow): Promise<void>;
  publishableKeyByKey(key: string): Promise<PublishableKeyRow | undefined>;
  publishableKey(id: string): Promise<PublishableKeyRow | undefined>;
  /** All keys, revoked ones included, ordered by `createdAt`, then id. */
  publishableKeys(): Promise<PublishableKeyRow[]>;
  /** Returns false when the key does not exist. */
  updatePublishableKey(
    id: string,
    patch: Partial<Pick<PublishableKeyRow, "originsJson" | "revokedAt">>,
  ): Promise<boolean>;

  // --- model usage ---------------------------------------------------------

  /** Appends a row, setting `duplicate` when one with the same `effectKey` exists; returns it. */
  recordModelUsage(row: Omit<ModelUsageRow, "duplicate">): Promise<ModelUsageRow>;
  modelUsageTotals(query: ModelUsageQuery): Promise<ModelUsageTotals>;
  /** Every budget, ordered by scope, then scope id. */
  listModelBudgets(): Promise<ModelBudgetRow[]>;
  /** Replaces every budget with `rows`. */
  putModelBudgets(rows: readonly ModelBudgetRow[]): Promise<void>;

  // --- tool crossings (F4.1) ------------------------------------------------

  toolCrossing(key: string): Promise<ToolCrossingRow | undefined>;
  /** Inserts the running call's row; false when a row with `key` already exists. */
  startToolCrossing(row: Pick<ToolCrossingRow, "key" | "hash" | "startedAt">): Promise<boolean>;
  /** Records the call's answer. */
  settleToolCrossing(key: string, answer: unknown, settledAt: string): Promise<void>;
  /** Deletes rows that settled before `before`; returns how many. */
  pruneToolCrossings(before: string): Promise<number>;

  // --- tenant settings (non-secret) -----------------------------------------

  getSetting(key: string): Promise<string | undefined>;
  putSetting(key: string, value: string): Promise<void>;

  // --- reset ---------------------------------------------------------------

  /**
   * Deletes Tenant state by scope, in this transaction:
   * - `sessions`: sessions, commands, effects, actions, links, subject turn
   *   buckets and the Tenant's record rows and log heads. The Tenant moves to the next basin
   *   generation and the current one is retired, so session ids it frees start again in an
   *   empty basin;
   * - `sandboxes`: sandbox records, sandbox resources and their lifecycle streams;
   * - `all`: both, plus definitions, Action endpoints, user vaults with their credentials,
   *   the model usage ledger and the model budgets. The host vault, principals, signing keys, subject epochs,
   *   publishable keys, settings, audit and vault idempotency rows stay.
   */
  reset(scope: ResetScope): Promise<void>;
}
