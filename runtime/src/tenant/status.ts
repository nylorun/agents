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
  const modelView = await ctx.vault.getHostModel();
  const sandboxReport = await ctx.sandbox.report();

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
      sqlite: health.schemaVersion > 0,
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
