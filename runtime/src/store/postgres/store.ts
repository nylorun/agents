/**
 * The Postgres Session Store (architecture §12.2): one Tenant schema, one
 * `SessionStore`. See `store/types.ts` for the invariants it keeps.
 *
 * ## Transactions
 *
 * Every `tx` is one READ COMMITTED transaction on a pooled connection. Tables
 * are addressed by fully qualified, quoted names (`"tenant_<id>"."sessions"`),
 * never through `search_path`, so a statement cannot reach another schema.
 * Commit listeners and `afterCommit` callbacks run after `COMMIT` returns and
 * never reject the committed `tx`. Nested `tx` calls are detected with
 * `AsyncLocalStorage` and rejected, and a `Tx` rejects every call once its
 * callback settles.
 *
 * ## Lock ordering
 *
 * `lockSession`, `event`, `takeOwnership` and `assertEpoch` take the session
 * row lock (`SELECT … FOR UPDATE` or `UPDATE`), held until the transaction
 * ends. To stay deadlock-free:
 *
 * 1. A session-scoped transaction locks its session row before writing any
 *    other row of that session (effects, actions, checkpoints, outbox).
 * 2. A transaction that touches several sessions locks them in ascending id
 *    order, with `lockSessions` (`./locking.ts`), before writing any of them.
 *
 * Serialization failures and deadlocks are not retried here: with the order
 * above, READ COMMITTED transactions do not raise them. A `40P01` means a
 * caller broke the order, and it surfaces as the rejection of `tx`.
 *
 * ## Values
 *
 * Document and outbox bodies are `json`, stored as the text `JSON.stringify`
 * wrote, so every string round-trips, including U+0000 and unpaired
 * surrogates that `jsonb` rejects (see `migrations/001_initial.ts`), and key
 * order is kept. Ids and ISO timestamps compared as text use `COLLATE "C"`.
 * Lease times in action bodies are compared as `timestamptz`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PendingQuery, Sql, TransactionSql } from "postgres";
import type { LiveEvent } from "@nylorun/core/contracts";
import { encodeCursor } from "../cursor.js";
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
  OutboxRow,
  OutboxStats,
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
  SigningKeyRow,
  PublishableKeyRow,
  SubjectUsageRow,
  StoredSession,
  TakeOwnership,
  Tx,
  VaultAuditRow,
  VaultCredentialPatch,
  VaultCredentialRow,
  VaultIdempotencyRow,
  VaultRow,
} from "../types.js";
import { POSTGRES_SCHEMA_VERSION, readSchemaVersion } from "./migrations/index.js";
import { assertIdentifier, tenantSchemaName } from "./names.js";

export interface PostgresSessionStoreOptions extends SessionStoreOptions {
  /** The shared pool. The store never ends it. */
  sql: Sql;
  /** The Tenant schema. Defaults to `tenantSchemaName(tenantId)`. */
  schema?: string;
  /** The version `health()` expects. Defaults to `POSTGRES_SCHEMA_VERSION`. */
  schemaVersion?: number;
}

export function createPostgresSessionStore(
  options: PostgresSessionStoreOptions,
): SessionStore {
  return new PostgresSessionStore(options);
}

type Row = Record<string, any>;

const OWNERSHIP_KEYS = new Set(["owner", "epoch", "ownerExpiresAt"]);
const OPEN_SESSION = ["running", "runnable"];

class PostgresSessionStore implements SessionStore {
  readonly tenantId: string;
  private readonly sql: Sql;
  private readonly schema: string;
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
    this.schema = options.schema ?? tenantSchemaName(options.tenantId);
    assertIdentifier(this.schema);
    this.schemaVersion = options.schemaVersion ?? POSTGRES_SCHEMA_VERSION;
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
    const run = this.sql.begin("isolation level read committed", async (sql) => {
      t = new PostgresTx(sql, this.schema, this.tenantId, this.now);
      try {
        return { value: await this.active.run(this, () => fn(t)) };
      } finally {
        t.closed = true;
      }
    });
    this.inflight.add(run);
    let result: { value: T };
    try {
      result = (await run) as { value: T };
    } finally {
      this.inflight.delete(run);
    }
    if (t.events.length > 0) {
      const commit = {
        events: t.events,
        incarnations: t.incarnations,
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

  async health(): Promise<StoreHealth> {
    const expectedSchemaVersion = this.schemaVersion;
    if (this.closed)
      return { ok: false, schemaVersion: 0, expectedSchemaVersion };
    try {
      const schemaVersion = (await readSchemaVersion(this.sql, this.schema)) ?? 0;
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

function storedSession<T extends SessionDoc>(row: Row): StoredSession<T> {
  return { ...row.body, ...ownership(row) };
}

function ownership(row: Row): SessionOwnership {
  return {
    owner: row.owner ?? null,
    epoch: Number(row.epoch),
    ownerExpiresAt: row.owner_expires_at
      ? new Date(row.owner_expires_at).toISOString()
      : null,
  };
}

function toJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Document body must be JSON");
  return json;
}

const bytes = (value: Uint8Array): Buffer =>
  Buffer.from(value.buffer, value.byteOffset, value.byteLength);

const fromBytes = (value: Uint8Array): Uint8Array => new Uint8Array(value);

function endpointRow(row: Row): EndpointRow {
  const optional = (key: keyof EndpointRow, value: unknown) =>
    value === null ? {} : { [key]: value };
  return {
    agentId: row.agent_id,
    url: row.url,
    implementationVersion: row.implementation_version,
    ...optional("manifestHash", row.manifest_hash),
    timeoutMs: row.timeout_ms,
    maxConcurrent: row.max_concurrent,
    ...optional("principalId", row.principal_id),
    ...optional("lastDeliveryAt", row.last_delivery_at),
    ...optional("lastSuccessAt", row.last_success_at),
    ...optional("lastErrorCode", row.last_error_code),
    ...optional("lastErrorMessage", row.last_error_message),
    consecutiveFailures: row.consecutive_failures,
    ...optional("servedImplementationVersion", row.served_implementation_version),
    ...optional("servedManifestHash", row.served_manifest_hash),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as EndpointRow;
}

function principalRow(row: Row): PrincipalRow {
  return {
    id: row.id,
    role: row.role,
    tokenHash: row.token_hash,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function signingKeyRow(row: Row): SigningKeyRow {
  return {
    id: row.id,
    state: row.state,
    alg: row.alg,
    publicJwk: row.public_jwk,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
    revokedAt: row.revoked_at,
    kekId: row.kek_id,
    nonce: fromBytes(row.nonce),
    ciphertext: fromBytes(row.ciphertext),
    wrappedDek: fromBytes(row.wrapped_dek),
  };
}

function publishableKeyRow(row: Row): PublishableKeyRow {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    originsJson: row.origins_json,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** The time column a signing key's new state stamps. */
const SIGNING_KEY_STAMP: Partial<Record<SigningKeyRow["state"], string>> = {
  current: "activated_at",
  previous: "retired_at",
  revoked: "revoked_at",
};

function vaultRow(row: Row): VaultRow {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    metadataJson: row.metadata_json,
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
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    kekId: row.kek_id,
    nonce: fromBytes(row.nonce),
    ciphertext: fromBytes(row.ciphertext),
    wrappedDek: fromBytes(row.wrapped_dek),
  };
}

function auditRow(row: Row): VaultAuditRow {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    vaultId: row.vault_id,
    credentialId: row.credential_id,
    sessionId: row.session_id,
    target: row.target,
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

const SESSION_TABLES = [
  "sessions",
  "commands",
  "checkpoints",
  "effects",
  "actions",
  "links",
  "outbox",
] as const;

class PostgresTx implements Tx {
  closed = false;
  readonly events: LiveEvent[] = [];
  readonly incarnations: (string | null)[] = [];
  readonly callbacks: (() => void | Promise<void>)[] = [];

  constructor(
    private readonly sql: TransactionSql,
    private readonly schema: string,
    private readonly tenantId: string,
    private readonly now: () => Date,
  ) {}

  private check(): void {
    if (this.closed) throw new Error("Tx used after its transaction ended");
  }

  /** The quoted, schema-qualified table. */
  private t(table: string) {
    return this.sql(`${this.schema}.${table}`);
  }

  // --- documents -----------------------------------------------------------

  async get<T = any>(table: DocTable, id: string): Promise<T | undefined> {
    this.check();
    const sql = this.sql;
    if (table === "sessions") {
      const [row] = await sql`
        SELECT body, owner, epoch, owner_expires_at FROM ${this.t("sessions")}
        WHERE id = ${id}`;
      return row && (storedSession(row) as T);
    }
    const [row] = await sql`SELECT body FROM ${this.t(table)} WHERE id = ${id}`;
    return row?.body as T | undefined;
  }

  async put(table: DocTable, id: string, body: unknown): Promise<void> {
    this.check();
    let value = body;
    if (table === "sessions" && body && typeof body === "object")
      value = Object.fromEntries(
        Object.entries(body).filter(([key]) => !OWNERSHIP_KEYS.has(key)),
      );
    const json = toJson(value);
    await this.sql`
      INSERT INTO ${this.t(table)} (id, body) VALUES (${id}, ${json}::text::json)
      ON CONFLICT (id) DO UPDATE SET body = excluded.body`;
  }

  async delete(table: DocTable, id: string): Promise<void> {
    this.check();
    await this.sql`DELETE FROM ${this.t(table)} WHERE id = ${id}`;
    // The session's stream is abandoned with it (a new incarnation starts at 0).
    if (table === "sessions")
      await this.sql`DELETE FROM ${this.t("outbox")} WHERE session_id = ${id}`;
  }

  private async sessionRows<T extends SessionDoc>(
    where: PendingQuery<Row[]> | undefined,
    tail?: PendingQuery<Row[]>,
  ): Promise<StoredSession<T>[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT body, owner, epoch, owner_expires_at FROM ${this.t("sessions")}
      ${where ? sql`WHERE ${where}` : sql``}
      ${tail ?? sql`ORDER BY id`}`;
    return rows.map((row) => storedSession<T>(row));
  }

  // --- ordering ------------------------------------------------------------

  async lockSession<T extends SessionDoc = SessionDoc>(
    id: string,
  ): Promise<StoredSession<T> | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT body, owner, epoch, owner_expires_at FROM ${this.t("sessions")}
      WHERE id = ${id} FOR UPDATE`;
    return row && storedSession<T>(row);
  }

  async event(
    sessionId: string,
    turnId: string | null,
    type: string,
    payload: unknown,
  ): Promise<LiveEvent> {
    this.check();
    const sql = this.sql;
    // The UPDATE takes the session row lock and allocates under it.
    const [row] = await sql`
      UPDATE ${this.t("sessions")} SET next_event_seq = next_event_seq + 1
      WHERE id = ${sessionId}
      RETURNING next_event_seq - 1 AS seq, stream_incarnation AS incarnation`;
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
    await sql`
      INSERT INTO ${this.t("outbox")} (session_id, seq, body)
      VALUES (${sessionId}, ${seq}, ${JSON.stringify(event)}::text::json)`;
    this.events.push(event);
    this.incarnations.push((row.incarnation as string | null) ?? null);
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
    const sql = this.sql;
    const [row] = await sql`
      SELECT owner, epoch, owner_expires_at FROM ${this.t("sessions")}
      WHERE id = ${sessionId} FOR UPDATE`;
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
    const expires = new Date(claim.now.getTime() + claim.leaseMs);
    const [updated] = await sql`
      UPDATE ${this.t("sessions")}
      SET owner = ${claim.owner}, epoch = epoch + 1, owner_expires_at = ${expires}
      WHERE id = ${sessionId} RETURNING epoch`;
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
    const result = await this.sql`
      UPDATE ${this.t("sessions")} SET owner_expires_at = ${until}
      WHERE id = ${sessionId} AND owner = ${owner} AND epoch = ${epoch}`;
    return result.count > 0;
  }

  async releaseOwnership(
    sessionId: string,
    owner: string,
    epoch: number,
  ): Promise<boolean> {
    this.check();
    const result = await this.sql`
      UPDATE ${this.t("sessions")} SET owner = NULL, owner_expires_at = NULL
      WHERE id = ${sessionId} AND owner = ${owner} AND epoch = ${epoch}`;
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

  // --- typed queries -------------------------------------------------------

  async sessionsWithStatus<T extends SessionDoc = SessionDoc>(
    statuses: readonly string[],
  ): Promise<StoredSession<T>[]> {
    this.check();
    return this.sessionRows<T>(this.sql`status = ANY(${[...statuses]})`);
  }

  async orphanedSessions<T extends SessionDoc = SessionDoc>(
    now: Date,
    limit: number,
  ): Promise<StoredSession<T>[]> {
    this.check();
    const sql = this.sql;
    return this.sessionRows<T>(
      sql`status = ANY(${OPEN_SESSION})
        AND (owner IS NULL OR owner_expires_at IS NULL OR owner_expires_at <= ${now})`,
      sql`ORDER BY
        CASE WHEN owner IS NULL THEN NULL ELSE owner_expires_at END ASC NULLS FIRST,
        id
        LIMIT ${limit}`,
    );
  }

  async listSessions<T extends SessionDoc = SessionDoc>(
    filter: { agentId?: string; ownerUserId?: string } = {},
  ): Promise<StoredSession<T>[]> {
    this.check();
    const sql = this.sql;
    const conditions = [
      ...(filter.agentId === undefined ? [] : [sql`agent_id = ${filter.agentId}`]),
      ...(filter.ownerUserId === undefined
        ? []
        : [sql`owner_user_id = ${filter.ownerUserId}`]),
    ];
    return this.sessionRows<T>(
      conditions.length === 0
        ? undefined
        : conditions.reduce((all, next) => sql`${all} AND ${next}`),
    );
  }

  private async bodies<T>(table: DocTable): Promise<T[]> {
    const rows = await this.sql`SELECT body FROM ${this.t(table)} ORDER BY id`;
    return rows.map((row) => row.body as T);
  }

  async listDefinitions<T extends DefinitionDoc = DefinitionDoc>(): Promise<T[]> {
    this.check();
    return this.bodies<T>("definitions");
  }

  async listSandboxes<T extends SandboxDoc = SandboxDoc>(): Promise<T[]> {
    this.check();
    return this.bodies<T>("sandboxes");
  }

  async pendingActions(agentId: string): Promise<ActionDoc[]> {
    this.check();
    const rows = await this.sql`
      SELECT body FROM ${this.t("actions")}
      WHERE agent_id = ${agentId} AND status = 'pending'
      ORDER BY id`;
    return rows.map((row) => row.body as ActionDoc);
  }

  async deliveringCount(agentId: string): Promise<number> {
    this.check();
    const [row] = await this.sql`
      SELECT count(*)::int AS n FROM ${this.t("actions")}
      WHERE agent_id = ${agentId} AND status = 'delivering'`;
    return row!.n as number;
  }

  async pendingActionsWithEndpoint(limit: number): Promise<ActionDoc[]> {
    this.check();
    const rows = await this.sql`
      SELECT a.body FROM ${this.t("actions")} a
      JOIN ${this.t("endpoints")} e ON e.agent_id = a.agent_id
      WHERE a.status = 'pending'
      ORDER BY a.id
      LIMIT ${limit}`;
    return rows.map((row) => row.body as ActionDoc);
  }

  async expiredDeliveries(now: Date, limit: number): Promise<ActionDoc[]> {
    this.check();
    const rows = await this.sql`
      SELECT body FROM ${this.t("actions")}
      WHERE status = 'delivering' AND deadline_at IS NOT NULL
        AND deadline_at::timestamptz <= ${now}
      ORDER BY deadline_at::timestamptz, id
      LIMIT ${limit}`;
    return rows.map((row) => row.body as ActionDoc);
  }

  async actionsForSession(
    sessionId: string,
    filter: SessionActionFilter = {},
  ): Promise<ActionDoc[]> {
    this.check();
    const sql = this.sql;
    const rows = await sql`
      SELECT body FROM ${this.t("actions")}
      WHERE session_id = ${sessionId}
      ${filter.turnId === undefined ? sql`` : sql`AND turn_id = ${filter.turnId}`}
      ${filter.statuses === undefined ? sql`` : sql`AND status = ANY(${[...filter.statuses]})`}
      ORDER BY id`;
    return rows.map((row) => row.body as ActionDoc);
  }

  async actionsWithStatus(
    statuses: readonly ActionStatus[],
    filter: { kinds?: readonly ActionKind[] } = {},
  ): Promise<ActionDoc[]> {
    this.check();
    const sql = this.sql;
    const rows = await sql`
      SELECT body FROM ${this.t("actions")}
      WHERE status = ANY(${[...statuses]})
      ${filter.kinds === undefined ? sql`` : sql`AND kind = ANY(${[...filter.kinds]})`}
      ORDER BY id`;
    return rows.map((row) => row.body as ActionDoc);
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
    const sql = this.sql;
    const rows = await sql`
      SELECT body FROM ${this.t("effects")}
      WHERE session_id = ${sessionId}
      ${filter.turnId === undefined ? sql`` : sql`AND turn_id = ${filter.turnId}`}
      ${filter.statuses === undefined ? sql`` : sql`AND status = ANY(${[...filter.statuses]})`}
      ORDER BY id`;
    return rows.map((row) => row.body as T);
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
    const sql = this.sql;
    const rows = await sql`
      SELECT body FROM ${this.t("effects")}
      WHERE status = ANY(${[...statuses]})
      ${filter.kinds === undefined ? sql`` : sql`AND kind = ANY(${[...filter.kinds]})`}
      ORDER BY id`;
    return rows.map((row) => row.body as T);
  }

  async linkedSessions<S extends SessionDoc = SessionDoc>(
    workflowSessionId: string,
  ): Promise<LinkedSession<S>[]> {
    this.check();
    const rows = await this.sql`
      SELECT l.id, l.body AS link, s.body, s.owner, s.epoch, s.owner_expires_at
      FROM ${this.t("links")} l JOIN ${this.t("sessions")} s ON s.id = l.id
      WHERE l.workflow_session_id = ${workflowSessionId}
      ORDER BY l.id`;
    return rows.map((row) => ({
      agentSessionId: row.id,
      link: row.link as LinkDoc,
      session: storedSession<S>(row),
    }));
  }

  async counts(): Promise<StoreCounts> {
    this.check();
    const sql = this.sql;
    const [row] = await sql`
      SELECT
        (SELECT count(*) FROM ${this.t("sessions")})::int AS sessions,
        (SELECT count(*) FROM ${this.t("sessions")} WHERE status = ANY(${OPEN_SESSION}))::int AS running,
        (SELECT count(*) FROM ${this.t("actions")} WHERE status IN ('pending', 'delivering'))::int AS actions,
        (SELECT count(*) FROM ${this.t("effects")} WHERE status = 'uncertain')::int AS uncertain,
        (SELECT count(*) FROM ${this.t("sandboxes")})::int AS sandboxes,
        (SELECT count(*) FROM ${this.t("definitions")})::int AS definitions`;
    return {
      sessions: row!.sessions,
      runningSessions: row!.running,
      pendingActions: row!.actions,
      uncertainEffects: row!.uncertain,
      sandboxes: row!.sandboxes,
      definitions: row!.definitions,
    };
  }

  // --- outbox --------------------------------------------------------------

  async outbox(
    limit: number,
    filter: { sessionId?: string } = {},
  ): Promise<OutboxRow[]> {
    this.check();
    const sql = this.sql;
    const rows = await sql`
      SELECT session_id, seq, body FROM ${this.t("outbox")}
      ${filter.sessionId === undefined ? sql`` : sql`WHERE session_id = ${filter.sessionId}`}
      ORDER BY session_id, seq
      LIMIT ${limit}`;
    return rows.map((row) => ({
      sessionId: row.session_id,
      seq: Number(row.seq),
      event: row.body as LiveEvent,
    }));
  }

  async deleteOutbox(
    sessionId: string,
    throughSeq: number,
    incarnation?: string | null,
  ): Promise<number> {
    this.check();
    const sql = this.sql;
    // One statement: the session and the rows are read from the same snapshot.
    const result = await sql`
      DELETE FROM ${this.t("outbox")}
      WHERE session_id = ${sessionId} AND seq <= ${throughSeq}
      ${
        incarnation === undefined
          ? sql``
          : sql`AND EXISTS (
              SELECT 1 FROM ${this.t("sessions")} WHERE id = ${sessionId}
                AND stream_incarnation IS NOT DISTINCT FROM ${incarnation})`
      }`;
    return result.count;
  }

  async outboxStats(): Promise<OutboxStats> {
    this.check();
    const [row] = await this.sql`
      SELECT count(*)::int AS depth, min(created_at) AS oldest
      FROM ${this.t("outbox")}`;
    return {
      depth: row!.depth as number,
      oldestCreatedAt: (row!.oldest as string | null) ?? null,
    };
  }

  // --- Action endpoints -----------------------------------------------------

  async listEndpoints(): Promise<EndpointRow[]> {
    this.check();
    const rows = await this.sql`SELECT * FROM ${this.t("endpoints")} ORDER BY agent_id`;
    return rows.map(endpointRow);
  }

  async getEndpoint(agentId: string): Promise<EndpointRow | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT * FROM ${this.t("endpoints")} WHERE agent_id = ${agentId}`;
    return row && endpointRow(row);
  }

  async putEndpoint(row: EndpointRegistrationRow): Promise<void> {
    this.check();
    // Health belongs to a URL: a new URL starts with none.
    await this.sql`
      INSERT INTO ${this.t("endpoints")} AS e (
        agent_id, url, implementation_version, manifest_hash, timeout_ms,
        max_concurrent, principal_id, consecutive_failures, created_at, updated_at
      ) VALUES (
        ${row.agentId}, ${row.url}, ${row.implementationVersion}, ${row.manifestHash ?? null},
        ${row.timeoutMs}, ${row.maxConcurrent}, ${row.principalId ?? null}, 0,
        ${row.updatedAt}, ${row.updatedAt}
      )
      ON CONFLICT (agent_id) DO UPDATE SET
        url = excluded.url,
        implementation_version = excluded.implementation_version,
        manifest_hash = excluded.manifest_hash,
        timeout_ms = excluded.timeout_ms,
        max_concurrent = excluded.max_concurrent,
        principal_id = excluded.principal_id,
        updated_at = excluded.updated_at,
        last_delivery_at = CASE WHEN e.url = excluded.url THEN e.last_delivery_at END,
        last_success_at = CASE WHEN e.url = excluded.url THEN e.last_success_at END,
        last_error_code = CASE WHEN e.url = excluded.url THEN e.last_error_code END,
        last_error_message = CASE WHEN e.url = excluded.url THEN e.last_error_message END,
        consecutive_failures =
          CASE WHEN e.url = excluded.url THEN e.consecutive_failures ELSE 0 END,
        served_implementation_version =
          CASE WHEN e.url = excluded.url THEN e.served_implementation_version END,
        served_manifest_hash =
          CASE WHEN e.url = excluded.url THEN e.served_manifest_hash END`;
  }

  async deleteEndpoint(agentId: string): Promise<void> {
    this.check();
    await this.sql`DELETE FROM ${this.t("endpoints")} WHERE agent_id = ${agentId}`;
  }

  async recordEndpointHealth(
    agentId: string,
    update: EndpointHealthUpdate,
  ): Promise<void> {
    this.check();
    const table = this.t("endpoints");
    switch (update.kind) {
      case "success":
        await this.sql`
          UPDATE ${table} SET last_delivery_at = ${update.at}, last_success_at = ${update.at},
            consecutive_failures = 0, last_error_code = NULL, last_error_message = NULL
          WHERE agent_id = ${agentId}`;
        return;
      case "failure":
        await this.sql`
          UPDATE ${table} SET last_delivery_at = ${update.at}, last_error_code = ${update.code},
            last_error_message = ${update.message},
            consecutive_failures = consecutive_failures + 1
          WHERE agent_id = ${agentId}`;
        return;
      case "served":
        await this.sql`
          UPDATE ${table} SET served_implementation_version = ${update.implementationVersion},
            served_manifest_hash = ${update.manifestHash ?? null}
          WHERE agent_id = ${agentId}`;
        return;
    }
  }

  // --- principals ----------------------------------------------------------

  async insertPrincipal(row: PrincipalRow): Promise<void> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("principals")} (id, role, token_hash, idempotency_key, created_at)
      VALUES (${row.id}, ${row.role}, ${row.tokenHash}, ${row.idempotencyKey}, ${row.createdAt})`;
  }

  async principalByTokenHash(
    tokenHash: string,
  ): Promise<PrincipalRow | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT * FROM ${this.t("principals")} WHERE token_hash = ${tokenHash}`;
    return row && principalRow(row);
  }

  async principalById(id: string): Promise<PrincipalRow | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT * FROM ${this.t("principals")} WHERE id = ${id}`;
    return row && principalRow(row);
  }

  async applicationTokenHashes(): Promise<string[]> {
    this.check();
    const rows = await this.sql`
      SELECT token_hash FROM ${this.t("principals")}
      WHERE role = 'application' ORDER BY id`;
    return rows.map((row) => row.token_hash as string);
  }

  // --- vault ---------------------------------------------------------------

  async insertVault(row: VaultRow): Promise<void> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("vaults")} (id, name, owner_user_id, metadata_json, created_at, scope)
      VALUES (${row.id}, ${row.name}, ${row.ownerUserId}, ${row.metadataJson},
              ${row.createdAt}, ${row.scope})`;
  }

  async getVault(id: string): Promise<VaultRow | undefined> {
    this.check();
    const [row] = await this.sql`SELECT * FROM ${this.t("vaults")} WHERE id = ${id}`;
    return row && vaultRow(row);
  }

  async vaultsByOwner(ownerUserId: string): Promise<VaultRow[]> {
    this.check();
    const rows = await this.sql`
      SELECT * FROM ${this.t("vaults")}
      WHERE owner_user_id = ${ownerUserId} AND scope = 'user'
      ORDER BY created_at, id`;
    return rows.map(vaultRow);
  }

  async updateVaultMetadata(
    id: string,
    metadataJson: string | null,
  ): Promise<void> {
    this.check();
    await this.sql`
      UPDATE ${this.t("vaults")} SET metadata_json = ${metadataJson} WHERE id = ${id}`;
  }

  async deleteVault(id: string): Promise<void> {
    this.check();
    // Credentials go with it (ON DELETE CASCADE).
    await this.sql`DELETE FROM ${this.t("vaults")} WHERE id = ${id}`;
  }

  async insertCredential(row: VaultCredentialRow): Promise<void> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("vault_credentials")} (
        id, vault_id, name, type, binding_json, expires_at, created_at,
        rotated_at, kek_id, nonce, ciphertext, wrapped_dek
      ) VALUES (
        ${row.id}, ${row.vaultId}, ${row.name}, ${row.type}, ${row.bindingJson},
        ${row.expiresAt}, ${row.createdAt}, ${row.rotatedAt}, ${row.kekId},
        ${bytes(row.nonce)}, ${bytes(row.ciphertext)}, ${bytes(row.wrappedDek)}
      )`;
  }

  async getCredential(id: string): Promise<VaultCredentialRow | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT * FROM ${this.t("vault_credentials")} WHERE id = ${id}`;
    return row && credentialRow(row);
  }

  async credentialsForVault(
    vaultId: string,
    filter: { type?: VaultCredentialRow["type"] } = {},
  ): Promise<VaultCredentialRow[]> {
    this.check();
    const sql = this.sql;
    const rows = await sql`
      SELECT * FROM ${this.t("vault_credentials")}
      WHERE vault_id = ${vaultId}
      ${filter.type === undefined ? sql`` : sql`AND type = ${filter.type}`}
      ORDER BY created_at, id`;
    return rows.map(credentialRow);
  }

  async updateCredential(
    vaultId: string,
    id: string,
    patch: VaultCredentialPatch,
  ): Promise<boolean> {
    this.check();
    const sql = this.sql;
    const columns: Record<string, unknown> = {};
    for (const [field, column] of Object.entries(CREDENTIAL_COLUMNS)) {
      const value = patch[field as keyof VaultCredentialPatch];
      if (value === undefined) continue;
      columns[column] = value instanceof Uint8Array ? bytes(value) : value;
    }
    if (Object.keys(columns).length === 0) {
      const rows = await sql`
        SELECT 1 FROM ${this.t("vault_credentials")}
        WHERE vault_id = ${vaultId} AND id = ${id}`;
      return rows.length > 0;
    }
    const result = await sql`
      UPDATE ${this.t("vault_credentials")} SET ${sql(columns as Record<string, any>)}
      WHERE vault_id = ${vaultId} AND id = ${id}`;
    return result.count > 0;
  }

  async deleteCredential(vaultId: string, id: string): Promise<boolean> {
    this.check();
    const result = await this.sql`
      DELETE FROM ${this.t("vault_credentials")}
      WHERE vault_id = ${vaultId} AND id = ${id}`;
    return result.count > 0;
  }

  async countCredentials(): Promise<number> {
    this.check();
    const [row] = await this.sql`
      SELECT count(*)::int AS n FROM ${this.t("vault_credentials")}`;
    return row!.n;
  }

  async insertVaultAudit(row: VaultAuditRow): Promise<void> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("vault_audit")} (
        id, at, actor, action, vault_id, credential_id, session_id, target, outcome
      ) VALUES (
        ${row.id}, ${row.at}, ${row.actor}, ${row.action}, ${row.vaultId},
        ${row.credentialId}, ${row.sessionId}, ${row.target}, ${row.outcome}
      )`;
  }

  async vaultAudit(
    filter: { vaultId?: string; limit?: number } = {},
  ): Promise<VaultAuditRow[]> {
    this.check();
    const sql = this.sql;
    const rows = await sql`
      SELECT * FROM ${this.t("vault_audit")}
      ${filter.vaultId === undefined ? sql`` : sql`WHERE vault_id = ${filter.vaultId}`}
      ORDER BY ord
      ${filter.limit === undefined ? sql`` : sql`LIMIT ${filter.limit}`}`;
    return rows.map(auditRow);
  }

  async getVaultIdempotency(
    id: string,
  ): Promise<VaultIdempotencyRow | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT id, body_hash, response FROM ${this.t("vault_idempotency")} WHERE id = ${id}`;
    return row && { id: row.id, bodyHash: row.body_hash, response: row.response };
  }

  async insertVaultIdempotency(row: VaultIdempotencyRow): Promise<void> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("vault_idempotency")} (id, body_hash, response)
      VALUES (${row.id}, ${row.bodyHash}, ${row.response})`;
  }

  // --- subject tokens ------------------------------------------------------

  async insertSigningKey(row: SigningKeyRow): Promise<void> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("signing_keys")} (
        id, state, alg, public_jwk, kek_id, nonce, ciphertext, wrapped_dek,
        created_at, activated_at, retired_at, revoked_at
      ) VALUES (
        ${row.id}, ${row.state}, ${row.alg}, ${row.publicJwk}, ${row.kekId},
        ${bytes(row.nonce)}, ${bytes(row.ciphertext)}, ${bytes(row.wrappedDek)},
        ${row.createdAt}, ${row.activatedAt}, ${row.retiredAt}, ${row.revokedAt}
      )`;
  }

  async signingKey(id: string): Promise<SigningKeyRow | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT * FROM ${this.t("signing_keys")} WHERE id = ${id}`;
    return row && signingKeyRow(row);
  }

  async signingKeys(
    states?: readonly SigningKeyRow["state"][],
  ): Promise<SigningKeyRow[]> {
    this.check();
    const sql = this.sql;
    const rows = await sql`
      SELECT * FROM ${this.t("signing_keys")}
      ${states === undefined ? sql`` : sql`WHERE state = ANY(${states as string[]})`}
      ORDER BY created_at, id`;
    return rows.map(signingKeyRow);
  }

  async setSigningKeyState(
    id: string,
    from: SigningKeyRow["state"],
    to: SigningKeyRow["state"],
    at: string,
  ): Promise<boolean> {
    this.check();
    const sql = this.sql;
    const column = SIGNING_KEY_STAMP[to];
    const rows = await sql`
      UPDATE ${this.t("signing_keys")}
      SET state = ${to}${column ? sql`, ${sql(column)} = ${at}` : sql``}
      WHERE id = ${id} AND state = ${from}
      RETURNING id`;
    return rows.length === 1;
  }

  async countSigningKeys(): Promise<number> {
    this.check();
    const [row] = await this.sql`
      SELECT count(*)::int AS n FROM ${this.t("signing_keys")}`;
    return row!.n as number;
  }

  async subjectEpoch(subject: string): Promise<number> {
    this.check();
    const [row] = await this.sql`
      SELECT epoch FROM ${this.t("subject_epochs")} WHERE subject = ${subject}`;
    return row ? Number(row.epoch) : 0;
  }

  async subjectEpochs(subjects: readonly string[]): Promise<Map<string, number>> {
    this.check();
    if (subjects.length === 0) return new Map();
    const rows = await this.sql`
      SELECT subject, epoch FROM ${this.t("subject_epochs")}
      WHERE subject = ANY(${subjects as string[]})`;
    return new Map(rows.map((row) => [row.subject as string, Number(row.epoch)]));
  }

  async bumpSubjectEpoch(subject: string, at: string): Promise<number> {
    this.check();
    const [row] = await this.sql`
      INSERT INTO ${this.t("subject_epochs")} (subject, epoch, revoked_at)
      VALUES (${subject}, 1, ${at})
      ON CONFLICT (subject) DO UPDATE
        SET epoch = ${this.t("subject_epochs")}.epoch + 1, revoked_at = excluded.revoked_at
      RETURNING epoch`;
    return Number(row!.epoch);
  }

  async lockSubjectUsage(initial: SubjectUsageRow): Promise<SubjectUsageRow> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("subject_usage")} (subject, turn_tokens, refilled_at)
      VALUES (${initial.subject}, ${initial.turnTokens}, ${initial.refilledAt})
      ON CONFLICT (subject) DO NOTHING`;
    const [row] = await this.sql`
      SELECT subject, turn_tokens, refilled_at FROM ${this.t("subject_usage")}
      WHERE subject = ${initial.subject} FOR UPDATE`;
    return {
      subject: row!.subject,
      turnTokens: Number(row!.turn_tokens),
      refilledAt: row!.refilled_at,
    };
  }

  async putSubjectUsage(row: SubjectUsageRow): Promise<void> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("subject_usage")} (subject, turn_tokens, refilled_at)
      VALUES (${row.subject}, ${row.turnTokens}, ${row.refilledAt})
      ON CONFLICT (subject) DO UPDATE
        SET turn_tokens = excluded.turn_tokens, refilled_at = excluded.refilled_at`;
  }

  async countOwnerSessions(
    ownerUserId: string,
    statuses: readonly string[],
  ): Promise<number> {
    this.check();
    const [row] = await this.sql`
      SELECT count(*)::int AS n FROM ${this.t("sessions")}
      WHERE owner_user_id = ${ownerUserId} AND status = ANY(${statuses as string[]})`;
    return row!.n as number;
  }

  // --- publishable keys ----------------------------------------------------

  async insertPublishableKey(row: PublishableKeyRow): Promise<void> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("publishable_keys")} (id, key, name, origins_json, created_at, revoked_at)
      VALUES (${row.id}, ${row.key}, ${row.name}, ${row.originsJson}, ${row.createdAt}, ${row.revokedAt})`;
  }

  async publishableKeyByKey(key: string): Promise<PublishableKeyRow | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT * FROM ${this.t("publishable_keys")} WHERE key = ${key}`;
    return row && publishableKeyRow(row);
  }

  async publishableKey(id: string): Promise<PublishableKeyRow | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT * FROM ${this.t("publishable_keys")} WHERE id = ${id}`;
    return row && publishableKeyRow(row);
  }

  async publishableKeys(): Promise<PublishableKeyRow[]> {
    this.check();
    const rows = await this.sql`
      SELECT * FROM ${this.t("publishable_keys")} ORDER BY created_at, id`;
    return rows.map(publishableKeyRow);
  }

  async updatePublishableKey(
    id: string,
    patch: Partial<Pick<PublishableKeyRow, "originsJson" | "revokedAt">>,
  ): Promise<boolean> {
    this.check();
    const sql = this.sql;
    const sets = [
      ...(patch.originsJson === undefined ? [] : [sql`origins_json = ${patch.originsJson}`]),
      ...(patch.revokedAt === undefined ? [] : [sql`revoked_at = ${patch.revokedAt}`]),
    ];
    if (sets.length === 0) return (await this.publishableKey(id)) !== undefined;
    const rows = await sql`
      UPDATE ${this.t("publishable_keys")}
      SET ${sets.reduce((all, next) => sql`${all}, ${next}`)}
      WHERE id = ${id} RETURNING id`;
    return rows.length === 1;
  }

  // --- settings ------------------------------------------------------------

  async getSetting(key: string): Promise<string | undefined> {
    this.check();
    const [row] = await this.sql`
      SELECT value FROM ${this.t("tenant_settings")} WHERE key = ${key}`;
    return row?.value as string | undefined;
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.check();
    await this.sql`
      INSERT INTO ${this.t("tenant_settings")} (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  }

  // --- reset ---------------------------------------------------------------

  async reset(scope: ResetScope): Promise<void> {
    this.check();
    const sql = this.sql;
    if (scope === "sessions" || scope === "all") {
      for (const table of SESSION_TABLES) await sql`DELETE FROM ${this.t(table)}`;
      await sql`DELETE FROM ${this.t("subject_usage")}`;
    }
    if (scope === "sandboxes" || scope === "all")
      await sql`DELETE FROM ${this.t("sandboxes")}`;
    if (scope === "all") {
      await sql`DELETE FROM ${this.t("definitions")}`;
      await sql`DELETE FROM ${this.t("endpoints")}`;
      await sql`DELETE FROM ${this.t("vaults")} WHERE scope <> 'host'`;
    }
  }
}
