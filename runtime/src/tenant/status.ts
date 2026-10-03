import type {
  HarnessStatus,
  SeedTenantConfigRequest,
  SeedTenantConfigResponse,
  TenantStatus,
} from "@nylorun/core/contracts";
import type { SessionStore } from "../store/types.js";
import type { VaultService } from "../vault/service.js";
import type { WorkspacePort } from "../harness-api/workspace.js";
import type { TenantConfig } from "./types.js";
import type { TenantContext } from "./context.js";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import type { StuckInvocation } from "../execution/types.js";
import type { StreamsStatus } from "./streams.js";
import { FIXTURE_MODEL_SETTING, seedFixtureModel } from "./model-setting.js";
import { SANDBOX_CONFIG_SETTING, writeSandboxConfig } from "../sandbox/tenant-config.js";
import type { Keys } from "../keys/keys.js";

export interface TenantStatusContext {
  envelope: TenantEnvelope;
  config: TenantConfig;
  store: SessionStore;
  vault: VaultService;
  sandbox: Pick<WorkspacePort, "report">;
  closing: boolean;
  modelConfigured: boolean;
  /**
   * This Tenant's execution invocations that need an operator (`TenantExecution`). Absent
   * when the execution cannot report them.
   */
  stuckInvocations?: () => Promise<StuckInvocation[]>;
  /** This Tenant's Durable Streams status (`streamsStatus` in `streams.ts`). */
  streamsStatus?: () => Promise<StreamsStatus>;
  /** The Tenant's harnesses (F6.2). */
  harness?: HarnessStatus;
}

/** The Tenant's harnesses, for its status and the Host's. */
export function harnessStatusOf(ctx: Pick<TenantContext, "mcp" | "harness">): HarnessStatus {
  return { mode: ctx.mcp ? "in-process" : "remote", ...ctx.harness.status() };
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
  const endpointIds = new Set(
    (await ctx.store.tx((t) => t.listEndpoints())).map((e) => e.agentId),
  );
  const agentIds = new Set([...definitionIds, ...endpointIds]);
  const agents = [...agentIds].sort().map((agentId) => ({
    agentId,
    registered: definitionIds.has(agentId),
    endpoint: endpointIds.has(agentId),
  }));

  return {
    tenant: ctx.envelope,
    path: ctx.config.paths.root,
    checks: {
      store: health.schemaVersion > 0,
      scheduler: !ctx.closing,
      model: ctx.modelConfigured || modelView.configured,
      endpoints: true,
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
    ...(ctx.harness ? { harness: ctx.harness } : {}),
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
    /** Seals the seeded model credential (F4.2). */
    keys: Pick<Keys, "putHostModel">;
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

  const sandboxConfig = body.sandbox?.config;
  if (sandboxConfig) {
    const inserted = await ctx.store.tx(async (t) => {
      if ((await t.getSetting(SANDBOX_CONFIG_SETTING)) !== undefined) return false;
      await writeSandboxConfig(t, sandboxConfig);
      return true;
    });
    (inserted ? applied : kept).push(SANDBOX_CONFIG_SETTING);
  }

  if (body.fixtureModel) {
    const inserted = await ctx.store.tx((t) => seedFixtureModel(t));
    (inserted ? applied : kept).push(FIXTURE_MODEL_SETTING);
  }

  if (body.model) {
    const current = await ctx.vault.getHostModel();
    if (current.configured) {
      kept.push("model");
    } else {
      await ctx.keys.putHostModel({
        requestId: body.requestId,
        idempotencyKey: `seed-model:${body.requestId}`,
        ...body.model,
      });
      applied.push("model");
    }
  }

  return { applied, kept };
}
