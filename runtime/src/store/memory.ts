import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  EventPayload,
  EventType,
  LiveEvent,
  SessionEventOf,
} from "@nylorun/core/contracts";
import { MemoryRecord } from "../streams/relay/memory.js";
import type { RecordRow } from "../streams/relay/types.js";
import { buildEvent } from "../record/index.js";
import { OwnershipLostError } from "./ownership.js";
import {
  DOC_TABLES,
  type ActionDoc,
  type ActionKind,
  type ActionStatus,
  type CommitListener,
  type DefinitionDoc,
  type DocTable,
  type EffectDoc,
  type EffectKind,
  type EndpointHealthUpdate,
  type EndpointRegistrationRow,
  type EndpointRow,
  type LinkDoc,
  type LinkedSession,
  type BasinGenerations,
  type PrincipalRow,
  type PublishableKeyRow,
  type ResetScope,
  type SandboxDoc,
  type SessionActionFilter,
  type SessionDoc,
  type SessionEffectFilter,
  type SessionOwnership,
  type SessionStore,
  type SessionStoreOptions,
  type SigningKeyRow,
  type StoreCounts,
  type StoreHealth,
  type StoredSession,
  type SubjectUsageRow,
  type ModelUsageQuery,
  type ModelUsageRow,
  type ModelUsageTotals,
  type TakeOwnership,
  type Tx,
  type VaultAuditRow,
  type VaultCredentialPatch,
  type VaultCredentialRow,
  type VaultIdempotencyRow,
  type VaultRow,
} from "./types.js";

/** Schema version the fake reports; it has no migrations. */
export const MEMORY_SCHEMA_VERSION = 1;

type SessionMeta = SessionOwnership;

/** A change to the record, applied when its transaction commits. */
type RecordChange =
  | { kind: "rows"; rows: RecordRow[] }
  | { kind: "reset"; generation: number };

interface State {
  /** JSON text per id, like a `body` column. */
  docs: Record<DocTable, Map<string, string>>;
  sessionMeta: Map<string, SessionMeta>;
  /** sessionId → its log head: the next seq and the basin generation it was started in. */
  heads: Map<string, { head: number; generation: number }>;
  basin: BasinGenerations;
  endpoints: Map<string, EndpointRow>;
  principals: Map<string, PrincipalRow>;
  vaults: Map<string, VaultRow>;
  credentials: Map<string, VaultCredentialRow>;
  audit: VaultAuditRow[];
  idempotency: Map<string, VaultIdempotencyRow>;
  settings: Map<string, string>;
  signingKeys: Map<string, SigningKeyRow>;
  subjectEpochs: Map<string, number>;
  subjectUsage: Map<string, SubjectUsageRow>;
  publishableKeys: Map<string, PublishableKeyRow>;
  modelUsage: ModelUsageRow[];
}

function emptyState(): State {
  return {
    docs: Object.fromEntries(
      DOC_TABLES.map((table) => [table, new Map<string, string>()]),
    ) as Record<DocTable, Map<string, string>>,
    sessionMeta: new Map(),
    heads: new Map(),
    basin: { current: 0, retired: [] },
    endpoints: new Map(),
    principals: new Map(),
    vaults: new Map(),
    credentials: new Map(),
    audit: [],
    idempotency: new Map(),
    settings: new Map(),
    signingKeys: new Map(),
    subjectEpochs: new Map(),
    subjectUsage: new Map(),
    publishableKeys: new Map(),
    modelUsage: [],
  };
}

const OWNERSHIP_KEYS = new Set(["owner", "epoch", "ownerExpiresAt"]);
const OPEN_SESSION = new Set(["running", "runnable"]);

const byId = <T>(entries: Iterable<[string, T]>): [string, T][] =>
  [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const copy = <T>(value: T): T => structuredClone(value);

/**
 * The data behind in-memory Session Stores: what a database is to its connections. Several
 * `MemorySessionStore`s on one `MemoryStoreData` see each other's commits and serialize their
 * transactions together, as several processes on one Tenant schema would; it outlives them,
 * so a test can close a Tenant and open it again.
 */
export class MemoryStoreData {
  /** @internal */ state = emptyState();
  /** @internal */ queue: Promise<void> = Promise.resolve();
  /** The record of committed events, read back by the stream relay. */
  readonly record = new MemoryRecord();
}

/**
 * In-memory `SessionStore` for unit tests. Not a supported profile.
 *
 * Transactions are serialized (one at a time), each works on a copy of the
 * state and replaces it on commit, so a throw rolls back everything: documents,
 * sequences, record rows and `afterCommit` callbacks. Commit listeners see
 * only this store's commits, as with a Postgres connection.
 */
export class MemorySessionStore implements SessionStore {
  readonly tenantId: string;
  private readonly active = new AsyncLocalStorage<MemorySessionStore>();
  private readonly listeners = new Set<CommitListener>();
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private closed = false;

  constructor(
    options: SessionStoreOptions,
    /** Shared with other stores on the same data; a fresh, private one by default. */
    private readonly data = new MemoryStoreData(),
  ) {
    this.tenantId = options.tenantId;
    this.now = options.now ?? (() => new Date());
    this.onError =
      options.onError ??
      ((error) =>
        queueMicrotask(() => {
          throw error;
        }));
  }

  async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("SessionStore is closed");
    if (this.active.getStore() === this)
      throw new Error("Nested SessionStore.tx is not allowed");
    const release = await this.acquire();
    let t!: MemoryTx;
    let result!: T;
    try {
      const working = copy(this.data.state);
      t = new MemoryTx(working, this.tenantId, this.now);
      try {
        result = await this.active.run(this, () => fn(t));
      } finally {
        t.closed = true;
      }
      this.data.state = working;
      for (const change of t.recordChanges)
        if (change.kind === "rows") this.data.record.commit(change.rows);
        else {
          this.data.record.deleteRows(this.tenantId);
          this.data.record.setGeneration(this.tenantId, change.generation);
        }
      if (t.events.length > 0) {
        const commit = {
          events: t.events,
          generations: t.generations,
        };
        for (const listener of this.listeners) {
          try {
            listener(commit);
          } catch (error) {
            this.onError(error);
          }
        }
      }
    } finally {
      release();
    }
    for (const callback of t.callbacks) {
      try {
        await callback();
      } catch (error) {
        this.onError(error);
      }
    }
    return result;
  }

  onCommit(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(): MemoryRecord {
    return this.data.record;
  }

  async health(): Promise<StoreHealth> {
    return {
      ok: !this.closed,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      expectedSchemaVersion: MEMORY_SCHEMA_VERSION,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.data.queue;
  }

  private acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const ready = this.data.queue.then(() => release);
    this.data.queue = this.data.queue.then(() => next);
    return ready;
  }
}

class MemoryTx implements Tx {
  closed = false;
  readonly events: LiveEvent[] = [];
  readonly generations: number[] = [];
  readonly recordChanges: RecordChange[] = [];
  readonly callbacks: (() => void | Promise<void>)[] = [];

  constructor(
    private readonly s: State,
    private readonly tenantId: string,
    private readonly now: () => Date,
  ) {}

  private check(): void {
    if (this.closed) throw new Error("Tx used after its transaction ended");
  }

  // --- documents -----------------------------------------------------------

  async get<T = any>(table: DocTable, id: string): Promise<T | undefined> {
    this.check();
    const raw = this.s.docs[table].get(id);
    if (raw === undefined) return undefined;
    return (table === "sessions" ? this.session(id) : JSON.parse(raw)) as T;
  }

  async put(table: DocTable, id: string, body: unknown): Promise<void> {
    this.check();
    let value = body;
    if (table === "sessions" && body && typeof body === "object") {
      value = Object.fromEntries(
        Object.entries(body).filter(([key]) => !OWNERSHIP_KEYS.has(key)),
      );
      if (!this.s.sessionMeta.has(id))
        this.s.sessionMeta.set(id, {
          owner: null,
          epoch: 0,
          ownerExpiresAt: null,
        });
    }
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Document body must be JSON");
    this.s.docs[table].set(id, json);
  }

  async delete(table: DocTable, id: string): Promise<void> {
    this.check();
    this.s.docs[table].delete(id);
    // The session's log head stays: a session created again with this id continues its log.
    if (table === "sessions") this.s.sessionMeta.delete(id);
  }

  private session<T extends SessionDoc>(
    id: string,
  ): StoredSession<T> | undefined {
    const raw = this.s.docs.sessions.get(id);
    const meta = this.s.sessionMeta.get(id);
    if (raw === undefined || !meta) return undefined;
    return {
      ...JSON.parse(raw),
      owner: meta.owner,
      epoch: meta.epoch,
      ownerExpiresAt: meta.ownerExpiresAt,
    };
  }

  private docs<T>(table: DocTable): [string, T][] {
    return byId(this.s.docs[table]).map(([id, raw]) => [
      id,
      JSON.parse(raw) as T,
    ]);
  }

  private sessions<T extends SessionDoc>(): StoredSession<T>[] {
    return byId(this.s.docs.sessions).map(([id]) => this.session<T>(id)!);
  }

  // --- ordering ------------------------------------------------------------

  async lockSession<T extends SessionDoc = SessionDoc>(
    id: string,
  ): Promise<StoredSession<T> | undefined> {
    this.check();
    // Transactions are serialized, so the whole store is already locked.
    return this.session<T>(id);
  }

  async event<T extends EventType>(
    sessionId: string,
    turnId: string | null,
    type: T,
    payload: EventPayload<T>,
  ): Promise<SessionEventOf<T>> {
    this.check();
    const meta = this.s.sessionMeta.get(sessionId);
    if (!meta) throw new Error(`Session ${sessionId} not found`);
    let head = this.s.heads.get(sessionId);
    if (!head)
      this.s.heads.set(sessionId, (head = { head: 0, generation: this.s.basin.current }));
    const event = buildEvent({
      tenantId: this.tenantId,
      sessionId,
      turnId,
      seq: head.head,
      epoch: meta.epoch,
      time: this.now(),
      type,
      payload,
    });
    const seq = head.head++;
    this.recordChanges.push({
      kind: "rows",
      rows: [{ tenantId: this.tenantId, sessionId, seq, generation: head.generation, body: event }],
    });
    this.events.push(event);
    this.generations.push(head.generation);
    return copy(event);
  }

  afterCommit(fn: () => void | Promise<void>): void {
    this.check();
    this.callbacks.push(fn);
  }

  // --- ownership -----------------------------------------------------------

  async takeOwnership(
    sessionId: string,
    claim: { owner: string; now: Date; leaseMs: number },
  ): Promise<TakeOwnership> {
    this.check();
    const meta = this.s.sessionMeta.get(sessionId);
    if (!meta) return { status: "missing" };
    if (
      meta.owner !== null &&
      meta.ownerExpiresAt !== null &&
      Date.parse(meta.ownerExpiresAt) > claim.now.getTime()
    )
      return {
        status: "busy",
        owner: meta.owner,
        ownerExpiresAt: meta.ownerExpiresAt,
      };
    const previous: SessionOwnership = {
      owner: meta.owner,
      epoch: meta.epoch,
      ownerExpiresAt: meta.ownerExpiresAt,
    };
    meta.epoch += 1;
    meta.owner = claim.owner;
    meta.ownerExpiresAt = new Date(
      claim.now.getTime() + claim.leaseMs,
    ).toISOString();
    return {
      status: "owned",
      epoch: meta.epoch,
      takeover: previous.owner !== null,
      previous,
    };
  }

  async renewOwnership(
    sessionId: string,
    owner: string,
    epoch: number,
    until: Date,
  ): Promise<boolean> {
    this.check();
    const meta = this.s.sessionMeta.get(sessionId);
    if (!meta || meta.owner !== owner || meta.epoch !== epoch) return false;
    meta.ownerExpiresAt = until.toISOString();
    return true;
  }

  async releaseOwnership(
    sessionId: string,
    owner: string,
    epoch: number,
  ): Promise<boolean> {
    this.check();
    const meta = this.s.sessionMeta.get(sessionId);
    if (!meta || meta.owner !== owner || meta.epoch !== epoch) return false;
    meta.owner = null;
    meta.ownerExpiresAt = null;
    return true;
  }

  async assertEpoch<T extends SessionDoc = SessionDoc>(
    sessionId: string,
    epoch: number,
  ): Promise<StoredSession<T>> {
    this.check();
    const session = this.session<T>(sessionId);
    if (!session) throw new OwnershipLostError(sessionId, epoch, undefined);
    if (session.epoch !== epoch)
      throw new OwnershipLostError(sessionId, epoch, session.epoch);
    return session;
  }

  // --- typed queries -------------------------------------------------------

  async sessionsWithStatus<T extends SessionDoc = SessionDoc>(
    statuses: readonly string[],
  ): Promise<StoredSession<T>[]> {
    this.check();
    return this.sessions<T>().filter((s) => statuses.includes(s.status));
  }

  async orphanedSessions<T extends SessionDoc = SessionDoc>(
    now: Date,
    limit: number,
  ): Promise<StoredSession<T>[]> {
    this.check();
    const lease = (s: SessionOwnership) =>
      s.owner === null || s.ownerExpiresAt === null
        ? -Infinity
        : Date.parse(s.ownerExpiresAt);
    return this.sessions<T>()
      .filter((s) => OPEN_SESSION.has(s.status) && lease(s) <= now.getTime())
      .sort((a, b) => lease(a) - lease(b) || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  async listSessions<T extends SessionDoc = SessionDoc>(
    filter: { agentId?: string; ownerUserId?: string } = {},
  ): Promise<StoredSession<T>[]> {
    this.check();
    return this.sessions<T>().filter(
      (s) =>
        (filter.agentId === undefined || s.agentId === filter.agentId) &&
        (filter.ownerUserId === undefined ||
          (s as { ownerUserId?: unknown }).ownerUserId === filter.ownerUserId),
    );
  }

  async listDefinitions<T extends DefinitionDoc = DefinitionDoc>(): Promise<
    T[]
  > {
    this.check();
    return this.docs<T>("definitions").map(([, doc]) => doc);
  }

  async listSandboxes<T extends SandboxDoc = SandboxDoc>(): Promise<T[]> {
    this.check();
    return this.docs<T>("sandboxes").map(([, doc]) => doc);
  }

  private actions(): ActionDoc[] {
    return this.docs<ActionDoc>("actions").map(([, doc]) => doc);
  }

  async pendingActions(agentId: string): Promise<ActionDoc[]> {
    this.check();
    return this.actions().filter(
      (a) => a.status === "pending" && a.agentId === agentId,
    );
  }

  async deliveringCount(agentId: string): Promise<number> {
    this.check();
    return this.actions().filter(
      (a) => a.status === "delivering" && a.agentId === agentId,
    ).length;
  }

  async pendingActionsWithEndpoint(limit: number): Promise<ActionDoc[]> {
    this.check();
    return this.actions()
      .filter((a) => a.status === "pending" && this.s.endpoints.has(a.agentId))
      .slice(0, limit);
  }

  async expiredDeliveries(now: Date, limit: number): Promise<ActionDoc[]> {
    this.check();
    return this.actions()
      .filter(
        (a) =>
          a.status === "delivering" &&
          typeof a.deadlineAt === "string" &&
          Date.parse(a.deadlineAt) <= now.getTime(),
      )
      .sort(
        (a, b) =>
          Date.parse(a.deadlineAt!) - Date.parse(b.deadlineAt!) ||
          (a.actionId < b.actionId ? -1 : 1),
      )
      .slice(0, limit);
  }

  async actionsForSession(
    sessionId: string,
    filter: SessionActionFilter = {},
  ): Promise<ActionDoc[]> {
    this.check();
    return this.actions().filter(
      (a) =>
        a.sessionId === sessionId &&
        (filter.turnId === undefined || a.turnId === filter.turnId) &&
        (filter.statuses === undefined || filter.statuses.includes(a.status)),
    );
  }

  async actionsWithStatus(
    statuses: readonly ActionStatus[],
    filter: { kinds?: readonly ActionKind[] } = {},
  ): Promise<ActionDoc[]> {
    this.check();
    return this.actions().filter(
      (a) =>
        statuses.includes(a.status) &&
        (filter.kinds === undefined || filter.kinds.includes(a.kind)),
    );
  }

  private effects<T extends EffectDoc>(): T[] {
    return this.docs<T>("effects").map(([, doc]) => doc);
  }

  async invokingEffects<T extends EffectDoc = EffectDoc>(
    sessionId: string,
  ): Promise<T[]> {
    return this.effectsForSession<T>(sessionId, { statuses: ["invoking"] });
  }

  async effectsForSession<T extends EffectDoc = EffectDoc>(
    sessionId: string,
    filter: SessionEffectFilter = {},
  ): Promise<T[]> {
    this.check();
    return this.effects<T>().filter(
      (e) =>
        e.request?.sessionId === sessionId &&
        (filter.turnId === undefined || e.request.turnId === filter.turnId) &&
        (filter.statuses === undefined || filter.statuses.includes(e.status)),
    );
  }

  async effectsForTurn<T extends EffectDoc = EffectDoc>(
    sessionId: string,
    turnId: string,
    statuses?: readonly string[],
  ): Promise<T[]> {
    return this.effectsForSession<T>(sessionId, { turnId, statuses });
  }

  async effectsWithStatus<T extends EffectDoc = EffectDoc>(
    statuses: readonly string[],
    filter: { kinds?: readonly EffectKind[] } = {},
  ): Promise<T[]> {
    this.check();
    return this.effects<T>().filter(
      (e) =>
        statuses.includes(e.status) &&
        (filter.kinds === undefined || filter.kinds.includes(e.request?.kind)),
    );
  }

  async linkedSessions<S extends SessionDoc = SessionDoc>(
    workflowSessionId: string,
  ): Promise<LinkedSession<S>[]> {
    this.check();
    const out: LinkedSession<S>[] = [];
    for (const [agentSessionId, link] of this.docs<LinkDoc>("links")) {
      if (link.workflowSessionId !== workflowSessionId) continue;
      const session = this.session<S>(agentSessionId);
      if (session) out.push({ agentSessionId, link, session });
    }
    return out;
  }

  async counts(): Promise<StoreCounts> {
    this.check();
    const sessions = this.sessions();
    return {
      sessions: sessions.length,
      runningSessions: sessions.filter((s) => OPEN_SESSION.has(s.status))
        .length,
      pendingActions: this.actions().filter(
        (a) => a.status === "pending" || a.status === "delivering",
      ).length,
      uncertainEffects: this.effects().filter((e) => e.status === "uncertain")
        .length,
      sandboxes: this.s.docs.sandboxes.size,
      definitions: this.s.docs.definitions.size,
    };
  }

  // --- basin generations --------------------------------------------------

  async basinGenerations(): Promise<BasinGenerations> {
    this.check();
    return copy(this.s.basin);
  }

  async forgetRetiredGeneration(generation: number): Promise<void> {
    this.check();
    this.s.basin.retired = this.s.basin.retired.filter((g) => g !== generation);
  }

  // --- Action endpoints -----------------------------------------------------

  async listEndpoints(): Promise<EndpointRow[]> {
    this.check();
    return byId(this.s.endpoints).map(([, row]) => copy(row));
  }

  async getEndpoint(agentId: string): Promise<EndpointRow | undefined> {
    this.check();
    const row = this.s.endpoints.get(agentId);
    return row && copy(row);
  }

  async putEndpoint(row: EndpointRegistrationRow): Promise<void> {
    this.check();
    const existing = this.s.endpoints.get(row.agentId);
    const health =
      existing && existing.url === row.url ? healthOf(existing) : { consecutiveFailures: 0 };
    this.s.endpoints.set(row.agentId, {
      ...copy(row),
      ...health,
      createdAt: existing?.createdAt ?? row.updatedAt,
    });
  }

  async deleteEndpoint(agentId: string): Promise<void> {
    this.check();
    this.s.endpoints.delete(agentId);
  }

  async recordEndpointHealth(
    agentId: string,
    update: EndpointHealthUpdate,
  ): Promise<void> {
    this.check();
    const row = this.s.endpoints.get(agentId);
    if (row) this.s.endpoints.set(agentId, withHealth(row, update));
  }

  // --- principals ----------------------------------------------------------

  async insertPrincipal(row: PrincipalRow): Promise<void> {
    this.check();
    if (this.s.principals.has(row.id))
      throw new Error("principals.id must be unique");
    for (const other of this.s.principals.values())
      if (other.tokenHash === row.tokenHash)
        throw new Error("principals.token_hash must be unique");
    this.s.principals.set(row.id, copy(row));
  }

  async principalByTokenHash(
    tokenHash: string,
  ): Promise<PrincipalRow | undefined> {
    this.check();
    for (const row of this.s.principals.values())
      if (row.tokenHash === tokenHash) return copy(row);
    return undefined;
  }

  async principalById(id: string): Promise<PrincipalRow | undefined> {
    this.check();
    const row = this.s.principals.get(id);
    return row && copy(row);
  }

  async applicationTokenHashes(): Promise<string[]> {
    this.check();
    return byId(this.s.principals)
      .filter(([, row]) => row.role === "application")
      .map(([, row]) => row.tokenHash);
  }

  // --- vault ---------------------------------------------------------------

  async insertVault(row: VaultRow): Promise<void> {
    this.check();
    if (this.s.vaults.has(row.id)) throw new Error("vaults.id must be unique");
    if (
      row.scope === "host" &&
      [...this.s.vaults.values()].some((v) => v.scope === "host")
    )
      throw new Error("Only one host vault is allowed");
    this.s.vaults.set(row.id, copy(row));
  }

  async getVault(id: string): Promise<VaultRow | undefined> {
    this.check();
    const row = this.s.vaults.get(id);
    return row && copy(row);
  }

  async vaultsByOwner(ownerUserId: string): Promise<VaultRow[]> {
    this.check();
    return [...this.s.vaults.values()]
      .filter((v) => v.ownerUserId === ownerUserId && v.scope === "user")
      .sort(byCreated)
      .map(copy);
  }

  async updateVaultMetadata(
    id: string,
    metadataJson: string | null,
  ): Promise<void> {
    this.check();
    const row = this.s.vaults.get(id);
    if (row) row.metadataJson = metadataJson;
  }

  async deleteVault(id: string): Promise<void> {
    this.check();
    for (const [credentialId, row] of this.s.credentials)
      if (row.vaultId === id) this.s.credentials.delete(credentialId);
    this.s.vaults.delete(id);
  }

  async insertCredential(row: VaultCredentialRow): Promise<void> {
    this.check();
    if (this.s.credentials.has(row.id))
      throw new Error("vault_credentials.id must be unique");
    if (!this.s.vaults.has(row.vaultId))
      throw new Error("vault_credentials.vault_id references a missing vault");
    this.s.credentials.set(row.id, copy(row));
  }

  async getCredential(id: string): Promise<VaultCredentialRow | undefined> {
    this.check();
    const row = this.s.credentials.get(id);
    return row && copy(row);
  }

  async credentialsForVault(
    vaultId: string,
    filter: { type?: VaultCredentialRow["type"] } = {},
  ): Promise<VaultCredentialRow[]> {
    this.check();
    return [...this.s.credentials.values()]
      .filter(
        (c) =>
          c.vaultId === vaultId &&
          (filter.type === undefined || c.type === filter.type),
      )
      .sort(byCreated)
      .map(copy);
  }

  async updateCredential(
    vaultId: string,
    id: string,
    patch: VaultCredentialPatch,
  ): Promise<boolean> {
    this.check();
    const row = this.s.credentials.get(id);
    if (!row || row.vaultId !== vaultId) return false;
    const defined = Object.fromEntries(
      Object.entries(copy(patch)).filter(([, value]) => value !== undefined),
    );
    this.s.credentials.set(id, { ...row, ...defined });
    return true;
  }

  async deleteCredential(vaultId: string, id: string): Promise<boolean> {
    this.check();
    const row = this.s.credentials.get(id);
    if (!row || row.vaultId !== vaultId) return false;
    this.s.credentials.delete(id);
    return true;
  }

  async countCredentials(): Promise<number> {
    this.check();
    return this.s.credentials.size;
  }

  async insertVaultAudit(row: VaultAuditRow): Promise<void> {
    this.check();
    this.s.audit.push(copy(row));
  }

  async vaultAudit(
    filter: { vaultId?: string; limit?: number } = {},
  ): Promise<VaultAuditRow[]> {
    this.check();
    return this.s.audit
      .filter((r) => filter.vaultId === undefined || r.vaultId === filter.vaultId)
      .slice(0, filter.limit ?? Infinity)
      .map(copy);
  }

  async getVaultIdempotency(
    id: string,
  ): Promise<VaultIdempotencyRow | undefined> {
    this.check();
    const row = this.s.idempotency.get(id);
    return row && copy(row);
  }

  async insertVaultIdempotency(row: VaultIdempotencyRow): Promise<void> {
    this.check();
    if (this.s.idempotency.has(row.id))
      throw new Error("vault_idempotency.id must be unique");
    this.s.idempotency.set(row.id, copy(row));
  }

  // --- subject tokens ------------------------------------------------------

  /** Transactions are serialized already. */
  async lockSigningKeys(): Promise<void> {
    this.check();
  }

  async insertSigningKey(row: SigningKeyRow): Promise<void> {
    this.check();
    if (this.s.signingKeys.has(row.id))
      throw new Error("signing_keys.id must be unique");
    if (row.state !== "revoked")
      for (const other of this.s.signingKeys.values())
        if (other.state === row.state)
          throw new Error(`signing_keys allows one ${row.state} key`);
    this.s.signingKeys.set(row.id, copy(row));
  }

  async signingKey(id: string): Promise<SigningKeyRow | undefined> {
    this.check();
    const row = this.s.signingKeys.get(id);
    return row && copy(row);
  }

  async signingKeys(
    states?: readonly SigningKeyRow["state"][],
  ): Promise<SigningKeyRow[]> {
    this.check();
    return [...this.s.signingKeys.values()]
      .filter((row) => states === undefined || states.includes(row.state))
      .sort(byCreated)
      .map(copy);
  }

  async setSigningKeyState(
    id: string,
    from: SigningKeyRow["state"],
    to: SigningKeyRow["state"],
    at: string,
  ): Promise<boolean> {
    this.check();
    const row = this.s.signingKeys.get(id);
    if (!row || row.state !== from) return false;
    if (to !== "revoked")
      for (const other of this.s.signingKeys.values())
        if (other.id !== id && other.state === to)
          throw new Error(`signing_keys allows one ${to} key`);
    this.s.signingKeys.set(id, { ...row, ...signingKeyStamp(to, at), state: to });
    return true;
  }

  async countSigningKeys(): Promise<number> {
    this.check();
    return this.s.signingKeys.size;
  }

  async subjectEpoch(subject: string): Promise<number> {
    this.check();
    return this.s.subjectEpochs.get(subject) ?? 0;
  }

  async subjectEpochs(subjects: readonly string[]): Promise<Map<string, number>> {
    this.check();
    const out = new Map<string, number>();
    for (const subject of subjects) {
      const epoch = this.s.subjectEpochs.get(subject);
      if (epoch !== undefined) out.set(subject, epoch);
    }
    return out;
  }

  async bumpSubjectEpoch(subject: string, _at: string): Promise<number> {
    this.check();
    const epoch = (this.s.subjectEpochs.get(subject) ?? 0) + 1;
    this.s.subjectEpochs.set(subject, epoch);
    return epoch;
  }

  async lockSubjectUsage(initial: SubjectUsageRow): Promise<SubjectUsageRow> {
    this.check();
    // Transactions are serialized, so the row is as good as locked.
    const row = this.s.subjectUsage.get(initial.subject);
    if (row) return copy(row);
    this.s.subjectUsage.set(initial.subject, copy(initial));
    return copy(initial);
  }

  async putSubjectUsage(row: SubjectUsageRow): Promise<void> {
    this.check();
    this.s.subjectUsage.set(row.subject, copy(row));
  }

  async countOwnerSessions(
    ownerUserId: string,
    statuses: readonly string[],
  ): Promise<number> {
    this.check();
    return this.sessions<SessionDoc>().filter(
      (s) =>
        (s as { ownerUserId?: unknown }).ownerUserId === ownerUserId &&
        statuses.includes((s as { status?: string }).status ?? ""),
    ).length;
  }

  // --- publishable keys ----------------------------------------------------

  async insertPublishableKey(row: PublishableKeyRow): Promise<void> {
    this.check();
    for (const other of this.s.publishableKeys.values())
      if (other.id === row.id || other.key === row.key || other.name === row.name)
        throw new Error("publishable_keys id, key and name must be unique");
    this.s.publishableKeys.set(row.id, copy(row));
  }

  async publishableKeyByKey(key: string): Promise<PublishableKeyRow | undefined> {
    this.check();
    for (const row of this.s.publishableKeys.values())
      if (row.key === key) return copy(row);
    return undefined;
  }

  async publishableKey(id: string): Promise<PublishableKeyRow | undefined> {
    this.check();
    const row = this.s.publishableKeys.get(id);
    return row && copy(row);
  }

  async publishableKeys(): Promise<PublishableKeyRow[]> {
    this.check();
    return [...this.s.publishableKeys.values()].sort(byCreated).map(copy);
  }

  async updatePublishableKey(
    id: string,
    patch: Partial<Pick<PublishableKeyRow, "originsJson" | "revokedAt">>,
  ): Promise<boolean> {
    this.check();
    const row = this.s.publishableKeys.get(id);
    if (!row) return false;
    this.s.publishableKeys.set(id, { ...row, ...copy(patch) });
    return true;
  }

  // --- model usage ---------------------------------------------------------

  async recordModelUsage(row: Omit<ModelUsageRow, "duplicate">): Promise<ModelUsageRow> {
    this.check();
    const recorded: ModelUsageRow = {
      ...copy(row),
      duplicate: this.s.modelUsage.some((other) => other.effectKey === row.effectKey),
    };
    this.s.modelUsage.push(recorded);
    return copy(recorded);
  }

  async modelUsageTotals(query: ModelUsageQuery): Promise<ModelUsageTotals> {
    this.check();
    const totals: ModelUsageTotals = { calls: 0, tokens: 0, costUsd: 0 };
    for (const row of this.s.modelUsage) {
      if (query.scope === "agent" && row.agentId !== query.id) continue;
      if (query.scope === "turn" && row.turnId !== query.id) continue;
      if (query.since !== undefined && row.createdAt < query.since) continue;
      totals.calls += 1;
      totals.tokens += row.totalTokens;
      totals.costUsd += row.costUsd;
    }
    return totals;
  }

  // --- settings ------------------------------------------------------------

  async getSetting(key: string): Promise<string | undefined> {
    this.check();
    return this.s.settings.get(key);
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.check();
    this.s.settings.set(key, value);
  }

  // --- reset ---------------------------------------------------------------

  async reset(scope: ResetScope): Promise<void> {
    this.check();
    if (scope === "sessions" || scope === "all") {
      for (const table of [
        "sessions",
        "commands",
        "effects",
        "actions",
        "links",
      ] as const)
        this.s.docs[table].clear();
      this.s.sessionMeta.clear();
      this.s.heads.clear();
      this.s.subjectUsage.clear();
      this.s.basin = {
        current: this.s.basin.current + 1,
        retired: [...this.s.basin.retired, this.s.basin.current],
      };
      this.recordChanges.push({ kind: "reset", generation: this.s.basin.current });
    }
    if (scope === "sandboxes" || scope === "all")
      this.s.docs.sandboxes.clear();
    if (scope === "all") {
      this.s.docs.definitions.clear();
      this.s.endpoints.clear();
      this.s.modelUsage = [];
      for (const vault of [...this.s.vaults.values()])
        if (vault.scope !== "host") await this.deleteVault(vault.id);
    }
  }
}

/** The time column a signing key's new state stamps. */
export function signingKeyStamp(
  state: SigningKeyRow["state"],
  at: string,
): Partial<SigningKeyRow> {
  if (state === "current") return { activatedAt: at };
  if (state === "previous") return { retiredAt: at };
  if (state === "revoked") return { revokedAt: at };
  return {};
}

function byCreated(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const HEALTH_KEYS = [
  "lastDeliveryAt",
  "lastSuccessAt",
  "lastErrorCode",
  "lastErrorMessage",
  "consecutiveFailures",
  "servedImplementationVersion",
  "servedManifestHash",
] as const;

/** The health fields of an endpoint row. */
function healthOf(row: EndpointRow): Partial<EndpointRow> & { consecutiveFailures: number } {
  const health: Partial<EndpointRow> = {};
  for (const key of HEALTH_KEYS)
    if (row[key] !== undefined) (health as Record<string, unknown>)[key] = row[key];
  return { ...health, consecutiveFailures: row.consecutiveFailures };
}

/** `row` after one health observation (the same rules as the Postgres store). */
function withHealth(row: EndpointRow, update: EndpointHealthUpdate): EndpointRow {
  switch (update.kind) {
    case "success": {
      const { lastErrorCode: _c, lastErrorMessage: _m, ...rest } = row;
      return {
        ...rest,
        lastDeliveryAt: update.at,
        lastSuccessAt: update.at,
        consecutiveFailures: 0,
      };
    }
    case "failure":
      return {
        ...row,
        lastDeliveryAt: update.at,
        lastErrorCode: update.code,
        lastErrorMessage: update.message,
        consecutiveFailures: row.consecutiveFailures + 1,
      };
    case "served": {
      const { servedManifestHash: _h, ...rest } = row;
      return {
        ...rest,
        servedImplementationVersion: update.implementationVersion,
        ...(update.manifestHash === undefined ? {} : { servedManifestHash: update.manifestHash }),
      };
    }
  }
}
