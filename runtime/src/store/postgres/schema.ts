/**
 * The tables of a Tenant database (session-store.md §2–§3): the source drizzle-kit generates
 * the migrations from (`drizzle/`, `CONTRIBUTING.md` "Adding a migration") and the query
 * builder's view of them. Column names are the camelCase keys in snake_case (`casing:
 * "snake_case"`, here, in `db.ts` and in `drizzle.config.ts`).
 *
 * - `nylorun` holds the Tenant's state: the one `tenant` row, the document tables, Action
 *   endpoints, principals, vaults and credentials, signing keys, settings, the model usage
 *   ledger, the model budgets, the Tool Gate's crossings and file artifacts with their versions.
 * - `nylorun_streams` holds the record (Durable Streams §6): `session_events`,
 *   `session_log_heads` and the relay's `relay_slots`. The relay's publication is custom SQL
 *   (`drizzle/0002_stream_relay.sql`).
 *
 * What the columns keep:
 *
 * - **Bodies are `json`, not `jsonb`** (`jsonText`), written as the text `JSON.stringify`
 *   wrote, so every string round-trips exactly, key order included. `jsonb` rejects the
 *   escapes `\u0000` (`22P05`) and unpaired surrogates (`\ud800`), which tool output can
 *   contain; `json` stores the text verbatim and checks only its syntax.
 * - **Indexed fields of a body are stored generated columns** read through
 *   `nylorun.doc(body)` (custom SQL, `drizzle/0000_foundation.sql`), which casts to `jsonb`
 *   after replacing those two escapes with `\ufffd`: the body is untouched, and only an indexed
 *   field that itself contained one (never an id, status or timestamp) would see U+FFFD.
 *   Queries never apply `->`/`->>` to a `json` body (Postgres de-escapes the whole text and
 *   fails on the same escapes); they read the generated columns.
 * - **Ids and timestamps compared as text are `COLLATE "C"`** (`textC`), so they order by code
 *   point whatever the database's collation.
 * - **Timestamps are ISO text**, except the session lease `owner_expires_at` and the record's
 *   `committed_at` (`timestamptz`).
 * - **Sealed secrets are `bytea` columns** (`bytes`), never inside a JSON body.
 * - Sessions carry the store-managed ownership columns (`owner`, `epoch`,
 *   `owner_expires_at`), which are never in `body`.
 *
 * Columns are listed in the order the tables have them, so a database created by these
 * migrations and one created by the hand-written migrations they replaced dump the same.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const TENANT_SCHEMA = "nylorun";
export const STREAMS_SCHEMA = "nylorun_streams";
/** The publication the stream relay subscribes to (`drizzle/0002_stream_relay.sql`). */
export const STREAMS_PUBLICATION = "nylorun_stream_relay";

export const nylorun = pgSchema(TENANT_SCHEMA);
export const nylorunStreams = pgSchema(STREAMS_SCHEMA);

// ---------------------------------------------------------------------------
// Column types

/** JSON text of `value`. Throws when `value` is not JSON (`undefined`, a function). */
export function toJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Document body must be JSON");
  return json;
}

/**
 * A `json` column written as the text `JSON.stringify` makes (`$1::text::json`), so the
 * database keeps exactly that text. postgres.js parses `json` results, so a read gives the
 * parsed value as is.
 */
export const jsonText = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "json",
  toDriver: (value) => sql`${toJson(value)}::text::json`,
});

/** `bytea` to and from `Uint8Array` (postgres.js reads a `Buffer`; the row gets a copy). */
export const bytes = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value),
});

/** `text COLLATE "C"`: ids and ISO timestamps that order by code point. */
export const textC = customType<{ data: string; driverData: string }>({
  dataType: () => 'text COLLATE "C"',
});

/** A generated column reading `path` of the body through `nylorun.doc(body)`. */
const field = (path: string) => text().generatedAlwaysAs(sql.raw(`nylorun.doc(body)${path}`));

/** A table of JSON documents keyed by `id`. */
const documents = (name: string) =>
  nylorun.table(name, { id: textC().primaryKey(), body: jsonText().notNull() });

// ---------------------------------------------------------------------------
// nylorun: the Tenant's state

/** The Tenant envelope: one row (`singleton`). */
export const tenant = nylorun.table(
  "tenant",
  {
    id: textC().primaryKey(),
    name: text().notNull(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
    /** The number of migrations applied when the row was last migrated (`migrate.ts`). */
    schemaVersion: integer().notNull(),
    singleton: boolean().notNull().default(true).unique("tenant_singleton_key"),
    /** The basin generation session streams go to (Durable Streams §8.1). */
    basinGeneration: integer().notNull().default(0),
    /** Earlier generations whose basins are still to be deleted. */
    retiredGenerations: integer().array().notNull().default(sql`'{}'`),
  },
  () => [check("tenant_singleton_check", sql`singleton`)],
);

export const definitions = documents("definitions");

export const sessions = nylorun.table(
  "sessions",
  {
    id: textC().primaryKey(),
    body: jsonText().notNull(),
    status: field("->>'status'"),
    agentId: field("->>'agentId'"),
    /** The lease holder; store-managed, never in `body`. */
    owner: text(),
    epoch: bigint({ mode: "number" }).notNull().default(0),
    ownerExpiresAt: timestamp({ withTimezone: true, mode: "date" }),
    /** The session owner (`ownerUserId`), not the lease column `owner`. */
    ownerUserId: field("->>'ownerUserId'"),
    /** The sandbox resource the session is attached to (`sandbox: { id }`). */
    sandboxId: field("->>'sandboxId'"),
  },
  (t) => [
    index("sessions_status").on(t.status, t.ownerExpiresAt),
    index("sessions_agent").on(t.agentId),
    index("sessions_owner_user").on(t.ownerUserId),
    index("sessions_sandbox").on(t.sandboxId),
  ],
);

export const commands = documents("commands");

export const effects = nylorun.table(
  "effects",
  {
    id: textC().primaryKey(),
    body: jsonText().notNull(),
    sessionId: field("->'request'->>'sessionId'"),
    turnId: field("->'request'->>'turnId'"),
    kind: field("->'request'->>'kind'"),
    status: field("->>'status'"),
  },
  (t) => [
    index("effects_session").on(t.sessionId, t.turnId, t.status),
    index("effects_status").on(t.status, t.kind),
  ],
);

export const actions = nylorun.table(
  "actions",
  {
    id: textC().primaryKey(),
    body: jsonText().notNull(),
    sessionId: field("->>'sessionId'"),
    turnId: field("->>'turnId'"),
    agentId: field("->>'agentId'"),
    status: field("->>'status'"),
    kind: field("->>'kind'"),
    /** When the Action being delivered is lost (ISO text). */
    deadlineAt: field("->>'deadlineAt'"),
  },
  (t) => [
    index("actions_session").on(t.sessionId, t.turnId, t.status),
    index("actions_agent").on(t.agentId, t.status),
    index("actions_status").on(t.status, t.kind),
    index("actions_deadline").on(t.status, t.deadlineAt),
  ],
);

export const sandboxes = documents("sandboxes");

export const links = nylorun.table(
  "links",
  {
    id: textC().primaryKey(),
    body: jsonText().notNull(),
    workflowSessionId: field("->>'workflowSessionId'"),
  },
  (t) => [index("links_workflow").on(t.workflowSessionId)],
);

/** An application principal: who holds a key, by its SHA-256. */
export const principals = nylorun.table("principals", {
  id: textC().primaryKey(),
  role: text().$type<"application" | (string & {})>().notNull(),
  tokenHash: text().notNull().unique("principals_token_hash_key"),
  idempotencyKey: text(),
  createdAt: text().notNull(),
});

export const vaults = nylorun.table(
  "vaults",
  {
    id: textC().primaryKey(),
    name: text().notNull(),
    ownerUserId: text().notNull(),
    /** JSON text, or null. */
    metadataJson: text(),
    createdAt: textC().notNull(),
    /**
     * `user`: one person's (owner `ownerUserId`); `installation`: the installation's own,
     * attachable to any session (owner `installation`); `host`: the model vault, never attached.
     */
    scope: text({ enum: ["user", "installation", "host"] }).notNull().default("user"),
  },
  (t) => [
    index("vaults_owner").on(t.ownerUserId, t.createdAt, t.id),
    uniqueIndex("vaults_one_host").on(t.scope).where(sql`scope = 'host'`),
    check("vaults_scope_check", sql`scope IN ('user', 'installation', 'host')`),
  ],
);

/** A credential of a vault: its binding in the clear, its secret sealed. */
export const vaultCredentials = nylorun.table(
  "vault_credentials",
  {
    id: textC().primaryKey(),
    vaultId: text().notNull(),
    name: text().notNull(),
    type: text({ enum: ["bearer", "oauth", "model"] }).notNull(),
    /** JSON text of the non-secret binding (url, or provider and model). */
    bindingJson: text().notNull(),
    expiresAt: text(),
    createdAt: textC().notNull(),
    rotatedAt: text(),
    kekId: text().notNull(),
    nonce: bytes().notNull(),
    ciphertext: bytes().notNull(),
    wrappedDek: bytes().notNull(),
  },
  (t) => [
    foreignKey({
      name: "vault_credentials_vault_id_fkey",
      columns: [t.vaultId],
      foreignColumns: [vaults.id],
    }).onDelete("cascade"),
    index("vault_credentials_vault").on(t.vaultId, t.createdAt, t.id),
  ],
);

export const vaultAudit = nylorun.table(
  "vault_audit",
  {
    ord: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    id: text().notNull().unique("vault_audit_id_key"),
    at: text().notNull(),
    actor: text().notNull(),
    action: text().notNull(),
    vaultId: text(),
    credentialId: text(),
    sessionId: text(),
    target: text(),
    outcome: text().notNull(),
  },
  (t) => [index("vault_audit_vault").on(t.vaultId, t.ord)],
);

export const vaultIdempotency = nylorun.table("vault_idempotency", {
  id: text().primaryKey(),
  bodyHash: text().notNull(),
  /** JSON text of the original response. */
  response: text().notNull(),
});

/**
 * An MCP OAuth connect between its start and its callback (F9 C2): found by the SHA-256 of its
 * `state`, used once, for ten minutes. The PKCE verifier and any client secret are sealed under
 * the vault key (`sealBytes`), which only the keys module holds.
 */
export const oauthPending = nylorun.table(
  "oauth_pending",
  {
    stateHash: text().primaryKey(),
    vaultId: text().notNull(),
    /** The MCP server's name in the agent, the credential's name. */
    server: text().notNull(),
    /** The MCP server's URL (normalized): the credential's binding. */
    url: text().notNull(),
    tokenEndpoint: text().notNull(),
    clientId: text().notNull(),
    /** How the client authenticates at the token endpoint: `none`, `client_secret_basic` or `client_secret_post`. */
    tokenEndpointAuth: text({ enum: ["none", "client_secret_basic", "client_secret_post"] }).notNull(),
    /** The RFC 8707 resource indicator sent with the authorization request, if any. */
    resource: text(),
    kekId: text().notNull(),
    /** Sealed; null for a public client. */
    clientSecret: bytes(),
    /** Sealed. */
    codeVerifier: bytes().notNull(),
    redirectUri: text().notNull(),
    expiresAt: textC().notNull(),
    createdAt: textC().notNull(),
  },
  (t) => [
    foreignKey({
      name: "oauth_pending_vault_id_fkey",
      columns: [t.vaultId],
      foreignColumns: [vaults.id],
    }).onDelete("cascade"),
    index("oauth_pending_expires").on(t.expiresAt),
  ],
);

export const tenantSettings = nylorun.table("tenant_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});

/**
 * The Tenant's signing keys (delivery tokens, capability links, run and host tokens): the
 * private half sealed, the public JWK not.
 */
export const signingKeys = nylorun.table(
  "signing_keys",
  {
    id: textC().primaryKey(),
    state: text({ enum: ["standby", "current", "previous", "revoked"] }).notNull(),
    alg: text({ enum: ["ES256"] }).notNull(),
    /** JSON text of the public JWK. */
    publicJwk: text().notNull(),
    kekId: text().notNull(),
    nonce: bytes().notNull(),
    ciphertext: bytes().notNull(),
    wrappedDek: bytes().notNull(),
    createdAt: text().notNull(),
    activatedAt: text(),
    retiredAt: text(),
    revokedAt: text(),
  },
  (t) => [
    check(
      "signing_keys_state_check",
      sql`state IN ('standby', 'current', 'previous', 'revoked')`,
    ),
    check("signing_keys_alg_check", sql`alg = 'ES256'`),
    uniqueIndex("signing_keys_one_standby").on(t.state).where(sql`state = 'standby'`),
    uniqueIndex("signing_keys_one_current").on(t.state).where(sql`state = 'current'`),
    uniqueIndex("signing_keys_one_previous").on(t.state).where(sql`state = 'previous'`),
  ],
);

/**
 * Action endpoints: where the Runtime delivers each agent's Actions over HTTP, and the health
 * recent deliveries and the last ping report.
 */
export const endpoints = nylorun.table("endpoints", {
  agentId: textC().primaryKey(),
  url: text().notNull(),
  implementationVersion: text().notNull(),
  manifestHash: text(),
  timeoutMs: integer().notNull(),
  maxConcurrent: integer().notNull(),
  principalId: text(),
  lastDeliveryAt: text(),
  lastSuccessAt: text(),
  lastErrorCode: text(),
  lastErrorMessage: text(),
  consecutiveFailures: integer().notNull().default(0),
  servedImplementationVersion: text(),
  servedManifestHash: text(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

/**
 * The model usage ledger (P1.3): one row per model call a gate served, written after the call.
 * A second row for the same effect (a call the gate ran again after a gateway restart) is
 * flagged `duplicate`; both were billed. Budgets read their spend from it. Token counts are 0
 * when the provider sent none.
 */
export const modelUsage = nylorun.table(
  "model_usage",
  {
    id: textC().primaryKey(),
    /** The model effect's id; unique per Tenant, since it carries the turn id. */
    effectKey: textC().notNull(),
    sessionId: textC().notNull(),
    turnId: textC().notNull(),
    agentId: textC().notNull(),
    provider: text(),
    model: text(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    totalTokens: integer().notNull(),
    cachedTokens: integer().notNull(),
    cacheWriteTokens: integer().notNull(),
    reasoningTokens: integer().notNull(),
    costUsd: doublePrecision().notNull(),
    /** True when an earlier row has the same `effectKey`: the provider billed the call twice. */
    duplicate: boolean().notNull(),
    createdAt: text().notNull(),
  },
  (t) => [
    index("model_usage_effect").on(t.effectKey),
    index("model_usage_agent").on(t.agentId, t.createdAt),
    index("model_usage_turn").on(t.turnId),
    index("model_usage_created").on(t.createdAt),
  ],
);

/**
 * Model budgets (P1.3): hard caps the model gate checks before each call, at least one limit
 * set. One row per scope: `turn` and `tenant` use `*`, `agent` the agent id. `period` is the
 * UTC `day` or `month` the spend is counted over, or null for `turn`.
 */
export const modelBudgets = nylorun.table(
  "model_budgets",
  {
    scope: text({ enum: ["tenant", "agent", "turn"] }).notNull(),
    scopeId: textC().notNull(),
    period: text({ enum: ["day", "month"] }),
    limitUsd: doublePrecision(),
    limitTokens: bigint({ mode: "number" }),
    updatedAt: text().notNull(),
  },
  (t) => [primaryKey({ name: "model_budgets_pkey", columns: [t.scope, t.scopeId] })],
);

/**
 * The Tool Gate's keyed MCP calls (F4.1 G3): one row per call, written by the gates service
 * before it calls the server and given the answer after. A re-send whose row has an answer
 * gets it; one whose row has none, and that the gateway no longer runs, was lost with an
 * earlier gateway and answers `uncertain`, so a call is never run twice. Rows are deleted a
 * day after they settle.
 */
export const toolCrossings = nylorun.table(
  "tool_crossings",
  {
    /** The call's effect id (`Idempotency-Key`). */
    key: textC().primaryKey(),
    /** SHA-256 of the canonical request: a re-send with another request is refused. */
    hash: text().notNull(),
    startedAt: textC().notNull(),
    settledAt: textC(),
    /** The gate's answer (`McpAnswer`), once the call ended; null while it runs or once lost. */
    answer: jsonText(),
  },
  (t) => [index("tool_crossings_settled").on(t.settledAt)],
);

/**
 * A sandbox resource (blueprint D39, F7.1): its id, kind, the spec resolved against the
 * Tenant's limits when it was created, and the developer's labels. Sessions attach to it by id
 * (the session body's `sandboxId`). Not the `sandboxes` document table, which holds the virtual
 * backend's compute records, keyed by workspace key.
 */
export const sandboxResources = nylorun.table("sandbox_resources", {
  id: textC().primaryKey(),
  kind: text({ enum: ["virtual", "pod"] }).notNull(),
  /** The resolved `SandboxManifest`. */
  spec: jsonText().notNull(),
  /** `{ key: value }`, filtered through `nylorun.doc(labels)`. */
  labels: jsonText().notNull(),
  createdAt: textC().notNull(),
  updatedAt: textC().notNull(),
  // Kind `pod` (F7.2, D34): null for a virtual sandbox. `tenant/sandboxes.ts` and the
  // `Sandbox` object's reconcile (`sandbox/pods/reconcile.ts`) are the only writers.
  /** The agent-sandbox Sandbox's name, `sbx-<16 base32>-g<volume_gen>` (`podName`). */
  k8sName: textC(),
  /** Bumped by every reset: a new Sandbox on a new volume. */
  volumeGen: integer().notNull().default(0),
  /** `running`, `suspended` or `deleted`. */
  desired: text({ enum: ["running", "suspended", "deleted"] }),
  /** `creating`, `running`, `suspended`, `expired`, `lost`, `failed` or `deleting`. */
  observed: text({
    enum: ["creating", "running", "suspended", "expired", "lost", "failed", "deleting"],
  }),
  /** The UID of the pod that last joined. */
  podUid: text(),
  /**
   * Bumped by every join (`host.join`), relaunch, loss and reset: host and egress tokens carry
   * it (`epc`), and one of an older epoch is refused (egress-gate reads it too).
   */
  hostEpoch: integer().notNull().default(0),
  /** sha256 (hex) of the incarnation's join token; the token itself is never stored. */
  joinTokenHash: text(),
  /** Bumped by every change the Runtime asks of the pod: the sandboxes service's `opId`. */
  rev: integer().notNull().default(0),
  /** When a turn last ended on it, for the idle timer. */
  lastActiveAt: timestamp({ withTimezone: true }),
  /** When its TTL passes (`createdAt + lifecycle.ttl`). */
  expiresAt: timestamp({ withTimezone: true }),
  /** When the current incarnation was asked to run, for the ready deadline. */
  startedAt: timestamp({ withTimezone: true }),
  /** Why it failed or was lost. */
  reason: text(),
  /** An earlier incarnation's Sandbox still to delete (after a reset or a loss). */
  retiring: textC(),
  /**
   * The id the engine keeps on the volume (`/harness/volume-id`), recorded at the first join:
   * a join with another one means the volume was replaced (its files are gone), so `lost`.
   */
  volumeId: text(),
});

/**
 * Artifacts (blueprint D35, F8.1 and F8.2): an id, a name and numbered versions. The bytes are in
 * the Object store under each version's `blobKey` (a folder's: its manifest); a blob counts only
 * once its version row commits. `sessionId` is the session the artifact belongs to, or null for
 * a Tenant-wide one an application made. `latestVersion` is the newest version's number.
 */
export const artifacts = nylorun.table(
  "artifacts",
  {
    id: textC().primaryKey(),
    kind: text({ enum: ["file", "folder"] }).notNull(),
    name: text().notNull(),
    contentType: text().notNull(),
    sessionId: textC(),
    latestVersion: integer().notNull(),
    /** Labels as JSON text, or null. */
    labelsJson: text(),
    createdAt: textC().notNull(),
    updatedAt: text().notNull(),
  },
  (t) => [
    index("artifacts_session").on(t.sessionId, t.createdAt, t.id),
    check("artifacts_kind_check", sql`kind IN ('file', 'folder')`),
  ],
);

/** The versions of an artifact, immutable once written. */
export const artifactVersions = nylorun.table(
  "artifact_versions",
  {
    artifactId: textC().notNull(),
    version: integer().notNull(),
    /** Where the bytes are in the Object store (`BlobStore`). */
    blobKey: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    sha256: text().notNull(),
    contentType: text().notNull(),
    source: text({ enum: ["upload", "engine", "export"] }).notNull(),
    createdAt: textC().notNull(),
  },
  (t) => [
    primaryKey({ name: "artifact_versions_pkey", columns: [t.artifactId, t.version] }),
    foreignKey({
      name: "artifact_versions_artifact_id_fkey",
      columns: [t.artifactId],
      foreignColumns: [artifacts.id],
    }).onDelete("cascade"),
  ],
);

/**
 * The content-addressed files each folder version references (F8.2), one row per distinct
 * SHA-256: the index that says which `blobs/sha256/<hex>` objects are still in use, so deleting
 * a folder removes only the files no other version names, and the Tenant total counts each file
 * once. The manifest itself stays the source of truth for paths.
 */
export const artifactContent = nylorun.table(
  "artifact_content",
  {
    artifactId: textC().notNull(),
    version: integer().notNull(),
    sha256: textC().notNull(),
    size: bigint({ mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ name: "artifact_content_pkey", columns: [t.artifactId, t.version, t.sha256] }),
    foreignKey({
      name: "artifact_content_version_fkey",
      columns: [t.artifactId, t.version],
      foreignColumns: [artifactVersions.artifactId, artifactVersions.version],
    }).onDelete("cascade"),
    index("artifact_content_sha256").on(t.sha256),
  ],
);

// ---------------------------------------------------------------------------
// nylorun_streams: the record

/**
 * Each sandbox's lifecycle stream (`nylorun.sandbox-event/1`), numbered from 0 per sandbox id.
 * Written only by the record module; not published to the stream relay.
 */
export const sandboxEvents = nylorunStreams.table(
  "sandbox_events",
  {
    sandboxId: textC().notNull(),
    seq: bigint({ mode: "number" }).notNull(),
    type: text().notNull(),
    body: jsonText().notNull(),
    committedAt: timestamp({ withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "sandbox_events_pkey", columns: [t.sandboxId, t.seq] })],
);

/** Each session's log head: the next seq and the basin generation its events go to. */
export const sessionLogHeads = nylorunStreams.table("session_log_heads", {
  sessionId: textC().primaryKey(),
  generation: integer().notNull(),
  head: bigint({ mode: "number" }).notNull().default(0),
});

/** The record of every session event, the `nylorun.event/2` envelope as written. */
export const sessionEvents = nylorunStreams.table(
  "session_events",
  {
    sessionId: textC().notNull(),
    seq: bigint({ mode: "number" }).notNull(),
    generation: integer().notNull(),
    type: text().notNull(),
    body: jsonText().notNull(),
    committedAt: timestamp({ withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "session_events_pkey", columns: [t.sessionId, t.seq] })],
);

/**
 * One row per replication slot: whether the record still has to be reconciled with S2 after
 * the slot was created (a crash during reconciliation leaves it pending). The stream relay's
 * replication adapter reads and writes it (`adapters/replication/pgoutput.ts`).
 */
export const relaySlots = nylorunStreams.table("relay_slots", {
  slotName: text().primaryKey(),
  reconcilePending: boolean().notNull(),
});

// ---------------------------------------------------------------------------
// Rows the Session Store hands out (`store/types.ts` re-exports them)

export type PrincipalRow = typeof principals.$inferSelect;
export type VaultRow = typeof vaults.$inferSelect;
export type VaultCredentialRow = typeof vaultCredentials.$inferSelect;
export type VaultAuditRow = Omit<typeof vaultAudit.$inferSelect, "ord">;
export type VaultIdempotencyRow = typeof vaultIdempotency.$inferSelect;
export type OAuthPendingRow = typeof oauthPending.$inferSelect;
export type SigningKeyRow = typeof signingKeys.$inferSelect;
export type ModelUsageRow = typeof modelUsage.$inferSelect;
export type ModelBudgetRow = typeof modelBudgets.$inferSelect;
export type ToolCrossingRow = typeof toolCrossings.$inferSelect;
export type SandboxResourceRow = typeof sandboxResources.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
