/**
 * The engine host of a segment run in this process without the Harness API
 * (`NYLORUN_HARNESS_API=0`, until F6.2 removes it): the same journal (`harness-api/record.ts`)
 * and the same calls (`harness/calls.ts`) as a harness, without the channel between them.
 */
import { HarnessApiError, effectRequestHash, type EffectIntent } from "@nylorun/core/harness-api";
import type { EffectResolution, HostEffect } from "@nylorun/harness/run";
import type { ModelProvider } from "../core/provider.js";
import { modelRouteOf } from "../harness-api/in-process.js";
import { recordIntent, recordOutcome } from "../harness-api/record.js";
import {
  abortOn,
  callMcpTool,
  callSandboxTool,
  invokeModel,
  isRemoteMcpCall,
  isSaveArtifactCall,
  type ToolRouting,
} from "../harness/calls.js";
import { manifestFor, mcpToolOf } from "../mcp/snapshot.js";
import { callSaveArtifact } from "./artifact-tool.js";
import { sandboxWorkspaceOf } from "../sandbox/share.js";
import { isOwnershipLost } from "../store/ownership.js";
import { sandboxLookup, sessionOf, type Lease, type TenantContext } from "./context.js";
import { recoversMcpCalls, recoversModelCalls } from "./effects.js";
import { abortKind } from "./worker.js";

/** What one advance's segment decides for all its effects. */
export interface SegmentOptions {
  /** Overrides the Tenant's model (the fixture-model Tenant setting, `model-setting.ts`). */
  model?: ModelProvider;
}

export async function resolveEffect(
  ctx: TenantContext,
  request: HostEffect,
  signal: AbortSignal,
  lease: Lease,
  segment: SegmentOptions = {}
): Promise<EffectResolution> {
  const scope = { ctx, lease, signal };
  const intent: EffectIntent =
    request.kind === "model" ? (({ input: _, ...rest }) => rest)(request) : request;
  const answer = await recordIntent(scope, intent, effectRequestHash(request));
  if (answer.status !== "execute") return answer;
  const model = request.kind === "model";
  let remote = false;
  try {
    // The intent is committed; the call itself runs outside any transaction.
    let value: unknown;
    if (model) value = await invokeModel(modelRouteOf(ctx), request, signal, segment.model);
    else {
      const routing = await routingOf(ctx, request.sessionId);
      if (mcpToolOf(routing.mcpSnapshot, request)) {
        remote = isRemoteMcpCall(routing, request);
        value = await callMcpTool(
          ctx.mcp,
          routing,
          request,
          abortOn(signal, remote && recoversMcpCalls(ctx) ? ["cancel", "shutdown"] : ["cancel"])
        );
      } else if (isSaveArtifactCall(manifestFor(routing.rootManifest, request.agent), request))
        value = await callSaveArtifact(ctx, request, signal);
      else value = await callSandboxTool(ctx.sandbox, routing, request, signal);
    }
    return await recordOutcome(scope, request.effectId, { value });
  } catch (error) {
    // A lost epoch writes nothing: the new owner decides what the effect became.
    if (isOwnershipLost(error) || (error instanceof HarnessApiError && error.code === "ownership_lost"))
      throw error;
    // A shutdown leaves a model call running at the gate, still `invoking`: the next advance
    // re-sends it (P1.2). The segment stops for the shutdown as usual.
    if (model && recoversModelCalls(ctx) && abortKind(signal) === "shutdown") throw error;
    // The same for a remote MCP call at the Tool Gate (G3). A user cancel stops it there: a
    // keyed call outlives the request that sent it.
    if (remote && recoversMcpCalls(ctx)) {
      if (abortKind(signal) === "shutdown") throw error;
      if (abortKind(signal) === "cancel" && ctx.toolGate.cancel)
        await ctx.toolGate.cancel({
          tenantId: ctx.config.tenantId,
          sessionId: request.sessionId,
          effectId: request.effectId,
        });
    }
    return recordOutcome(scope, request.effectId, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The session's tool routing, read from its row. */
async function routingOf(ctx: TenantContext, sessionId: string): Promise<ToolRouting> {
  return ctx.store.tx(async (t) => {
    const s = await sessionOf(t, sessionId);
    const workspace = sandboxWorkspaceOf(s, await sandboxLookup(t, s.id));
    return {
      rootManifest: s.manifest,
      pluginRoots: s.pluginRoots ?? {},
      ...(s.mcpSnapshot ? { mcpSnapshot: s.mcpSnapshot } : {}),
      sandboxOwnerId: workspace.ownerId,
      ...(workspace.sandboxId === undefined ? {} : { sandboxId: workspace.sandboxId }),
      activeTurnId: s.activeTurnId,
    };
  });
}
