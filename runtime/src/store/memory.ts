import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LiveEvent } from "@nylorun/core/contracts";
import { encodeCursor } from "./cursor.js";
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
  type ExecutorRow,
  type LinkDoc,
  type LinkedSession,
  type OutboxRow,
  type OutboxStats,
  type PrincipalRow,
  type ResetScope,
  type SandboxDoc,
  type SessionActionFilter,
  type SessionDoc,
  type SessionEffectFilter,
  type SessionOwnership,
  type SessionStore,
  type SessionStoreOptions,
  type StoreCounts,
  type StoreHealth,
  type StoredSession,
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

interface SessionMeta extends SessionOwnership {
  nextSeq: number;
}

interface State {
  /** JSON text per id, like a `body` column. */
  docs: Record<DocTable, Map<string, string>>;
  sessionMeta: Map<string, SessionMeta>;
  /** sessionId → seq → event JSON. */
  outbox: Map<string, Map<number, string>>;
  executors: Map<string, ExecutorRow>;
  principals: Map<string, PrincipalRow>;
  vaults: Map<string, VaultRow>;
  credentials: Map<string, VaultCredentialRow>;
  audit: VaultAuditRow[];
  idempotency: Map<string, VaultIdempotencyRow>;
  settings: Map<string, string>;
}

function emptyState(): State {
  return {
    docs: Object.fromEntries(
      DOC_TABLES.map((table) => [table, new Map<string, string>()]),
    ) as Record<DocTable, Map<string, string>>,
    sessionMeta: new Map(),
    outbox: new Map(),
    executors: new Map(),
    principals: new Map(),
    vaults: new Map(),
    credentials: new Map(),
    audit: [],
    idempotency: new Map(),
    settings: new Map(),
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
}

/**
 * In-memory `SessionStore` for unit tests. Not a supported profile.
 *
 * Transactions are serialized (one at a time), each works on a copy of the
 * state and replaces it on commit, so a throw rolls back everything: documents,
 * sequences, outbox rows, `afterCommit` callbacks and `signalWork`. Commit listeners see
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
      if (t.events.length > 0 || t.workAvailable) {
        const commit = {
          events: t.events,
          incarnations: t.incarnations,
          workAvailable: t.workAvailable,
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
  readonly incarnations: (string | null)[] = [];
  readonly callbacks: (() => void | Promise<void>)[] = [];
  workAvailable = false;

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
          nextSeq: 0,
        });
    }
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Document body must be JSON");
    this.s.docs[table].set(id, json);
  }

  async delete(table: DocTable, id: string): Promise<void> {
    this.check();
    this.s.docs[table].delete(id);
    if (table === "sessions") {
      this.s.sessionMeta.delete(id);
      this.s.outbox.delete(id);
    }
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

  async event(
    sessionId: string,
    turnId: string | null,
    type: string,
    payload: unknown,
  ): Promise<LiveEvent> {
    this.check();
    const meta = this.s.sessionMeta.get(sessionId);
    if (!meta) throw new Error(`Session ${sessionId} not found`);
    const seq = meta.nextSeq++;
    const event: LiveEvent = JSON.parse(
      JSON.stringify({
        eventId: randomUUID(),
        sessionId,
        tenantId: this.tenantId,
        turnId,
        cursor: encodeCursor(sessionId, seq),
        createdAt: this.now().toISOString(),
        type,
        payload,
      }),
    );
    let rows = this.s.outbox.get(sessionId);
    if (!rows) this.s.outbox.set(sessionId, (rows = new Map()));
    rows.set(seq, JSON.stringify(event));
    this.events.push(event);
    const doc = JSON.parse(this.s.docs.sessions.get(sessionId)!) as SessionDoc;
    this.incarnations.push(doc.streamIncarnation ?? null);
    return copy(event);
  }

  afterCommit(fn: () => void | Promise<void>): void {
    this.check();
    this.callbacks.push(fn);
  }

  signalWork(): void {
    this.check();
    this.workAvailable = true;
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
    filter: { agentId?: string } = {},
  ): Promise<StoredSession<T>[]> {
    this.check();
    return this.sessions<T>().filter(
      (s) => filter.agentId === undefined || s.agentId === filter.agentId,
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

  async expiredClaims(now: Date, limit: number): Promise<ActionDoc[]> {
    this.check();
    return this.actions()
      .filter(
        (a) =>
          a.status === "claimed" &&
          a.leaseExpiresAt !== null &&
          Date.parse(a.leaseExpiresAt) <= now.getTime(),
      )
      .sort(
        (a, b) =>
          Date.parse(a.leaseExpiresAt!) - Date.parse(b.leaseExpiresAt!) ||
          (a.actionId < b.actionId ? -1 : 1),
      )
      .slice(0, limit);
  }

  async pendingActions(agentId: string): Promise<ActionDoc[]> {
    this.check();
    return this.actions().filter(
      (a) => a.status === "pending" && a.agentId === agentId,
    );
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
        (a) => a.status === "pending" || a.status === "claimed",
      ).length,
      uncertainEffects: this.effects().filter((e) => e.status === "uncertain")
        .length,
      sandboxes: this.s.docs.sandboxes.size,
      definitions: this.s.docs.definitions.size,
    };
  }

  // --- outbox --------------------------------------------------------------

  async outbox(
    limit: number,
    filter: { sessionId?: string } = {},
  ): Promise<OutboxRow[]> {
    this.check();
    const rows: OutboxRow[] = [];
    for (const [sessionId, bySeq] of byId(this.s.outbox)) {
      if (filter.sessionId !== undefined && filter.sessionId !== sessionId)
        continue;
      for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) {
        if (rows.length >= limit) return rows;
        rows.push({ sessionId, seq, event: JSON.parse(bySeq.get(seq)!) });
      }
    }
    return rows;
  }

  async deleteOutbox(
    sessionId: string,
    throughSeq: number,
    incarnation?: string | null,
  ): Promise<number> {
    this.check();
    const rows = this.s.outbox.get(sessionId);
    if (!rows) return 0;
    if (incarnation !== undefined) {
      const doc = this.s.docs.sessions.get(sessionId);
      if (
        doc === undefined ||
        ((JSON.parse(doc) as SessionDoc).streamIncarnation ?? null) !== incarnation
      )
        return 0;
    }
    let n = 0;
    for (const seq of [...rows.keys()])
      if (seq <= throughSeq) {
        rows.delete(seq);
        n += 1;
      }
    if (rows.size === 0) this.s.outbox.delete(sessionId);
    return n;
  }

  async outboxStats(): Promise<OutboxStats> {
    this.check();
    let depth = 0;
    let oldestCreatedAt: string | null = null;
    for (const rows of this.s.outbox.values())
      for (const body of rows.values()) {
        depth += 1;
        const createdAt = (JSON.parse(body) as { createdAt: string }).createdAt;
        if (oldestCreatedAt === null || createdAt < oldestCreatedAt)
          oldestCreatedAt = createdAt;
      }
    return { depth, oldestCreatedAt };
  }

  // --- executors -----------------------------------------------------------

  async listExecutors(): Promise<ExecutorRow[]> {
    this.check();
    return byId(this.s.executors).map(([, row]) => copy(row));
  }

  async getExecutor(agentId: string): Promise<ExecutorRow | undefined> {
    this.check();
    const row = this.s.executors.get(agentId);
    return row && copy(row);
  }

  async putExecutor(row: Omit<ExecutorRow, "createdAt">): Promise<void> {
    this.check();
    for (const other of this.s.executors.values())
      if (other.tokenHash === row.tokenHash && other.agentId !== row.agentId)
        throw new Error("executors.token_hash must be unique");
    const existing = this.s.executors.get(row.agentId);
    this.s.executors.set(row.agentId, {
      ...copy(row),
      createdAt: existing?.createdAt ?? row.updatedAt,
    });
  }

  async deleteExecutor(agentId: string): Promise<void> {
    this.check();
    this.s.executors.delete(agentId);
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
        "checkpoints",
        "effects",
        "actions",
        "links",
      ] as const)
        this.s.docs[table].clear();
      this.s.sessionMeta.clear();
      this.s.outbox.clear();
    }
    if (scope === "sandboxes" || scope === "all")
      this.s.docs.sandboxes.clear();
    if (scope === "all") {
      this.s.docs.definitions.clear();
      this.s.executors.clear();
      for (const vault of [...this.s.vaults.values()])
        if (vault.scope !== "host") await this.deleteVault(vault.id);
    }
  }
}

function byCreated(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
