/**
 * The shared Tenant context: every Tenant module function takes a `TenantContext` instead of
 * calling methods on the composition root. It carries the stores and services and the
 * in-process work and live-stream state.
 *
 * Business code changes state only inside `ctx.store.tx(async (t) => …)` and follows the
 * seam rules: events through `t.event(...)` (the store delivers them to live observers after
 * commit), executor wakes through `t.signalWork()`, and advances through
 * `t.afterCommit(() => ctx.schedule(id))`. It never calls `publish` or `notify` itself;
 * `runtime.ts` wires the store's commit listener to them. No external I/O runs inside a tx.
 *
 * Later waves replace each seam in one place (`runtime.ts` wires them): Wave 2 / X puts
 * `schedule` and `abortLocal` behind `DurableExecution`, and Wave 2 / Y puts the commit
 * listener and `history` behind Durable Streams.
 */
import type { LiveEvent, TenantEnvelope } from "@nylorun/core/contracts";
import type {
  DurableCheckpoint,
  FlowCheckpoint,
} from "@nylorun/harness/run";
import type { AgentManifest, JsonValue } from "@nylorun/core/define";
import type { CredentialSelection } from "@nylorun/core/contracts";
import type { SessionStore, StoredSession, Tx } from "../store/types.js";
import type { ExecutorRecord, ExecutorRegistry } from "../core/executors.js";
import type { FlowLimits } from "../core/limits.js";
import type { ModelProvider } from "../core/provider.js";
import type { VaultService } from "../vault/service.js";
import type { McpPool } from "../mcp/pool.js";
import type { McpDiagnostic, McpSnapshot } from "../mcp/snapshot.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { TenantConfig } from "./types.js";
import type { LiveHub } from "./live.js";
import type { WorkState } from "./scheduler.js";
import { fail } from "./http.js";

export interface Session {
  id: string;
  agentId: string;
  ownerUserId: string;
  /** Session pin — the manifest the session was created with. */
  manifest: any;
  manifestHash: string;
  /** Validated turn-manifest variants, keyed by hash (loops.md §4.2). */
  variants?: Record<string, AgentManifest>;
  implementationVersion: string;
  info?: any;
  status: string;
  activeTurnId: string | null;
  checkpoint?: DurableCheckpoint | FlowCheckpoint;
  state?: any;
  turnStartState?: any;
  waits?: unknown;
  error?: string;
  /** Last completed turn output (for linked agent → workflow settle). */
  lastOutput?: JsonValue;
  creation: unknown;
  vaultIds?: readonly string[];
  credentialSelections?: readonly CredentialSelection[];
  pluginRoots?: Readonly<Record<string, string>>;
  mcpSnapshot?: McpSnapshot;
  mcpDiagnostics?: readonly McpDiagnostic[];
  /** Session id that keys the shared sandbox; absent means this session owns it. */
  sandboxOwnerId?: string;
}

export type AuthScope =
  | { kind: "application"; principalId: string }
  | { kind: "executor"; executor: ExecutorRecord };

/** Reads a session's committed events (the SQLite events table until Wave 2 / Y). */
export interface EventHistory {
  readEvents(
    sessionId: string,
    afterSeq?: number
  ): Promise<{ events: LiveEvent[]; lastSeq: number | null }>;
}

export interface TenantContext {
  readonly config: TenantConfig;
  readonly envelope: TenantEnvelope;
  readonly store: SessionStore;
  /** Seam: session history for `GET …/items` and SSE replay. */
  readonly history: EventHistory;
  readonly vault: VaultService;
  readonly registry: ExecutorRegistry;
  readonly mcp: McpPool;
  readonly sandbox: SandboxManager;
  readonly flowLimits: FlowLimits;
  readonly modelProvider: ModelProvider;
  /** True when the model comes from the Tenant vault selection (pi-ai adapter). */
  readonly useVaultModel: boolean;
  /** Set by drain/close; reset clears it again. Stops new advances. */
  closing: boolean;
  /** Set once close has finished releasing resources. */
  closed: boolean;
  /** In-process advances: running controllers and pending wakes. */
  readonly work: WorkState;
  /** In-process live streams: session observers and executor streams. */
  readonly live: LiveHub;
  /** Seam: request an advance of a session. Call it from `t.afterCommit`, never inside a tx. */
  schedule(sessionId: string): void;
  /** Seam: abort the advance of a session running in this process, if any. */
  abortLocal(sessionId: string): void;
}

/** The session, or a 404. Reads without locking. */
export async function sessionOf(t: Tx, id: string): Promise<Session> {
  return (
    (await t.get<StoredSession<Session>>("sessions", id)) ??
    fail(404, "Session not found")
  );
}

/** Locks the session for the rest of the transaction and returns it, or a 404. */
export async function lockedSession(t: Tx, id: string): Promise<Session> {
  return (
    (await t.lockSession<Session>(id)) ?? fail(404, "Session not found")
  );
}

/** The session read in its own transaction, or a 404. */
export function loadSession(ctx: TenantContext, id: string): Promise<Session> {
  return ctx.store.tx((t) => sessionOf(t, id));
}

/**
 * A synchronous lookup over `start` and every session its `sandboxOwnerId` chain names, for
 * the sandbox-sharing helpers, which walk that chain synchronously.
 */
export async function sandboxLookup(
  t: Tx,
  start: string | undefined
): Promise<(id: string) => Session | undefined> {
  const found = new Map<string, Session>();
  let id = start;
  while (id && !found.has(id)) {
    const session = await t.get<Session>("sessions", id);
    if (!session) break;
    found.set(id, session);
    id = session.sandboxOwnerId;
  }
  return (sid) => found.get(sid);
}
