/**
 * The SQLite Session Store: today's Tenant database (`tenant.sqlite`) behind
 * the async `SessionStore` seam (architecture §12.2). It bridges SQLite
 * Tenants until the Postgres switch and keeps the invariants in
 * `store/types.ts` with the same semantics as the in-memory fake and the
 * Postgres store.
 *
 * ## Transactions
 *
 * One connection per store. A per-store async mutex runs one transaction at a
 * time on it, as `BEGIN IMMEDIATE … COMMIT`, so a transaction never sees
 * another's uncommitted writes, and `lockSession` is a no-op beyond reading
 * the row: the whole database is already locked. Because every transaction is
 * serialized, lock ordering cannot deadlock here; callers still follow the
 * order in `store/types.ts` so the same code is safe on Postgres.
 *
 * Nested `tx` calls are detected with `AsyncLocalStorage` and rejected (a
 * nested call would wait on the mutex forever), and a `Tx` rejects every call
 * once its callback settles. Commit listeners run after `COMMIT` while the
 * mutex is still held, so they see commits in commit order; `afterCommit`
 * callbacks run after the mutex is released and may open new transactions.
 *
 * ## Events and history
 *
 * `events(session_id, seq, body, relayed)` holds every event of a session. A
 * row with `relayed = 0` is in the outbox; `deleteOutbox` marks rows relayed
 * rather than deleting them, because the SQLite profile has no durable
 * streams yet: at open, the Tenant runtime re-hydrates its in-memory streams
 * from the relayed rows (`readRelayed`, `tenant/streams.ts`). Wave 3 removes
 * that. Deleting a session deletes its events.
 *
 * ## Values
 *
 * Bodies are JSON text. Ids and ISO timestamps compare as text in binary
 * collation (code point order). Ownership times are ISO strings.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LiveEvent } from "@nylorun/core/contracts";
import {
  TENANT_SCHEMA_VERSION,
  migrateTenantDatabase,
  openTenantDatabase,
  schemaVersionOf,
  type TenantDatabase,
} from "../tenant/schema.js";
import { encodeCursor } from "./cursor.js";
import { OwnershipLostError } from "./ownership.js";
import type {
  ActionDoc,
  ActionKind,
  ActionStatus,
  CommitListener,
  DefinitionDoc,
  DocTable,
  EffectDoc,
  EffectKind,
  ExecutorRow,
  LinkDoc,
  LinkedSession,
  OutboxRow,
  PrincipalRow,
  ResetScope,
  SandboxDoc,
  SessionActionFilter,
  SessionDoc,
  SessionEffectFilter,
  SessionOwnership,
  SessionStore,
  SessionStoreOptions,
  StoreCounts,
  StoreHealth,
  StoredSession,
  TakeOwnership,
  Tx,
  VaultAuditRow,
  VaultCredentialPatch,
  VaultCredentialRow,
  VaultIdempotencyRow,
  VaultRow,
} from "./types.js";

export interface SqliteSessionStoreOptions extends SessionStoreOptions {
  /** The database file (or `:memory:`). The store opens and closes it. */
  path?: string;
  /** An open database the caller owns; the store never closes it. */
  db?: TenantDatabase;
  /** Migrate to `TENANT_SCHEMA_VERSION` on open. Defaults to true unless read-only. */
  migrate?: boolean;
  /** Open the file read-only: transactions are `BEGIN DEFERRED` and every write rejects. */
  readOnly?: boolean;
}

/** The SQLite Session Store, plus the event history it keeps until Wave 3. */
export interface SqliteSessionStore extends SessionStore {
  /**
   * Events of one session with `seq > afterSeq` (all when omitted), in order,
   * plus the session's last sequence (or null without events). Store tests and
   * migration checks only; the Runtime reads history from Durable Streams.
   */
  readEvents(
    sessionId: string,
    afterSeq?: number,
  ): Promise<{ events: LiveEvent[]; lastSeq: number | null }>;
  /**
   * Every relayed event (not in the outbox), ordered by session id then
   * sequence: the re-hydration source of the interim in-memory streams.
   */
  readRelayed(): Promise<OutboxRow[]>;
}

export function createSqliteSessionStore(
  options: SqliteSessionStoreOptions,
): SqliteSessionStore {
  return new SqliteStore(options);
}

type Row = Record<string, any>;

const OWNERSHIP_KEYS = new Set(["owner", "epoch", "ownerExpiresAt"]);
const OPEN_SESSION = ["running", "runnable"] as const;
const SESSION_COLUMNS = "id, body, owner, epoch, owner_expires_at";
const SESSION_TABLES = [
  "sessions",
  "commands",
  "checkpoints",
  "effects",
  "actions",
  "links",
  "events",
] as const;

class SqliteStore implements SqliteSessionStore {
  readonly tenantId: string;
  private readonly db: TenantDatabase;
  private readonly ownsDb: boolean;
  private readonly readOnly: boolean;
  private readonly statements = new Map<string, ReturnType<TenantDatabase["prepare"]>>();
  private readonly active = new AsyncLocalStorage<SqliteStore>();
  private readonly listeners = new Set<CommitListener>();
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: SqliteSessionStoreOptions) {
    this.tenantId = options.tenantId;
    this.readOnly = options.readOnly ?? false;
    this.now = options.now ?? (() => new Date());
    this.onError =
      options.onError ??
      ((error) =>
        queueMicrotask(() => {
          throw error;
        }));
    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      if (!options.path) throw new Error("SQLite store needs a path or a db");
      this.db = openTenantDatabase(options.path, { readOnly: this.readOnly });
      this.ownsDb = true;
    }
    try {
      if (options.migrate ?? !this.readOnly) migrateTenantDatabase(this.db);
    } catch (error) {
      if (this.ownsDb) this.db.close();
      throw error;
    }
  }

  /** A cached prepared statement. */
  sql(text: string) {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("SessionStore is closed");
    if (this.active.getStore() === this)
      throw new Error("Nested SessionStore.tx is not allowed");
    const release = await this.acquire();
    let t: SqliteTx | undefined;
    let result!: T;
    try {
      if (this.closed) throw new Error("SessionStore is closed");
      this.db.exec(this.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
      t = new SqliteTx(this, this.tenantId, this.now);
      const tx = t;
      try {
        result = await this.active.run(this, () => fn(tx));
        tx.closed = true;
        this.db.exec("COMMIT");
      } catch (error) {
        tx.closed = true;
        try {
          if (this.db.isTransaction) this.db.exec("ROLLBACK");
        } catch {
          /* the rollback failed too; the original error wins */
        }
        throw error;
      }
      if (tx.events.length > 0 || tx.workAvailable) {
        const commit = { events: tx.events, workAvailable: tx.workAvailable };
        for (const listener of [...this.listeners]) {
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

  async readEvents(
    sessionId: string,
    afterSeq = -1,
  ): Promise<{ events: LiveEvent[]; lastSeq: number | null }> {
    return this.read(() => {
      const events = this.sql(
        "SELECT body FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
      )
        .all(sessionId, afterSeq)
        .map((row) => JSON.parse(String(row.body)) as LiveEvent);
      const last = this.sql(
        "SELECT MAX(seq) AS seq FROM events WHERE session_id = ?",
      ).get(sessionId) as { seq: number | null } | undefined;
      return {
        events,
        lastSeq: last?.seq == null ? null : Number(last.seq),
      };
    });
  }

  async readRelayed(): Promise<OutboxRow[]> {
    return this.read(() =>
      this.sql(
        "SELECT session_id, seq, body FROM events WHERE relayed = 1 ORDER BY session_id, seq",
      )
        .all()
        .map((row) => ({
          sessionId: String(row.session_id),
          seq: Number(row.seq),
          event: JSON.parse(String(row.body)) as LiveEvent,
        })),
    );
  }

  async health(): Promise<StoreHealth> {
    const expectedSchemaVersion = TENANT_SCHEMA_VERSION;
    if (this.closed)
      return { ok: false, schemaVersion: 0, expectedSchemaVersion };
    try {
      this.db.prepare("SELECT 1").get();
      const schemaVersion = schemaVersionOf(this.db);
      return {
        ok: schemaVersion === expectedSchemaVersion,
        schemaVersion,
        expectedSchemaVersion,
      };
    } catch {
      return { ok: false, schemaVersion: 0, expectedSchemaVersion };
    }
  }

  /** Rejects new transactions, waits for queued ones, then closes the database it opened. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const release = await this.acquire();
    try {
      this.statements.clear();
      if (this.ownsDb && this.db.isOpen) this.db.close();
    } finally {
      release();
    }
  }

  /** Runs a read outside any transaction, but never while one is open on the connection. */
  private async read<T>(fn: () => T): Promise<T> {
    if (this.closed) throw new Error("SessionStore is closed");
    if (this.active.getStore() === this)
      throw new Error("Nested SessionStore read is not allowed");
    const release = await this.acquire();
    try {
      if (this.closed) throw new Error("SessionStore is closed");
      return fn();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const ready = this.queue.then(() => release);
    this.queue = this.queue.then(() => next);
    return ready;
  }
}

// ---------------------------------------------------------------------------

function toJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Document body must be JSON");
  return json;
}

function ownership(row: Row): SessionOwnership {
  return {
    owner: row.owner ?? null,
    epoch: Number(row.epoch),
    ownerExpiresAt: row.owner_expires_at ?? null,
  };
}

function storedSession<T extends SessionDoc>(row: Row): StoredSession<T> {
  return { ...JSON.parse(String(row.body)), ...ownership(row) };
}

const bodyOf = <T>(row: Row): T => JSON.parse(String(row.body)) as T;

const placeholders = (values: readonly unknown[]) =>
  values.map(() => "?").join(", ");

const blob = (value: Uint8Array): Uint8Array => new Uint8Array(value);

function executorRow(row: Row): ExecutorRow {
  return {
    agentId: row.agent_id,
    tokenHash: row.token_hash,
    implementationVersion: row.implementation_version,
    ...(row.manifest_hash != null ? { manifestHash: row.manifest_hash } : {}),
    ...(row.principal_id != null ? { principalId: row.principal_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function principalRow(row: Row): PrincipalRow {
  return {
    id: row.id,
    role: row.role,
    tokenHash: row.token_hash,
    idempotencyKey: row.idempotency_key ?? null,
    createdAt: row.created_at,
  };
}

function vaultRow(row: Row): VaultRow {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    metadataJson: row.metadata_json ?? null,
    createdAt: row.created_at,
    scope: row.scope,
  };
}

function credentialRow(row: Row): VaultCredentialRow {
  return {
    id: row.id,
    vaultId: row.vault_id,
    name: row.name,
    type: row.type,
    bindingJson: row.binding_json,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at ?? null,
    kekId: row.kek_id,
    nonce: blob(row.nonce),
    ciphertext: blob(row.ciphertext),
    wrappedDek: blob(row.wrapped_dek),
  };
}

function auditRow(row: Row): VaultAuditRow {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    vaultId: row.vault_id ?? null,
    credentialId: row.credential_id ?? null,
    sessionId: row.session_id ?? null,
    target: row.target ?? null,
    outcome: row.outcome,
  };
}

/** `VaultCredentialPatch` field → column. */
const CREDENTIAL_COLUMNS = {
  name: "name",
  type: "type",
  bindingJson: "binding_json",
  expiresAt: "expires_at",
  rotatedAt: "rotated_at",
  kekId: "kek_id",
  nonce: "nonce",
  ciphertext: "ciphertext",
  wrappedDek: "wrapped_dek",
} as const satisfies Record<keyof VaultCredentialPatch, string>;

class SqliteTx implements Tx {
  closed = false;
  readonly events: LiveEvent[] = [];
  readonly callbacks: (() => void | Promise<void>)[] = [];
  workAvailable = false;

  constructor(
    private readonly store: SqliteStore,
    private readonly tenantId: string,
    private readonly now: () => Date,
  ) {}

  private check(): void {
    if (this.closed) throw new Error("Tx used after its transaction ended");
  }

  private all(text: string, ...params: any[]): Row[] {
    return this.store.sql(text).all(...params) as Row[];
  }

  private one(text: string, ...params: any[]): Row | undefined {
    return this.store.sql(text).get(...params) as Row | undefined;
  }

  private run(text: string, ...params: any[]): number {
    return Number(this.store.sql(text).run(...params).changes);
  }

  // --- documents -----------------------------------------------------------

  async get<T = any>(table: DocTable, id: string): Promise<T | undefined> {
    this.check();
    if (table === "sessions") {
      const row = this.one(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`,
        id,
      );
      return row && (storedSession(row) as T);
    }
    const row = this.one(`SELECT body FROM ${table} WHERE id = ?`, id);
    return row && bodyOf<T>(row);
  }

  async put(table: DocTable, id: string, body: unknown): Promise<void> {
    this.check();
    let value = body;
    if (table === "sessions" && body && typeof body === "object")
      value = Object.fromEntries(
        Object.entries(body).filter(([key]) => !OWNERSHIP_KEYS.has(key)),
      );
    this.run(
      `INSERT INTO ${table}(id, body) VALUES(?, ?)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body`,
      id,
      toJson(value),
    );
  }

  async delete(table: DocTable, id: string): Promise<void> {
    this.check();
    this.run(`DELETE FROM ${table} WHERE id = ?`, id);
    if (table === "sessions")
      this.run("DELETE FROM events WHERE session_id = ?", id);
  }

  private sessionRows<T extends SessionDoc>(
    where: string,
    params: unknown[],
    tail = "ORDER BY id",
  ): StoredSession<T>[] {
    return this.all(
      `SELECT ${SESSION_COLUMNS} FROM sessions ${where} ${tail}`,
      ...params,
    ).map((row) => storedSession<T>(row));
  }

  // --- ordering ------------------------------------------------------------

  async lockSession<T extends SessionDoc = SessionDoc>(
    id: string,
  ): Promise<StoredSession<T> | undefined> {
    // The transaction already holds the database write lock.
    return this.get<StoredSession<T>>("sessions", id);
  }

  async event(
    sessionId: string,
    turnId: string | null,
    type: string,
    payload: unknown,
  ): Promise<LiveEvent> {
    this.check();
    const row = this.one(
      `UPDATE sessions SET next_event_seq = next_event_seq + 1
       WHERE id = ? RETURNING next_event_seq - 1 AS seq`,
      sessionId,
    );
    if (!row) throw new Error(`Session ${sessionId} not found`);
    const seq = Number(row.seq);
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
    this.run(
      "INSERT INTO events(session_id, seq, body, relayed) VALUES(?, ?, ?, 0)",
      sessionId,
      seq,
      JSON.stringify(event),
    );
    this.events.push(event);
    return structuredClone(event);
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
    const row = this.one(
      "SELECT owner, epoch, owner_expires_at FROM sessions WHERE id = ?",
      sessionId,
    );
    if (!row) return { status: "missing" };
    const previous = ownership(row);
    if (
      previous.owner !== null &&
      previous.ownerExpiresAt !== null &&
      Date.parse(previous.ownerExpiresAt) > claim.now.getTime()
    )
      return {
        status: "busy",
        owner: previous.owner,
        ownerExpiresAt: previous.ownerExpiresAt,
      };
    const expires = new Date(claim.now.getTime() + claim.leaseMs).toISOString();
    const updated = this.one(
      `UPDATE sessions SET owner = ?, epoch = epoch + 1, owner_expires_at = ?
       WHERE id = ? RETURNING epoch`,
      claim.owner,
      expires,
      sessionId,
    );
    return {
      status: "owned",
      epoch: Number(updated!.epoch),
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
    return (
      this.run(
        `UPDATE sessions SET owner_expires_at = ?
         WHERE id = ? AND owner = ? AND epoch = ?`,
        until.toISOString(),
        sessionId,
        owner,
        epoch,
      ) > 0
    );
  }

  async releaseOwnership(
    sessionId: string,
    owner: string,
    epoch: number,
  ): Promise<boolean> {
    this.check();
    return (
      this.run(
        `UPDATE sessions SET owner = NULL, owner_expires_at = NULL
         WHERE id = ? AND owner = ? AND epoch = ?`,
        sessionId,
        owner,
        epoch,
      ) > 0
    );
  }

  async assertEpoch<T extends SessionDoc = SessionDoc>(
    sessionId: string,
    epoch: number,
  ): Promise<StoredSession<T>> {
    const session = await this.lockSession<T>(sessionId);
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
    if (statuses.length === 0) return [];
    return this.sessionRows<T>(
      `WHERE status IN (${placeholders(statuses)})`,
      [...statuses],
    );
  }

  async orphanedSessions<T extends SessionDoc = SessionDoc>(
    now: Date,
    limit: number,
  ): Promise<StoredSession<T>[]> {
    this.check();
    return this.sessionRows<T>(
      `WHERE status IN ('running', 'runnable')
         AND (owner IS NULL OR owner_expires_at IS NULL OR owner_expires_at <= ?)`,
      [now.toISOString(), limit],
      `ORDER BY CASE WHEN owner IS NULL THEN NULL ELSE owner_expires_at END ASC NULLS FIRST, id
       LIMIT ?`,
    );
  }

  async listSessions<T extends SessionDoc = SessionDoc>(
    filter: { agentId?: string } = {},
  ): Promise<StoredSession<T>[]> {
    this.check();
    return filter.agentId === undefined
      ? this.sessionRows<T>("", [])
      : this.sessionRows<T>("WHERE agent_id = ?", [filter.agentId]);
  }

  private bodies<T>(table: DocTable): T[] {
    return this.all(`SELECT body FROM ${table} ORDER BY id`).map(bodyOf<T>);
  }

  async listDefinitions<T extends DefinitionDoc = DefinitionDoc>(): Promise<
    T[]
  > {
    this.check();
    return this.bodies<T>("definitions");
  }

  async listSandboxes<T extends SandboxDoc = SandboxDoc>(): Promise<T[]> {
    this.check();
    return this.bodies<T>("sandboxes");
  }

  async expiredClaims(now: Date, limit: number): Promise<ActionDoc[]> {
    this.check();
    return this.all(
      `SELECT body FROM actions
       WHERE status = 'claimed' AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?
       ORDER BY lease_expires_at, id
       LIMIT ?`,
      now.toISOString(),
      limit,
    ).map(bodyOf<ActionDoc>);
  }

  async pendingActions(agentId: string): Promise<ActionDoc[]> {
    this.check();
    return this.all(
      `SELECT body FROM actions WHERE agent_id = ? AND status = 'pending'
       ORDER BY id`,
      agentId,
    ).map(bodyOf<ActionDoc>);
  }

  private filtered<T>(
    table: "actions" | "effects",
    conditions: string[],
    params: unknown[],
    turnId: string | undefined,
    statuses: readonly string[] | undefined,
  ): T[] {
    if (turnId !== undefined) {
      conditions.push("turn_id = ?");
      params.push(turnId);
    }
    if (statuses !== undefined) {
      if (statuses.length === 0) return [];
      conditions.push(`status IN (${placeholders(statuses)})`);
      params.push(...statuses);
    }
    return this.all(
      `SELECT body FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY id`,
      ...params,
    ).map(bodyOf<T>);
  }

  async actionsForSession(
    sessionId: string,
    filter: SessionActionFilter = {},
  ): Promise<ActionDoc[]> {
    this.check();
    return this.filtered<ActionDoc>(
      "actions",
      ["session_id = ?"],
      [sessionId],
      filter.turnId,
      filter.statuses,
    );
  }

  async actionsWithStatus(
    statuses: readonly ActionStatus[],
    filter: { kinds?: readonly ActionKind[] } = {},
  ): Promise<ActionDoc[]> {
    this.check();
    return this.withStatusAndKind<ActionDoc>("actions", statuses, filter.kinds);
  }

  private withStatusAndKind<T>(
    table: "actions" | "effects",
    statuses: readonly string[],
    kinds: readonly string[] | undefined,
  ): T[] {
    if (statuses.length === 0 || kinds?.length === 0) return [];
    const params: unknown[] = [...statuses];
    let where = `status IN (${placeholders(statuses)})`;
    if (kinds !== undefined) {
      where += ` AND kind IN (${placeholders(kinds)})`;
      params.push(...kinds);
    }
    return this.all(
      `SELECT body FROM ${table} WHERE ${where} ORDER BY id`,
      ...params,
    ).map(bodyOf<T>);
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
    return this.filtered<T>(
      "effects",
      ["session_id = ?"],
      [sessionId],
      filter.turnId,
      filter.statuses,
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
    return this.withStatusAndKind<T>("effects", statuses, filter.kinds);
  }

  async linkedSessions<S extends SessionDoc = SessionDoc>(
    workflowSessionId: string,
  ): Promise<LinkedSession<S>[]> {
    this.check();
    return this.all(
      `SELECT l.id AS agent_session_id, l.body AS link,
              s.body, s.owner, s.epoch, s.owner_expires_at
       FROM links l JOIN sessions s ON s.id = l.id
       WHERE l.workflow_session_id = ?
       ORDER BY l.id`,
      workflowSessionId,
    ).map((row) => ({
      agentSessionId: String(row.agent_session_id),
      link: JSON.parse(String(row.link)) as LinkDoc,
      session: storedSession<S>(row),
    }));
  }

  async counts(): Promise<StoreCounts> {
    this.check();
    const row = this.one(
      `SELECT
         (SELECT count(*) FROM sessions) AS sessions,
         (SELECT count(*) FROM sessions WHERE status IN ('running', 'runnable')) AS running,
         (SELECT count(*) FROM actions WHERE status IN ('pending', 'claimed')) AS actions,
         (SELECT count(*) FROM effects WHERE status = 'uncertain') AS uncertain,
         (SELECT count(*) FROM sandboxes) AS sandboxes,
         (SELECT count(*) FROM definitions) AS definitions`,
    )!;
    return {
      sessions: Number(row.sessions),
      runningSessions: Number(row.running),
      pendingActions: Number(row.actions),
      uncertainEffects: Number(row.uncertain),
      sandboxes: Number(row.sandboxes),
      definitions: Number(row.definitions),
    };
  }

  // --- outbox --------------------------------------------------------------

  async outbox(
    limit: number,
    filter: { sessionId?: string } = {},
  ): Promise<OutboxRow[]> {
    this.check();
    const rows =
      filter.sessionId === undefined
        ? this.all(
            `SELECT session_id, seq, body FROM events WHERE relayed = 0
             ORDER BY session_id, seq LIMIT ?`,
            limit,
          )
        : this.all(
            `SELECT session_id, seq, body FROM events
             WHERE relayed = 0 AND session_id = ?
             ORDER BY seq LIMIT ?`,
            filter.sessionId,
            limit,
          );
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      seq: Number(row.seq),
      event: bodyOf<LiveEvent>(row),
    }));
  }

  async deleteOutbox(sessionId: string, throughSeq: number): Promise<number> {
    this.check();
    // Relayed events stay as the session history (see the module comment).
    return this.run(
      `UPDATE events SET relayed = 1
       WHERE session_id = ? AND seq <= ? AND relayed = 0`,
      sessionId,
      throughSeq,
    );
  }

  // --- executors -----------------------------------------------------------

  async listExecutors(): Promise<ExecutorRow[]> {
    this.check();
    return this.all("SELECT * FROM executors ORDER BY agent_id").map(
      executorRow,
    );
  }

  async getExecutor(agentId: string): Promise<ExecutorRow | undefined> {
    this.check();
    const row = this.one("SELECT * FROM executors WHERE agent_id = ?", agentId);
    return row && executorRow(row);
  }

  async putExecutor(row: Omit<ExecutorRow, "createdAt">): Promise<void> {
    this.check();
    this.run(
      `INSERT INTO executors(agent_id, token_hash, implementation_version,
         manifest_hash, principal_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         implementation_version = excluded.implementation_version,
         manifest_hash = excluded.manifest_hash,
         principal_id = excluded.principal_id,
         updated_at = excluded.updated_at`,
      row.agentId,
      row.tokenHash,
      row.implementationVersion,
      row.manifestHash ?? null,
      row.principalId ?? null,
      row.updatedAt,
      row.updatedAt,
    );
  }

  async deleteExecutor(agentId: string): Promise<void> {
    this.check();
    this.run("DELETE FROM executors WHERE agent_id = ?", agentId);
  }

  // --- principals ----------------------------------------------------------

  async insertPrincipal(row: PrincipalRow): Promise<void> {
    this.check();
    this.run(
      `INSERT INTO principals(id, role, token_hash, idempotency_key, created_at)
       VALUES(?, ?, ?, ?, ?)`,
      row.id,
      row.role,
      row.tokenHash,
      row.idempotencyKey,
      row.createdAt,
    );
  }

  async principalByTokenHash(
    tokenHash: string,
  ): Promise<PrincipalRow | undefined> {
    this.check();
    const row = this.one(
      "SELECT * FROM principals WHERE token_hash = ?",
      tokenHash,
    );
    return row && principalRow(row);
  }

  async principalById(id: string): Promise<PrincipalRow | undefined> {
    this.check();
    const row = this.one("SELECT * FROM principals WHERE id = ?", id);
    return row && principalRow(row);
  }

  async applicationTokenHashes(): Promise<string[]> {
    this.check();
    return this.all(
      "SELECT token_hash FROM principals WHERE role = 'application' ORDER BY id",
    ).map((row) => String(row.token_hash));
  }

  // --- vault ---------------------------------------------------------------

  async insertVault(row: VaultRow): Promise<void> {
    this.check();
    this.run(
      `INSERT INTO vaults(id, name, owner_user_id, metadata_json, created_at, scope)
       VALUES(?, ?, ?, ?, ?, ?)`,
      row.id,
      row.name,
      row.ownerUserId,
      row.metadataJson,
      row.createdAt,
      row.scope,
    );
  }

  async getVault(id: string): Promise<VaultRow | undefined> {
    this.check();
    const row = this.one("SELECT * FROM vaults WHERE id = ?", id);
    return row && vaultRow(row);
  }

  async vaultsByOwner(ownerUserId: string): Promise<VaultRow[]> {
    this.check();
    return this.all(
      `SELECT * FROM vaults WHERE owner_user_id = ? AND scope = 'user'
       ORDER BY created_at, id`,
      ownerUserId,
    ).map(vaultRow);
  }

  async updateVaultMetadata(
    id: string,
    metadataJson: string | null,
  ): Promise<void> {
    this.check();
    this.run("UPDATE vaults SET metadata_json = ? WHERE id = ?", metadataJson, id);
  }

  async deleteVault(id: string): Promise<void> {
    this.check();
    this.run("DELETE FROM vault_credentials WHERE vault_id = ?", id);
    this.run("DELETE FROM vaults WHERE id = ?", id);
  }

  async insertCredential(row: VaultCredentialRow): Promise<void> {
    this.check();
    if (!this.one("SELECT 1 AS ok FROM vaults WHERE id = ?", row.vaultId))
      throw new Error("vault_credentials.vault_id references a missing vault");
    this.run(
      `INSERT INTO vault_credentials(id, vault_id, name, type, binding_json,
         expires_at, created_at, rotated_at, kek_id, nonce, ciphertext, wrapped_dek)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.vaultId,
      row.name,
      row.type,
      row.bindingJson,
      row.expiresAt,
      row.createdAt,
      row.rotatedAt,
      row.kekId,
      row.nonce,
      row.ciphertext,
      row.wrappedDek,
    );
  }

  async getCredential(id: string): Promise<VaultCredentialRow | undefined> {
    this.check();
    const row = this.one("SELECT * FROM vault_credentials WHERE id = ?", id);
    return row && credentialRow(row);
  }

  async credentialsForVault(
    vaultId: string,
    filter: { type?: VaultCredentialRow["type"] } = {},
  ): Promise<VaultCredentialRow[]> {
    this.check();
    const rows =
      filter.type === undefined
        ? this.all(
            `SELECT * FROM vault_credentials WHERE vault_id = ?
             ORDER BY created_at, id`,
            vaultId,
          )
        : this.all(
            `SELECT * FROM vault_credentials WHERE vault_id = ? AND type = ?
             ORDER BY created_at, id`,
            vaultId,
            filter.type,
          );
    return rows.map(credentialRow);
  }

  async updateCredential(
    vaultId: string,
    id: string,
    patch: VaultCredentialPatch,
  ): Promise<boolean> {
    this.check();
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [field, column] of Object.entries(CREDENTIAL_COLUMNS)) {
      const value = patch[field as keyof VaultCredentialPatch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length === 0)
      return !!this.one(
        "SELECT 1 AS ok FROM vault_credentials WHERE vault_id = ? AND id = ?",
        vaultId,
        id,
      );
    return (
      this.run(
        `UPDATE vault_credentials SET ${sets.join(", ")}
         WHERE vault_id = ? AND id = ?`,
        ...params,
        vaultId,
        id,
      ) > 0
    );
  }

  async deleteCredential(vaultId: string, id: string): Promise<boolean> {
    this.check();
    return (
      this.run(
        "DELETE FROM vault_credentials WHERE vault_id = ? AND id = ?",
        vaultId,
        id,
      ) > 0
    );
  }

  async countCredentials(): Promise<number> {
    this.check();
    return Number(
      this.one("SELECT count(*) AS n FROM vault_credentials")!.n,
    );
  }

  async insertVaultAudit(row: VaultAuditRow): Promise<void> {
    this.check();
    this.run(
      `INSERT INTO vault_audit(id, at, actor, action, vault_id, credential_id,
         session_id, target, outcome)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.at,
      row.actor,
      row.action,
      row.vaultId,
      row.credentialId,
      row.sessionId,
      row.target,
      row.outcome,
    );
  }

  async vaultAudit(
    filter: { vaultId?: string; limit?: number } = {},
  ): Promise<VaultAuditRow[]> {
    this.check();
    const limit = filter.limit ?? -1;
    const rows =
      filter.vaultId === undefined
        ? this.all("SELECT * FROM vault_audit ORDER BY rowid LIMIT ?", limit)
        : this.all(
            "SELECT * FROM vault_audit WHERE vault_id = ? ORDER BY rowid LIMIT ?",
            filter.vaultId,
            limit,
          );
    return rows.map(auditRow);
  }

  async getVaultIdempotency(
    id: string,
  ): Promise<VaultIdempotencyRow | undefined> {
    this.check();
    const row = this.one(
      "SELECT id, body_hash, response FROM vault_idempotency WHERE id = ?",
      id,
    );
    return (
      row && {
        id: String(row.id),
        bodyHash: String(row.body_hash),
        response: String(row.response),
      }
    );
  }

  async insertVaultIdempotency(row: VaultIdempotencyRow): Promise<void> {
    this.check();
    this.run(
      "INSERT INTO vault_idempotency(id, body_hash, response) VALUES(?, ?, ?)",
      row.id,
      row.bodyHash,
      row.response,
    );
  }

  // --- settings ------------------------------------------------------------

  async getSetting(key: string): Promise<string | undefined> {
    this.check();
    const row = this.one("SELECT value FROM tenant_settings WHERE key = ?", key);
    return row ? String(row.value) : undefined;
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.check();
    this.run(
      `INSERT INTO tenant_settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  // --- reset ---------------------------------------------------------------

  async reset(scope: ResetScope): Promise<void> {
    this.check();
    if (scope === "sessions" || scope === "all")
      for (const table of SESSION_TABLES) this.run(`DELETE FROM ${table}`);
    if (scope === "sandboxes" || scope === "all")
      this.run("DELETE FROM sandboxes");
    if (scope === "all") {
      this.run("DELETE FROM definitions");
      this.run("DELETE FROM executors");
      this.run(
        "DELETE FROM vault_credentials WHERE vault_id IN (SELECT id FROM vaults WHERE scope <> 'host')",
      );
      this.run("DELETE FROM vaults WHERE scope <> 'host'");
    }
  }
}
