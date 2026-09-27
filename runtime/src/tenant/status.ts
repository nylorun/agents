import type {
  SeedTenantConfigRequest,
  SeedTenantConfigResponse,
  TenantStatus,
} from "@nylorun/core/contracts";
import type { SessionStore } from "../store/types.js";
import type { ExecutorRegistry } from "../core/executors.js";
import type { VaultService } from "../vault/service.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { TenantConfig } from "./types.js";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import type { StuckInvocation } from "../execution/types.js";
import type { StreamsStatus } from "./streams.js";

export interface TenantStatusContext {
  envelope: TenantEnvelope;
  config: TenantConfig;
  store: SessionStore;
  registry: ExecutorRegistry;
  vault: VaultService;
  sandbox: SandboxManager;
  closing: boolean;
  modelConfigured: boolean;
  executorStreams: Map<string, Set<unknown>>;
  /**
   * This Tenant's execution invocations that need an operator (`TenantExecution`). Absent
   * when the execution cannot report them.
   */
  stuckInvocations?: () => Promise<StuckInvocation[]>;
  /** This Tenant's Durable Streams status (`streamsStatus` in `streams.ts`). */
  streamsStatus?: () => Promise<StreamsStatus>;
}

/** How long status waits for the execution to list stuck invocations. */
const STUCK_TIMEOUT_MS = 5000;

/** `TenantStatus.execution`: paused and backing-off invocations, or why they are unknown. */
async function executionStatus(
  stuckInvocations: () => Promise<StuckInvocation[]>,
): Promise<NonNullable<TenantStatus["execution"]>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const stuck = await Promise.race([
      stuckInvocations(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out listing stuck invocations")),
          STUCK_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      stuckInvocations: stuck.map((invocation) => ({
        id: invocation.id,
        status: invocation.status,
        service: invocation.service,
        handler: invocation.handler,
        key: invocation.key,
        retryCount: invocation.retryCount,
        ...(invocation.lastFailure !== undefined
          ? { lastFailure: invocation.lastFailure }
          : {}),
        ...(invocation.modifiedAt !== undefined
          ? { modifiedAt: invocation.modifiedAt }
          : {}),
      })),
    };
  } catch (error) {
    return {
      stuckInvocations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Build `TenantStatusSchema` with secrets redacted (A14). */
export async function buildTenantStatus(
  ctx: TenantStatusContext,
): Promise<TenantStatus> {
  const health = await ctx.store.health();
  const { counts, definitions } = await ctx.store.tx(async (t) => ({
    counts: await t.counts(),
    definitions: await t.listDefinitions(),
  }));
  const [modelView, sandboxReport, execution, streams] = await Promise.all([
    ctx.vault.getHostModel(),
    ctx.sandbox.report(),
    ctx.stuckInvocations ? executionStatus(ctx.stuckInvocations) : undefined,
    ctx.streamsStatus?.(),
  ]);

  const definitionIds = new Set(
    definitions
      .map((d) => (d.manifest as { id?: unknown } | undefined)?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const executorIds = new Set(ctx.registry.list().map((e) => e.agentId));
  const agentIds = new Set([...definitionIds, ...executorIds]);
  const agents = [...agentIds].sort().map((agentId) => {
    const record = ctx.registry.get(agentId);
    return {
      agentId,
      registered: definitionIds.has(agentId),
      connected:
        !!record &&
        (ctx.executorStreams.get(record.tokenHash)?.size ?? 0) > 0,
    };
  });

  return {
    tenant: ctx.envelope,
    path: ctx.config.paths.root,
    checks: {
      store: health.schemaVersion > 0,
      scheduler: !ctx.closing,
      model: ctx.modelConfigured || modelView.configured,
      executors: true,
      schema: health.ok,
    },
    model: modelView,
    agents,
    counts: {
      sessions: counts.sessions,
      runningSessions: counts.runningSessions,
      pendingActions: counts.pendingActions,
      uncertainEffects: counts.uncertainEffects,
    },
    sandbox: {
      backend: sandboxReport.backend,
      retained: counts.sandboxes,
    },
    ...(execution ? { execution } : {}),
    ...(streams ? { streams } : {}),
  };
}

/**
 * Insert-if-absent Tenant configuration seed (A18).
 * Response lists field names only; never secret values.
 */
export async function seedTenantConfig(
  ctx: {
    store: SessionStore;
    vault: VaultService;
  },
  body: SeedTenantConfigRequest,
): Promise<SeedTenantConfigResponse> {
  const applied: string[] = [];
  const kept: string[] = [];

  const backend = body.sandbox?.backend;
  if (backend) {
    const inserted = await ctx.store.tx(async (t) => {
      if ((await t.getSetting("sandbox.backend")) !== undefined) return false;
      await t.putSetting("sandbox.backend", backend);
      return true;
    });
    (inserted ? applied : kept).push("sandbox.backend");
  }

  if (body.model) {
    const current = await ctx.vault.getHostModel();
    if (current.configured) {
      kept.push("model");
    } else {
      await ctx.vault.putHostModel({
        requestId: body.requestId,
        idempotencyKey: `seed-model:${body.requestId}`,
        ...body.model,
      });
      applied.push("model");
    }
  }

  return { applied, kept };
}
