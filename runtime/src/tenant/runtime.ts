/**
 * Composition root of an open Tenant: validates the config, opens the Session Store and the
 * vault key, builds the services and the `TenantContext`, wires the seams, registers the
 * Tenant's Worker handlers and arms its sweep, and implements `TenantHandle` (handle,
 * summary, drain, close) by delegating to the Tenant modules.
 *
 * Seams wired here: `wireStreams()` connects the store's commits to Durable Streams (the
 * relay, and the history, SSE, work and control readers); `wake` goes to the
 * `DurableExecution`, whose handlers (`worker.ts`) call `advance` and `sweep`; `abortLocal`
 * aborts an advance running on this process. The sweep also drains the outbox.
 *
 * Execution: the Host passes one `TenantExecution` for every Tenant it opens
 * (`TenantOpenHooks.execution`); without one, the Tenant runs its own in-process
 * `MemoryExecution`. No lock file: several processes may open a Tenant, and ownership of each
 * session (§10.6) keeps its advances apart.
 */
import type { ServerResponse, IncomingMessage } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
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
} from "../store/sqlite.js";
import type { SessionStore } from "../store/types.js";
import { createKekFile, readVaultKek } from "../vault/kek.js";
import { VaultService, type AuthorizeResult } from "../vault/service.js";
import { McpPool } from "../mcp/pool.js";
import { SandboxManager } from "../sandbox/manager.js";
import { defaultSandboxBackends } from "../sandbox/select.js";
import { MemoryExecution } from "../execution/memory.js";
import { QuarantineError } from "./quarantine-error.js";
import { MemoryStreams } from "../streams/memory.js";
import type { DurableStreams } from "../streams/types.js";
import type { TenantConfig, TenantHandle, TenantSummary } from "./types.js";
import type { TenantContext } from "./context.js";
import {
  connectedExecutorCount,
  createLiveHub,
  endAllStreams,
} from "./live.js";
import {
  closeStreams,
  drainOutbox,
  streamsStatus,
  wireStreams,
  type StreamsStatus,
  type StreamsWiring,
} from "./streams.js";
import {
  abortAll,
  abortLocal,
  createWorkState,
  drain,
  waitForIdle,
} from "./scheduler.js";
import { advance } from "./advance.js";
import { sweep } from "./sweep.js";
import {
  TenantWorkers,
  WORKER_ID,
  type TenantExecution,
  type TenantWorker,
} from "./worker.js";
import { authorize } from "./effects.js";
import { handle } from "./routes.js";

/** TENANTS-CCR: test/injection hooks until TenantConfig gains them. */
export type TenantOpenHooks = {
  modelProvider?: ModelProvider;
  vaultKek?: Buffer | string | null;
  /** When true, create the KEK file on first vault write (tests / new Tenants). */
  createKekIfMissing?: boolean;
  /**
   * The Host's Durable Session Execution and the registry its handlers dispatch through.
   * The Host starts it; the Tenant registers its worker and arms its sweep. Without one,
   * the Tenant starts and stops its own in-process `MemoryExecution`.
   */
  execution?: TenantExecution;
  /** The Worker id written as session owner. Defaults to this process's `WORKER_ID`. */
  workerId?: string;
  /**
   * Durable Streams for this Tenant, owned by the caller (the Host's S2 streams). Without
   * them the Tenant creates its own in-process `MemoryStreams`: the SQLite profile until
   * Wave 4, whose history does not survive a restart.
   */
  streams?: DurableStreams;
  /**
   * The Tenant's opened Session Store (its Postgres schema, `store-pg.ts`). The Tenant owns
   * it from here on and closes it on close or on a failed open. Without one, the Tenant
   * opens SQLite at `paths.database`.
   */
  store?: SessionStore;
  /** The Tenant envelope as its store reports it. Without one, read from `paths.envelope`. */
  envelope?: TenantEnvelope;
};

/** Default ownership lease of an advance; the heartbeat renews it every third. */
const DEFAULT_OWNER_LEASE_MS = 30_000;

function validateConfig(config: TenantConfig): FlowLimits {
  for (const key of ["leaseMs", "ownerLeaseMs", "sweepIntervalMs"] as const) {
    const value = config[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0))
      throw new Error(`${key} must be finite and positive`);
  }
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

export class TenantRuntime implements TenantHandle {
  private constructor(
    private readonly ctx: TenantContext,
    readonly envelope: TenantEnvelope,
    /** This Tenant's Worker handlers, as registered with the execution. */
    readonly worker: TenantWorker,
    private readonly detach: () => Promise<void>
  ) {}

  static async open(
    config: TenantConfig,
    hooks: TenantOpenHooks = {}
  ): Promise<TenantRuntime> {
    const envelope = hooks.envelope ?? readEnvelope(config);
    const flowLimits = validateConfig(config);

    const paths = config.paths;
    mkdirSync(paths.root, { recursive: true });
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.tmp, { recursive: true });
    mkdirSync(paths.sandboxes, { recursive: true });
    mkdirSync(paths.pluginData, { recursive: true });
    mkdirSync(paths.logs, { recursive: true });
    if (!hooks.store) mkdirSync(dirname(paths.database), { recursive: true });

    let store: SessionStore | undefined = hooks.store;
    let wired: StreamsWiring | undefined;
    let detach: (() => Promise<void>) | undefined;
    try {
      store ??= createSqliteSessionStore({
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
      const local = hooks.execution
        ? undefined
        : new MemoryExecution({
            sweepIntervalMs:
              config.sweepIntervalMs ?? Math.min(config.leaseMs ?? 30_000, 5000),
            onError: (error) =>
              config.logger.error("tenant execution failed", {
                message: error instanceof Error ? error.message : String(error),
              }),
          });
      const { execution, workers } = hooks.execution ?? {
        execution: local!,
        workers: new TenantWorkers(),
      };
      const sweepHooks = new Set<() => Promise<void>>();
      ctx = {
        config,
        envelope,
        store: opened,
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
        workerId: hooks.workerId ?? WORKER_ID,
        ownerLeaseMs: config.ownerLeaseMs ?? DEFAULT_OWNER_LEASE_MS,
        wake: async (sessionId, wake) => {
          if (ctx.closing || ctx.closed) return;
          await execution.wake(config.tenantId, sessionId, wake);
        },
        abortLocal: (sessionId) => abortLocal(ctx, sessionId),
        ...(hooks.execution?.stuckInvocations
          ? {
              stuckInvocations: () =>
                hooks.execution!.stuckInvocations!(config.tenantId),
            }
          : {}),
        sweepHooks,
        onSweep: (hook) => {
          sweepHooks.add(hook);
          return () => sweepHooks.delete(hook);
        },
      };
      wired = await wireStreams(ctx, {
        store: opened,
        streams: hooks.streams ?? new MemoryStreams(),
        ownsStreams: !hooks.streams,
        tenantId: config.tenantId,
      });
      // Outbox rows a lost relay step left behind are appended by the sweep.
      sweepHooks.add(async () => {
        await drainOutbox(ctx);
      });

      // Register the handlers, then arm the sweep: its first pass runs at once and re-wakes
      // sessions a previous process left runnable or running (takeover handles the rest).
      let afterOpen = true;
      const worker: TenantWorker = {
        advance: (sessionId, signal) => advance(ctx, sessionId, signal),
        sweep: async () => {
          const first = afterOpen;
          afterOpen = false;
          await sweep(ctx, { afterOpen: first });
        },
      };
      const unregister = workers.register(config.tenantId, worker);
      detach = async () => {
        unregister();
        await local?.stop();
      };
      if (local) await local.start(workers.handlers);
      await execution.armSweep(config.tenantId);
      return new TenantRuntime(ctx, envelope, worker, detach);
    } catch (error) {
      await detach?.().catch(() => undefined);
      await wired?.close().catch(() => undefined);
      await store?.close().catch(() => undefined);
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
    const { counts, outbox } = await store.tx(async (t) => ({
      counts: await t.counts(),
      outbox: await t.outboxStats(),
    }));
    return {
      ready: !this.ctx.closing && !this.ctx.closed,
      runningSessions: counts.runningSessions,
      connectedExecutors: connectedExecutorCount(live),
      pendingActions: counts.pendingActions,
      uncertainEffects: counts.uncertainEffects,
      outboxDepth: outbox.depth,
      relayLagMs:
        outbox.oldestCreatedAt === null
          ? 0
          : Math.max(0, Date.now() - Date.parse(outbox.oldestCreatedAt)),
    };
  }

  drain(activeWork: "drain" | "cancel", timeoutMs = 30_000): Promise<void> {
    return drain(this.ctx, activeWork, timeoutMs);
  }

  /**
   * Aborts the advance of `sessionId` if it runs on this process. Cancel calls it after
   * committing `cancelled`; the control stream calls it for cancels made elsewhere.
   */
  abortLocal(sessionId: string): void {
    this.ctx.abortLocal(sessionId);
  }

  /**
   * The Durable Streams seam's status for Tenant status and readiness: S2 reachability, the
   * basin, outbox depth and relay lag (`streamsStatus` in `tenant/streams.ts`).
   */
  streamsStatus(): Promise<StreamsStatus> {
    return streamsStatus(this.ctx);
  }

  /** Adds a callback to the Tenant sweep. Returns a function that removes it. */
  onSweep(hook: () => Promise<void>): () => void {
    return this.ctx.onSweep(hook);
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    ctx.closing = true;
    abortAll(ctx);
    await this.detach();
    await ctx.mcp.close();
    endAllStreams(ctx.live);
    await waitForIdle(ctx);
    await ctx.sandbox.close();
    ctx.closed = true;
    await closeStreams(ctx);
    await ctx.store.close();
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
