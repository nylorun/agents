/**
 * The shared Tenant context: every Tenant module function takes a `TenantContext` instead of
 * calling methods on the composition root. It carries the stores and services, the in-process
 * work and live-stream state, and the three seams business code must use:
 *
 * - `ctx.publish(event)` — tell live observers about a committed event;
 * - `ctx.notify()` — tell connected executors that work is available;
 * - `ctx.schedule(sessionId)` — ask for an advance of a session.
 *
 * Later waves replace each seam in one place (`runtime.ts` wires them): Wave 1 / A makes the
 * store async, Wave 2 / X puts `schedule` and `abortLocal` behind `DurableExecution`, and
 * Wave 2 / Y puts `publish` and `notify` behind Durable Streams.
 */
import type { LiveEvent, TenantEnvelope } from "@nylorun/core/contracts";
import type {
  DurableCheckpoint,
  FlowCheckpoint,
} from "@nylorun/harness/run";
import type { AgentManifest, JsonValue } from "@nylorun/core/define";
import type { CredentialSelection } from "@nylorun/core/contracts";
import type { Store } from "../core/store.js";
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

export interface TenantContext {
  readonly config: TenantConfig;
  readonly envelope: TenantEnvelope;
  readonly store: Store;
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
  /** Seam: deliver a committed event to live observers. */
  publish(event: LiveEvent): void;
  /** Seam: tell connected executors that work is available. */
  notify(): void;
  /** Seam: request an advance of a session. */
  schedule(sessionId: string): void;
  /** Seam: abort the advance of a session running in this process, if any. */
  abortLocal(sessionId: string): void;
}

/** The session row, or a 404. */
export function sessionOf(ctx: TenantContext, id: string): Session {
  return (
    ctx.store.get<Session>("sessions", id) ?? fail(404, "Session not found")
  );
}
