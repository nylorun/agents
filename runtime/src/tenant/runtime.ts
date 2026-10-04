/**
 * Composition root of an open Tenant: validates the config, opens the Session Store and the
 * vault key, builds the services and the `TenantContext`, wires the seams, registers the
 * Tenant's Worker handlers and arms its sweep, and implements `TenantHandle` (handle,
 * summary, drain, close) by delegating to the Tenant modules.
 *
 * Seams wired here: `wireStreams()` connects the store's commits to Durable Streams (the
 * relay, and the history, SSE, work and control readers); `wake` goes to the
 * `DurableExecution`, whose handlers (`worker.ts`) call `advance` and `sweep`; `abortLocal`
 * aborts an advance running on this process.
 *
 * Execution: the Host passes its `TenantExecution` (`TenantOpenHooks.execution`); without
 * one, the Tenant runs its own in-process `MemoryExecution`. No lock file: several processes may open a Tenant, and ownership of each
 * session (§10.6) keeps its advances apart.
 */
import type { ServerResponse, IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import { resolveFlowLimits, type FlowLimits } from "../core/limits.js";
import {
  scriptedModel,
  toolFixtureModel,
  type ModelProvider,
} from "../core/provider.js";
import type { ModelGate } from "../gates/model-gate.js";
import { tenantModelGate } from "../gates/in-process.js";
import type { SessionStore } from "../store/types.js";
import { createKekFile, readVaultKek } from "../vault/kek.js";
import { SigningKeys } from "./signing-keys.js";
import { VaultService, type AuthorizeResult } from "../vault/service.js";
import { McpPool } from "../mcp/pool.js";
import { SandboxManager } from "../sandbox/manager.js";
import { storeSandboxRecords } from "../sandbox/records.js";
import { defaultSandboxBackends } from "../sandbox/select.js";
import { MemoryExecution } from "../execution/memory.js";
import { openError } from "./cause.js";
import { MemoryStreams } from "../streams/memory.js";
import type { DurableStreams } from "../streams/types.js";
import type {
  NodeBindings,
  OpenedTenant,
  TenantConfig,
  TenantHandle,
  TenantSummary,
} from "./types.js";
import type { TenantContext } from "./context.js";
import {
  createSessionStreams,
  endAllStreams,
} from "./session-streams.js";
import {
  closeStreams,
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
import { deliverAction } from "./delivery.js";
import {
  TenantWorkers,
  WORKER_ID,
  type TenantExecution,
  type TenantWorker,
} from "./worker.js";
import { authorize } from "./effects.js";
import { inProcessToolGate, type ToolGate } from "../gates/tool-gate.js";
import { inProcessKeys, type Keys } from "../keys/keys.js";
import type { RunGrants } from "./run-grants.js";
import { tenantApi } from "../api/http/app.js";
import { createFsBlobStore, type BlobStore } from "../blob/index.js";
import type { HarnessChannel, MemoryPortsOptions } from "@nylorun/core/harness-api";
import {
  createHarnessApiServer,
  type HarnessApiServer,
  type HarnessPeer,
} from "../harness-api/server.js";
import { harnessStatusOf } from "./status.js";
import {
  startInProcessHarness,
  startLoopbackHarness,
  type InProcessHarness,
} from "../harness-api/in-process.js";
import {
  localWorkspace,
  remoteWorkspace,
  withPodWorkspaces,
  type WorkspacePort,
} from "../harness-api/workspace.js";
import { hostAuthority, type HostAuthority } from "../sandbox/join.js";
import { reconcileSandbox } from "../sandbox/pods/reconcile.js";
import type { TenantPods } from "./context.js";
import { sandboxWorkspaceReader } from "../artifacts/workspace.js";
import { operatorKeys, type OperatorKeys } from "./operator-keys.js";

/** TENANTS-CCR: test/injection hooks until TenantConfig gains them. */
export type TenantOpenHooks = {
  modelProvider?: ModelProvider;
  /**
   * Serves the Tenant's vault-backed model calls (the gates service's client). Without one,
   * the Tenant calls the model in this process.
   */
  modelGate?: ModelGate;
  /**
   * Serves the Tenant's remote MCP servers and Action deliveries (the gates service's client).
   * Without one, the Tenant opens them and POSTs deliveries in this process.
   */
  toolGate?: ToolGate;
  /**
   * Runs vault writes and token signing (the `keys` service's client, F4.2). With one, this
   * process never reads, creates or holds the vault key. Without one, it does them here.
   */
  keys?: Keys;
  /**
   * The run grants the gates service's clients read (F5): each advance mints its session's
   * run token into them. Give the same object to `modelGate` and `toolGate`.
   */
  runGrants?: RunGrants;
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
   * them the Tenant creates its own in-process `MemoryStreams`, whose history does not
   * survive a restart (tests, and a Host without S2).
   */
  streams?: DurableStreams;
  /**
   * The Host's stream relay feeds `streams` from the record. Without it the
   * Tenant relays its own commits.
   */
  hostRelay?: boolean;
  /** How long a retired stream basin is kept after a reset (tests). Default 60 s. */
  retireGraceMs?: number;
  /**
   * The Object store, owned by the caller (the Host's `s3` BlobStore, D35). Without one the
   * Tenant keeps blobs on disk under `paths.blobs` (the `fs` adapter: embedding, tests).
   */
  blobs?: BlobStore;
  /**
   * The Tenant's harness (F6.1, F6.2): `memory` (default) runs one in this process over a memory
   * channel, with the Tenant's MCP pool and SandboxManager; `json` the same through JSON with
   * every frame validated (tests). `remote` runs none: harnesses attach with
   * `TenantHandle.attachHarness` (the Harness API listener, `NYLORUN_HARNESS=remote`), and the
   * one that declares `workspace` holds the workspaces; this process has no MCP pool and no
   * SandboxManager. `ws` is `remote` with a harness service in this process over a loopback
   * WebSocket (tests).
   */
  harness?: "memory" | "json" | "ws" | "remote";
  /** Sees each frame of the in-process harness's channel (tests and benchmarks). */
  harnessTap?: MemoryPortsOptions["tap"];
  /**
   * Sandbox pods (F7.2): the sandboxes service (`NYLORUN_SANDBOXES_URL`) and the Runtime image
   * pods copy the engine from. Without it, kind `pod` is `sandbox_unavailable`.
   */
  pods?: TenantPods;
} & OpenedTenant;

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
    private readonly detach: () => Promise<void>,
    /** How long close waits for running advances: the execution's advance grace period. */
    private readonly closeGraceMs: number,
    private readonly harness?: InProcessHarness,
    private readonly hosts?: HostAuthority
  ) {}

  /** The Tenant's side of a sandbox pod's join (F7.2). */
  hostAuthority(): HostAuthority | undefined {
    return this.ctx.closing || this.ctx.closed ? undefined : this.hosts;
  }

  static async open(
    config: TenantConfig,
    hooks: TenantOpenHooks
  ): Promise<TenantRuntime> {
    const envelope = hooks.envelope;
    const flowLimits = validateConfig(config);

    const paths = config.paths;
    mkdirSync(paths.root, { recursive: true });
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.tmp, { recursive: true });
    mkdirSync(paths.sandboxes, { recursive: true });
    mkdirSync(paths.pluginData, { recursive: true });
    mkdirSync(paths.logs, { recursive: true });

    const store: SessionStore = hooks.store;
    let wired: StreamsWiring | undefined;
    let detach: (() => Promise<void>) | undefined;
    let harness: InProcessHarness | undefined;
    try {
      // With the keys service (F4.2) the key lives in the gateway: this process never reads,
      // creates or holds it, and the gateway reports a missing key on its readiness.
      let kek = hooks.keys
        ? undefined
        : readVaultKek({
            vaultKek: hooks.vaultKek,
            vaultKekPath: paths.kek,
          });
      if (!hooks.keys) {
        const sealed = await store.tx(
          async (t) => (await t.countCredentials()) + (await t.countSigningKeys())
        );
        if (sealed > 0 && !kek) {
          throw openError(
            "kek-missing",
            "Vault key-encryption key is missing for ciphertext (vault credentials or signing keys) in this Tenant",
          );
        }
      }
      const createKekIfMissing = hooks.createKekIfMissing !== false;
      const ensureKek = (): Buffer => {
        if (hooks.keys)
          throw new Error(
            "The vault key lives in the gateway's keys service: this process never reads it"
          );
        if (kek) return kek;
        if (!createKekIfMissing)
          throw openError("kek-missing", "Vault key-encryption key is required");
        kek = createKekFile(paths.kek);
        return kek;
      };
      const opened = store;
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
      const toolGate = hooks.toolGate ?? inProcessToolGate(config.delivery ?? {});
      const signingKeys = new SigningKeys({ tenantId: config.tenantId, kek: ensureKek });
      const keys =
        hooks.keys ?? inProcessKeys({ store: opened, vault, signingKeys, kek: ensureKek });
      const harnessMode = hooks.harness ?? "memory";
      const inProcess = harnessMode === "memory" || harnessMode === "json";
      const preference = seededBackend ?? config.sandbox.backend;
      // With a harness in this process, the Tenant's MCP pool and SandboxManager are its
      // executors; otherwise the harness holds both (F6.2).
      const mcp = inProcess
        ? new McpPool({
            pluginData: paths.pluginData,
            childEnv: config.childEnv,
            authorize: (sessionId, request) => authorize(ctx, sessionId, request),
            ...(toolGate.openMcp ? { openRemote: (server) => toolGate.openMcp!(server) } : {}),
          })
        : undefined;
      const ephemeral = config.mode === "ephemeral";
      const manager = inProcess
        ? new SandboxManager({
            scope: config.tenantId,
            records: storeSandboxRecords(opened),
            backends:
              config.sandbox.backends ??
              defaultSandboxBackends({ root: paths.sandboxes }),
            preference,
            ephemeral,
            emit: async (sessionId, turnId, type, payload) => {
              if (ctx.closed) return;
              try {
                await opened.tx((t) => t.event(sessionId, turnId, type, payload));
              } catch {
                /* the session is gone (reset) or the store closed */
              }
            },
          })
        : undefined;
      let harnessServer!: HarnessApiServer;
      const workspaces: WorkspacePort = manager
        ? localWorkspace(manager)
        : remoteWorkspace({
            get server() {
              return harnessServer;
            },
            store: opened,
            logger: config.logger,
            preference,
          });
      // A pod sandbox's workspace is in its pod, served by its engine (F7.2).
      const sandbox: WorkspacePort = hooks.pods
        ? withPodWorkspaces(workspaces, {
            get server() {
              return harnessServer;
            },
            store: opened,
            logger: config.logger,
            preference,
            isPod: async (sandboxId) =>
              (await opened.tx((t) => t.sandboxResource(sandboxId)))?.kind === "pod",
          })
        : workspaces;

      const useVaultModel = config.model.kind === "vault";
      let modelProvider: ModelProvider;
      if (hooks.modelProvider) modelProvider = hooks.modelProvider;
      else if (config.model.kind === "scripted")
        modelProvider = scriptedModel(config.model.output);
      else if (config.model.kind === "fixture")
        modelProvider = toolFixtureModel();
      else modelProvider = scriptedModel();
      const blobs = hooks.blobs ?? createFsBlobStore({ root: paths.blobs });
      // With the gates service the loop never reads a model credential: only a Runtime
      // without one (embedding, the ephemeral Runtime, tests) reads it here.
      const modelGate =
        hooks.modelGate ??
        tenantModelGate({
          store: opened,
          kek: ensureKek,
          root: paths.home,
          logger: config.logger,
          blobs,
          ...(config.modelCall ? { settings: config.modelCall } : {}),
        });

      const sessionStreams = createSessionStreams();
      const workers = hooks.execution?.workers ?? new TenantWorkers();
      const local = hooks.execution
        ? undefined
        : new MemoryExecution({
            sweepIntervalMs:
              config.sweepIntervalMs ?? Math.min(config.leaseMs ?? 30_000, 5000),
            // Close's `detach` step waits no longer for running work than for its advances.
            stopGraceMs: workers.graceMs,
            onError: (error) =>
              config.logger.error("tenant execution failed", {
                message: error instanceof Error ? error.message : String(error),
              }),
          });
      const execution = hooks.execution?.execution ?? local!;
      const sweepHooks = new Set<() => Promise<void>>();
      ctx = {
        config,
        envelope,
        store: opened,
        vault,
        ...(mcp ? { mcp } : {}),
        sandbox,
        flowLimits,
        modelProvider,
        useVaultModel,
        modelGate,
        toolGate,
        get harness() {
          return harnessServer;
        },
        closing: false,
        closed: false,
        work: createWorkState(),
        sessionStreams,
        signingKeys,
        keys,
        blobs,
        workspaces: sandboxWorkspaceReader(sandbox),
        ...(hooks.runGrants ? { runGrants: hooks.runGrants } : {}),
        workerId: hooks.workerId ?? WORKER_ID,
        ownerLeaseMs: config.ownerLeaseMs ?? DEFAULT_OWNER_LEASE_MS,
        wake: async (sessionId, wake) => {
          if (ctx.closing || ctx.closed) return;
          await execution.wake(config.tenantId, sessionId, wake);
        },
        abortLocal: (sessionId, turnId) => abortLocal(ctx, sessionId, "cancel", turnId),
        deliver: async (actionId) => {
          if (ctx.closing || ctx.closed) return;
          await execution.deliver(config.tenantId, actionId);
        },
        ...(hooks.pods ? { pods: hooks.pods } : {}),
        sandboxSignal: async (sandboxId, signal) => {
          if (ctx.closing || ctx.closed || !execution.sandbox) return;
          await execution.sandbox(config.tenantId, sandboxId, signal);
        },
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
      harnessServer = createHarnessApiServer(ctx, { sandboxPreference: preference });
      if (mcp && manager)
        harness = await startInProcessHarness(
          ctx,
          { mcp, sandbox: manager },
          {
            json: harnessMode === "json",
            ...(hooks.harnessTap ? { tap: hooks.harnessTap } : {}),
          }
        );
      else if (harnessMode === "ws")
        harness = await startLoopbackHarness(ctx, {
          ...(config.sandbox.backends ? { sandboxBackends: config.sandbox.backends } : {}),
        });
      wired = await wireStreams(ctx, {
        store: opened,
        streams: hooks.streams ?? new MemoryStreams(),
        ownsStreams: !hooks.streams,
        tenantId: config.tenantId,
        ...(hooks.hostRelay ? { hostRelay: true } : {}),
        ...(hooks.retireGraceMs !== undefined ? { retireGraceMs: hooks.retireGraceMs } : {}),
      });

      // Register the handlers, then arm the sweep: its first pass runs at once and re-wakes
      // sessions a previous process left runnable or running (takeover handles the rest).
      const worker: TenantWorker = {
        advance: (sessionId, signal) => advance(ctx, sessionId, signal),
        deliver: (actionId, signal) => deliverAction(ctx, actionId, signal),
        sweep: () => sweep(ctx),
        sandbox: (sandboxId, trigger) => reconcileSandbox(ctx, sandboxId, trigger),
      };
      const unregister = workers.register(config.tenantId, worker);
      detach = async () => {
        unregister();
        await local?.stop();
      };
      if (local) await local.start(workers.handlers);
      await execution.armSweep(config.tenantId);
      return new TenantRuntime(
        ctx,
        envelope,
        worker,
        detach,
        workers.graceMs,
        harness,
        hooks.pods ? hostAuthority(ctx) : undefined
      );
    } catch (error) {
      await detach?.().catch(() => undefined);
      await harness?.stop().catch(() => undefined);
      await wired?.close().catch(() => undefined);
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  async fetch(request: Request, node: NodeBindings): Promise<Response> {
    return await tenantApi().fetch(request, { ...node, tenant: this.ctx });
  }


  authorize(
    sessionId: string,
    request: { url: string; serverName?: string }
  ): Promise<AuthorizeResult> {
    return authorize(this.ctx, sessionId, request);
  }

  async summary(): Promise<TenantSummary> {
    const { store } = this.ctx;
    const counts = await store.tx((t) => t.counts());
    return {
      ready: !this.ctx.closing && !this.ctx.closed,
      runningSessions: counts.runningSessions,
      inFlightDeliveries: [...this.ctx.work.deliveries.values()].reduce(
        (n, set) => n + set.size,
        0,
      ),
      pendingActions: counts.pendingActions,
      uncertainEffects: counts.uncertainEffects,
      harness: harnessStatusOf(this.ctx),
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
   * basin, its generation and the Tenant's relay (`streamsStatus` in `tenant/streams.ts`).
   */
  streamsStatus(): Promise<StreamsStatus> {
    return streamsStatus(this.ctx);
  }

  /** Adds a callback to the Tenant sweep. Returns a function that removes it. */
  onSweep(hook: () => Promise<void>): () => void {
    return this.ctx.onSweep(hook);
  }

  attachHarness(channel: HarnessChannel, peer: HarnessPeer): () => void {
    return this.ctx.harness.attach(channel, peer);
  }

  /** The Tenant's operator keys (F9 I1), over its store. */
  operatorKeys(): OperatorKeys {
    return operatorKeys(this.ctx.store);
  }



  async close(): Promise<void> {
    const ctx = this.ctx;
    ctx.closing = true;
    // A shutdown abort: the advances leave their sessions to the next advance, unsettled.
    abortAll(ctx, "shutdown");
    const idleBy = Date.now() + this.closeGraceMs;
    // Every step runs even when one before it fails, so nothing is left running; the first
    // error is rethrown at the end.
    const steps: [name: string, run: () => unknown][] = [
      ["detach", () => this.detach()],
      ["mcp", () => ctx.mcp?.close()],
      ["session streams", () => endAllStreams(ctx.sessionStreams)],
      // Bounded: an advance that ignores its abort is abandoned; its lease lapses (§11.4).
      ["idle", () => waitForIdle(ctx, Math.max(0, idleBy - Date.now()))],
      [
        "harness",
        async () => {
          ctx.harness.close();
          // Advances still running were abandoned at "idle": their runs are left behind too.
          await this.harness?.stop(Math.max(0, idleBy - Date.now()));
        },
      ],
      ["sandbox", () => ctx.sandbox.close()],
      [
        "streams",
        () => {
          ctx.closed = true;
          return closeStreams(ctx);
        },
      ],
      ["store", () => ctx.store.close()],
    ];
    let failure: { error: unknown } | undefined;
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        ctx.config.logger.warn("tenant close step failed", {
          step,
          message: error instanceof Error ? error.message : String(error),
        });
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }
}

/**
 * Open a Tenant Runtime from an explicit `TenantConfig`. No listen() (A1).
 * Implements `OpenTenantRuntime`.
 */
export async function openTenantRuntime(
  config: TenantConfig,
  hooks: TenantOpenHooks
): Promise<TenantHandle> {
  return TenantRuntime.open(config, hooks);
}
