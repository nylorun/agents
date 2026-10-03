/**
 * The Tenant's own harness (D37): `@nylorun/harness/api` in this process, attached to the
 * Tenant's Harness API server over a memory channel, with the Tenant's model gate, MCP pool
 * and SandboxManager as its executors. `json` sends every frame through JSON and validates it,
 * as a socket will (tests).
 */
import { memoryChannels, type MemoryPortsOptions } from "@nylorun/core/harness-api";
import { createHarness } from "@nylorun/harness/api";
import type { ModelRoute } from "../harness/calls.js";
import { inProcessExecutors } from "../harness/executors.js";
import type { TenantContext } from "../tenant/context.js";

/** Where the Tenant's model calls go. */
export function modelRouteOf(ctx: TenantContext): ModelRoute {
  return {
    tenantId: ctx.config.tenantId,
    modelGate: ctx.modelGate,
    modelProvider: ctx.modelProvider,
    useVaultModel: ctx.useVaultModel,
  };
}

export interface InProcessHarness {
  /** Aborts its runs with `shutdown`, waits for them at most `waitMs`, and detaches. */
  stop(waitMs?: number): Promise<void>;
}

export async function startInProcessHarness(
  ctx: TenantContext,
  options: MemoryPortsOptions = {}
): Promise<InProcessHarness> {
  const channels = memoryChannels(options);
  const detach = ctx.harness.attach(channels.core, { name: "in-process" });
  const harness = createHarness({
    channel: channels.harness,
    executors: inProcessExecutors({
      ...modelRouteOf(ctx),
      toolGate: ctx.toolGate,
      mcp: ctx.mcp,
      sandbox: ctx.sandbox,
    }),
    logger: ctx.config.logger,
    name: "in-process",
  });
  await harness.start();
  return {
    async stop(waitMs) {
      await harness.stop(waitMs);
      channels.harness.close("stopped");
      detach();
    },
  };
}
