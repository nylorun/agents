/**
 * The shared Tenant context: every Tenant module function takes a `TenantContext` instead of
 * calling methods on the composition root. It carries the stores and services and the
 * in-process work and live-stream state.
 *
 * Business code changes state only inside `ctx.store.tx(async (t) => …)` and follows the
 * seam rules: events through `t.event(...)` (the relay appends them to Durable Streams after
 * commit), and advances through `t.afterCommit(() => ctx.wake(id, { reason, dedupeKey }))`. It never publishes or notifies
 * itself; `runtime.ts` wires the streams with `wireStreams()`. No external I/O runs inside a
 * tx.
 *
 * `wake` goes to `DurableExecution.wake`, which calls the Tenant's `advance` (`advance.ts`)
 * under ownership (§10.6); `abortLocal` aborts an advance running on this process.
 */
import type { SessionHistory } from "./history.js";
import type {
  IssuerScope,
  SubjectScope,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import type {
  DurableCheckpoint,
  FlowCheckpoint,
} from "@nylorun/harness/run";
import type { AgentManifest, JsonValue, SandboxManifest } from "@nylorun/core/define";
import type { CredentialSelection } from "@nylorun/core/contracts";
import type { SessionStore, StoredSession, Tx } from "../store/types.js";
import type { FlowLimits } from "../core/limits.js";
import type { ModelProvider } from "../core/provider.js";
import type { ModelGate } from "../gates/model-gate.js";
import type { ToolGate } from "../gates/tool-gate.js";
import type { Keys } from "../keys/keys.js";
import type { VaultService } from "../vault/service.js";
import type { CredentialSources } from "../vault/sources.js";
import type { McpPool } from "../mcp/pool.js";
import type { McpDiagnostic, McpSnapshot } from "../mcp/snapshot.js";
import type { HarnessApiServer } from "../harness-api/server.js";
import type { WorkspacePort } from "../harness-api/workspace.js";
import type { SandboxesClient } from "../sandbox/pods/client.js";
import type { SandboxSignal } from "../execution/types.js";
import type { TenantConfig } from "./types.js";
import type { SessionStreams } from "./session-streams.js";
import type { StuckInvocation, Wake } from "../execution/types.js";
import type { WorkState } from "./scheduler.js";
import type { SigningKeys } from "./signing-keys.js";
import type { BlobStore } from "../blob/index.js";
import type { WorkspaceReader } from "../artifacts/workspace.js";
import type { RunGrants } from "./run-grants.js";
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
  /** The engine state; its transcript is folded from the record (`history.ts`), not stored. */
  state?: any;
  turnStartState?: any;
  /** Where the transcript's fold starts in the session's record (`history.ts`). */
  history?: SessionHistory;
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
  mcpSnapshot?: McpSnapshot;
  mcpDiagnostics?: readonly McpDiagnostic[];
  /** Session id that keys the shared sandbox; absent means this session owns it. */
  sandboxOwnerId?: string;
  /**
   * The sandbox resource the session is attached to (`sandbox: { id }`): its workspace is the
   * sandbox's, shared with every session attached to it, and it outlives the session.
   */
  sandboxId?: string;
  /**
   * The sandbox chosen when the session was opened, resolved against the Tenant's limits, or
   * inherited from the session it shares with. Absent when the session has no sandbox or its
   * definition declares one (`.sandbox()`).
   */
  sandbox?: SandboxManifest;
  /** Where `sandbox` came from: `sandbox` is a sandbox resource's spec. */
  sandboxSource?: "default" | "inline" | "shared" | "sandbox";
}

export type AuthScope =
  | { kind: "application"; principalId: string }
  /**
   * A management key (role `management`), or Studio's key on a Management API route: the
   * principal acting as itself, never for a subject. It reaches only the Management API
   * (`/v1/tenant/*`) and `/v1/me`.
   */
  | { kind: "management"; principalId: string }
  /**
   * A trusted issuer's token (Host feature `trusted-issuers`, F9-D12): one subject, with the
   * issuer's scopes, agents and sandbox grants, until `expiresAt` (ms). Only its expiry ends it.
   */
  | {
      kind: "token";
      /** The identity file's issuer that signed it. */
      issuer: string;
      subject: string;
      /** The issuer's scopes the token holds, which may add `studio`. */
      scopes: ReadonlySet<IssuerScope>;
      agents: ReadonlySet<string> | "*";
      /** The sandboxes it reaches: exact ids or `p/*` prefixes. Absent or empty reaches none. */
      sandboxes?: readonly string[];
      expiresAt: number;
      /** The token's `jti`, or a hash of it. */
      tokenId: string;
      /** The issuer key's `kid`, when it has one. */
      keyId?: string;
    }
  /** An application principal acting for `subject` (`Nylorun-Subject`), narrowed to `scopes`. */
  | {
      kind: "subject";
      principalId: string;
      subject: string;
      scopes: ReadonlySet<SubjectScope>;
    }
  /** No credential, on a route that serves public data (`RouteAccess.anonymous`). */
  | { kind: "anonymous" };

export interface TenantContext {
  readonly reads?: import("../reads/types.js").ReadStore;
  readonly config: TenantConfig;
  readonly envelope: TenantEnvelope;
  readonly store: SessionStore;
  readonly vault: VaultService;
  /**
   * A session's MCP credentials, for the in-process MCP pool: its attached vaults, then the
   * operator's credential resolver (`TenantConfig.resolver`, F9 C1).
   */
  readonly credentials: CredentialSources;
  /**
   * The MCP pool of the Tenant's in-process harness. Absent when harnesses run elsewhere
   * (`NYLORUN_HARNESS=remote`): each keeps its own (F6.2).
   */
  readonly mcp?: McpPool;
  /**
   * The workspace capability (F6.2): the Tenant's SandboxManager with an in-process harness,
   * else the harness that serves workspaces (`harness-api/workspace.ts`).
   */
  readonly sandbox: WorkspacePort;
  readonly flowLimits: FlowLimits;
  readonly modelProvider: ModelProvider;
  /** True when the model comes from the Tenant vault selection, served by `modelGate`. */
  readonly useVaultModel: boolean;
  /** Serves vault-backed model calls (blueprint §15): in this process, or the gates service. */
  readonly modelGate: ModelGate;
  /**
   * Serves remote MCP servers and HTTP tools (blueprint §12, F4.1): in this process, or the
   * gates service.
   */
  readonly toolGate: ToolGate;
  /**
   * Vault writes that touch a secret, and all token signing (blueprint §14, F4.2): in this
   * process, or the gateway's keys service. Call it instead of `vault`'s sealing methods and
   * `signingKeys`' private key.
   */
  readonly keys: Keys;
  /**
   * The Object store's `BlobStore` seam (D35): the Host's `s3` store (RustFS in the local
   * stack), or the `fs` store under `paths.blobs` without one. Bytes only; Postgres holds what
   * they mean, and a blob counts once a committed row names its key.
   */
  readonly blobs: BlobStore;
  /**
   * How core reads a session's sandbox workspace at turn end, to export its outputs (F8.2): over
   * this process's `sandbox` today; over the Harness API's `workspace.read` from F6.2.
   */
  readonly workspaces: WorkspaceReader;
  /**
   * The run token of each session an advance of this process owns (F5): the credential the
   * HTTP gate clients present for that session's model and MCP calls (`run-grants.ts`).
   * Absent when the gates run in this process, which needs no token (G6).
   */
  readonly runGrants?: RunGrants;
  /**
   * The Harness API server (D37): advances offer their segments here, and the Tenant's
   * harnesses (the in-process one, or attached ones) run them.
   */
  readonly harness: HarnessApiServer;
  /** Set by drain/close; reset clears it again. Stops new advances. */
  closing: boolean;
  /** Set once close has finished releasing resources. */
  closed: boolean;
  /** Advances running on this process, for `abortLocal`, drain and close. */
  readonly work: WorkState;
  /** Live delivery over Durable Streams: one `SessionStream` per observed session, and the streams wiring. */
  readonly sessionStreams: SessionStreams;
  /** This process's follower of the control bus (`control.ts`), once wired. */
  control?: { close(): Promise<void> };
  /** The Tenant's signing keys: capability links, run and host tokens. */
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
  /**
   * Seam: abort the advance of a session running in this process, if any. With `turnId`, only
   * an advance of that turn (a cancel signal names the turn it cancelled).
   */
  abortLocal(sessionId: string, turnId?: string): void;
  /**
   * Sandbox pods (F7.2): the sandboxes service and the Runtime image pods copy the engine from.
   * Absent without a cluster (`nylorun sandbox enable`): kind `pod` is `sandbox_unavailable`.
   */
  readonly pods?: TenantPods;
  /**
   * Seam: reconcile a pod sandbox, or arm one of its timers (`DurableExecution.sandbox`). Call
   * it from `t.afterCommit`. Dropped while the Tenant is closing; the sweep re-sends reconciles.
   */
  sandboxSignal(sandboxId: string, signal: SandboxSignal): Promise<void>;
  /** This Tenant's execution invocations that need an operator, for Tenant status. */
  readonly stuckInvocations?: () => Promise<StuckInvocation[]>;
  /** Callbacks the Tenant sweep runs after its own steps (`sweep.ts`). */
  readonly sweepHooks: ReadonlySet<() => Promise<void>>;
  /** Adds a sweep callback. Returns a function that removes it. */
  onSweep(hook: () => Promise<void>): () => void;
}

/**
 * What a request acting for a person may reach: that person's sessions, and, for a token
 * caller, only sessions of the agents its issuer allows. Undefined means the whole Tenant.
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

/** The sandboxes service a Tenant drives its pod sandboxes with (`TenantContext.pods`). */
export interface TenantPods {
  readonly client: SandboxesClient;
  /** The Runtime image the pods copy the engine from (`NYLORUN_SANDBOX_HARNESS_IMAGE`). */
  readonly harnessImage: string;
}
