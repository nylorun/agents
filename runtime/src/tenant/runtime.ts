/**
 * Composition root of an open Tenant: validates the config, takes the Tenant lock, opens the
 * store and the vault key, builds the services and the `TenantContext`, wires the three seams
 * (`publish`, `notify`, `schedule`) plus `abortLocal`, runs startup recovery, and implements
 * `TenantHandle` (handle, summary, drain, close) by delegating to the Tenant modules.
 *
 * Later waves: Wave 1 / A opens the async store here; Wave 2 / X replaces the lock file and
 * startup recovery with ownership takeover and wires `DurableExecution`; Wave 2 / Y adds one
 * `wireStreams()` call for `publish`/`notify`.
 */
import type { ServerResponse, IncomingMessage } from "node:http";
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
import type { Action, TenantEnvelope } from "@nylorun/core/contracts";
import { resolveFlowLimits } from "../core/limits.js";
import { Store } from "../core/store.js";
import { ExecutorRegistry } from "../core/executors.js";
import {
  scriptedModel,
  gatewayModel,
  toolFixtureModel,
  type ModelProvider,
} from "../core/provider.js";
import { createKekFile, readVaultKek } from "../vault/kek.js";
import { VaultService, type AuthorizeResult } from "../vault/service.js";
import { McpPool } from "../mcp/pool.js";
import { SandboxManager } from "../sandbox/manager.js";
import { defaultSandboxBackends } from "../sandbox/select.js";
import { QuarantineError } from "./quarantine-error.js";
import type { TenantConfig, TenantHandle, TenantSummary } from "./types.js";
import type { Session, TenantContext } from "./context.js";
import {
  connectedExecutorCount,
  createLiveHub,
  endAllStreams,
  notify,
  publish,
} from "./live.js";
import {
  abortAll,
  abortLocal,
  createWorkState,
  drain,
  recoverOnOpen,
  rescheduleOnOpen,
  schedule,
  startLeaseTimer,
  waitForIdle,
} from "./scheduler.js";
import { authorize } from "./effects.js";
import { handle } from "./routes.js";

/** TENANTS-CCR: test/injection hooks until TenantConfig gains them. */
export type TenantOpenHooks = {
  modelProvider?: ModelProvider;
  vaultKek?: Buffer | string | null;
  /** When true, create the KEK file on first vault write (tests / new Tenants). */
  createKekIfMissing?: boolean;
};

export class TenantRuntime implements TenantHandle {
  private readonly ctx: TenantContext;
  private kek: Buffer | undefined;
  private readonly kekPath: string;
  private readonly lockPath?: string;
  private readonly timer: NodeJS.Timeout;
  private readonly createKekIfMissing: boolean;
  readonly envelope: TenantEnvelope;
  private constructor(
    config: TenantConfig,
    hooks: TenantOpenHooks,
    envelope: TenantEnvelope
  ) {
    this.envelope = envelope;
    if (
      config.leaseMs !== undefined &&
      (!Number.isFinite(config.leaseMs) || config.leaseMs <= 0)
    )
      throw new Error("leaseMs must be finite and positive");
    const flowLimits = resolveFlowLimits({
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
    let opened: Store | undefined;
    try {
      opened = new Store(paths.database, config.tenantId);
      this.kek = readVaultKek({
        vaultKek: hooks.vaultKek,
        vaultKekPath: this.kekPath,
      });
      if (opened.credentialCount() > 0 && !this.kek) {
        throw new QuarantineError(
          "kek-missing",
          "Vault key-encryption key is missing for ciphertext in this Tenant",
          "restore the vault-kek file beside tenant.sqlite"
        );
      }
    } catch (e) {
      opened?.db.close();
      if (this.lockPath && existsSync(this.lockPath)) unlinkSync(this.lockPath);
      throw e;
    }
    const store = opened;

    const registry = new ExecutorRegistry();
    registry.seed(
      store.allExecutors().map((row) => ({
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

    const vault = new VaultService(
      store.db,
      (fn) => store.tx(fn),
      () => this.ensureKek(),
      config.vaultFetch ?? globalThis.fetch
    );
    const mcp = new McpPool({
      pluginData: paths.pluginData,
      childEnv: config.childEnv,
      authorize: (sessionId, request) => this.authorize(sessionId, request),
    });
    const ephemeral = config.mode === "ephemeral";
    const sandbox = new SandboxManager({
      scope: config.tenantId,
      store,
      backends:
        config.sandbox.backends ??
        defaultSandboxBackends({ root: paths.sandboxes }),
      preference: config.sandbox.backend,
      ephemeral,
      emit: (sessionId, turnId, type, payload) => {
        if (ctx.closed) return;
        const event = store.tx(() =>
          store.event(sessionId, turnId, type, payload)
        );
        ctx.publish(event);
      },
    });

    const useVaultModel = config.model.kind === "vault";
    let modelProvider: ModelProvider;
    if (hooks.modelProvider) modelProvider = hooks.modelProvider;
    else if (config.model.kind === "scripted")
      modelProvider = scriptedModel(config.model.output);
    else if (config.model.kind === "fixture")
      modelProvider = toolFixtureModel();
    else if (config.model.kind === "gateway") {
      const gateway = config.model;
      modelProvider = async (effect, signal) => {
        const secret = vault.readHostModel();
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
    } else modelProvider = scriptedModel();

    const live = createLiveHub();
    const ctx: TenantContext = {
      config,
      envelope,
      store,
      vault,
      registry,
      mcp,
      sandbox,
      flowLimits,
      modelProvider,
      useVaultModel,
      closing: false,
      closed: false,
      work: createWorkState(),
      live,
      // The seams. Later waves rewire each of these in this one place.
      publish: (event) => publish(live, event),
      notify: () => notify(live),
      schedule: (sessionId) => schedule(ctx, sessionId),
      abortLocal: (sessionId) => abortLocal(ctx, sessionId),
    };
    this.ctx = ctx;

    if (!ephemeral && sandbox.hasRecords())
      void sandbox
        .reconcile((id) => !ctx.closed && !!store.get("sessions", id))
        .catch(() => undefined);

    recoverOnOpen(ctx);
    this.timer = startLeaseTimer(ctx);
    rescheduleOnOpen(ctx);
  }

  static async open(
    config: TenantConfig,
    hooks: TenantOpenHooks = {}
  ): Promise<TenantRuntime> {
    const envelope = readEnvelope(config);
    return new TenantRuntime(config, hooks, envelope);
  }

  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url?: URL
  ): Promise<void> {
    return handle(this.ctx, request, response, url);
  }

  authorize(
    sessionId: string,
    request: { url: string; serverName?: string }
  ): Promise<AuthorizeResult> {
    return authorize(this.ctx, sessionId, request);
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

  async summary(): Promise<TenantSummary> {
    const { store, live } = this.ctx;
    const sessions = store.all<Session>("sessions");
    const runningSessions = sessions.filter(
      (sess) => sess.status === "running" || sess.status === "runnable"
    ).length;
    const connectedExecutors = connectedExecutorCount(live);
    const pendingActions = store
      .all<Action>("actions")
      .filter((a) => a.status === "pending" || a.status === "claimed").length;
    const uncertainEffects = store
      .all("effects")
      .filter((e) => e.status === "uncertain").length;
    return {
      ready: !this.ctx.closing && !this.ctx.closed,
      runningSessions,
      connectedExecutors,
      pendingActions,
      uncertainEffects,
    };
  }

  drain(activeWork: "drain" | "cancel", timeoutMs = 30_000): Promise<void> {
    return drain(this.ctx, activeWork, timeoutMs);
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    ctx.closing = true;
    clearInterval(this.timer);
    abortAll(ctx);
    await ctx.mcp.close();
    endAllStreams(ctx.live);
    await waitForIdle(ctx);
    await ctx.sandbox.close();
    ctx.closed = true;
    ctx.store.db.close();
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
  // TENANTS-CCR: optional hooks for tests until TenantConfig gains them
  hooks?: TenantOpenHooks
): Promise<TenantHandle> {
  return TenantRuntime.open(config, hooks ?? {});
}
