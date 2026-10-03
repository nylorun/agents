/**
 * The Tenant's own harness (D37): `@nylorun/harness/api` in this process, attached to the
 * Tenant's Harness API server over a memory channel, with the Tenant's model gate, MCP pool
 * and SandboxManager as its executors. `json` sends every frame through JSON and validates it,
 * as a socket will (tests).
 *
 * `startLoopbackHarness` (tests, `harness: "ws"`) runs a harness service in this process instead:
 * over a WebSocket to a Harness API listener on 127.0.0.1, with its own MCP pool and
 * SandboxManager and no store, as `--service harness` runs one.
 */
import { randomBytes } from "node:crypto";
import { memoryChannels, type MemoryPortsOptions } from "@nylorun/core/harness-api";
import { createHarness } from "@nylorun/harness/api";
import type { ModelRoute } from "../harness/calls.js";
import { harnessExecutors } from "../harness/executors.js";
import { startHarnessService } from "../harness/service.js";
import type { McpPool } from "../mcp/pool.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { SandboxBackend } from "../sandbox/types.js";
import type { TenantContext } from "../tenant/context.js";
import { authorize } from "../tenant/effects.js";
import { startHarnessListener } from "./ws-server.js";

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
  tools: { mcp: McpPool; sandbox: SandboxManager },
  options: MemoryPortsOptions = {}
): Promise<InProcessHarness> {
  const channels = memoryChannels(options);
  const detach = ctx.harness.attach(channels.core, { name: "in-process" });
  const harness = createHarness({
    channel: channels.harness,
    executors: harnessExecutors({
      model: modelRouteOf(ctx),
      toolGate: ctx.toolGate,
      mcp: tools.mcp,
      sandbox: () => tools.sandbox,
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

/**
 * A harness service over a loopback WebSocket (tests): what `--service harness` runs, in this
 * process. Its workspaces live under the Tenant's `sandboxes` directory. Remote MCP servers go
 * through the Tenant's Tool Gate when it opens them, else they are authorized in this process.
 */
export async function startLoopbackHarness(
  ctx: TenantContext,
  options: { sandboxBackends?: readonly SandboxBackend[] } = {}
): Promise<InProcessHarness> {
  const token = randomBytes(32).toString("hex");
  const listener = await startHarnessListener({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [],
    token,
    attach: async () => (ctx.closed ? undefined : (channel, peer) => ctx.harness.attach(channel, peer)),
    logger: ctx.config.logger,
  });
  const route = modelRouteOf(ctx);
  const service = startHarnessService({
    url: listener.url,
    token,
    paths: { sandboxes: ctx.config.paths.sandboxes, pluginData: ctx.config.paths.pluginData },
    childEnv: ctx.config.childEnv,
    modelGate: route.modelGate,
    modelProvider: route.modelProvider,
    useVaultModel: route.useVaultModel,
    toolGate: ctx.toolGate,
    ...(ctx.toolGate.openMcp
      ? {}
      : { authorize: (sessionId: string, request: { url: string; serverName: string }) => authorize(ctx, sessionId, request) }),
    ...(options.sandboxBackends ? { sandboxBackends: options.sandboxBackends } : {}),
    logger: quietLogger(ctx),
    name: "loopback",
    ephemeral: ctx.config.mode === "ephemeral",
    backoff: { minMs: 50, maxMs: 500 },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      service.client.ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The loopback harness did not connect")), 10_000);
      }),
    ]);
  } catch (error) {
    await service.stop(0);
    await listener.close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    async stop(waitMs) {
      await service.stop(waitMs);
      await listener.close();
    },
  };
}

/** The Tenant's logger, which never throws: a harness may log after the Tenant's log is gone. */
function quietLogger(ctx: TenantContext) {
  const quiet =
    (level: "info" | "warn") =>
    (message: string, fields?: Record<string, unknown>) => {
      try {
        ctx.config.logger[level](message, fields);
      } catch {
        /* nowhere to log */
      }
    };
  return { info: quiet("info"), warn: quiet("warn") };
}
