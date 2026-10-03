/**
 * The Postgres Session Store (architecture §12.2, session-store.md §2–§3): the `SessionStore`
 * of the one Tenant a database holds, its state in the schema `nylorun` and its record in
 * `nylorun_streams`, queried through Drizzle (`schema.ts`). See `store/types.ts` for the
 * invariants it keeps.
 *
 * ## Queries
 *
 * Plain reads and writes use Drizzle's query builder: `.set(patch)` and `and(...)` skip
 * `undefined`, rows come back in the camelCase of `schema.ts`. Statements whose logic is SQL
 * stay `sql` fragments inside it: the endpoint upsert's `CASE` arms, the log-head upsert,
 * `orphanedSessions`' ordering, `counts()`, advisory locks and array updates.
 *
 * ## Transactions
 *
 * Every `tx` is one READ COMMITTED transaction on a pooled connection (Drizzle's
 * `transaction` on postgres.js `begin`). Tables are addressed by schema-qualified names,
 * never through `search_path`. Commit listeners and `afterCommit` callbacks run after `COMMIT`
 * returns and never reject the committed `tx`. Nested `tx` calls are detected with
 * `AsyncLocalStorage` and rejected, and a `Tx` rejects every call once its callback settles.
 * A failed statement rejects `tx` with the driver's error (`driverError`), not Drizzle's
 * wrapper, so its SQLSTATE is `code`.
 *
 * ## Lock ordering
 *
 * `lockSession`, `event`, `takeOwnership` and `assertEpoch` take the session
 * row lock (`SELECT … FOR UPDATE` or `UPDATE`), held until the transaction
 * ends. To stay deadlock-free:
 *
 * 1. A session-scoped transaction locks its session row before writing any
 *    other row of that session (effects, actions, its record rows and log
 *    head).
 * 2. A transaction that touches several sessions locks them in ascending id
 *    order, with `lockSessions` (`./locking.ts`), before writing any of them.
 * 3. A sandbox resource's row (`sandboxResource(id, { lock: true })`, which orders its
 *    lifecycle stream) is locked after every session row the transaction locks, never
 *    before one.
 *
 * Serialization failures and deadlocks are not retried here: with the order
 * above, READ COMMITTED transactions do not raise them. A `40P01` means a
 * caller broke the order, and it surfaces as the rejection of `tx`.
 *
 * ## Values
 *
 * Document and event bodies are `json`, stored as the text `JSON.stringify`
 * wrote (`jsonText` in `schema.ts`), so every string round-trips, including U+0000 and
 * unpaired surrogates that `jsonb` rejects, and key order is kept. Ids and ISO timestamps
 * compared as text are `COLLATE "C"`. Delivery deadlines in action bodies are compared as
 * `timestamptz`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  and,
  count,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import type {
  EventPayload,
  EventType,
  LiveEvent,
  SandboxEvent,
  SandboxEventPayload,
  SandboxEventType,
  SessionEventOf,
} from "@nylorun/core/contracts";
import type { RecordReader } from "../../streams/relay/types.js";
import { appendEvent, appendSandboxEvent } from "../../record/index.js";
import { OwnershipLostError } from "../ownership.js";
import type {
  ActionDoc,
  ActionKind,
  ActionStatus,
  CommitListener,
  DefinitionDoc,
  DocTable,
  EffectDoc,
  EffectKind,
  EndpointHealthUpdate,
  EndpointRegistrationRow,
  EndpointRow,
  LinkDoc,
  LinkedSession,
  BasinGenerations,
  PrincipalRow,
  ResetScope,
  SandboxDoc,
  SandboxResource,
  SessionActionFilter,
  SessionDoc,
  SessionEffectFilter,
  SessionOwnership,
  SessionRunState,
  SessionStore,
  SessionStoreOptions,
  StoreCounts,
  StoreHealth,
  SigningKeyRow,
  PublishableKeyRow,
  SubjectUsageRow,
  ModelBudgetRow,
  ModelUsageQuery,
  ModelUsageRow,
  ModelUsageTotals,
  StoredSession,
  ToolCrossingRow,
  TakeOwnership,
  Tx,
  VaultAuditRow,
  VaultCredentialPatch,
  VaultCredentialRow,
  VaultIdempotencyRow,
  VaultRow,
} from "../types.js";
import { database, driverError, type Database, type Transaction } from "./db.js";
import { expectedSchemaVersion, readSchemaVersion } from "./migrate.js";
import { createPostgresRecordReader } from "./record.js";
import { postgresRecordWriter, postgresSandboxRecordWriter } from "./record-writer.js";
import {
  actions,
  commands,
  definitions,
  effects,
  endpoints,
  links,
  modelBudgets,
  modelUsage,
  principals,
  publishableKeys,
  sandboxes,
  sandboxEvents,
  sandboxResources,
  sessionEvents,
  sessionLogHeads,
  sessions,
  toJson,
  toolCrossings,
  signingKeys,
  subjectEpochs,
  subjectUsage,
  tenant,
  tenantSettings,
  vaultAudit,
  vaultCredentials,
  vaultIdempotency,
  vaults,
} from "./schema.js";

export interface PostgresSessionStoreOptions extends SessionStoreOptions {
  /** The pool on the Tenant's database. The store never ends it. */
  sql: Sql;
  /** The schema version `health()` expects. Defaults to the shipped migrations' count. */
  schemaVersion?: number;
}

export function createPostgresSessionStore(
  options: PostgresSessionStoreOptions,
): SessionStore {
  return new PostgresSessionStore(options);
}

const OPEN_SESSION = ["running", "runnable"];

/** Every document table has `id` and `body`; `sessions` has more. */
type DocumentTable = typeof definitions;
const DOCUMENTS: Record<DocTable, DocumentTable> = {
  definitions,
  sessions: sessions as unknown as DocumentTable,
  commands,
  effects: effects as unknown as DocumentTable,
  actions: actions as unknown as DocumentTable,
  sandboxes,
  links: links as unknown as DocumentTable,
};

/** A session row as `StoredSession` reads it: the body and the ownership columns. */
const SESSION = {
  body: sessions.body,
  owner: sessions.owner,
  epoch: sessions.epoch,
  ownerExpiresAt: sessions.ownerExpiresAt,
};

class PostgresSessionStore implements SessionStore {
  readonly tenantId: string;
  private readonly sql: Sql;
  private readonly db: Database;
  private readonly schemaVersion: number;
  private readonly active = new AsyncLocalStorage<PostgresSessionStore>();
  private readonly listeners = new Set<CommitListener>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private closed = false;

  constructor(options: PostgresSessionStoreOptions) {
    this.tenantId = options.tenantId;
    this.sql = options.sql;
    this.db = database(options.sql);
    this.schemaVersion = options.schemaVersion ?? expectedSchemaVersion();
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
    let t!: PostgresTx;
    // Wrapped so `begin` does not treat an array result as queries to await.
    const run = this.db.transaction(
      async (db) => {
        t = new PostgresTx(db, this.tenantId, this.now);
        try {
          return { value: await this.active.run(this, () => fn(t)) };
        } finally {
          t.closed = true;
        }
      },
      { isolationLevel: "read committed" },
    );
    this.inflight.add(run);
    let result: { value: T };
    try {
      result = await run;
    } catch (error) {
      throw driverError(error);
    } finally {
      this.inflight.delete(run);
    }
    if (t.events.length > 0) {
      const commit = {
        events: t.events,
        generations: t.generations,
      };
      for (const listener of [...this.listeners]) {
        try {
          listener(commit);
        } catch (error) {
          this.onError(error);
        }
      }
    }
    for (const callback of t.callbacks) {
      try {
        await callback();
      } catch (error) {
        this.onError(error);
      }
    }
    return result.value;
  }

  onCommit(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(): RecordReader {
    return createPostgresRecordReader(this.sql, { tenantId: this.tenantId });
  }

  async health(): Promise<StoreHealth> {
    const expectedSchemaVersion = this.schemaVersion;
    if (this.closed)
      return { ok: false, schemaVersion: 0, expectedSchemaVersion };
    try {
      const schemaVersion = (await readSchemaVersion(this.db)) ?? 0;
      return {
        ok: schemaVersion === expectedSchemaVersion,
        schemaVersion,
        expectedSchemaVersion,
      };
    } catch {
      return { ok: false, schemaVersion: 0, expectedSchemaVersion };
    }
  }

  /** Rejects new transactions and waits for running ones. Does not end the pool. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.inflight]);
  }
}

// ---------------------------------------------------------------------------

interface SessionOwnershipRow {
  owner: string | null;
  epoch: number;
  ownerExpiresAt: Date | null;
}

function storedSession<T extends SessionDoc>(
  row: SessionOwnershipRow & { body: unknown },
): StoredSession<T> {
  return { ...(row.body as T), ...ownership(row) };
}

function ownership(row: SessionOwnershipRow): SessionOwnership {
  return {
    owner: row.owner,
    epoch: row.epoch,
    ownerExpiresAt: row.ownerExpiresAt?.toISOString() ?? null,
  };
}

function sandboxResourceOf(row: typeof sandboxResources.$inferSelect): SandboxResource {
  return {
    id: row.id,
    kind: row.kind,
    spec: row.spec as SandboxResource["spec"],
    labels: row.labels as Record<string, string>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** An endpoint row with its unset (null) columns left out, as `EndpointRow` has them. */
function endpointRow(row: typeof endpoints.$inferSelect): EndpointRow {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null),
  ) as unknown as EndpointRow;
}

/** The time column a signing key's new state stamps. */
const SIGNING_KEY_STAMP: Partial<
  Record<SigningKeyRow["state"], "activatedAt" | "retiredAt" | "revokedAt">
> = {
  current: "activatedAt",
  previous: "retiredAt",
  revoked: "revokedAt",
};

/** The audit columns a row has (`ord` only orders them). */
const { ord: _ord, ...AUDIT } = getTableColumns(vaultAudit);

const SESSION_TABLES = [sessions, commands, effects, actions, links];

/** The inserted row's `column` (`ON CONFLICT … DO UPDATE`). */
const excluded = (column: string): SQL => sql.raw(`excluded.${column}`);

/** Keeps an endpoint's health `column` when its URL stays; a new URL starts with `fresh`. */
const sameUrl = (column: SQL, fresh: SQL = sql`NULL`): SQL =>
  sql`CASE WHEN ${endpoints.url} = excluded.url THEN ${column} ELSE ${fresh} END`;

class PostgresTx implements Tx {
  closed = false;
  readonly events: LiveEvent[] = [];
  readonly generations: number[] = [];
  readonly callbacks: (() => void | Promise<void>)[] = [];

  constructor(
    private readonly db: Transaction,
    private readonly tenantId: string,
    private readonly now: () => Date,
  ) {}

  private check(): void {
    if (this.closed) throw new Error("Tx used after its transaction ended");
  }

  // --- documents -----------------------------------------------------------

  async get<T = any>(table: DocTable, id: string): Promise<T | undefined> {
    this.check();
    if (table === "sessions") {
      const [row] = await this.sessions().where(eq(sessions.id, id));
      return row && (storedSession(row) as T);
    }
    const t = DOCUMENTS[table];
    const [row] = await this.db.select({ body: t.body }).from(t).where(eq(t.id, id));
    return row?.body as T | undefined;
  }

  async put(table: DocTable, id: string, body: unknown): Promise<void> {
    this.check();
    let value = body;
    if (table === "sessions" && body && typeof body === "object") {
      // Ownership is store-managed: never in the body.
      const { owner: _owner, epoch: _epoch, ownerExpiresAt: _expires, ...rest } =
        body as Record<string, unknown>;
      value = rest;
    }
    const t = DOCUMENTS[table];
    await this.db
      .insert(t)
      .values({ id, body: value })
      .onConflictDoUpdate({ target: t.id, set: { body: excluded("body") } });
  }

  async delete(table: DocTable, id: string): Promise<void> {
    this.check();
    // A session's record rows and log head stay: a session created again with this id
    // continues its log (per-session record deletion is deferred, Durable Streams §15).
    const t = DOCUMENTS[table];
    await this.db.delete(t).where(eq(t.id, id));
  }

  private sessions() {
    return this.db.select(SESSION).from(sessions).$dynamic();
  }

  // --- ordering ------------------------------------------------------------

  async lockSession<T extends SessionDoc = SessionDoc>(
    id: string,
  ): Promise<StoredSession<T> | undefined> {
    this.check();
    const [row] = await this.sessions().where(eq(sessions.id, id)).for("update");
    return row && storedSession<T>(row);
  }

  async event<T extends EventType>(
    sessionId: string,
    turnId: string | null,
    type: T,
    payload: EventPayload<T>,
  ): Promise<SessionEventOf<T>> {
    this.check();
    const db = this.db;
    // The session row lock orders the session's events; the log head allocates under it.
    const [session] = await db
      .select({ epoch: sessions.epoch })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for("update");
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const { event, generation } = await appendEvent(postgresRecordWriter(db), {
      tenantId: this.tenantId,
      sessionId,
      turnId,
      epoch: session.epoch,
      time: this.now(),
      type,
      payload,
    });
    this.events.push(event);
    this.generations.push(generation);
    return structuredClone(event);
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
    const [row] = await this.sessions().where(eq(sessions.id, sessionId)).for("update");
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
    const [updated] = await this.db
      .update(sessions)
      .set({
        owner: claim.owner,
        epoch: sql`${sessions.epoch} + 1`,
        ownerExpiresAt: new Date(claim.now.getTime() + claim.leaseMs),
      })
      .where(eq(sessions.id, sessionId))
      .returning({ epoch: sessions.epoch });
    return {
      status: "owned",
      epoch: updated!.epoch,
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
    const result = await this.db
      .update(sessions)
      .set({ ownerExpiresAt: until })
      .where(and(eq(sessions.id, sessionId), eq(sessions.owner, owner), eq(sessions.epoch, epoch)));
    return result.count > 0;
  }

  async releaseOwnership(
    sessionId: string,
    owner: string,
    epoch: number,
  ): Promise<boolean> {
    this.check();
    const result = await this.db
      .update(sessions)
      .set({ owner: null, ownerExpiresAt: null })
      .where(and(eq(sessions.id, sessionId), eq(sessions.owner, owner), eq(sessions.epoch, epoch)));
    return result.count > 0;
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

  async runState(sessionId: string): Promise<SessionRunState | undefined> {
    this.check();
    const [row] = await this.db
      .select({
        epoch: sessions.epoch,
        status: sessions.status,
        activeTurnId: sql<string | null>`nylorun.doc(${sessions.body})->>'activeTurnId'`,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row && { epoch: row.epoch, status: row.status ?? "", activeTurnId: row.activeTurnId ?? null };
  }

  // --- typed queries -------------------------------------------------------

  async sessionsWithStatus<T extends SessionDoc = SessionDoc>(
    statuses: readonly string[],
  ): Promise<StoredSession<T>[]> {
    this.check();
    const rows = await this.sessions()
      .where(inArray(sessions.status, statuses))
      .orderBy(sessions.id);
    return rows.map((row) => storedSession<T>(row));
  }

  async orphanedSessions<T extends SessionDoc = SessionDoc>(
    now: Date,
    limit: number,
  ): Promise<StoredSession<T>[]> {
    this.check();
    const rows = await this.sessions()
      .where(
        and(
          inArray(sessions.status, OPEN_SESSION),
          or(
            isNull(sessions.owner),
            isNull(sessions.ownerExpiresAt),
            lte(sessions.ownerExpiresAt, now),
          ),
        ),
      )
      // Never-owned sessions first, then the longest expired.
      .orderBy(
        sql`CASE WHEN ${sessions.owner} IS NULL THEN NULL ELSE ${sessions.ownerExpiresAt} END ASC NULLS FIRST`,
        sessions.id,
      )
      .limit(limit);
    return rows.map((row) => storedSession<T>(row));
  }

  async listSessions<T extends SessionDoc = SessionDoc>(
    filter: { agentId?: string; ownerUserId?: string } = {},
  ): Promise<StoredSession<T>[]> {
    this.check();
    const rows = await this.sessions()
      .where(
        and(
          filter.agentId === undefined ? undefined : eq(sessions.agentId, filter.agentId),
          filter.ownerUserId === undefined
            ? undefined
            : eq(sessions.ownerUserId, filter.ownerUserId),
        ),
      )
      .orderBy(sessions.id);
    return rows.map((row) => storedSession<T>(row));
  }

  private async bodies<T>(table: DocumentTable): Promise<T[]> {
    const rows = await this.db.select({ body: table.body }).from(table).orderBy(table.id);
    return rows.map((row) => row.body as T);
  }

  async listDefinitions<T extends DefinitionDoc = DefinitionDoc>(): Promise<T[]> {
    this.check();
    return this.bodies<T>(definitions);
  }

  async listSandboxes<T extends SandboxDoc = SandboxDoc>(): Promise<T[]> {
    this.check();
    return this.bodies<T>(sandboxes);
  }

  // --- sandbox resources ---------------------------------------------------

  async sandboxResource(
    id: string,
    options: { lock?: boolean } = {},
  ): Promise<SandboxResource | undefined> {
    this.check();
    const query = this.db.select().from(sandboxResources).where(eq(sandboxResources.id, id));
    const [row] = options.lock ? await query.for("update") : await query;
    return row && sandboxResourceOf(row);
  }

  async createSandboxResource(
    row: SandboxResource,
    limit: number,
  ): Promise<"created" | "exists" | "limit"> {
    this.check();
    // Every create takes this lock, so two never both see room for one more.
    await this.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('nylorun.sandbox_resources'))`);
    const [found] = await this.db
      .select({ id: sandboxResources.id })
      .from(sandboxResources)
      .where(eq(sandboxResources.id, row.id));
    if (found) return "exists";
    const [counted] = await this.db.select({ n: count() }).from(sandboxResources);
    if ((counted?.n ?? 0) >= limit) return "limit";
    await this.db.insert(sandboxResources).values(row);
    return "created";
  }

  async updateSandboxLabels(
    id: string,
    labels: Record<string, string>,
    updatedAt: string,
  ): Promise<void> {
    this.check();
    await this.db
      .update(sandboxResources)
      .set({ labels, updatedAt })
      .where(eq(sandboxResources.id, id));
  }

  async deleteSandboxResource(id: string): Promise<void> {
    this.check();
    await this.db.delete(sandboxResources).where(eq(sandboxResources.id, id));
  }

  async listSandboxResources(
    filter: { labels?: Record<string, string> } = {},
  ): Promise<SandboxResource[]> {
    this.check();
    const labels = filter.labels;
    const rows = await this.db
      .select()
      .from(sandboxResources)
      .where(
        labels === undefined || Object.keys(labels).length === 0
          ? undefined
          : sql`nylorun.doc(${sandboxResources.labels}) @> ${toJson(labels)}::jsonb`,
      )
      .orderBy(sandboxResources.id);
    return rows.map(sandboxResourceOf);
  }

  async sessionsOnSandbox<T extends SessionDoc = SessionDoc>(
    sandboxId: string,
  ): Promise<StoredSession<T>[]> {
    this.check();
    const rows = await this.sessions()
      .where(eq(sessions.sandboxId, sandboxId))
      .orderBy(sessions.id);
    return rows.map((row) => storedSession<T>(row));
  }

  async sandboxEvent<T extends SandboxEventType>(
    sandboxId: string,
    type: T,
    payload: SandboxEventPayload<T>,
  ): Promise<SandboxEvent> {
    this.check();
    return appendSandboxEvent(postgresSandboxRecordWriter(this.db), {
      tenantId: this.tenantId,
      sandboxId,
      time: this.now(),
      type,
      payload,
    });
  }

  async sandboxEvents(
    sandboxId: string,
    options: { fromSeq?: number; limit?: number } = {},
  ): Promise<SandboxEvent[]> {
    this.check();
    const rows = await this.db
      .select({ body: sandboxEvents.body })
      .from(sandboxEvents)
      .where(
        and(
          eq(sandboxEvents.sandboxId, sandboxId),
          options.fromSeq === undefined ? undefined : gte(sandboxEvents.seq, options.fromSeq),
        ),
      )
      .orderBy(sandboxEvents.seq)
      .limit(options.limit ?? 1000);
    return rows.map((row) => row.body as SandboxEvent);
  }

  private async actionBodies(where: SQL | undefined): Promise<ActionDoc[]> {
    const rows = await this.db
      .select({ body: actions.body })
      .from(actions)
      .where(where)
      .orderBy(actions.id);
    return rows.map((row) => row.body as ActionDoc);
  }

  async pendingActions(agentId: string): Promise<ActionDoc[]> {
    this.check();
    return this.actionBodies(and(eq(actions.agentId, agentId), eq(actions.status, "pending")));
  }

  async deliveringCount(agentId: string): Promise<number> {
    this.check();
    const [row] = await this.db
      .select({ n: count() })
      .from(actions)
      .where(and(eq(actions.agentId, agentId), eq(actions.status, "delivering")));
    return row!.n;
  }

  async pendingActionsWithEndpoint(limit: number): Promise<ActionDoc[]> {
    this.check();
    const rows = await this.db
      .select({ body: actions.body })
      .from(actions)
      .innerJoin(endpoints, eq(endpoints.agentId, actions.agentId))
      .where(eq(actions.status, "pending"))
      .orderBy(actions.id)
      .limit(limit);
    return rows.map((row) => row.body as ActionDoc);
  }

  async expiredDeliveries(now: Date, limit: number): Promise<ActionDoc[]> {
    this.check();
    const deadline = sql`${actions.deadlineAt}::timestamptz`;
    const rows = await this.db
      .select({ body: actions.body })
      .from(actions)
      .where(
        and(
          eq(actions.status, "delivering"),
          isNotNull(actions.deadlineAt),
          sql`${deadline} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(deadline, actions.id)
      .limit(limit);
    return rows.map((row) => row.body as ActionDoc);
  }

  async actionsForSession(
    sessionId: string,
    filter: SessionActionFilter = {},
  ): Promise<ActionDoc[]> {
    this.check();
    return this.actionBodies(
      and(
        eq(actions.sessionId, sessionId),
        filter.turnId === undefined ? undefined : eq(actions.turnId, filter.turnId),
        filter.statuses === undefined ? undefined : inArray(actions.status, filter.statuses),
      ),
    );
  }

  async actionsWithStatus(
    statuses: readonly ActionStatus[],
    filter: { kinds?: readonly ActionKind[] } = {},
  ): Promise<ActionDoc[]> {
    this.check();
    return this.actionBodies(
      and(
        inArray(actions.status, statuses),
        filter.kinds === undefined ? undefined : inArray(actions.kind, filter.kinds),
      ),
    );
  }

  private async effectBodies<T>(where: SQL | undefined): Promise<T[]> {
    const rows = await this.db
      .select({ body: effects.body })
      .from(effects)
      .where(where)
      .orderBy(effects.id);
    return rows.map((row) => row.body as T);
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
    return this.effectBodies<T>(
      and(
        eq(effects.sessionId, sessionId),
        filter.turnId === undefined ? undefined : eq(effects.turnId, filter.turnId),
        filter.statuses === undefined ? undefined : inArray(effects.status, filter.statuses),
      ),
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
    return this.effectBodies<T>(
      and(
        inArray(effects.status, statuses),
        filter.kinds === undefined ? undefined : inArray(effects.kind, filter.kinds),
      ),
    );
  }

  async linkedSessions<S extends SessionDoc = SessionDoc>(
    workflowSessionId: string,
  ): Promise<LinkedSession<S>[]> {
    this.check();
    const rows = await this.db
      .select({ id: links.id, link: links.body, ...SESSION })
      .from(links)
      .innerJoin(sessions, eq(sessions.id, links.id))
      .where(eq(links.workflowSessionId, workflowSessionId))
      .orderBy(links.id);
    return rows.map((row) => ({
      agentSessionId: row.id,
      link: row.link as LinkDoc,
      session: storedSession<S>(row),
    }));
  }

  async counts(): Promise<StoreCounts> {
    this.check();
    const [row] = await this.db.execute<{
      sessions: number;
      running: number;
      actions: number;
      uncertain: number;
      sandboxes: number;
      definitions: number;
    }>(sql`
      SELECT
        (SELECT count(*) FROM ${sessions})::int AS sessions,
        (SELECT count(*) FROM ${sessions}
          WHERE ${sessions.status} IN ('running', 'runnable'))::int AS running,
        (SELECT count(*) FROM ${actions}
          WHERE ${actions.status} IN ('pending', 'delivering'))::int AS actions,
        (SELECT count(*) FROM ${effects} WHERE ${effects.status} = 'uncertain')::int AS uncertain,
        (SELECT count(*) FROM ${sandboxes})::int AS sandboxes,
        (SELECT count(*) FROM ${definitions})::int AS definitions`);
    return {
      sessions: row!.sessions,
      runningSessions: row!.running,
      pendingActions: row!.actions,
      uncertainEffects: row!.uncertain,
      sandboxes: row!.sandboxes,
      definitions: row!.definitions,
    };
  }

  // --- basin generations --------------------------------------------------

  async basinGenerations(): Promise<BasinGenerations> {
    this.check();
    const [row] = await this.db
      .select({ current: tenant.basinGeneration, retired: tenant.retiredGenerations })
      .from(tenant);
    // A database whose Tenant row is not written yet is at generation 0.
    return row ?? { current: 0, retired: [] };
  }

  async forgetRetiredGeneration(generation: number): Promise<void> {
    this.check();
    await this.db.update(tenant).set({
      retiredGenerations: sql`array_remove(${tenant.retiredGenerations}, ${generation}::int)`,
    });
  }

  // --- Action endpoints -----------------------------------------------------

  async listEndpoints(): Promise<EndpointRow[]> {
    this.check();
    const rows = await this.db.select().from(endpoints).orderBy(endpoints.agentId);
    return rows.map(endpointRow);
  }

  async getEndpoint(agentId: string): Promise<EndpointRow | undefined> {
    this.check();
    const [row] = await this.db.select().from(endpoints).where(eq(endpoints.agentId, agentId));
    return row && endpointRow(row);
  }

  async putEndpoint(row: EndpointRegistrationRow): Promise<void> {
    this.check();
    // Health belongs to a URL: a new URL starts with none.
    await this.db
      .insert(endpoints)
      .values({
        agentId: row.agentId,
        url: row.url,
        implementationVersion: row.implementationVersion,
        manifestHash: row.manifestHash ?? null,
        timeoutMs: row.timeoutMs,
        maxConcurrent: row.maxConcurrent,
        principalId: row.principalId ?? null,
        consecutiveFailures: 0,
        createdAt: row.updatedAt,
        updatedAt: row.updatedAt,
      })
      .onConflictDoUpdate({
        target: endpoints.agentId,
        set: {
          url: excluded("url"),
          implementationVersion: excluded("implementation_version"),
          manifestHash: excluded("manifest_hash"),
          timeoutMs: excluded("timeout_ms"),
          maxConcurrent: excluded("max_concurrent"),
          principalId: excluded("principal_id"),
          updatedAt: excluded("updated_at"),
          lastDeliveryAt: sameUrl(sql`${endpoints.lastDeliveryAt}`),
          lastSuccessAt: sameUrl(sql`${endpoints.lastSuccessAt}`),
          lastErrorCode: sameUrl(sql`${endpoints.lastErrorCode}`),
          lastErrorMessage: sameUrl(sql`${endpoints.lastErrorMessage}`),
          consecutiveFailures: sameUrl(sql`${endpoints.consecutiveFailures}`, sql`0`),
          servedImplementationVersion: sameUrl(sql`${endpoints.servedImplementationVersion}`),
          servedManifestHash: sameUrl(sql`${endpoints.servedManifestHash}`),
        },
      });
  }

  async deleteEndpoint(agentId: string): Promise<void> {
    this.check();
    await this.db.delete(endpoints).where(eq(endpoints.agentId, agentId));
  }

  async recordEndpointHealth(
    agentId: string,
    update: EndpointHealthUpdate,
  ): Promise<void> {
    this.check();
    const set: PgUpdateSetSource<typeof endpoints> =
      update.kind === "success"
        ? {
            lastDeliveryAt: update.at,
            lastSuccessAt: update.at,
            consecutiveFailures: 0,
            lastErrorCode: null,
            lastErrorMessage: null,
          }
        : update.kind === "failure"
          ? {
              lastDeliveryAt: update.at,
              lastErrorCode: update.code,
              lastErrorMessage: update.message,
              consecutiveFailures: sql`${endpoints.consecutiveFailures} + 1`,
            }
          : {
              servedImplementationVersion: update.implementationVersion,
              servedManifestHash: update.manifestHash ?? null,
            };
    await this.db.update(endpoints).set(set).where(eq(endpoints.agentId, agentId));
  }

  // --- principals ----------------------------------------------------------

  async insertPrincipal(row: PrincipalRow): Promise<void> {
    this.check();
    await this.db.insert(principals).values(row);
  }

  async principalByTokenHash(
    tokenHash: string,
  ): Promise<PrincipalRow | undefined> {
    this.check();
    const [row] = await this.db
      .select()
      .from(principals)
      .where(eq(principals.tokenHash, tokenHash));
    return row;
  }

  async principalById(id: string): Promise<PrincipalRow | undefined> {
    this.check();
    const [row] = await this.db.select().from(principals).where(eq(principals.id, id));
    return row;
  }

  async applicationTokenHashes(): Promise<string[]> {
    this.check();
    const rows = await this.db
      .select({ tokenHash: principals.tokenHash })
      .from(principals)
      .where(eq(principals.role, "application"))
      .orderBy(principals.id);
    return rows.map((row) => row.tokenHash);
  }

  // --- vault ---------------------------------------------------------------

  async insertVault(row: VaultRow): Promise<void> {
    this.check();
    await this.db.insert(vaults).values(row);
  }

  async getVault(id: string): Promise<VaultRow | undefined> {
    this.check();
    const [row] = await this.db.select().from(vaults).where(eq(vaults.id, id));
    return row;
  }

  async vaultsByOwner(ownerUserId: string): Promise<VaultRow[]> {
    this.check();
    return this.db
      .select()
      .from(vaults)
      .where(and(eq(vaults.ownerUserId, ownerUserId), eq(vaults.scope, "user")))
      .orderBy(vaults.createdAt, vaults.id);
  }

  async updateVaultMetadata(
    id: string,
    metadataJson: string | null,
  ): Promise<void> {
    this.check();
    await this.db.update(vaults).set({ metadataJson }).where(eq(vaults.id, id));
  }

  async deleteVault(id: string): Promise<void> {
    this.check();
    // Credentials go with it (ON DELETE CASCADE).
    await this.db.delete(vaults).where(eq(vaults.id, id));
  }

  async insertCredential(row: VaultCredentialRow): Promise<void> {
    this.check();
    await this.db.insert(vaultCredentials).values(row);
  }

  async getCredential(id: string): Promise<VaultCredentialRow | undefined> {
    this.check();
    const [row] = await this.db
      .select()
      .from(vaultCredentials)
      .where(eq(vaultCredentials.id, id));
    return row;
  }

  async credentialsForVault(
    vaultId: string,
    filter: { type?: VaultCredentialRow["type"] } = {},
  ): Promise<VaultCredentialRow[]> {
    this.check();
    return this.db
      .select()
      .from(vaultCredentials)
      .where(
        and(
          eq(vaultCredentials.vaultId, vaultId),
          filter.type === undefined ? undefined : eq(vaultCredentials.type, filter.type),
        ),
      )
      .orderBy(vaultCredentials.createdAt, vaultCredentials.id);
  }

  async updateCredential(
    vaultId: string,
    id: string,
    patch: VaultCredentialPatch,
  ): Promise<boolean> {
    this.check();
    const where = and(eq(vaultCredentials.vaultId, vaultId), eq(vaultCredentials.id, id));
    if (Object.values(patch).every((value) => value === undefined)) {
      const rows = await this.db
        .select({ id: vaultCredentials.id })
        .from(vaultCredentials)
        .where(where);
      return rows.length > 0;
    }
    const result = await this.db.update(vaultCredentials).set(patch).where(where);
    return result.count > 0;
  }

  async deleteCredential(vaultId: string, id: string): Promise<boolean> {
    this.check();
    const result = await this.db
      .delete(vaultCredentials)
      .where(and(eq(vaultCredentials.vaultId, vaultId), eq(vaultCredentials.id, id)));
    return result.count > 0;
  }

  async countCredentials(): Promise<number> {
    this.check();
    const [row] = await this.db.select({ n: count() }).from(vaultCredentials);
    return row!.n;
  }

  async insertVaultAudit(row: VaultAuditRow): Promise<void> {
    this.check();
    await this.db.insert(vaultAudit).values(row);
  }

  async vaultAudit(
    filter: { vaultId?: string; limit?: number } = {},
  ): Promise<VaultAuditRow[]> {
    this.check();
    const query = this.db
      .select(AUDIT)
      .from(vaultAudit)
      .where(filter.vaultId === undefined ? undefined : eq(vaultAudit.vaultId, filter.vaultId))
      .orderBy(vaultAudit.ord)
      .$dynamic();
    return filter.limit === undefined ? query : query.limit(filter.limit);
  }

  async getVaultIdempotency(
    id: string,
  ): Promise<VaultIdempotencyRow | undefined> {
    this.check();
    const [row] = await this.db
      .select()
      .from(vaultIdempotency)
      .where(eq(vaultIdempotency.id, id));
    return row;
  }

  async insertVaultIdempotency(row: VaultIdempotencyRow): Promise<void> {
    this.check();
    await this.db.insert(vaultIdempotency).values(row);
  }

  // --- subject tokens ------------------------------------------------------

  async lockSigningKeys(): Promise<void> {
    this.check();
    await this.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('nylorun.signing_keys'))`);
  }

  async insertSigningKey(row: SigningKeyRow): Promise<void> {
    this.check();
    await this.db.insert(signingKeys).values(row);
  }

  async signingKey(id: string): Promise<SigningKeyRow | undefined> {
    this.check();
    const [row] = await this.db.select().from(signingKeys).where(eq(signingKeys.id, id));
    return row;
  }

  async signingKeys(
    states?: readonly SigningKeyRow["state"][],
  ): Promise<SigningKeyRow[]> {
    this.check();
    return this.db
      .select()
      .from(signingKeys)
      .where(states === undefined ? undefined : inArray(signingKeys.state, states))
      .orderBy(signingKeys.createdAt, signingKeys.id);
  }

  async setSigningKeyState(
    id: string,
    from: SigningKeyRow["state"],
    to: SigningKeyRow["state"],
    at: string,
  ): Promise<boolean> {
    this.check();
    const stamp = SIGNING_KEY_STAMP[to];
    const rows = await this.db
      .update(signingKeys)
      .set({ state: to, ...(stamp ? { [stamp]: at } : {}) })
      .where(and(eq(signingKeys.id, id), eq(signingKeys.state, from)))
      .returning({ id: signingKeys.id });
    return rows.length === 1;
  }

  async countSigningKeys(): Promise<number> {
    this.check();
    const [row] = await this.db.select({ n: count() }).from(signingKeys);
    return row!.n;
  }

  async subjectEpoch(subject: string): Promise<number> {
    this.check();
    const [row] = await this.db
      .select({ epoch: subjectEpochs.epoch })
      .from(subjectEpochs)
      .where(eq(subjectEpochs.subject, subject));
    return row?.epoch ?? 0;
  }

  async subjectEpochs(subjects: readonly string[]): Promise<Map<string, number>> {
    this.check();
    if (subjects.length === 0) return new Map();
    const rows = await this.db
      .select({ subject: subjectEpochs.subject, epoch: subjectEpochs.epoch })
      .from(subjectEpochs)
      .where(inArray(subjectEpochs.subject, subjects));
    return new Map(rows.map((row) => [row.subject, row.epoch]));
  }

  async bumpSubjectEpoch(subject: string, at: string): Promise<number> {
    this.check();
    const [row] = await this.db
      .insert(subjectEpochs)
      .values({ subject, epoch: 1, revokedAt: at })
      .onConflictDoUpdate({
        target: subjectEpochs.subject,
        set: { epoch: sql`${subjectEpochs.epoch} + 1`, revokedAt: excluded("revoked_at") },
      })
      .returning({ epoch: subjectEpochs.epoch });
    return row!.epoch;
  }

  async lockSubjectUsage(initial: SubjectUsageRow): Promise<SubjectUsageRow> {
    this.check();
    await this.db.insert(subjectUsage).values(initial).onConflictDoNothing();
    const [row] = await this.db
      .select()
      .from(subjectUsage)
      .where(eq(subjectUsage.subject, initial.subject))
      .for("update");
    return row!;
  }

  async putSubjectUsage(row: SubjectUsageRow): Promise<void> {
    this.check();
    await this.db
      .insert(subjectUsage)
      .values(row)
      .onConflictDoUpdate({
        target: subjectUsage.subject,
        set: { turnTokens: excluded("turn_tokens"), refilledAt: excluded("refilled_at") },
      });
  }

  async countOwnerSessions(
    ownerUserId: string,
    statuses: readonly string[],
  ): Promise<number> {
    this.check();
    const [row] = await this.db
      .select({ n: count() })
      .from(sessions)
      .where(and(eq(sessions.ownerUserId, ownerUserId), inArray(sessions.status, statuses)));
    return row!.n;
  }

  // --- publishable keys ----------------------------------------------------

  async insertPublishableKey(row: PublishableKeyRow): Promise<void> {
    this.check();
    await this.db.insert(publishableKeys).values(row);
  }

  async publishableKeyByKey(key: string): Promise<PublishableKeyRow | undefined> {
    this.check();
    const [row] = await this.db
      .select()
      .from(publishableKeys)
      .where(eq(publishableKeys.key, key));
    return row;
  }

  async publishableKey(id: string): Promise<PublishableKeyRow | undefined> {
    this.check();
    const [row] = await this.db
      .select()
      .from(publishableKeys)
      .where(eq(publishableKeys.id, id));
    return row;
  }

  async publishableKeys(): Promise<PublishableKeyRow[]> {
    this.check();
    return this.db
      .select()
      .from(publishableKeys)
      .orderBy(publishableKeys.createdAt, publishableKeys.id);
  }

  async updatePublishableKey(
    id: string,
    patch: Partial<Pick<PublishableKeyRow, "originsJson" | "revokedAt">>,
  ): Promise<boolean> {
    this.check();
    if (patch.originsJson === undefined && patch.revokedAt === undefined)
      return (await this.publishableKey(id)) !== undefined;
    const rows = await this.db
      .update(publishableKeys)
      .set(patch)
      .where(eq(publishableKeys.id, id))
      .returning({ id: publishableKeys.id });
    return rows.length === 1;
  }

  // --- model usage ---------------------------------------------------------

  async recordModelUsage(row: Omit<ModelUsageRow, "duplicate">): Promise<ModelUsageRow> {
    this.check();
    const [inserted] = await this.db
      .insert(modelUsage)
      .values({
        ...row,
        duplicate: sql`EXISTS (SELECT 1 FROM ${modelUsage} WHERE ${modelUsage.effectKey} = ${row.effectKey})`,
      })
      .returning({ duplicate: modelUsage.duplicate });
    return { ...row, duplicate: inserted!.duplicate };
  }

  async modelUsageTotals(query: ModelUsageQuery): Promise<ModelUsageTotals> {
    this.check();
    const [row] = await this.db
      .select({
        calls: count(),
        tokens: sql<number>`coalesce(sum(${modelUsage.totalTokens}), 0)::bigint`.mapWith(Number),
        costUsd: sql<number>`coalesce(sum(${modelUsage.costUsd}), 0)::double precision`.mapWith(
          Number,
        ),
      })
      .from(modelUsage)
      .where(
        and(
          query.scope === "agent" ? eq(modelUsage.agentId, query.id ?? "") : undefined,
          query.scope === "turn" ? eq(modelUsage.turnId, query.id ?? "") : undefined,
          query.since !== undefined ? gte(modelUsage.createdAt, query.since) : undefined,
        ),
      );
    return row!;
  }

  async listModelBudgets(): Promise<ModelBudgetRow[]> {
    this.check();
    return this.db
      .select()
      .from(modelBudgets)
      .orderBy(sql`${modelBudgets.scope} COLLATE "C"`, modelBudgets.scopeId);
  }

  async putModelBudgets(rows: readonly ModelBudgetRow[]): Promise<void> {
    this.check();
    await this.db.delete(modelBudgets);
    if (rows.length > 0) await this.db.insert(modelBudgets).values([...rows]);
  }

  // --- tool crossings --------------------------------------------------------

  async toolCrossing(key: string): Promise<ToolCrossingRow | undefined> {
    this.check();
    const [row] = await this.db.select().from(toolCrossings).where(eq(toolCrossings.key, key));
    return row;
  }

  async startToolCrossing(row: Pick<ToolCrossingRow, "key" | "hash" | "startedAt">): Promise<boolean> {
    this.check();
    const inserted = await this.db
      .insert(toolCrossings)
      .values({ ...row, settledAt: null, answer: null })
      .onConflictDoNothing()
      .returning({ key: toolCrossings.key });
    return inserted.length === 1;
  }

  async settleToolCrossing(key: string, answer: unknown, settledAt: string): Promise<void> {
    this.check();
    await this.db
      .update(toolCrossings)
      .set({ answer, settledAt })
      .where(eq(toolCrossings.key, key));
  }

  async pruneToolCrossings(before: string): Promise<number> {
    this.check();
    const deleted = await this.db
      .delete(toolCrossings)
      .where(lt(toolCrossings.settledAt, before))
      .returning({ key: toolCrossings.key });
    return deleted.length;
  }

  // --- settings ------------------------------------------------------------

  async getSetting(key: string): Promise<string | undefined> {
    this.check();
    const [row] = await this.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(eq(tenantSettings.key, key));
    return row?.value;
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.check();
    await this.db
      .insert(tenantSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: tenantSettings.key, set: { value: excluded("value") } });
  }

  // --- reset ---------------------------------------------------------------

  async reset(scope: ResetScope): Promise<void> {
    this.check();
    const db = this.db;
    if (scope === "sessions" || scope === "all") {
      for (const table of SESSION_TABLES) await db.delete(table);
      await db.delete(subjectUsage);
      await db.delete(toolCrossings);
      // The record goes with the sessions, and the Tenant moves to a new basin: the ids it
      // frees start again in an empty one (Durable Streams §8.1).
      await db.delete(sessionEvents);
      await db.delete(sessionLogHeads);
      await db.update(tenant).set({
        retiredGenerations: sql`array_append(${tenant.retiredGenerations}, ${tenant.basinGeneration})`,
        basinGeneration: sql`${tenant.basinGeneration} + 1`,
      });
    }
    if (scope === "sandboxes" || scope === "all") {
      await db.delete(sandboxes);
      await db.delete(sandboxResources);
      await db.delete(sandboxEvents);
    }
    if (scope === "all") {
      await db.delete(definitions);
      await db.delete(endpoints);
      await db.delete(modelUsage);
      await db.delete(modelBudgets);
      await db.delete(vaults).where(ne(vaults.scope, "host"));
    }
  }
}
