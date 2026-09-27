/**
 * Composition root of an open Tenant: validates the config, takes the Tenant lock, opens the
 * Session Store and the vault key, builds the services and the `TenantContext`, wires the
 * seams, runs startup recovery, and implements `TenantHandle` (handle, summary, drain, close)
 * by delegating to the Tenant modules.
 *
 * Seams wired here: the store's commit listener delivers committed events to live observers
 * (`publish`) and `workAvailable` to connected executors (`notify`); `schedule` and
 * `abortLocal` drive in-process advances; `history` reads the SQLite events table.
 *
 * Later waves: Wave 2 / X replaces the lock file and startup recovery with ownership
 * takeover and wires `DurableExecution`; Wave 2 / Y replaces the commit listener and
 * `history` with one `wireStreams()` call.
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
import type { TenantEnvelope } from "@nylorun/core/contracts";
import { resolveFlowLimits, type FlowLimits } from "../core/limits.js";
import { loadExecutorRegistry } from "../core/executors.js";
import {
  scriptedModel,
  gatewayModel,
  toolFixtureModel,
  type ModelProvider,
} from "../core/provider.js";
import {
  createSqliteSessionStore,
  type SqliteSessionStore,
} from "../store/sqlite.js";
import { createKekFile, readVaultKek } from "../vault/kek.js";
import { VaultService, type AuthorizeResult } from "../vault/service.js";
import { McpPool } from "../mcp/pool.js";
import { SandboxManager } from "../sandbox/manager.js";
import { defaultSandboxBackends } from "../sandbox/select.js";
import { QuarantineError } from "./quarantine-error.js";
import type { TenantConfig, TenantHandle, TenantSummary } from "./types.js";
import type { TenantContext } from "./context.js";
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

function validateConfig(config: TenantConfig): FlowLimits {
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
  return flowLimits;
}

/** Take the Tenant lock file, clearing a stale one left by a dead process. */
function claimLock(lockPath: string): void {
  try {
    const oldPid = Number(readFileSync(lockPath, "utf8"));
    if (!Number.isSafeInteger(oldPid) || oldPid < 1)
      throw new Error("Invalid runtime lock; inspect before removing");
    try {
      process.kill(oldPid, 0);
      throw new QuarantineError(
        "locked",
        "Another Runtime owns this Tenant database",
        "nylorun tenant status",
        { lockPath, lockPid: oldPid }
      );
    } catch (error) {
      if (error instanceof QuarantineError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      unlinkSync(lockPath);
    }
  } catch (error) {
    if (error instanceof QuarantineError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fd = openSync(lockPath, "wx");
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
}

export class TenantRuntime implements TenantHandle {
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly ctx: TenantContext,
    private readonly lockPath: string,
    readonly envelope: TenantEnvelope
  ) {}

  static async open(
    config: TenantConfig,
    hooks: TenantOpenHooks = {}
  ): Promise<TenantRuntime> {
    const envelope = readEnvelope(config);
    const flowLimits = validateConfig(config);

    const paths = config.paths;
    mkdirSync(paths.root, { recursive: true });
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.tmp, { recursive: true });
    mkdirSync(paths.sandboxes, { recursive: true });
    mkdirSync(paths.pluginData, { recursive: true });
    mkdirSync(paths.logs, { recursive: true });
    mkdirSync(dirname(paths.database), { recursive: true });

    const lockPath = paths.lock;
    claimLock(lockPath);

    let store: SqliteSessionStore | undefined;
    try {
      store = createSqliteSessionStore({
        path: paths.database,
        tenantId: config.tenantId,
        onError: (error) =>
          config.logger.error("post-commit step failed", {
            message: error instanceof Error ? error.message : String(error),
          }),
      });
      let kek = readVaultKek({
        vaultKek: hooks.vaultKek,
        vaultKekPath: paths.kek,
      });
      if ((await store.tx((t) => t.countCredentials())) > 0 && !kek) {
        throw new QuarantineError(
          "kek-missing",
          "Vault key-encryption key is missing for ciphertext in this Tenant",
          "restore the vault-kek file beside tenant.sqlite"
        );
      }
      const createKekIfMissing = hooks.createKekIfMissing !== false;
      const ensureKek = (): Buffer => {
        if (kek) return kek;
        if (!createKekIfMissing)
          throw new QuarantineError(
            "kek-missing",
            "Vault key-encryption key is required",
            "restore the vault-kek file beside tenant.sqlite"
          );
        kek = createKekFile(paths.kek);
        return kek;
      };
      const opened = store;
      const registry = await loadExecutorRegistry(opened);
      // A seeded Tenant setting wins over the Host default (A18).
      const seededBackend = await opened.tx((t) =>
        t.getSetting("sandbox.backend")
      );

      const vault = new VaultService({
        store: opened,
        kek: ensureKek,
        fetch: config.vaultFetch ?? globalThis.fetch,
      });
      // `ctx` is assigned below; these callbacks only run once the Tenant is open.
      let ctx!: TenantContext;
      const mcp = new McpPool({
        pluginData: paths.pluginData,
        childEnv: config.childEnv,
        authorize: (sessionId, request) => authorize(ctx, sessionId, request),
      });
      const ephemeral = config.mode === "ephemeral";
      const sandbox = new SandboxManager({
        scope: config.tenantId,
        store: opened,
        backends:
          config.sandbox.backends ??
          defaultSandboxBackends({ root: paths.sandboxes }),
        preference: seededBackend ?? config.sandbox.backend,
        ephemeral,
        emit: async (sessionId, turnId, type, payload) => {
          if (ctx.closed) return;
          try {
            await opened.tx((t) => t.event(sessionId, turnId, type, payload));
          } catch {
            /* the session is gone (reset) or the store closed */
          }
        },
      });
      await sandbox.init();

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
          const secret = await vault.readHostModel();
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
      ctx = {
        config,
        envelope,
        store: opened,
        history: opened,
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
        schedule: (sessionId) => schedule(ctx, sessionId),
        abortLocal: (sessionId) => abortLocal(ctx, sessionId),
      };
      // The seams: committed events go to live observers, work to connected executors.
      opened.onCommit((commit) => {
        for (const event of commit.events) publish(live, event);
        if (commit.workAvailable) notify(live);
      });

      if (!ephemeral && (await sandbox.hasRecords()))
        void sandbox
          .reconcile(
            async (id) =>
              !ctx.closed &&
              !!(await opened.tx((t) => t.get("sessions", id)).catch(() => 1))
          )
          .catch(() => undefined);

      await recoverOnOpen(ctx);
      await rescheduleOnOpen(ctx);
      const runtime = new TenantRuntime(ctx, lockPath, envelope);
      runtime.timer = startLeaseTimer(ctx);
      return runtime;
    } catch (error) {
      await store?.close().catch(() => undefined);
      if (existsSync(lockPath)) unlinkSync(lockPath);
      throw error;
    }
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

  async summary(): Promise<TenantSummary> {
    const { store, live } = this.ctx;
    const counts = await store.tx((t) => t.counts());
    return {
      ready: !this.ctx.closing && !this.ctx.closed,
      runningSessions: counts.runningSessions,
      connectedExecutors: connectedExecutorCount(live),
      pendingActions: counts.pendingActions,
      uncertainEffects: counts.uncertainEffects,
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
    await ctx.store.close();
    if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
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
