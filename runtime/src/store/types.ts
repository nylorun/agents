/**
 * The Session Store seam (architecture §12.2).
 *
 * The Session Store records what happened. It is async, transactional and
 * tenant-scoped: one `SessionStore` per Tenant. Postgres is the supported
 * implementation; `store/memory.ts` is the in-memory fake for unit tests, and
 * `store/sqlite.ts` bridges today's SQLite Tenants while the Runtime moves over.
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
 *    event in `sessions/<id>`, and the cursor is `base64url("<sessionId>:<seq>")`
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
 * ## `store.all(...)` replacements
 *
 * Every full-table scan in the Runtime today maps to a typed query:
 *
 * | Call site (today) | What it scans for | Replacement |
 * | --- | --- | --- |
 * | `tenant/runtime.ts:535` startup recovery | `effects` with status `invoking` | `effectsWithStatus(["invoking"])`; after Wave 2, `invokingEffects(sessionId)` during takeover |
 * | `tenant/runtime.ts:568` reschedule on open | `sessions` running or runnable | `sessionsWithStatus(["running","runnable"])`; with Restate, `orphanedSessions(now, limit)` in the sweep |
 * | `tenant/runtime.ts:619` `retireLegacyHooks` | legacy hook `actions` | removed in Wave 0a |
 * | `tenant/runtime.ts:632` `retireLegacyHooks` | `sessions` with an active v3 turn | removed in Wave 0a |
 * | `tenant/runtime.ts:655` `expireClaims` | `actions` claimed past their lease | `expiredClaims(now, limit)` |
 * | `tenant/runtime.ts:1641` cancel (agent) | `actions` of the session and turn, pending or claimed | `actionsForSession(id, { turnId, statuses: ["pending","claimed"] })` |
 * | `tenant/runtime.ts:1655` cancel | `effects` of the session and turn, invoking | `effectsForTurn(id, turnId, ["invoking"])` |
 * | `tenant/runtime.ts:1923` `GET /v1/actions` | pending `actions` of one agent | `pendingActions(agentId)` |
 * | `tenant/runtime.ts:2158` `GET /v1/agents` | all `definitions` | `listDefinitions()` |
 * | `tenant/runtime.ts:2168` `GET /v1/sessions` | all `sessions`, optional agent filter | `listSessions({ agentId })` |
 * | `tenant/runtime.ts:2389` session view | open `actions` of the session | `actionsForSession(id, { statuses: ["pending","claimed","uncertain"] })` |
 * | `tenant/runtime.ts:2396` session view | uncertain `effects` of the session | `effectsForSession(id, { statuses: ["uncertain"] })` |
 * | `tenant/runtime.ts:2662-2673` `summary` | counts over sessions, actions, effects | `counts()` |
 * | `tenant/runtime.ts:2690` `drain` (cancel) | `sessions` running, runnable or paused | `sessionsWithStatus(["running","runnable","paused"])` |
 * | `tenant/status.ts:35-43` | counts over sessions, actions, effects | `counts()` |
 * | `tenant/status.ts:57` | number of `sandboxes` | `counts().sandboxes` |
 * | `tenant/status.ts:61` | agent ids of `definitions` | `listDefinitions()` |
 * | `sandbox/manager.ts:96` startup | all `sandboxes` | `listSandboxes()` |
 * | `sandbox/manager.ts:119` `hasRecords` | any `sandboxes` | `counts().sandboxes > 0` |
 * | `core/flow-host.ts:223` `countActiveFlowWork` | `effects` of the workflow turn, then their actions | `effectsForTurn(wf, turnId)` + `actionsForSession(wf, { turnId, statuses: ["pending","claimed"] })` |
 * | `core/flow-host.ts:599` `reconcilePendingAgentEffects` | pending `agent` effects | `effectsWithStatus(["pending"], { kinds: ["agent"] })` |
 * | `core/flow-host.ts:666` `reofferOrphanedFnVerifyClaims` | claimed fn/verify `actions` | `actionsWithStatus(["claimed"], { kinds: ["fn","verify"] })` |
 * | `core/flow-host.ts:894` `planCancelCascade` | `sessions` joined to `links` of the workflow | `linkedSessions(wf)` |
 * | `core/flow-host.ts:903` `planCancelCascade` | `actions` of the workflow (turn) | `actionsForSession(wf, { turnId, statuses: ["pending","claimed"] })` |
 * | `core/flow-host.ts:964` `cancelSiblingWork` | linked agent sessions | `linkedSessions(wf)` |
 * | `core/flow-host.ts:975` `cancelSiblingWork` | `actions` of the workflow turn | `actionsForSession(wf, { turnId, statuses: ["pending","claimed"] })` |
 * | `core/flow-host.ts:1013` `fenceWorkflowActions` | `actions` of the workflow (turn) | `actionsForSession(wf, { turnId, statuses: ["pending","claimed"] })` |
 * | `core/flow-host.ts:1029` `fenceWorkflowActions` | queued `effects` of the workflow (turn) | `effectsForSession(wf, { turnId, statuses: ["queued"] })` |
 * | `core/flow-host.ts:1090` `aggregateWaits` | paused linked agent sessions | `linkedSessions(wf)` |
 * | `core/flow-host.ts:1113` `findInteractionOwner` | linked agent sessions | `linkedSessions(wf)` |
 * | `core/flow-host.ts:1165` `wakeForQueuedEffects` | queued `effects` of the workflow turn | `effectsForTurn(wf, turnId, ["queued"])` |
 * | `core/store.ts` `allExecutors` | `executors` | `listExecutors()` |
 * | `core/store.ts` `credentialCount` | `vault_credentials` | `countCredentials()` |
 * | `core/store.ts` `history` | `events` of a session | `DurableStreams.read(sessionStream(id))` (Wave 2 Y); SQLite keeps it until then |
 *
 * Raw SQL outside the store moves behind typed methods too: `tenant/principals.ts`
 * (principal methods), `tenant/status.ts` and `host/config-for.ts`
 * (`getSetting`/`putSetting`, `SessionStore.health`), `tenant/reset.ts`
 * (`reset(scope)`), and `vault/service.ts` (vault methods).
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

/** What one commit produced, delivered to commit listeners after commit. */
export interface Commit {
  /** Events written by the transaction, in allocation order. */
  readonly events: readonly LiveEvent[];
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
   * events or signalled work. Returns an unsubscribe function. The relay and,
   * until Wave 2, the in-process SSE publisher subscribe here.
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
  delete(table: DocTable, id: string): Promise<void>;

  // --- ordering ------------------------------------------------------------

  /**
   * Locks the session row for the rest of the transaction and returns the
   * session (with ownership fields), or undefined when it does not exist.
   * Locking twice in one transaction is a no-op.
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
  listSessions<T extends SessionDoc = SessionDoc>(filter?: {
    agentId?: string;
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
  /** Deletes a session's outbox rows with `seq <= throughSeq`. Returns the number deleted. */
  deleteOutbox(sessionId: string, throughSeq: number): Promise<number>;

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

  // --- tenant settings (non-secret) -----------------------------------------

  getSetting(key: string): Promise<string | undefined>;
  putSetting(key: string, value: string): Promise<void>;

  // --- reset ---------------------------------------------------------------

  /**
   * Deletes Tenant state by scope, in this transaction:
   * - `sessions`: sessions, commands, checkpoints, effects, actions, links and the outbox;
   * - `sandboxes`: sandbox records;
   * - `all`: both, plus definitions, executors and user vaults with their
   *   credentials. The host vault, principals, settings, audit and vault
   *   idempotency rows stay.
   */
  reset(scope: ResetScope): Promise<void>;
}
