import { type ServerResponse, type IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  AgentManifestSchema,
  CreateCredentialRequestSchema,
  CreateVaultRequestSchema,
  PutAgentRequestSchema,
  PutHostModelRequestSchema,
  SelectHostModelRequestSchema,
  PutSessionRequestSchema,
  RegisterExecutorsRequestSchema,
  RotateCredentialRequestSchema,
  SessionCommandSchema,
  ActionClaimRequestSchema,
  ActionHeartbeatRequestSchema,
  ResetTenantRequestSchema,
  SeedTenantConfigRequestSchema,
  type Action,
  type CredentialSelection,
  type ExecutorScope,
  type SessionCommand,
  type LiveEvent,
  DefinitionDocumentSchema,
} from "@nylorun/core/contracts";
import {
  createDurableCheckpoint,
  createFlowCheckpoint,
  runDurable,
  runFlowDurable,
  agentTurnValue,
  type DurableCheckpoint,
  type DurableSessionTool,
  type FlowCheckpoint,
  type HostEffect,
  type EffectResolution,
} from "@nylorun/harness/run";
import {
  aggregateWaits,
  cancelSiblingWork,
  countActiveFlowWork,
  deriveAgentEffectSessionId,
  emitLoopActionEvents,
  fenceWorkflowActions,
  foreignInteractionConflict,
  isFlowEffect,
  isFlowToolEffect,
  isWorkflowManifest,
  planCancelCascade,
  reconcilePendingAgentEffects,
  reofferOrphanedFnVerifyClaims,
  wakeForQueuedEffects,
  wakeLinkedWorkflow,
} from "../core/flow-host.js";
import {
  mayDispatchMore,
  resolveFlowLimits,
  type FlowLimits,
} from "../core/limits.js";
import {
  allowedManifestHashes,
  rebaseTurnState,
  resolveMessageManifest,
  type TurnManifestStore,
} from "../core/turn-manifest.js";
import { hashManifest } from "@nylorun/core/compatibility";
import {
  delegateManifest,
  schemaFromJSON,
  type AgentManifest,
  type JsonObject,
  type JsonValue,
} from "@nylorun/core/define";
import { Store, canonical } from "../core/store.js";
import {
  ExecutorRegistry,
  assertExecutorCredential,
  hashToken,
  type ExecutorRecord,
} from "../core/executors.js";
import { hostModelCatalog } from "../model/catalog.js";
import { piModel } from "../model/pi-model.js";
import {
  scriptedModel,
  gatewayModel,
  toolFixtureModel,
  type ModelProvider,
} from "../core/provider.js";
import { scrub } from "../redact.js";
import { createKekFile, readVaultKek } from "../vault/kek.js";
import { QuarantineError } from "./quarantine-error.js";
import {
  applicationTokenHashes,
  findPrincipalByTokenHash,
} from "./principals.js";
import { resetTenant } from "./reset.js";
import { buildTenantStatus, seedTenantConfig } from "./status.js";
import type { TenantConfig, TenantHandle, TenantSummary } from "./types.js";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import { VaultError } from "../vault/error.js";
import { VaultService, type AuthorizeResult } from "../vault/service.js";
import { McpPool, serversOf } from "../mcp/pool.js";
import { SandboxManager, sandboxCapabilityOf } from "../sandbox/manager.js";
import { defaultSandboxBackends } from "../sandbox/select.js";
import type { SandboxBackend } from "../sandbox/types.js";
import { owningSandboxSessionId, sandboxSpecOf } from "../sandbox/share.js";
import {
  SandboxRouteError,
  handleActionSandboxTool,
  handleSessionSandboxTool,
  validateSandboxAttach,
} from "../core/sandbox-routes.js";
import type {
  McpDiagnostic,
  McpSnapshot,
  McpToolRecord,
} from "../mcp/snapshot.js";

/** D5 opaque failure for unknown/rejected credentials on Tenant routes. */
const OPAQUE_NOT_FOUND = {
  status: "rejected" as const,
  code: "not_found" as const,
  message: "Not found",
};

type AuthScope =
  | { kind: "application"; principalId: string }
  | { kind: "executor"; executor: ExecutorRecord };

/** TENANTS-CCR: test/injection hooks until TenantConfig gains them. */
export type TenantOpenHooks = {
  modelProvider?: ModelProvider;
  vaultKek?: Buffer | string | null;
  /** When true, create the KEK file on first vault write (tests / new Tenants). */
  createKekIfMissing?: boolean;
};

interface Session {
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
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
/** AbortSignal tied to the HTTP request being closed by the client. */
function requestAborted(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  request.on("close", () => {
    if (!request.complete) controller.abort();
  });
  return controller.signal;
}
class OpaqueAuthError extends Error {
  readonly status = 404;
  readonly body = OPAQUE_NOT_FOUND;
  constructor() {
    super(OPAQUE_NOT_FOUND.message);
    this.name = "OpaqueAuthError";
  }
}
const failOpaque = (): never => {
  throw new OpaqueAuthError();
};
function sessionToolsOf(
  snapshot: McpSnapshot | undefined
): readonly DurableSessionTool[] | undefined {
  if (!snapshot?.mcpTools.length) return undefined;
  return snapshot.mcpTools.map((tool) => ({
    ...(tool.agentId === undefined ? {} : { agentId: tool.agentId }),
    capabilityId: tool.capabilityId,
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
  }));
}

/** Turn-manifest store backed by the session's `variants` map (no schema change). */
function variantStore(session: Session): TurnManifestStore {
  return {
    get(hash) {
      return session.variants?.[hash];
    },
    put(hash, manifest) {
      session.variants = { ...(session.variants ?? {}), [hash]: manifest };
    },
  };
}

/** Manifest this turn's checkpoint is pinned to (session pin or a stored variant). */
function turnManifestOf(session: Session): AgentManifest {
  const hash = session.checkpoint?.manifestHash;
  if (!hash || hash === session.manifestHash) return session.manifest;
  return session.variants?.[hash] ?? session.manifest;
}

/** Wrap a linked agent turn so the Loop learns the turn's manifest (SD-I4 pin stays on session). */
function linkedAgentOutput(
  session: Session,
  output: JsonValue | undefined
): JsonValue {
  if (isWorkflowManifest(session.manifest)) return output ?? null;
  return agentTurnValue(
    output ?? null,
    turnManifestOf(session)
  ) as unknown as JsonValue;
}

function rebaseSessionState(session: Session, turnHash: string): void {
  const allowed = allowedManifestHashes({
    pinnedHash: session.manifestHash,
    variantHashes: Object.keys(session.variants ?? {}),
  });
  const next = rebaseTurnState({
    state: session.state,
    turnManifestHash: turnHash,
    isAllowedHash: (hash) => allowed.has(hash),
  });
  if (next !== session.state) session.state = next;
}
function mcpToolOf(
  session: Session,
  request: Pick<HostEffect, "agent" | "capabilityId" | "toolName">
): McpToolRecord | undefined {
  return session.mcpSnapshot?.mcpTools.find(
    (tool) =>
      tool.agentId === request.agent?.id &&
      tool.capabilityId === request.capabilityId &&
      tool.name === request.toolName
  );
}
/** The manifest of the agent an effect belongs to: the root, or an agent it uses as a tool. */
function manifestFor(
  manifest: AgentManifest,
  agent: HostEffect["agent"]
): AgentManifest | undefined {
  return agent ? delegateManifest(manifest, agent.id) : manifest;
}
function pinnedTool(
  manifest: AgentManifest,
  capabilityId?: string,
  toolName?: string
) {
  const capability = manifest.capabilities.find(
    (item) => item.id === capabilityId
  );
  return capability?.tools?.find((tool) => tool.name === toolName);
}
function acceptedToolResult(
  action: Action,
  command: Extract<SessionCommand, { type: "action_result" }>
): Extract<SessionCommand, { type: "action_result" }> {
  if (action.kind !== "tool" || !action.outputSchema) return command;
  const value = command.outcome.value;
  if (isFailedToolValue(value)) return command;
  // Executors wrap successful tool output as `{ kind: "completed", output }`.
  // Validate the tool payload, not the outcome envelope.
  const candidate = completedToolOutput(value);
  let matches = false;
  try {
    matches = schemaFromJSON(action.outputSchema as JsonObject).validate(
      candidate
    ).ok;
  } catch {
    matches = false;
  }
  if (matches) return command;
  return {
    ...command,
    outcome: {
      ...command.outcome,
      value: {
        kind: "failed",
        code: "tool.invalid-output",
        message:
          "Tool result does not match the output schema stored on the action",
      },
    },
  };
}
function completedToolOutput(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "completed" &&
    "output" in (value as object)
  ) {
    return (value as { output: unknown }).output;
  }
  return value;
}
function isFailedToolValue(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "failed"
  );
}
const semantic = (value: any): string => {
  const { requestId: _, ...body } = value;
  return canonical(body);
};
const sessionIdentity = (value: any): string => {
  const {
    requestId: _requestId,
    vaultIds: _vaultIds,
    credentialSelections: _selections,
    ...body
  } = value ?? {};
  return canonical(body);
};
const equals = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export class TenantRuntime implements TenantHandle {
  private readonly store: Store;
  private readonly vault: VaultService;
  private kek: Buffer | undefined;
  private readonly kekPath: string;
  private readonly running = new Map<string, AbortController>();
  private readonly pending = new Set<string>();
  private readonly observers = new Map<string, Set<ServerResponse>>();
  // Keyed by token hash so a rotation can end exactly the streams that the replaced token owns.
  private readonly executorStreams = new Map<string, Set<ServerResponse>>();
  private readonly registry = new ExecutorRegistry();
  private readonly mcp: McpPool;
  private readonly sandbox: SandboxManager;
  private closing = false;
  private closed = false;
  private readonly lockPath?: string;
  private readonly timer: NodeJS.Timeout;
  private readonly modelProvider: ModelProvider;
  private readonly useVaultModel: boolean;
  private readonly createKekIfMissing: boolean;
  private readonly flowLimits: FlowLimits;
  readonly envelope: TenantEnvelope;
  private constructor(
    private readonly config: TenantConfig,
    hooks: TenantOpenHooks,
    envelope: TenantEnvelope
  ) {
    this.envelope = envelope;
    if (
      config.leaseMs !== undefined &&
      (!Number.isFinite(config.leaseMs) || config.leaseMs <= 0)
    )
      throw new Error("leaseMs must be finite and positive");
    this.flowLimits = resolveFlowLimits({
      flow: config.flow,
      env: config.flowEnv,
    });
    if (
      (config.model.kind === "fixture" || config.model.kind === "scripted") &&
      config.mode === "shared"
    )
      throw new Error("fixture/scripted models require ephemeral or test mode");

    const paths = config.paths;
    mkdirSync(paths.root, { recursive: true });
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.tmp, { recursive: true });
    mkdirSync(paths.sandboxes, { recursive: true });
    mkdirSync(paths.pluginData, { recursive: true });
    mkdirSync(paths.logs, { recursive: true });
    mkdirSync(dirname(paths.database), { recursive: true });

    this.lockPath = paths.lock;
    try {
      const oldPid = Number(readFileSync(this.lockPath, "utf8"));
      if (!Number.isSafeInteger(oldPid) || oldPid < 1)
        throw new Error("Invalid runtime lock; inspect before removing");
      try {
        process.kill(oldPid, 0);
        throw new QuarantineError(
          "locked",
          "Another Runtime owns this Tenant database",
          "nylorun tenant status",
          { lockPath: this.lockPath, lockPid: oldPid }
        );
      } catch (error) {
        if (error instanceof QuarantineError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        unlinkSync(this.lockPath);
      }
    } catch (error) {
      if (error instanceof QuarantineError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fd = openSync(this.lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);

    this.kekPath = paths.kek;
    this.createKekIfMissing = hooks.createKekIfMissing !== false;
    let store: Store | undefined;
    try {
      store = new Store(paths.database, config.tenantId);
      this.kek = readVaultKek({
        vaultKek: hooks.vaultKek,
        vaultKekPath: this.kekPath,
      });
      if (store.credentialCount() > 0 && !this.kek) {
        throw new QuarantineError(
          "kek-missing",
          "Vault key-encryption key is missing for ciphertext in this Tenant",
          "restore the vault-kek file beside tenant.sqlite"
        );
      }
      this.store = store;
    } catch (e) {
      store?.db.close();
      if (this.lockPath && existsSync(this.lockPath)) unlinkSync(this.lockPath);
      throw e;
    }

    this.registry.seed(
      this.store.allExecutors().map((row) => ({
        agentId: row.agentId,
        implementationVersion: row.implementationVersion,
        ...(row.manifestHash === undefined
          ? {}
          : { manifestHash: row.manifestHash }),
        tokenHash: row.tokenHash,
        persisted: true,
        updatedAt: row.updatedAt,
        ...(row.principalId === undefined
          ? {}
          : { principalId: row.principalId }),
      }))
    );

    this.vault = new VaultService(
      this.store.db,
      (fn) => this.store.tx(fn),
      () => this.ensureKek(),
      config.vaultFetch ?? globalThis.fetch
    );
    this.mcp = new McpPool({
      pluginData: paths.pluginData,
      childEnv: config.childEnv,
      authorize: (sessionId, request) => this.authorize(sessionId, request),
    });
    const ephemeral = config.mode === "ephemeral";
    this.sandbox = new SandboxManager({
      scope: config.tenantId,
      store: this.store,
      backends:
        config.sandbox.backends ??
        defaultSandboxBackends({ root: paths.sandboxes }),
      preference: config.sandbox.backend,
      ephemeral,
      emit: (sessionId, turnId, type, payload) => {
        if (this.closed) return;
        const event = this.store.tx(() =>
          this.store.event(sessionId, turnId, type, payload)
        );
        this.publish(event);
      },
    });
    if (!ephemeral && this.sandbox.hasRecords())
      void this.sandbox
        .reconcile((id) => !this.closed && !!this.store.get("sessions", id))
        .catch(() => undefined);

    this.useVaultModel = config.model.kind === "vault";
    if (hooks.modelProvider) this.modelProvider = hooks.modelProvider;
    else if (config.model.kind === "scripted")
      this.modelProvider = scriptedModel(config.model.output);
    else if (config.model.kind === "fixture")
      this.modelProvider = toolFixtureModel();
    else if (config.model.kind === "gateway") {
      const gateway = config.model;
      this.modelProvider = async (effect, signal) => {
        const secret = this.vault.readHostModel();
        const token =
          typeof secret?.credential.key === "string"
            ? secret.credential.key
            : "";
        return gatewayModel({
          url: gateway.url,
          model: gateway.model,
          token,
        })(effect, signal);
      };
    } else this.modelProvider = scriptedModel();

    this.store.tx(() => {
      for (const effect of this.store.all("effects"))
        if (effect.status === "invoking") {
          effect.status = "uncertain";
          this.store.put("effects", effect.request.effectId, effect);
          const sess = this.store.get<Session>(
            "sessions",
            effect.request.sessionId
          );
          if (
            sess &&
            sess.status !== "cancelled" &&
            sess.activeTurnId === effect.request.turnId
          ) {
            sess.status = "uncertain";
            this.store.put("sessions", sess.id, sess);
            this.store.event(sess.id, sess.activeTurnId, "effect.uncertain", {
              effectId: effect.request.effectId,
            });
          }
        }
    });
    this.expireClaims();
    // Orphaned fn/verify claims from a prior process: re-offer immediately.
    this.store.tx(() => {
      reofferOrphanedFnVerifyClaims(this.store);
    });
    this.notify();
    this.timer = setInterval(
      () => this.expireClaims(),
      Math.min(config.leaseMs ?? 30000, 5000)
    );
    this.timer.unref();
    for (const sess of this.store.all<Session>("sessions"))
      if (sess.status === "running" || sess.status === "runnable")
        this.schedule(sess.id);
    this.store.tx(() => {
      reconcilePendingAgentEffects({
        store: this.store,
        schedule: (sid) => this.schedule(sid),
        publish: (e) => this.publish(e),
      });
    });
  }

  static async open(
    config: TenantConfig,
    hooks: TenantOpenHooks = {}
  ): Promise<TenantRuntime> {
    const envelope = readEnvelope(config);
    return new TenantRuntime(config, hooks, envelope);
  }

  private session(id: string): Session {
    return (
      this.store.get<Session>("sessions", id) ?? fail(404, "Session not found")
    );
  }
  private publish(event: LiveEvent): void {
    for (const response of this.observers.get(event.sessionId) ?? [])
      this.send(
        response,
        `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(
          event
        )}\n\n`
      );
  }
  private send(response: ServerResponse, data: string): void {
    if (!response.write(data)) response.destroy();
  }
  private notify(): void {
    for (const streams of this.executorStreams.values())
      for (const response of streams)
        this.send(
          response,
          'event: work_available\ndata: {"type":"work_available"}\n\n'
        );
  }
  private expireClaims(): void {
    const events: LiveEvent[] = [];
    let redeliver = false;
    this.store.tx(() => {
      for (const action of this.store.all<Action>("actions"))
        if (
          action.status === "claimed" &&
          Date.parse(action.leaseExpiresAt!) <= Date.now()
        ) {
          if (
            action.kind === "hook" ||
            action.kind === "fn" ||
            action.kind === "verify"
          ) {
            // Hooks, fn and verify are pure / repeat-safe; a lost claim is offered again.
            // The next claim bumps the generation, which fences any late result.
            action.status = "pending";
            action.claimId = null;
            action.leaseExpiresAt = null;
            this.store.put("actions", action.actionId, action);
            redeliver = true;
            continue;
          }
          action.status = "uncertain";
          this.store.put("actions", action.actionId, action);
          const effect = this.store.get("effects", action.actionId);
          effect.status = "uncertain";
          this.store.put("effects", action.actionId, effect);
          const s = this.session(action.sessionId);
          if (s.status !== "cancelled" && s.activeTurnId === action.turnId) {
            s.status = "uncertain";
            this.store.put("sessions", s.id, s);
            events.push(
              this.store.event(s.id, s.activeTurnId, "action.uncertain", {
                actionId: action.actionId,
                ...(action.agent ? { agent: action.agent } : {}),
              })
            );
          }
        }
    });
    events.forEach((e) => this.publish(e));
    if (redeliver) this.notify();
  }
  private schedule(id: string): void {
    if (this.closing) return;
    this.pending.add(id);
    setImmediate(() => {
      if (!this.running.has(id) && this.pending.delete(id) && !this.closing)
        void this.execute(id);
    });
  }
  private async execute(id: string): Promise<void> {
    const s = this.session(id);
    if (!s.checkpoint || !["running", "runnable"].includes(s.status)) return;
    s.status = "running";
    this.store.tx(() => this.store.put("sessions", id, s));
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      // prepareMcp mutates the session's mcpSnapshot; read current after it.
      if (!isWorkflowManifest(this.session(id).manifest))
        await this.prepareMcp(id, controller.signal);
      const current = this.session(id);
      const host = {
        resolveEffect: (e: HostEffect) =>
          this.resolveEffect(e, controller.signal),
      };
      if (!isWorkflowManifest(current.manifest) && current.checkpoint) {
        rebaseSessionState(current, current.checkpoint.manifestHash);
        const cp = current.checkpoint as DurableCheckpoint;
        current.checkpoint = { ...cp, state: current.state };
        this.store.tx(() => this.store.put("sessions", id, current));
      }
      const result = isWorkflowManifest(current.manifest)
        ? await runFlowDurable({
            manifest: current.manifest,
            checkpoint: current.checkpoint as FlowCheckpoint,
            signal: controller.signal,
            host,
            limits: this.flowLimits,
          })
        : await runDurable({
            manifest: turnManifestOf(current),
            checkpoint: current.checkpoint as DurableCheckpoint,
            signal: controller.signal,
            sessionTools: sessionToolsOf(current.mcpSnapshot),
            host,
          });
      let event: LiveEvent | undefined;
      const siblingCancelIds: string[] = [];
      this.store.tx(() => {
        const current = this.session(id);
        if (
          current.status === "cancelled" ||
          current.activeTurnId !== s.activeTurnId
        )
          return;
        // A result can arrive during concurrent action persistence. Preserve the runnable marker.
        const resumeRequested = current.status === "runnable";
        if (result.status === "waiting" || result.status === "uncertain") {
          const linkedWaits = isWorkflowManifest(current.manifest)
            ? aggregateWaits({
                store: this.store,
                workflowSessionId: id,
              })
            : [];
          if (linkedWaits.length > 0 && !resumeRequested) {
            current.status = "paused";
            current.waits = linkedWaits;
          } else {
            current.status = resumeRequested
              ? "runnable"
              : current.status === "uncertain"
              ? "uncertain"
              : result.status;
            current.waits =
              linkedWaits.length > 0
                ? linkedWaits
                : { effectIds: result.effectIds };
          }
        } else if ("result" in result) {
          const flow = isWorkflowManifest(current.manifest);
          if (!flow) {
            current.state =
              result.status === "failed"
                ? current.turnStartState
                : (result.result as any).state;
          }
          current.checkpoint = result.checkpoint;
          this.store.put(
            "checkpoints",
            JSON.stringify([id, s.activeTurnId, result.checkpoint.segment]),
            { checkpoint: result.checkpoint, status: result.status }
          );
          current.status = result.status;
          current.waits =
            result.status === "paused"
              ? (result.result as any).pending
              : undefined;
          if (result.status === "completed")
            current.lastOutput = (result.result as any).output;
          // Fail-fast: cancel pending Parallel/Map siblings before clearing the turn.
          if (
            result.status === "failed" &&
            flow &&
            "cancelEffectIds" in result &&
            Array.isArray(result.cancelEffectIds) &&
            result.cancelEffectIds.length > 0 &&
            s.activeTurnId
          ) {
            const cancelResult = cancelSiblingWork({
              store: this.store,
              workflowSessionId: id,
              turnId: s.activeTurnId,
              cancelEffectIds: result.cancelEffectIds,
            });
            siblingCancelIds.push(...cancelResult.agentSessionIds);
          }
          if (result.status !== "paused") current.activeTurnId = null;
          event = this.store.event(
            id,
            s.activeTurnId,
            `turn.${result.status}`,
            result.status === "completed"
              ? { output: (result.result as any).output }
              : result.status === "paused"
              ? {
                  interactions: ((result.result as any).pending ?? []).map(
                    (call: any) => ({
                      invocationId: call.invocationId,
                      interaction: call.interaction,
                      wait: call.wait,
                      status: call.status,
                    })
                  ),
                }
              : result.status === "failed"
              ? {
                  error: {
                    code: (result.result as any).error?.code,
                    message: (result.result as any).error?.message,
                    ...((result.result as any).error?.path
                      ? { path: (result.result as any).error.path }
                      : {}),
                  },
                }
              : {}
          );
        }
        this.store.put("sessions", id, current);
      });
      for (const agentId of siblingCancelIds) {
        try {
          this.command(
            agentId,
            {
              type: "cancel",
              requestId: `flow-sibling-${id}-${agentId}`,
              idempotencyKey: `flow-sibling-cancel:${id}:${agentId}:${s.activeTurnId}`,
              reason: "sibling branch failed",
            },
            {
              kind: "application",
              principalId: "flow-host",
            }
          );
        } catch {
          /* agent may already be terminal */
        }
      }
      if (event) {
        this.publish(event);
        if (event.type === "turn.completed" || event.type === "turn.failed") {
          this.store.tx(() => {
            wakeLinkedWorkflow({
              agentSessionId: id,
              store: this.store,
              output:
                event!.type === "turn.completed"
                  ? linkedAgentOutput(
                      this.session(id),
                      (event!.payload as { output?: JsonValue }).output
                    )
                  : undefined,
              failed: event!.type === "turn.failed",
              error:
                event!.type === "turn.failed"
                  ? String(
                      (event!.payload as { message?: string }).message ?? ""
                    )
                  : undefined,
              schedule: (sid) => this.schedule(sid),
              publish: (e) => this.publish(e),
            });
          });
        }
        if (event.type === "turn.cancelled") {
          this.store.tx(() => {
            wakeLinkedWorkflow({
              agentSessionId: id,
              store: this.store,
              cancelled: true,
              error: "Agent turn was cancelled",
              schedule: (sid) => this.schedule(sid),
              publish: (e) => this.publish(e),
            });
          });
        }
      }
    } catch (error) {
      let event: LiveEvent | undefined;
      this.store.tx(() => {
        const current = this.session(id);
        if (
          current.status === "cancelled" ||
          current.activeTurnId !== s.activeTurnId
        )
          return;
        current.status = "failed";
        current.state = current.turnStartState;
        if (current.checkpoint)
          this.store.put(
            "checkpoints",
            JSON.stringify([id, s.activeTurnId, current.checkpoint.segment]),
            { checkpoint: current.checkpoint, status: "failed" }
          );
        current.error = error instanceof Error ? error.message : String(error);
        this.store.put("sessions", id, current);
        event = this.store.event(id, current.activeTurnId, "turn.failed", {
          message: current.error,
        });
        current.activeTurnId = null;
        this.store.put("sessions", id, current);
      });
      if (event) {
        this.publish(event);
        this.store.tx(() => {
          wakeLinkedWorkflow({
            agentSessionId: id,
            store: this.store,
            failed: true,
            error: String(
              (event!.payload as { message?: string }).message ?? ""
            ),
            schedule: (sid) => this.schedule(sid),
            publish: (e) => this.publish(e),
          });
        });
      }
    } finally {
      this.running.delete(id);
      if (
        !this.closing &&
        (this.pending.has(id) || this.session(id).status === "runnable")
      )
        this.schedule(id);
    }
  }
  private invokeModel(request: HostEffect, signal: AbortSignal) {
    if (!this.useVaultModel) return this.modelProvider(request, signal);
    const adapter = piModel({
      root: this.config.paths.home,
      readHostModel: () => this.vault.readHostModel(),
      writeHostCredential: (credential) =>
        this.vault.updateHostCredential(credential),
    });
    return adapter(request.input as any, {
      request: request.context.request as any,
      invocationId: String(request.context.invocationId),
      signal,
      reportPreparedCall() {},
    });
  }
  private async resolveEffect(
    request: HostEffect,
    signal: AbortSignal
  ): Promise<EffectResolution> {
    let invoke: "model" | "mcp" | "sandbox" | undefined;
    let notify = false;
    let event: LiveEvent | undefined;
    const resolution = this.store.tx((): EffectResolution | undefined => {
      const s = this.session(request.sessionId);
      if (
        s.status === "cancelled" ||
        s.activeTurnId !== request.turnId ||
        signal.aborted
      )
        throw new Error("Turn cancelled");
      const existing = this.store.get("effects", request.effectId);
      if (existing) {
        if (canonical(existing.request) !== canonical(request))
          throw new Error("Effect identity request drift");
        if (existing.status === "completed")
          return { status: "completed", outcome: existing.outcome };
        if (request.kind === "agent" && existing.status === "pending") {
          const agentSessionId = existing.agentSessionId as string | undefined;
          if (agentSessionId) {
            const agent = this.store.get<Session>("sessions", agentSessionId);
            if (agent?.status === "completed") {
              const outcome = {
                value: linkedAgentOutput(agent, agent.lastOutput ?? null),
              };
              existing.status = "completed";
              existing.outcome = outcome;
              this.store.put("effects", request.effectId, existing);
              return { status: "completed", outcome };
            }
            if (agent?.status === "failed") {
              const outcome = {
                value: {
                  kind: "failed",
                  code: "agent.failed",
                  message: agent.error ?? "Agent turn failed",
                },
              };
              existing.status = "completed";
              existing.outcome = outcome;
              this.store.put("effects", request.effectId, existing);
              return { status: "completed", outcome };
            }
          }
        }
        return {
          status:
            existing.status === "uncertain" || existing.status === "invoking"
              ? "uncertain"
              : "pending",
        };
      }
      if (
        request.kind === "agent" ||
        request.kind === "fn" ||
        request.kind === "verify" ||
        isFlowToolEffect(request)
      ) {
        // Handled outside the agent-manifest path below.
        return { status: "pending", __flow: true } as any;
      }
      if (request.kind === "delegation") {
        // Lifecycle points of an agent used as a tool: journaled once, so replays never re-emit.
        const outcome = { value: null };
        this.store.put("effects", request.effectId, {
          request,
          status: "completed",
          outcome,
        });
        const settled = request.effectId.endsWith(":settled");
        event = this.store.event(
          s.id,
          s.activeTurnId,
          settled ? "delegation.completed" : "delegation.started",
          { agent: request.agent, ...(request.input as object) }
        );
        return { status: "completed", outcome };
      }
      const agentManifest = manifestFor(s.manifest, request.agent);
      if (!agentManifest)
        throw new Error(
          `Agent '${request.agent?.id ?? ""}' is not used as a tool`
        );
      const mcpTool =
        request.kind === "tool" ? mcpToolOf(s, request) : undefined;
      const sandboxTool =
        request.kind === "tool" && !mcpTool
          ? sandboxCapabilityOf(
              agentManifest,
              request.capabilityId,
              request.toolName
            )
          : undefined;
      this.store.put("effects", request.effectId, {
        request,
        status:
          request.kind === "model" || mcpTool || sandboxTool
            ? "invoking"
            : "pending",
      });
      if (request.kind === "model" || mcpTool || sandboxTool) {
        invoke = mcpTool ? "mcp" : sandboxTool ? "sandbox" : "model";
        return undefined;
      }
      const tool =
        request.kind === "tool"
          ? pinnedTool(agentManifest, request.capabilityId, request.toolName)
          : undefined;
      const base = {
        actionId: request.effectId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        agentId: request.agentId,
        manifestHash: request.manifestHash,
        implementationVersion: s.implementationVersion,
        input: request.input,
        context: request.context,
        status: "pending" as const,
        generation: 0,
        claimId: null,
        leaseExpiresAt: null,
        ...(request.agent ? { agent: request.agent } : {}),
      };
      const action: Action =
        request.kind === "hook"
          ? {
              ...base,
              kind: "hook",
              hook: {
                at: request.hook!.at,
                scope: request.hook!.scope,
                capabilityIds: [...request.hook!.capabilityIds],
              },
            }
          : {
              ...base,
              kind: "tool",
              capabilityId: request.capabilityId!,
              toolName: request.toolName!,
              ...(tool?.inputSchema ? { inputSchema: tool.inputSchema } : {}),
              ...(tool?.outputSchema
                ? { outputSchema: tool.outputSchema }
                : {}),
            };
      this.store.put("actions", action.actionId, action);
      event = this.store.event(s.id, s.activeTurnId, "action.pending", {
        actionId: action.actionId,
        kind: action.kind,
        ...actionTarget(action),
        input: action.input,
      });
      notify = true;
      return { status: "pending" };
    });
    if (event) this.publish(event);
    if (notify) this.notify();
    if (resolution && (resolution as any).__flow && isFlowEffect(request)) {
      return this.resolveNewFlowEffect(request, signal);
    }
    if (!invoke) return resolution!;
    try {
      const value =
        invoke === "mcp"
          ? await this.callMcpTool(request)
          : invoke === "sandbox"
          ? await this.callSandboxTool(request, signal)
          : await this.invokeModel(request, signal);
      return this.store.tx(() => {
        const s = this.session(request.sessionId);
        if (
          s.status === "cancelled" ||
          s.activeTurnId !== request.turnId ||
          signal.aborted
        )
          throw new Error("Turn cancelled");
        const effect = this.store.get("effects", request.effectId);
        effect.status = "completed";
        effect.outcome = { value };
        this.store.put("effects", request.effectId, effect);
        return { status: "completed" as const, outcome: effect.outcome };
      });
    } catch (error) {
      let event: LiveEvent | undefined;
      this.store.tx(() => {
        const effect = this.store.get("effects", request.effectId);
        effect.status = "uncertain";
        effect.error = error instanceof Error ? error.message : String(error);
        this.store.put("effects", request.effectId, effect);
        const s = this.session(request.sessionId);
        if (s.status !== "cancelled" && s.activeTurnId === request.turnId)
          event = this.store.event(s.id, request.turnId, "effect.uncertain", {
            effectId: request.effectId,
            message: effect.error,
          });
      });
      if (event) this.publish(event);
      return { status: "uncertain" };
    }
  }

  /** Journal and dispatch a new flow effect (agent / tool node / fn / verify). */
  private async resolveNewFlowEffect(
    request: HostEffect,
    signal: AbortSignal
  ): Promise<EffectResolution> {
    if (signal.aborted) throw new Error("Turn cancelled");
    const existing = this.store.get("effects", request.effectId);
    if (existing) {
      if (existing.status === "completed")
        return { status: "completed", outcome: existing.outcome };
      if (existing.status === "queued") {
        // Fall through to dispatch when a concurrency slot is free.
      } else if (request.kind === "agent") {
        const agentSessionId = existing.agentSessionId as string | undefined;
        if (agentSessionId) {
          const agent = this.store.get<Session>("sessions", agentSessionId);
          if (agent?.status === "completed") {
            const outcome = {
              value: linkedAgentOutput(agent, agent.lastOutput ?? null),
            };
            this.store.tx(() => {
              existing.status = "completed";
              existing.outcome = outcome;
              this.store.put("effects", request.effectId, existing);
            });
            return { status: "completed", outcome };
          }
          if (agent?.status === "cancelled") {
            const outcome = {
              value: {
                kind: "failed" as const,
                code: "agent.cancelled",
                message: agent.error ?? "Agent turn was cancelled",
              },
            };
            this.store.tx(() => {
              existing.status = "completed";
              existing.outcome = outcome;
              this.store.put("effects", request.effectId, existing);
            });
            return { status: "completed", outcome };
          }
          if (agent?.status === "failed") {
            const outcome = {
              value: {
                kind: "failed" as const,
                code: "agent.failed",
                message: agent.error ?? "Agent turn failed",
              },
            };
            this.store.tx(() => {
              existing.status = "completed";
              existing.outcome = outcome;
              this.store.put("effects", request.effectId, existing);
            });
            return { status: "completed", outcome };
          }
        }
        return { status: "pending" };
      } else {
        return { status: "pending" };
      }
    }

    const active = countActiveFlowWork(
      this.store,
      request.sessionId,
      request.turnId
    );
    if (!mayDispatchMore(active, this.flowLimits)) {
      if (!existing || existing.status !== "queued") {
        this.store.tx(() => {
          this.store.put("effects", request.effectId, {
            request,
            status: "queued",
          });
        });
      }
      return { status: "pending" };
    }

    if (
      request.kind === "fn" ||
      request.kind === "verify" ||
      isFlowToolEffect(request)
    ) {
      let event: LiveEvent | undefined;
      let started: LiveEvent | undefined;
      this.store.tx(() => {
        const s = this.session(request.sessionId);
        this.store.put("effects", request.effectId, {
          request,
          status: "pending",
        });
        const action =
          request.kind === "fn" || request.kind === "verify"
            ? ({
                actionId: request.effectId,
                sessionId: request.sessionId,
                turnId: request.turnId,
                agentId: request.agentId,
                manifestHash: request.manifestHash,
                implementationVersion: s.implementationVersion,
                input: request.input as any,
                context: request.context,
                status: "pending" as const,
                generation: 0,
                claimId: null,
                leaseExpiresAt: null,
                kind: request.kind,
                path: request.path!,
                key: request.key!,
              } satisfies Action)
            : ({
                actionId: request.effectId,
                sessionId: request.sessionId,
                turnId: request.turnId,
                agentId: request.agentId,
                manifestHash: request.manifestHash,
                implementationVersion: s.implementationVersion,
                input: request.input as any,
                context: request.context,
                status: "pending" as const,
                generation: 0,
                claimId: null,
                leaseExpiresAt: null,
                kind: "tool" as const,
                path: request.path!,
                key: request.key!,
              } satisfies Action);
        this.store.put("actions", action.actionId, action);
        if (isFlowToolEffect(request)) {
          started = this.store.event(s.id, s.activeTurnId, "node.started", {
            path: request.path!,
            kind: "tool",
            key: request.key!,
            ...(request.iterations !== undefined
              ? { iterations: request.iterations }
              : {}),
          });
        }
        event = this.store.event(s.id, s.activeTurnId, "action.pending", {
          actionId: action.actionId,
          kind: action.kind,
          path: action.path,
          key: action.key,
          input: action.input,
        });
      });
      if (started) this.publish(started);
      if (event) this.publish(event);
      this.notify();
      return { status: "pending" };
    }

    // agent effect: create linked session + message via the public contract path
    const body = request.input as {
      agentId: string;
      input: JsonValue;
      path: string;
      manifest?: AgentManifest;
    };
    const path = body.path ?? request.path!;
    const workflow = this.session(request.sessionId);
    const agentSessionId = deriveAgentEffectSessionId(
      workflow.id,
      path,
      request
    );
    const iterations = request.iterations ?? "-";
    const n = Number(request.context.n ?? iterations.split(".")[0] ?? 1);

    this.store.tx(() => {
      this.store.put("effects", request.effectId, {
        request,
        status: "pending",
        agentSessionId,
      });
      this.store.put("links", agentSessionId, {
        workflowSessionId: workflow.id,
        path,
        effectId: request.effectId,
        turnId: request.turnId,
      });
    });

    if (!this.store.get<Session>("sessions", agentSessionId)) {
      const definition =
        this.store.get("definitions", body.agentId) ??
        fail(404, "Definition not found");
      const sandboxOwnerId =
        sandboxSpecOf(workflow.manifest) || workflow.sandboxOwnerId
          ? owningSandboxSessionId(workflow, (sid) =>
              this.store.get<Session>("sessions", sid)
            )
          : undefined;
      const created: Session = {
        id: agentSessionId,
        agentId: body.agentId,
        ownerUserId: workflow.ownerUserId,
        manifest: definition.manifest,
        manifestHash: definition.manifestHash,
        implementationVersion: definition.implementationVersion,
        status: "idle",
        activeTurnId: null,
        creation: {
          requestId: `flow-put-${request.effectId}`,
          agentId: body.agentId,
          ownerUserId: workflow.ownerUserId,
          ...(sandboxOwnerId ? { sandbox: { session: sandboxOwnerId } } : {}),
        },
        vaultIds: workflow.vaultIds,
        credentialSelections: workflow.credentialSelections,
        pluginRoots: definition.pluginRoots ?? {},
        ...(sandboxOwnerId ? { sandboxOwnerId } : {}),
      };
      this.store.tx(() => this.store.put("sessions", agentSessionId, created));
    }

    const idempotencyKey = `${request.turnId}:${path}:${iterations}`;
    const messageInput = body.input;
    const messageCommand: SessionCommand =
      typeof messageInput === "string"
        ? {
            type: "message",
            content: messageInput,
            requestId: `flow-${request.effectId}`,
            idempotencyKey,
            ...(body.manifest ? { manifest: body.manifest } : {}),
          }
        : {
            type: "message",
            data: messageInput,
            requestId: `flow-${request.effectId}`,
            idempotencyKey,
            ...(body.manifest ? { manifest: body.manifest } : {}),
          };
    const accepted = this.command(agentSessionId, messageCommand, {
      kind: "application",
      principalId: "flow-host",
    }) as { turnId: string | null };

    const events: LiveEvent[] = [];
    this.store.tx(() => {
      const s = this.session(request.sessionId);
      const agentSession = this.session(agentSessionId);
      events.push(
        this.store.event(s.id, s.activeTurnId, "loop.iteration", {
          path: String(request.context.loopPath ?? path.split("/")[0]),
          n,
          sessionId: agentSessionId,
          turnId: accepted.turnId ?? undefined,
          manifestHash: agentSession.checkpoint?.manifestHash,
        })
      );
      events.push(
        this.store.event(s.id, s.activeTurnId, "node.agent", {
          path,
          iterations,
          sessionId: agentSessionId,
          turnId: accepted.turnId,
        })
      );
    });
    for (const e of events) this.publish(e);

    // May already be settled if the agent was fast / replayed.
    const agent = this.session(agentSessionId);
    if (agent.status === "completed") {
      const outcome = {
        value: linkedAgentOutput(agent, agent.lastOutput ?? null),
      };
      this.store.tx(() => {
        this.store.put("effects", request.effectId, {
          request,
          status: "completed",
          outcome,
          agentSessionId,
        });
      });
      return { status: "completed", outcome };
    }
    return { status: "pending" };
  }

  private scope(request: IncomingMessage): AuthScope {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !header?.startsWith("Bearer ")) {
      this.config.logger.warn("credential rejected", {
        reason: "missing_bearer",
      });
      return failOpaque();
    }
    const tokenHash = hashToken(token);
    const principal = findPrincipalByTokenHash(this.store.db, tokenHash);
    if (principal) return { kind: "application", principalId: principal.id };
    const executor = this.registry.find(tokenHash);
    if (!executor) {
      this.config.logger.warn("credential rejected", {
        reason: "unknown_token",
      });
      return failOpaque();
    }
    return { kind: "executor", executor };
  }
  private scoped(scope: AuthScope, action: Action): void {
    if (scope.kind !== "executor" || scope.executor.agentId !== action.agentId)
      fail(403, "Executor scope does not authorize this action");
  }
  private requireApplication(scope: AuthScope): string {
    if (scope.kind === "application") return scope.principalId;
    return fail(403, "Application credential required");
  }
  private sandboxRouteDeps() {
    return {
      sandbox: this.sandbox,
      session: (id: string) => this.session(id),
      lookup: (id: string) => this.store.get<Session>("sessions", id),
      getAction: (id: string) => this.store.get<Action>("actions", id),
    };
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    let data = "";
    for await (const chunk of request) {
      data += chunk;
      if (Buffer.byteLength(data) > 1024 * 1024) fail(413, "Request too large");
    }
    try {
      return JSON.parse(data);
    } catch {
      return fail(400, "Invalid JSON");
    }
  }
  private command(
    id: string,
    input: SessionCommand,
    scope: AuthScope
  ): unknown {
    let event: LiveEvent | undefined;
    const extraEvents: LiveEvent[] = [];
    const cascadeCancelIds: string[] = [];
    let schedule = false;
    const response = this.store.tx(() => {
      const s = this.session(id);
      let command = input;
      if (command.type === "action_result") {
        const a =
          this.store.get<Action>("actions", command.actionId) ??
          fail(404, "Action not found");
        if (a.sessionId !== id) fail(403, "Action belongs to another session");
        this.scoped(scope, a);
        command = acceptedToolResult(a, command);
      } else if (scope.kind !== "application")
        fail(403, "Application credential required");
      const key = JSON.stringify([id, command.idempotencyKey]);
      const existing = this.store.get("commands", key);
      if (existing) {
        if (semantic(existing.command) !== semantic(command))
          fail(409, "Idempotency key already binds another command");
        return existing.response;
      }
      if (command.type === "action_result") {
        const action = this.store.get<Action>("actions", command.actionId)!;
        const prior = this.store.get("effects", command.actionId);
        if (action.status === "completed") {
          if (
            action.claimId !== command.claimId ||
            action.generation !== command.generation ||
            canonical(prior.outcome) !== canonical(command.outcome)
          )
            fail(409, "Conflicting action result");
          this.store.put("commands", key, { command, response: prior.receipt });
          return prior.receipt;
        }
        if (
          s.status === "cancelled" ||
          s.activeTurnId !== action.turnId ||
          action.status !== "claimed" ||
          action.claimId !== command.claimId ||
          action.generation !== command.generation ||
          Date.parse(action.leaseExpiresAt!) <= Date.now()
        )
          fail(409, "Stale, expired, or cancelled claim");
        action.status = "completed";
        this.store.put("actions", action.actionId, action);
        prior.status = "completed";
        prior.outcome = command.outcome;
        s.status = "runnable";
        schedule = true;
        event = this.store.event(id, s.activeTurnId, "action.completed", {
          actionId: action.actionId,
          ...actionTarget(action),
          kind: action.kind,
          result: command.outcome.value,
        });
        if (action.kind === "verify") {
          const verdict = command.outcome.value as {
            pass?: boolean;
            feedback?: string;
            data?: unknown;
            kind?: string;
          };
          if (verdict?.kind !== "failed") {
            extraEvents.push(
              this.store.event(id, s.activeTurnId, "loop.verified", {
                path: String(action.context?.loopPath ?? action.path ?? ""),
                n: Number(action.context?.n ?? 1),
                pass: Boolean(verdict?.pass),
                ...(verdict?.feedback !== undefined
                  ? { feedback: verdict.feedback }
                  : {}),
                ...(verdict?.data !== undefined ? { data: verdict.data } : {}),
              })
            );
          }
        } else if (action.kind === "fn" && action.context?.role === "decide") {
          const decision = command.outcome.value as {
            input?: unknown;
            output?: unknown;
            agent?: unknown;
          };
          extraEvents.push(
            this.store.event(id, s.activeTurnId, "loop.decided", {
              path: String(action.context?.loopPath ?? action.path ?? ""),
              n: Number(action.context?.n ?? 1),
              next:
                "output" in decision && !("input" in decision)
                  ? "output"
                  : "input",
              patched: Boolean(decision.agent),
            })
          );
        }
        const receipt = {
          status: "accepted",
          turnId: s.activeTurnId,
          cursor: event.cursor,
          requestId: command.requestId,
        };
        prior.receipt = receipt;
        this.store.put("effects", action.actionId, prior);
        if (isWorkflowManifest(s.manifest) && s.activeTurnId) {
          wakeForQueuedEffects({
            store: this.store,
            workflowSessionId: id,
            turnId: s.activeTurnId,
            limits: this.flowLimits,
            schedule: (sid) => {
              schedule = true;
              void sid;
            },
          });
        }
      } else if (command.type === "cancel") {
        const cancelledTurnId = s.activeTurnId;
        const workflowCancel = isWorkflowManifest(s.manifest);
        const cascade = workflowCancel
          ? planCancelCascade({
              store: this.store,
              workflowSessionId: id,
              turnId: cancelledTurnId,
            })
          : null;
        s.status = "cancelled";
        if (workflowCancel) {
          fenceWorkflowActions({
            store: this.store,
            workflowSessionId: id,
            turnId: cancelledTurnId,
          });
        } else {
          for (const a of this.store.all<Action>("actions"))
            if (
              a.sessionId === id &&
              a.turnId === cancelledTurnId &&
              ["pending", "claimed"].includes(a.status)
            ) {
              // Claimed work may already have an external effect. Preserve it for reconciliation.
              a.status = a.status === "claimed" ? "uncertain" : "cancelled";
              this.store.put("actions", a.actionId, a);
              const effect = this.store.get("effects", a.actionId);
              effect.status = a.status;
              this.store.put("effects", a.actionId, effect);
            }
        }
        for (const effect of this.store.all("effects"))
          if (
            effect.request.sessionId === id &&
            effect.request.turnId === cancelledTurnId &&
            effect.status === "invoking"
          ) {
            effect.status = "uncertain";
            effect.error =
              "Turn cancelled before model outcome was durably recorded";
            this.store.put("effects", effect.request.effectId, effect);
          }
        event = this.store.event(id, cancelledTurnId, "turn.cancelled", {
          reason: command.reason,
        });
        s.activeTurnId = null;
        // The next turn starts from the state preceding the cancelled turn, never its paused plan.
        if (cancelledTurnId !== null) s.state = s.turnStartState;
        s.checkpoint = undefined;
        s.waits = undefined;
        s.error = undefined;
        // Cascade: cancel linked agent sessions deepest-first (after fencing this session).
        if (cascade) {
          for (const agentId of cascade.agentSessionIds) {
            const agent = this.store.get<Session>("sessions", agentId);
            if (
              !agent ||
              !agent.activeTurnId ||
              ["idle", "completed", "failed", "cancelled"].includes(
                agent.status
              )
            )
              continue;
            cascadeCancelIds.push(agentId);
          }
        }
      } else {
        if (command.type === "message") {
          if (!["idle", "completed", "failed", "cancelled"].includes(s.status))
            fail(409, "Session has active or unresolved work");
          s.turnStartState = s.state;
          s.activeTurnId = randomUUID();
          if (isWorkflowManifest(s.manifest)) {
            const input: JsonValue =
              "content" in command
                ? command.content
                : (command.data as JsonValue);
            s.checkpoint = createFlowCheckpoint({
              manifest: s.manifest,
              sessionId: id,
              turnId: s.activeTurnId,
              input,
            });
          } else {
            // Optional message.manifest: validate as variant, pin by hash, apply this turn only.
            const resolved = resolveMessageManifest({
              pinned: s.manifest,
              pinnedHash: s.manifestHash,
              messageManifest: command.manifest,
              store: variantStore(s),
            });
            if (!resolved.ok) {
              fail(400, resolved.message);
            } else {
              rebaseSessionState(s, resolved.hash);
              s.checkpoint = createDurableCheckpoint({
                manifest: resolved.manifest,
                sessionId: id,
                turnId: s.activeTurnId,
                input:
                  "content" in command
                    ? command.content
                    : typeof command.data === "string"
                    ? command.data
                    : JSON.stringify(command.data),
                state: s.state,
                info: s.info,
              });
            }
          }
        } else {
          if (s.status !== "paused" || !s.state || !s.activeTurnId)
            fail(409, "Session is not awaiting a response");
          const pending = s.state.plan?.calls ?? [];
          if (
            !pending.some(
              (c: any) =>
                c.status === "interaction" &&
                c.interaction?.id === command.interactionId &&
                (command.type === "approve") ===
                  (c.interaction?.kind === "approval")
            )
          )
            fail(409, "Unknown interaction");
          const input =
            command.type === "approve"
              ? {
                  kind: "approve" as const,
                  interactionId: command.interactionId,
                  approved: command.approved,
                }
              : {
                  kind: "respond" as const,
                  interactionId: command.interactionId,
                  value: command.value,
                };
          if (isWorkflowManifest(s.manifest)) {
            // Approvals owned by linked agent sessions must be answered there (WF-R52).
            const conflict = foreignInteractionConflict({
              store: this.store,
              workflowSessionId: id,
              interactionId: command.interactionId,
            });
            if (conflict) fail(409, conflict.message);
            // Workflow-owned interactions (tool-node / verify) resume on this session once
            // the flow engine supports pause segments; tracer root Loop has none yet.
            fail(
              409,
              "Workflow sessions do not accept approve/respond on the root without a pending interaction"
            );
          }
          s.checkpoint = createDurableCheckpoint({
            manifest: turnManifestOf(s),
            sessionId: id,
            turnId: s.activeTurnId!,
            input: input as any,
            state: s.state,
            info: s.info,
            segment: (s.checkpoint?.segment ?? 0) + 1,
          });
        }
        this.store.put(
          "checkpoints",
          JSON.stringify([id, s.activeTurnId, s.checkpoint!.segment]),
          { checkpoint: s.checkpoint, status: "runnable" }
        );
        s.status = "runnable";
        s.waits = undefined;
        schedule = true;
        event = this.store.event(
          id,
          s.activeTurnId,
          `command.${command.type}`,
          command
        );
      }
      this.store.put("sessions", id, s);
      const response = {
        status: "accepted",
        turnId: s.activeTurnId,
        cursor: event?.cursor ?? this.store.history(id).cursor,
        requestId: command.requestId,
      };
      this.store.put("commands", key, { command, response });
      return response;
    });
    if (event) this.publish(event);
    for (const extra of extraEvents) this.publish(extra);
    if (input.type === "cancel") this.running.get(id)?.abort();
    // Cascade cancel linked agents deepest-first under existing fencing (WF-R53).
    for (const agentId of cascadeCancelIds) {
      try {
        this.command(
          agentId,
          {
            type: "cancel",
            requestId: `flow-cascade-${id}-${agentId}`,
            idempotencyKey: `flow-cascade-cancel:${id}:${agentId}`,
            reason: "workflow cancelled",
          },
          scope
        );
      } catch {
        /* agent may already be terminal */
      }
    }
    // Direct cancel of a linked agent fails that node with agent.cancelled (WF-R54).
    if (input.type === "cancel") {
      const link = this.store.get("links", id);
      if (link) {
        this.store.tx(() => {
          wakeLinkedWorkflow({
            agentSessionId: id,
            store: this.store,
            cancelled: true,
            error: "Agent turn was cancelled",
            schedule: (sid) => this.schedule(sid),
            publish: (e) => this.publish(e),
          });
        });
      }
    }
    if (schedule) this.schedule(id);
    return response;
  }
  private sse(
    request: IncomingMessage,
    response: ServerResponse,
    set: Set<ServerResponse>,
    whenEmpty?: () => void
  ): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    set.add(response);
    const timer = setInterval(
      () => this.send(response, ": keepalive\n\n"),
      15000
    );
    timer.unref();
    request.on("close", () => {
      clearInterval(timer);
      set.delete(response);
      if (!set.size) whenEmpty?.();
    });
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    _url?: URL
  ): Promise<void> {
    const json = (value: unknown, status = 200) => {
      const payload = JSON.stringify(value);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    };
    try {
      const url = _url ?? new URL(request.url ?? "/", "http://runtime");
      const path = url.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      const method = request.method;
      const scope = this.scope(request);
      if (path[0] !== "v1") fail(404, "Route not found");
      if (
        path[1] === "executors" &&
        path[2] === "connect" &&
        method === "GET"
      ) {
        if (scope.kind !== "executor")
          return fail(403, "Executor credential required");
        const tokenHash = scope.executor.tokenHash;
        let streams = this.executorStreams.get(tokenHash);
        if (!streams)
          this.executorStreams.set(tokenHash, (streams = new Set()));
        this.sse(request, response, streams, () =>
          this.executorStreams.delete(tokenHash)
        );
        this.send(
          response,
          'event: work_available\ndata: {"type":"work_available"}\n\n'
        );
        return;
      }
      if (path[1] === "actions") {
        if (scope.kind !== "executor")
          return fail(403, "Executor credential required");
        this.expireClaims();
        if (path.length === 2 && method === "GET")
          return json({
            actions: this.store
              .all<Action>("actions")
              .filter(
                (a) =>
                  a.status === "pending" && a.agentId === scope.executor.agentId
              ),
          });
        const actionId = path[2];
        if (!actionId) fail(404, "Action not found");
        if (
          method === "POST" &&
          path[3] === "sandbox" &&
          path[4] &&
          path.length === 5
        ) {
          const action =
            this.store.get<Action>("actions", actionId) ??
            fail(404, "Action not found");
          this.scoped(scope, action);
          try {
            const outcome = await handleActionSandboxTool(
              this.sandboxRouteDeps(),
              actionId,
              path[4],
              await this.body(request),
              requestAborted(request)
            );
            return json(outcome);
          } catch (error) {
            if (error instanceof SandboxRouteError)
              fail(error.status, error.message);
            throw error;
          }
        }
        const body = await this.body(request);
        let event: LiveEvent | undefined;
        const result = this.store.tx(() => {
          const action =
            this.store.get<Action>("actions", actionId) ??
            fail(404, "Action not found");
          this.scoped(scope, action);
          if (method === "POST" && path[3] === "claim") {
            ActionClaimRequestSchema.parse(body);
            if (
              action.status !== "pending" ||
              this.session(action.sessionId).status === "cancelled" ||
              this.session(action.sessionId).activeTurnId !== action.turnId
            )
              fail(409, "Action unavailable");
            action.status = "claimed";
            action.generation++;
            action.claimId = randomUUID();
            action.leaseExpiresAt = new Date(
              Date.now() + (this.config.leaseMs ?? 30000)
            ).toISOString();
            this.store.put("actions", actionId, action);
            event = this.store.event(
              action.sessionId,
              action.turnId,
              "action.claimed",
              {
                actionId,
                generation: action.generation,
                ...(action.agent ? { agent: action.agent } : {}),
              }
            );
            return {
              action,
              claimId: action.claimId,
              generation: action.generation,
              leaseExpiresAt: action.leaseExpiresAt,
            };
          }
          if (method === "POST" && path[3] === "heartbeat") {
            const beat = ActionHeartbeatRequestSchema.parse(body);
            if (
              this.session(action.sessionId).activeTurnId !== action.turnId ||
              action.status !== "claimed" ||
              action.claimId !== beat.claimId ||
              action.generation !== beat.generation ||
              Date.parse(action.leaseExpiresAt!) <= Date.now()
            )
              fail(409, "Stale or expired claim");
            action.leaseExpiresAt = new Date(
              Date.now() + (this.config.leaseMs ?? 30000)
            ).toISOString();
            this.store.put("actions", actionId, action);
            return { leaseExpiresAt: action.leaseExpiresAt };
          }
          return fail(404, "Route not found");
        });
        if (event) this.publish(event);
        return json(result);
      }
      if (
        path[1] === "sessions" &&
        path[2] &&
        path[3] === "commands" &&
        method === "POST"
      )
        return json(
          this.command(
            path[2],
            SessionCommandSchema.parse(await this.body(request)),
            scope
          )
        );
      if (path[1] === "vaults")
        return json(
          await this.dispatchVault(scope, method, path, url, request)
        );
      if (path[1] === "tenant")
        return json(await this.dispatchTenant(scope, method, path, request));
      const principalId = this.requireApplication(scope);
      if (path[1] === "executors" && path.length === 2 && method === "GET")
        return json({
          executors: this.registry.list().map((e) => ({
            agentId: e.agentId,
            implementationVersion: e.implementationVersion,
            ...(e.manifestHash === undefined
              ? {}
              : { manifestHash: e.manifestHash }),
            connected: (this.executorStreams.get(e.tokenHash)?.size ?? 0) > 0,
            updatedAt: e.updatedAt,
          })),
        });
      // The length guard matters: the connect branch above only matches GET, so without it a
      // PUT to /v1/executors/connect would register an agent literally named "connect".
      if (path[1] === "executors" && path.length === 2 && method === "PUT") {
        const body = RegisterExecutorsRequestSchema.parse(
          await this.body(request)
        );
        // Credential rules are shared with startup validation, which throws plainly; on the
        // wire a rejected registration is a bad request, not a server fault.
        const applicationHashes = applicationTokenHashes(this.store.db);
        try {
          for (const executor of body.executors)
            assertExecutorCredential(executor, applicationHashes);
        } catch (error) {
          fail(400, error instanceof Error ? error.message : String(error));
        }
        if (
          new Set(body.executors.map((e) => e.agentId)).size !==
            body.executors.length ||
          new Set(body.executors.map((e) => e.token)).size !==
            body.executors.length
        )
          fail(
            400,
            "Executor registrations must be unique per agent and token"
          );
        const updatedAt = new Date().toISOString();
        const records = body.executors.map((executor) => ({
          agentId: executor.agentId,
          implementationVersion: executor.implementationVersion,
          ...(executor.manifestHash === undefined
            ? {}
            : { manifestHash: executor.manifestHash }),
          tokenHash: hashToken(executor.token),
          persisted: true as const,
          updatedAt,
          principalId,
        }));
        for (const record of records) {
          const collision = this.registry.find(record.tokenHash);
          if (collision && collision.agentId !== record.agentId)
            fail(409, "Executor tokens must be unique");
          // A token hash may not appear in both principals and executors (D3).
          if (applicationHashes.includes(record.tokenHash))
            fail(
              400,
              "Executor tokens require independent credentials and an agent id"
            );
        }
        // Persist the whole batch first; the in-memory registry must never run ahead of SQLite.
        this.store.tx(() => {
          for (const record of records)
            this.store.putExecutor({
              agentId: record.agentId,
              tokenHash: record.tokenHash,
              implementationVersion: record.implementationVersion,
              ...(record.manifestHash === undefined
                ? {}
                : { manifestHash: record.manifestHash }),
              principalId: record.principalId,
              updatedAt,
            });
        });
        const results = records.map((record) => {
          const previous = this.registry.get(record.agentId);
          const { rotated, previousHash } = this.registry.upsert(record);
          if (rotated && previousHash) {
            for (const r of this.executorStreams.get(previousHash) ?? [])
              r.end();
            this.executorStreams.delete(previousHash);
          }
          const replacedByDifferent =
            previous?.principalId !== undefined &&
            previous.principalId !== principalId;
          if (replacedByDifferent)
            this.config.logger.warn(
              "executor registration replaced by different application credential",
              {
                agentId: record.agentId,
                previousPrincipalId: previous.principalId,
              }
            );
          return {
            agentId: record.agentId,
            implementationVersion: record.implementationVersion,
            rotated,
            ...(replacedByDifferent
              ? { replacedBy: "different-credential" as const }
              : {}),
          };
        });
        return json({ executors: results });
      }
      if (
        path[1] === "executors" &&
        path.length === 3 &&
        path[2] &&
        method === "DELETE"
      ) {
        const agentId = path[2];
        const existing =
          this.registry.get(agentId) ?? fail(404, "Executor not found");
        this.store.tx(() => this.store.deleteExecutor(agentId));
        this.registry.remove(agentId);
        for (const r of this.executorStreams.get(existing.tokenHash) ?? [])
          r.end();
        this.executorStreams.delete(existing.tokenHash);
        return json({ agentId, deleted: true });
      }
      if (path[1] === "agents" && path.length === 2 && method === "GET")
        return json({
          agents: this.store.all("definitions").map((d) => ({
            agentId: d.manifest.id,
            manifest: d.manifest,
            manifestHash: d.manifestHash,
            implementationVersion: d.implementationVersion,
          })),
        });
      if (path[1] === "sessions" && path.length === 2 && method === "GET")
        return json({
          sessions: this.store
            .all<Session>("sessions")
            .filter(
              (s) =>
                !url.searchParams.has("agentId") ||
                s.agentId === url.searchParams.get("agentId")
            )
            .map((s) => ({
              id: s.id,
              agentId: s.agentId,
              ownerUserId: s.ownerUserId,
              status: s.status,
              activeTurnId: s.activeTurnId,
            })),
        });
      if (
        path[1] === "agents" &&
        path[2] &&
        path.length === 3 &&
        method === "PUT"
      ) {
        const body = PutAgentRequestSchema.parse(await this.body(request));
        if (body.manifest.id !== path[2]) fail(400, "Agent id mismatch");
        DefinitionDocumentSchema.parse(body.manifest);
        const definition = {
          ...body,
          manifestHash: hashManifest(body.manifest as any),
        };
        this.store.tx(() => {
          this.store.put("definitions", path[2]!, definition);
        });
        return json({
          agentId: path[2],
          manifestHash: definition.manifestHash,
          implementationVersion: body.implementationVersion,
        });
      }
      if (path[1] === "sessions" && path[2]) {
        const id = path[2];
        if (method === "PUT" && path.length === 3) {
          const body = PutSessionRequestSchema.parse(await this.body(request));
          const vaultIds = body.vaultIds ?? [];
          const credentialSelections = body.credentialSelections ?? [];
          const prior = this.store.get<Session>("sessions", id);
          const definition =
            prior === undefined || body.sandbox
              ? this.store.get<{
                  manifest: unknown;
                  manifestHash: string;
                  implementationVersion: string;
                  pluginRoots?: Record<string, string>;
                }>("definitions", body.agentId) ??
                fail(404, "Definition not found")
              : undefined;
          const sandboxOwnerId = body.sandbox
            ? validateSandboxAttach(
                body,
                (definition ?? prior)!.manifest as never,
                (sid) => this.store.get<Session>("sessions", sid)
              )
            : undefined;
          const result = this.store.tx(() => {
            this.vault.assertAttachment(
              body.ownerUserId,
              vaultIds,
              credentialSelections
            );
            const existing = this.store.get<Session>("sessions", id);
            if (existing) {
              if (sessionIdentity(existing.creation) !== sessionIdentity(body))
                fail(
                  409,
                  "Session already exists with different creation parameters"
                );
              existing.vaultIds = vaultIds;
              existing.credentialSelections = credentialSelections;
              existing.creation = body;
              if (sandboxOwnerId !== undefined)
                existing.sandboxOwnerId = sandboxOwnerId;
              this.store.put("sessions", id, existing);
              this.vault.recordAttachment(id, vaultIds);
              return existing;
            }
            const created: Session = {
              id,
              agentId: body.agentId,
              ownerUserId: body.ownerUserId,
              manifest: definition!.manifest,
              manifestHash: definition!.manifestHash,
              implementationVersion: definition!.implementationVersion,
              info: body.info,
              status: "idle",
              activeTurnId: null,
              creation: body,
              vaultIds,
              credentialSelections,
              pluginRoots: definition!.pluginRoots ?? {},
              ...(sandboxOwnerId !== undefined ? { sandboxOwnerId } : {}),
            };
            this.store.put("sessions", id, created);
            this.vault.recordAttachment(id, vaultIds);
            return created;
          });
          return json(this.view(result));
        }
        const s = this.session(id);
        if (method === "GET" && path.length === 3) return json(this.view(s));
        const cursor =
          url.searchParams.get("cursor") ??
          (typeof request.headers["last-event-id"] === "string"
            ? request.headers["last-event-id"]
            : undefined);
        if (method === "GET" && path[3] === "items")
          return json(
            this.store.history(
              id,
              cursor,
              url.searchParams.get("agent") ?? undefined
            )
          );
        if (method === "GET" && path[3] === "events") {
          const history = this.store.history(id, cursor);
          const set = this.observers.get(id) ?? new Set<ServerResponse>();
          this.observers.set(id, set);
          this.sse(request, response, set);
          for (const event of history.items)
            this.send(
              response,
              `id: ${event.cursor}\nevent: ${
                event.type
              }\ndata: ${JSON.stringify(event)}\n\n`
            );
          return;
        }
        if (
          method === "POST" &&
          path[3] === "sandbox" &&
          path[4] &&
          path.length === 5
        ) {
          this.requireApplication(scope);
          try {
            const outcome = await handleSessionSandboxTool(
              this.sandboxRouteDeps(),
              id,
              path[4],
              await this.body(request),
              requestAborted(request)
            );
            return json(outcome);
          } catch (error) {
            if (error instanceof SandboxRouteError)
              fail(error.status, error.message);
            throw error;
          }
        }
      }
      fail(404, "Route not found");
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof OpaqueAuthError) {
        json(error.body, error.status);
        return;
      }
      const status =
        error instanceof HttpError ||
        error instanceof VaultError ||
        error instanceof SandboxRouteError
          ? error.status
          : (error as any)?.name === "ZodError" ||
            (error as Error)?.message === "Invalid cursor"
          ? 400
          : 500;
      json(
        {
          status: "rejected",
          code: status === 500 ? "internal_error" : "request_rejected",
          message:
            status === 500
              ? "Runtime request failed"
              : (error as Error).message,
        },
        status
      );
    }
  }
  private view(s: Session): unknown {
    return {
      id: s.id,
      agentId: s.agentId,
      ownerUserId: s.ownerUserId,
      manifestHash: s.manifestHash,
      implementationVersion: s.implementationVersion,
      status: s.status,
      activeTurnId: s.activeTurnId,
      vaultIds: s.vaultIds ?? [],
      credentialSelections: s.credentialSelections ?? [],
      sandboxOwnerId: s.sandboxOwnerId ?? null,
      mcpSnapshot: s.mcpSnapshot ?? null,
      mcpDiagnostics: s.mcpDiagnostics ?? [],
      waits: (() => {
        if (isWorkflowManifest(s.manifest)) {
          const aggregated = aggregateWaits({
            store: this.store,
            workflowSessionId: s.id,
          });
          if (aggregated.length > 0) return aggregated;
        }
        return Array.isArray(s.waits)
          ? s.waits.map((call: any) => ({
              invocationId: call.invocationId,
              interaction: call.interaction,
              wait: call.wait,
              status: call.status,
            }))
          : s.waits;
      })(),
      error: s.error,
      actions: this.store
        .all<Action>("actions")
        .filter(
          (a) =>
            a.sessionId === s.id &&
            !["completed", "cancelled"].includes(a.status)
        ),
      uncertainEffects: this.store
        .all("effects")
        .filter((e) => e.request.sessionId === s.id && e.status === "uncertain")
        .map((e) => ({
          effectId: e.request.effectId,
          turnId: e.request.turnId,
          kind: e.request.kind,
          error: e.error,
        })),
    };
  }
  private async prepareMcp(id: string, signal: AbortSignal): Promise<void> {
    const s = this.session(id);
    if (serversOf(s.manifest).length === 0) return;
    if (!s.mcpSnapshot) {
      const found = await this.mcp.discover({
        sessionId: id,
        manifest: s.manifest,
        manifestHash: s.manifestHash,
        pluginRoots: s.pluginRoots ?? {},
        signal,
      });
      this.store.tx(() => {
        const current = this.session(id);
        if (current.mcpSnapshot) return;
        current.mcpSnapshot = found.snapshot;
        current.mcpDiagnostics = found.diagnostics;
        this.store.put("sessions", id, current);
      });
      return;
    }
    const diagnostics = await this.mcp.reconnect({
      sessionId: id,
      manifest: s.manifest,
      pluginRoots: s.pluginRoots ?? {},
      tools: s.mcpSnapshot.mcpTools,
      signal,
    });
    if (diagnostics.length === 0) return;
    this.store.tx(() => {
      const current = this.session(id);
      const prior = [...(current.mcpDiagnostics ?? [])];
      for (const item of diagnostics) {
        const index = prior.findIndex(
          (existing) =>
            existing.capabilityId === item.capabilityId &&
            existing.serverName === item.serverName
        );
        if (index >= 0) prior[index] = item;
        else prior.push(item);
      }
      current.mcpDiagnostics = prior;
      this.store.put("sessions", id, current);
    });
  }
  private async callMcpTool(request: HostEffect): Promise<unknown> {
    const s = this.session(request.sessionId);
    const tool = mcpToolOf(s, request);
    if (!tool)
      throw new Error(
        `MCP tool '${request.toolName ?? ""}' is not in the session snapshot`
      );
    return this.mcp.call({
      sessionId: s.id,
      ...(tool.agentId === undefined ? {} : { agentId: tool.agentId }),
      capabilityId: tool.capabilityId,
      serverName: tool.serverName,
      serverToolName: tool.serverToolName,
      args: request.input,
      manifest: s.manifest,
      pluginRoots: s.pluginRoots ?? {},
    });
  }
  private async callSandboxTool(
    request: HostEffect,
    signal: AbortSignal
  ): Promise<unknown> {
    const s = this.session(request.sessionId);
    // Agents used as tools share the session's sandbox; the tree declares one sandbox spec.
    const capability = sandboxCapabilityOf(
      manifestFor(s.manifest, request.agent),
      request.capabilityId,
      request.toolName
    );
    if (!capability)
      throw new Error(`'${request.toolName ?? ""}' is not a sandbox tool`);
    const ownerId = owningSandboxSessionId(s, (id) =>
      this.store.get<Session>("sessions", id)
    );
    return this.sandbox.run(
      { id: ownerId, activeTurnId: s.activeTurnId, manifest: s.manifest },
      capability,
      request.toolName as never,
      request.input,
      signal
    );
  }
  async authorize(
    sessionId: string,
    request: { url: string; serverName?: string }
  ): Promise<AuthorizeResult> {
    const s = this.session(sessionId);
    const result = await this.vault.authorize({
      sessionId,
      vaultIds: s.vaultIds ?? [],
      credentialSelections: s.credentialSelections ?? [],
      url: request.url,
      serverName: request.serverName,
    });
    if (result.status === "authorized") {
      const token = result.headers.authorization.slice("Bearer ".length);
      scrub({ authorization: result.headers.authorization, url: result.url }, [
        token,
      ]);
    }
    return result;
  }
  private ensureKek(): Buffer {
    if (this.kek) return this.kek;
    if (!this.createKekIfMissing)
      throw new QuarantineError(
        "kek-missing",
        "Vault key-encryption key is required",
        "restore the vault-kek file beside tenant.sqlite"
      );
    this.kek = createKekFile(this.kekPath);
    return this.kek;
  }
  private async dispatchTenant(
    scope: AuthScope,
    method: string | undefined,
    path: string[],
    request: IncomingMessage
  ): Promise<unknown> {
    if (scope.kind !== "application") {
      this.vault.reject(path.join("/"));
      fail(403, "Application credential required");
    }
    if (path.length === 2 && method === "GET")
      return buildTenantStatus({
        envelope: this.envelope,
        config: this.config,
        store: this.store,
        registry: this.registry,
        vault: this.vault,
        sandbox: this.sandbox,
        closing: this.closing || this.closed,
        modelConfigured: this.useVaultModel
          ? this.vault.getHostModel().configured
          : true,
        executorStreams: this.executorStreams,
      });
    if (path[2] === "reset" && path.length === 3 && method === "POST") {
      const body = ResetTenantRequestSchema.parse(await this.body(request));
      await this.drain(body.activeWork);
      await resetTenant(
        {
          store: this.store,
          registry: this.registry,
          sandbox: this.sandbox,
          paths: this.config.paths,
          clearSessionState: () => {
            this.pending.clear();
            for (const c of this.running.values()) c.abort();
            this.running.clear();
            for (const set of this.observers.values())
              for (const r of set) r.end();
            this.observers.clear();
          },
          clearExecutorStreams: () => {
            for (const streams of this.executorStreams.values())
              for (const r of streams) r.end();
            this.executorStreams.clear();
          },
        },
        body.scope
      );
      // Reset leaves the Tenant open for new work.
      this.closing = false;
      return { ok: true };
    }
    if (
      path[2] === "config" &&
      path[3] === "seed" &&
      path.length === 4 &&
      method === "PUT"
    ) {
      const body = SeedTenantConfigRequestSchema.parse(
        await this.body(request)
      );
      return seedTenantConfig({ store: this.store, vault: this.vault }, body);
    }
    if (path[2] === "models" && path.length === 3 && method === "GET")
      return hostModelCatalog();
    if (path[2] === "sandbox" && path.length === 3 && method === "GET")
      return this.sandbox.report();
    if (path[2] === "providers" && path.length === 3 && method === "GET")
      return this.vault.listHostProviders();
    if (path[2] === "model" && path.length === 3 && method === "GET")
      return this.vault.getHostModel();
    if (path[2] === "model" && path.length === 3 && method === "PUT")
      return this.vault.putHostModel(
        PutHostModelRequestSchema.parse(await this.body(request))
      );
    if (
      path[2] === "model" &&
      path[3] === "selection" &&
      path.length === 4 &&
      method === "PUT"
    )
      return this.vault.selectHostModel(
        SelectHostModelRequestSchema.parse(await this.body(request))
      );
    fail(404, "Route not found");
  }
  private async dispatchVault(
    scope: AuthScope,
    method: string | undefined,
    path: string[],
    url: URL,
    request: IncomingMessage
  ): Promise<unknown> {
    if (scope.kind !== "application") {
      this.vault.reject(path.join("/"));
      fail(403, "Application credential required");
    }
    if (path.length === 2 && method === "POST") {
      const body = CreateVaultRequestSchema.parse(await this.body(request));
      return this.vault.createVault(body);
    }
    if (path.length === 2 && method === "GET") {
      const ownerUserId =
        url.searchParams.get("ownerUserId") ??
        fail(400, "ownerUserId is required");
      return { vaults: this.vault.listVaults(ownerUserId) };
    }
    const vaultId = path[2];
    if (!vaultId) fail(404, "Vault not found");
    if (path.length === 3 && method === "GET")
      return this.vault.getVault(vaultId);
    if (path.length === 3 && method === "DELETE")
      return this.vault.deleteVault(vaultId);
    if (path[3] !== "credentials") fail(404, "Route not found");
    if (path.length === 4 && method === "POST") {
      const body = CreateCredentialRequestSchema.parse(
        await this.body(request)
      );
      return this.vault.createCredential(vaultId, body);
    }
    if (path.length === 4 && method === "GET")
      return { credentials: this.vault.listCredentials(vaultId) };
    const credentialId = path[4];
    if (!credentialId) fail(404, "Credential not found");
    if (path.length === 5 && method === "GET")
      return this.vault.getCredential(vaultId, credentialId);
    if (path.length === 5 && method === "POST") {
      const body = RotateCredentialRequestSchema.parse(
        await this.body(request)
      );
      return this.vault.rotateCredential(vaultId, credentialId, body);
    }
    if (path.length === 5 && method === "DELETE")
      return this.vault.deleteCredential(vaultId, credentialId);
    fail(404, "Route not found");
  }

  async summary(): Promise<TenantSummary> {
    const sessions = this.store.all<Session>("sessions");
    const runningSessions = sessions.filter(
      (sess) => sess.status === "running" || sess.status === "runnable"
    ).length;
    const connectedExecutors = [...this.executorStreams.values()].filter(
      (set) => set.size > 0
    ).length;
    const pendingActions = this.store
      .all<Action>("actions")
      .filter((a) => a.status === "pending" || a.status === "claimed").length;
    const uncertainEffects = this.store
      .all("effects")
      .filter((e) => e.status === "uncertain").length;
    return {
      ready: !this.closing && !this.closed,
      runningSessions,
      connectedExecutors,
      pendingActions,
      uncertainEffects,
    };
  }

  async drain(
    activeWork: "drain" | "cancel",
    timeoutMs = 30_000
  ): Promise<void> {
    this.closing = true;
    if (activeWork === "cancel") {
      for (const sess of this.store.all<Session>("sessions"))
        if (
          sess.activeTurnId &&
          ["running", "runnable", "paused"].includes(sess.status)
        )
          this.command(
            sess.id,
            {
              type: "cancel",
              requestId: randomUUID(),
              idempotencyKey: `drain-cancel-${sess.id}-${sess.activeTurnId}`,
              reason: "tenant drain cancel",
            },
            {
              kind: "application",
              principalId: "drain",
            }
          );
    }
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    for (const c of this.running.values()) c.abort();
    await this.mcp.close();
    for (const streams of this.executorStreams.values())
      for (const r of streams) r.end();
    for (const set of this.observers.values()) for (const r of set) r.end();
    while (this.running.size)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await this.sandbox.close();
    this.closed = true;
    this.store.db.close();
    if (this.lockPath && existsSync(this.lockPath)) unlinkSync(this.lockPath);
  }
}

function readEnvelope(config: TenantConfig): TenantEnvelope {
  if (existsSync(config.paths.envelope)) {
    return JSON.parse(
      readFileSync(config.paths.envelope, "utf8")
    ) as TenantEnvelope;
  }
  const now = new Date().toISOString();
  return {
    id: config.tenantId,
    name: config.tenantId,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

/**
 * Open a Tenant Runtime from an explicit `TenantConfig`. No listen() (A1).
 * Implements `OpenTenantRuntime`.
 */
export async function openTenantRuntime(
  config: TenantConfig,
  // TENANTS-CCR: optional hooks for tests until TenantConfig grows them
  hooks?: TenantOpenHooks
): Promise<TenantHandle> {
  return TenantRuntime.open(config, hooks ?? {});
}

/** What an action runs, for events: a tool name, or a hook point and its capabilities. */
function actionTarget(action: Action) {
  if (action.kind === "hook")
    return {
      hook: action.hook,
      ...(action.agent ? { agent: action.agent } : {}),
    };
  if (action.kind === "tool" && "toolName" in action)
    return {
      toolName: action.toolName,
      ...(action.agent ? { agent: action.agent } : {}),
    };
  return {
    path: action.path,
    key: action.key,
    ...(action.agent ? { agent: action.agent } : {}),
  };
}
