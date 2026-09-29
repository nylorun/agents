/**
 * The shared Tenant context: every Tenant module function takes a `TenantContext` instead of
 * calling methods on the composition root. It carries the stores and services and the
 * in-process work and live-stream state.
 *
 * Business code changes state only inside `ctx.store.tx(async (t) => …)` and follows the
 * seam rules: events through `t.event(...)` (the relay appends them to Durable Streams after
 * commit), executor wakes through `t.signalWork()`, and advances through
 * `t.afterCommit(() => ctx.wake(id, { reason, dedupeKey }))`. It never publishes or notifies
 * itself; `runtime.ts` wires the streams with `wireStreams()`. No external I/O runs inside a
 * tx.
 *
 * `wake` goes to `DurableExecution.wake`, which calls the Tenant's `advance` (`advance.ts`)
 * under ownership (§10.6); `abortLocal` aborts an advance running on this process.
 */
import type {
  RoleLimits,
  SubjectScope,
  TenantEnvelope,
} from "@nylorun/core/contracts";
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
import type { StuckInvocation, Wake } from "../execution/types.js";
import type { WorkState } from "./scheduler.js";
import type { SigningKeys } from "./signing-keys.js";
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
  /**
   * The last turn that ended (completed, failed or cancelled): the turn `status`, `lastOutput`
   * and `error` describe while no turn is active. A linked `agent` effect settles only from the
   * turn it started (`linkedTurnEnd` in `core/flow-host.ts`).
   */
  lastTurnId?: string;
  creation: unknown;
  vaultIds?: readonly string[];
  credentialSelections?: readonly CredentialSelection[];
  pluginRoots?: Readonly<Record<string, string>>;
  mcpSnapshot?: McpSnapshot;
  mcpDiagnostics?: readonly McpDiagnostic[];
  /** Session id that keys the shared sandbox; absent means this session owns it. */
  sandboxOwnerId?: string;
  /**
   * The incarnation naming this session's event stream (`sessions/<id>/<incarnation>`), set at
   * creation and never changed. Absent only on sessions created before incarnations.
   */
  streamIncarnation?: string;
}

export type AuthScope =
  | { kind: "application"; principalId: string }
  /**
   * A subject token (Host feature `subject-tokens`): one subject, the role's scopes and agents
   * narrowed by the token, until `expiresAt` (ms) or the subject's epoch moves past `epoch`.
   */
  | {
      kind: "token";
      subject: string;
      scopes: ReadonlySet<SubjectScope>;
      agents: ReadonlySet<string> | "*";
      role: string;
      limits?: RoleLimits;
      epoch: number;
      expiresAt: number;
      tokenId: string;
      keyId: string;
    }
  /** An application principal acting for `subject` (`Nylorun-Subject`), narrowed to `scopes`. */
  | {
      kind: "subject";
      principalId: string;
      subject: string;
      scopes: ReadonlySet<SubjectScope>;
    }
  | { kind: "executor"; executor: ExecutorRecord }
  /**
   * A publishable key with no bearer (Host feature `browser-access`): what the policy grants
   * `anon`, at most `agents:read`. It owns no session or vault.
   */
  | {
      kind: "publishable";
      keyId: string;
      scopes: ReadonlySet<SubjectScope>;
      agents: ReadonlySet<string> | "*";
    };

export interface TenantContext {
  readonly config: TenantConfig;
  readonly envelope: TenantEnvelope;
  readonly store: SessionStore;
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
  /** Advances running on this process, for `abortLocal`, drain and close. */
  readonly work: WorkState;
  /** Live delivery over Durable Streams: session feeds, executor streams, the streams wiring. */
  readonly live: LiveHub;
  /** The Tenant's signing keys for subject tokens. */
  readonly signingKeys: SigningKeys;
  /** The Worker id this process writes as session `owner` (§10.6). */
  readonly workerId: string;
  /** How long an advance's ownership lease lasts; the heartbeat renews it. */
  readonly ownerLeaseMs: number;
  /**
   * Seam: request an advance of a session (`DurableExecution.wake`). Call it from
   * `t.afterCommit`, never inside a tx. Dropped while the Tenant is closing; the sweep
   * re-wakes anything left runnable.
   */
  wake(sessionId: string, wake: Wake): Promise<void>;
  /** Seam: abort the advance of a session running in this process, if any. */
  abortLocal(sessionId: string): void;
  /** This Tenant's execution invocations that need an operator, for Tenant status. */
  readonly stuckInvocations?: () => Promise<StuckInvocation[]>;
  /** Callbacks the Tenant sweep runs after its own steps (`sweep.ts`). */
  readonly sweepHooks: ReadonlySet<() => Promise<void>>;
  /** Adds a sweep callback (the outbox drain, Wave 2 / Y). Returns a function that removes it. */
  onSweep(hook: () => Promise<void>): () => void;
}

/**
 * What a request acting for a person may reach: that person's sessions and vaults, and, for a
 * subject token, only sessions of the agents its role allows. Undefined means the whole Tenant.
 */
export interface SessionAccess {
  readonly owner: string;
  readonly agents?: ReadonlySet<string>;
}

/**
 * `access`, when set, limits the request to the owner's sessions of the allowed agents:
 * anything else is the same 404 as a missing session, so a subject cannot learn which session
 * ids exist.
 */
function owned<T extends Session>(
  session: T | undefined,
  access?: SessionAccess
): T {
  if (
    !session ||
    (access !== undefined &&
      (session.ownerUserId !== access.owner ||
        (access.agents !== undefined && !access.agents.has(session.agentId))))
  )
    return fail(404, "Session not found");
  return session;
}

/** The session, or a 404. Reads without locking. */
export async function sessionOf(
  t: Tx,
  id: string,
  access?: SessionAccess
): Promise<Session> {
  return owned(await t.get<StoredSession<Session>>("sessions", id), access);
}

/** Locks the session for the rest of the transaction and returns it, or a 404. */
export async function lockedSession(
  t: Tx,
  id: string,
  access?: SessionAccess
): Promise<Session> {
  return owned(await t.lockSession<Session>(id), access);
}

/** An advance's hold on its session (§10.6): every write the advance makes presents `epoch`. */
export interface Lease {
  readonly sessionId: string;
  readonly owner: string;
  readonly epoch: number;
}

/**
 * Locks `id` for the advance holding `lease`. The advance's own session is epoch-checked: a
 * mismatch (or a deleted session) throws `ownership.lost` before anything is written. Any
 * other session is only locked (or a 404).
 */
export async function ownedSession(
  t: Tx,
  lease: Lease,
  id: string
): Promise<Session> {
  if (id === lease.sessionId)
    return t.assertEpoch<Session>(id, lease.epoch);
  return lockedSession(t, id);
}

/** The session read in its own transaction, or a 404. */
export function loadSession(
  ctx: TenantContext,
  id: string,
  access?: SessionAccess
): Promise<Session> {
  return ctx.store.tx((t) => sessionOf(t, id, access));
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
