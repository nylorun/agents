/**
 * The Record seam of the Harness API: core's journal for the effects of a run. `recordIntent`
 * journals an effect before anything runs it, and either answers it from the journal, hands it
 * to core's own executors (Actions, flow work, delegation), or tells the harness to `execute`
 * it. `recordOutcome` records what the harness's call returned. Both run under the advance's
 * lease: every write is epoch-checked (`ownedSession`), and a lost epoch writes nothing.
 *
 * Rows store the request's hash (`requestHash`) and, for a model call, the request without its
 * prompt: drift is a hash compare. Rows written before carry their full request, hashed on read.
 */
import {
  HarnessApiError,
  effectRequestHash,
  type EffectIntent,
  type IntentAnswer,
  type OutcomeAnswer,
  type RecordedOutcome,
} from "@nylorun/core/harness-api";
import type { Action, EventPayload } from "@nylorun/core/contracts";
import type { HostEffect } from "@nylorun/harness/run";
import { isFlowEffect, isFlowToolEffect } from "../core/flow-host.js";
import { sandboxCapabilityOf } from "../sandbox/capability.js";
import { isSaveArtifactCall } from "../harness/calls.js";
import { callSaveArtifact } from "../tenant/artifact-tool.js";
import { isOwnershipLost } from "../store/ownership.js";
import { manifestFor, mcpToolOf } from "../mcp/snapshot.js";
import { ownedSession, type Lease, type Session, type TenantContext } from "../tenant/context.js";
import { actionTarget, pinnedTool } from "../tenant/session.js";
import { offerAction } from "../tenant/delivery.js";
import {
  isRemoteMcpEffect,
  linkedOutcome,
  recoversMcpCalls,
  recoversModelCalls,
  resolveNewFlowEffect,
} from "../tenant/effects.js";
import {
  assistantMessage,
  contextCompacted,
  modelFailed,
  toolCompleted,
  toolIds,
} from "../tenant/transcript.js";
import { abortKind } from "../tenant/worker.js";
import type { EffectDoc, Tx } from "../store/types.js";

/** What a run's journal writes are scoped by: the advance's lease and its signal. */
export interface RecordScope {
  readonly ctx: TenantContext;
  readonly lease: Lease;
  readonly signal: AbortSignal;
}

type StoredEffect = EffectDoc & {
  requestHash?: string;
  outcome?: { value: unknown; statePatch?: Record<string, unknown> };
  agentSessionId?: string;
  error?: string;
};

const TURN_CANCELLED = () => new HarnessApiError("turn_cancelled", "Turn cancelled");

/** The hash a journal row's request was recorded with. */
export function hashOf(row: { request: unknown; requestHash?: string }): string {
  return row.requestHash ?? effectRequestHash(row.request as EffectIntent);
}

/** The completed outcomes of a segment, which a run replays without asking. */
export async function bulkOutcomes(
  t: Tx,
  session: Pick<Session, "id">,
  checkpoint: { turnId: string; segment: number }
): Promise<RecordedOutcome[]> {
  const prefix = `${checkpoint.turnId}:${checkpoint.segment}:`;
  const rows = await t.effectsForTurn<StoredEffect>(session.id, checkpoint.turnId, ["completed"]);
  return rows
    .filter((row) => row.request.effectId.startsWith(prefix) && row.outcome)
    .map((row) => ({ effectId: row.request.effectId, requestHash: hashOf(row), outcome: row.outcome! }));
}

/**
 * Journals one effect. `effect` is the engine's request; a model intent may come without its
 * prompt, and then `requestHash` is the only record of it.
 */
export async function recordIntent(
  scope: RecordScope,
  effect: EffectIntent,
  requestHash: string
): Promise<IntentAnswer> {
  const { ctx, lease, signal } = scope;
  const request = effect as HostEffect;
  const answer = await ctx.store.tx(async (t): Promise<IntentAnswer | "flow" | "save"> => {
    const s = await ownedSession(t, lease, request.sessionId);
    if (s.status === "cancelled" || s.activeTurnId !== request.turnId) throw TURN_CANCELLED();
    // An aborted advance starts no effect; the advance decides what the abort means.
    signal.throwIfAborted();
    const existing = await t.get<StoredEffect>("effects", request.effectId);
    if (existing) {
      if (hashOf(existing) !== requestHash)
        throw new HarnessApiError("effect_drift", "Effect identity request drift");
      if (existing.status === "completed") return { status: "completed", outcome: existing.outcome! };
      // A call its previous owner left running at the gate: re-send it, same key and request,
      // to join it or collect its outcome (P1.2 for model calls, F4.1 for remote MCP calls).
      if (existing.status === "invoking" && request.kind === "model" && recoversModelCalls(ctx))
        return { status: "execute", rejoin: true };
      if (existing.status === "invoking" && recoversMcpCalls(ctx) && isRemoteMcpEffect(s, existing.request))
        return { status: "execute", rejoin: true };
      if (request.kind === "agent" && existing.status === "pending" && existing.agentSessionId) {
        const agent = await t.get<Session>("sessions", existing.agentSessionId);
        const outcome = await linkedOutcome(t, existing, agent);
        if (outcome) {
          existing.status = "completed";
          existing.outcome = outcome;
          await t.put("effects", request.effectId, existing);
          return { status: "completed", outcome };
        }
      }
      return {
        status: existing.status === "uncertain" || existing.status === "invoking" ? "uncertain" : "pending",
      };
    }
    if (
      request.kind === "agent" ||
      request.kind === "fn" ||
      request.kind === "verify" ||
      isFlowToolEffect(request)
    )
      return "flow";
    if (request.kind !== "model" && effectRequestHash(request) !== requestHash)
      throw new HarnessApiError("invalid", "The request hash does not match the request");
    if (request.kind === "delegation") {
      // Lifecycle points of an agent used as a tool: journaled once, so replays never re-emit.
      const outcome = { value: null };
      await t.put("effects", request.effectId, { request, requestHash, status: "completed", outcome });
      const settled = request.effectId.endsWith(":settled");
      const callId = (request.context as { callId?: unknown } | undefined)?.callId;
      await t.event(s.id, s.activeTurnId, settled ? "delegation.completed" : "delegation.started", {
        agent: request.agent!,
        ...(typeof callId === "string" ? { callId } : {}),
        ...(request.input as object),
      });
      return { status: "completed", outcome };
    }
    const agentManifest = manifestFor(s.manifest, request.agent);
    if (!agentManifest) throw new Error(`Agent '${request.agent?.id ?? ""}' is not used as a tool`);
    const executed =
      request.kind === "model" ||
      (request.kind === "tool" &&
        (mcpToolOf(s.mcpSnapshot, request) !== undefined ||
          sandboxCapabilityOf(agentManifest, request.capabilityId, request.toolName) !== undefined ||
          // `save_artifact` (F8.1) runs beside the sandbox tools.
          isSaveArtifactCall(agentManifest, request)));
    await t.put("effects", request.effectId, {
      request: storedRequest(request),
      requestHash,
      status: executed ? "invoking" : "pending",
    });
    // `save_artifact` writes the Tenant's artifacts: core runs it, reading the file through the
    // workspace capability, wherever the sandbox is.
    if (executed && request.kind === "tool" && isSaveArtifactCall(agentManifest, request)) return "save";
    if (executed) return { status: "execute" };
    await offerActionFor(scope, t, s, agentManifest, request);
    return { status: "pending" };
  });
  if (answer === "save") return saveArtifact(scope, request);
  if (answer !== "flow") return answer;
  if (!isFlowEffect(request)) return { status: "pending" };
  return resolveNewFlowEffect(ctx, request, signal, lease);
}

/**
 * Runs `save_artifact` (F8.1) for the run and records its outcome, as a harness would record a
 * call it ran: the run gets the outcome as the intent's answer.
 */
async function saveArtifact(scope: RecordScope, request: HostEffect): Promise<IntentAnswer> {
  let value: unknown;
  try {
    value = await callSaveArtifact(scope.ctx, request, scope.signal);
  } catch (error) {
    if (isOwnershipLost(error)) throw error;
    return recordOutcome(scope, request.effectId, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return recordOutcome(scope, request.effectId, { value });
}

/** A tool or hook Action for the agent's endpoint, in the intent's transaction. */
async function offerActionFor(
  scope: RecordScope,
  t: Tx,
  s: Session,
  agentManifest: ReturnType<typeof manifestFor> & object,
  request: HostEffect
): Promise<void> {
  const tool =
    request.kind === "tool" ? pinnedTool(agentManifest, request.capabilityId, request.toolName) : undefined;
  const base = {
    actionId: request.effectId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    agentId: request.agentId,
    manifestHash: request.manifestHash,
    implementationVersion: s.implementationVersion,
    input: request.input,
    context: request.context,
    status: "pending" as const,
    generation: 0,
    ...(request.agent ? { agent: request.agent } : {}),
  };
  const action: Action =
    request.kind === "hook"
      ? {
          ...base,
          kind: "hook",
          hook: {
            at: request.hook!.at,
            scope: request.hook!.scope,
            capabilityIds: [...request.hook!.capabilityIds],
          },
        }
      : {
          ...base,
          kind: "tool",
          capabilityId: request.capabilityId!,
          toolName: request.toolName!,
          ...(tool?.inputSchema ? { inputSchema: tool.inputSchema } : {}),
          ...(tool?.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        };
  await t.put("actions", action.actionId, action);
  await t.event(s.id, s.activeTurnId, "action.pending", {
    actionId: action.actionId,
    kind: action.kind,
    ...actionTarget(action),
    ...(action.kind === "tool" ? toolIds(request.context) : {}),
    input: action.input,
  });
  await offerAction(t, scope.ctx, action);
}

/**
 * Records the outcome of a call the harness ran: `value`, with its transcript events, or the
 * `error` that left it uncertain. Only a cancel discards an outcome in hand (§10.7): after any
 * other abort (shutdown, deadline) it is recorded, so the next advance replays it.
 */
export async function recordOutcome(
  scope: RecordScope,
  effectId: string,
  result: { value: unknown } | { error: string }
): Promise<OutcomeAnswer> {
  const { ctx, lease, signal } = scope;
  if ("error" in result) {
    await ctx.store.tx(async (t) => {
      const s = await t.assertEpoch<Session>(lease.sessionId, lease.epoch);
      const effect = await t.get<StoredEffect>("effects", effectId);
      if (!effect) return;
      const { request } = effect;
      effect.status = "uncertain";
      effect.error = result.error;
      await t.put("effects", effectId, effect);
      if (s && s.status !== "cancelled" && s.activeTurnId === request.turnId)
        await t.event(s.id, request.turnId, "effect.uncertain", { effectId, message: result.error });
    });
    return { status: "uncertain" };
  }
  const { value } = result;
  return ctx.store.tx(async (t) => {
    const s = await t.assertEpoch<Session>(lease.sessionId, lease.epoch);
    const effect = await t.get<StoredEffect>("effects", effectId);
    if (!effect) throw new HarnessApiError("invalid", `Effect ${effectId} was never journaled`);
    const { request } = effect;
    if (s.status === "cancelled" || s.activeTurnId !== request.turnId || abortKind(signal) === "cancel")
      throw TURN_CANCELLED();
    effect.status = "completed";
    effect.outcome = { value };
    await t.put("effects", effectId, effect);
    const model = request.kind === "model";
    const failed = model ? modelFailed(request, value) : undefined;
    // A summary call is never an assistant message; the last one publishes context.compacted.
    const summarizing = model && Boolean((request.context as { compaction?: unknown }).compaction);
    const compacted = summarizing && !failed ? contextCompacted(request, value) : undefined;
    const transcript =
      failed || summarizing
        ? undefined
        : model
        ? assistantMessage(request, value)
        : toolCompleted(request, value);
    if (failed) await t.event(s.id, request.turnId, "model.failed", failed);
    if (compacted) await t.event(s.id, request.turnId, "context.compacted", compacted);
    if (transcript && model)
      await t.event(s.id, request.turnId, "message.assistant", transcript as EventPayload<"message.assistant">);
    else if (transcript)
      await t.event(s.id, request.turnId, "tool.completed", transcript as EventPayload<"tool.completed">);
    return { status: "completed" as const, outcome: effect.outcome };
  });
}

/** What a journal row keeps of a request: a model call without its prompt. */
function storedRequest(request: HostEffect): EffectIntent {
  if (request.kind !== "model" || request.input === undefined) return request;
  const { input: _, ...stored } = request;
  return stored;
}
