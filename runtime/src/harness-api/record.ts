/**
 * The Record seam of the Harness API: core's journal for the effects of a run. `recordIntent`
 * journals an effect before anything runs it, and either answers it from the journal, hands it
 * to core's own executors (flow work, delegation, `save_artifact` and the skill tools), tells
 * the harness to `execute` it (model calls; MCP, HTTP and sandbox tools; a flow's HTTP stages
 * and HTTP verifiers), or fails a tool the Runtime cannot run (one that would run the
 * developer's code, R2 M6). `recordOutcome`
 * records what the harness's call returned. Both run under the advance's lease: every write is
 * epoch-checked (`ownedSession`), and a lost epoch writes nothing.
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
import type { EventPayload } from "@nylorun/core/contracts";
import type { AgentManifest } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import {
  isFlowEffect,
  isFlowToolEffect,
  recordVerdict,
  settleAgentEffect,
  type FlowEffect,
} from "../core/flow-host.js";
import { sandboxCapabilityOf } from "../sandbox/capability.js";
import { isSaveArtifactCall } from "../harness/calls.js";
import { callSaveArtifact } from "../tenant/artifact-tool.js";
import { callSkillTool, isSkillToolCall } from "../tenant/skill-tool.js";
import { isOwnershipLost } from "../store/ownership.js";
import { manifestFor, mcpToolOf } from "../mcp/snapshot.js";
import { isHttpToolCall } from "../gates/http-tool.js";
import { ownedSession, type Lease, type Session, type TenantContext } from "../tenant/context.js";
import {
  isGateToolEffect,
  linkedOutcome,
  recoversModelCalls,
  recoversToolCalls,
  resolveNewFlowEffect,
} from "../tenant/effects.js";
import {
  assistantMessage,
  contextCompacted,
  modelFailed,
  toolCompleted,
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
  const answer = await ctx.store.tx(async (t): Promise<IntentAnswer | "flow" | "save" | { skill: AgentManifest }> => {
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
      // to join it or collect its outcome (P1.2 for model calls, F4.1 for remote MCP and HTTP
      // tool calls).
      if (existing.status === "invoking" && request.kind === "model" && recoversModelCalls(ctx))
        return { status: "execute", rejoin: true };
      if (existing.status === "invoking" && recoversToolCalls(ctx) && isGateToolEffect(s, existing.request))
        return { status: "execute", rejoin: true };
      if (request.kind === "agent" && existing.status === "pending" && existing.agentSessionId) {
        const agent = await t.get<Session>("sessions", existing.agentSessionId);
        const outcome = await linkedOutcome(t, existing, agent);
        if (outcome) {
          await settleAgentEffect({ t, effect: existing as FlowEffect, outcome });
          return { status: "completed", outcome };
        }
      }
      return {
        status: existing.status === "uncertain" || existing.status === "invoking" ? "uncertain" : "pending",
      };
    }
    // A flow's HTTP stages and HTTP verifiers cross the Tool Gate like an agent's HTTP tool.
    const flowHttp = isFlowToolEffect(request) && isHttpToolCall(s.manifest, request);
    if (request.kind === "agent" || (isFlowToolEffect(request) && !flowHttp)) return "flow";
    if (request.kind !== "model" && effectRequestHash(request) !== requestHash)
      throw new HarnessApiError("invalid", "The request hash does not match the request");
    if (flowHttp) {
      await t.put("effects", request.effectId, { request, requestHash, status: "invoking" });
      await t.event(s.id, s.activeTurnId, "node.started", {
        path: request.path!,
        kind: "http",
        key: request.key!,
        ...(request.iterations !== undefined ? { iterations: request.iterations } : {}),
      });
      return { status: "execute" };
    }
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
          // HTTP tools (R2 M3) cross the Tool Gate.
          isHttpToolCall(s.manifest, request) ||
          sandboxCapabilityOf(agentManifest, request.capabilityId, request.toolName) !== undefined ||
          // `save_artifact` (F8.1) runs beside the sandbox tools, and the skill tools (R2 M4).
          isSaveArtifactCall(agentManifest, request) ||
          isSkillToolCall(agentManifest, request)));
    if (!executed) {
      // A tool that would run the developer's code: refused at save (a turn's manifest only
      // removes tools), so this is a backstop. The model sees the failure; nothing runs.
      const outcome = { value: unrunnableTool(request) };
      await t.put("effects", request.effectId, { request, requestHash, status: "completed", outcome });
      const transcript = toolCompleted(request, outcome.value);
      if (transcript) await t.event(s.id, request.turnId, "tool.completed", transcript as EventPayload<"tool.completed">);
      return { status: "completed", outcome };
    }
    await t.put("effects", request.effectId, {
      request: storedRequest(request),
      requestHash,
      status: "invoking",
    });
    // `save_artifact` writes the Tenant's artifacts: core runs it, reading the file through the
    // workspace capability, wherever the sandbox is.
    if (request.kind === "tool" && isSaveArtifactCall(agentManifest, request)) return "save";
    // The skill tools read the agent's definition files: core serves them.
    if (isSkillToolCall(agentManifest, request)) return { skill: agentManifest };
    return { status: "execute" };
  });
  if (answer === "save") return runInCore(scope, request, () => callSaveArtifact(scope.ctx, request, scope.signal));
  if (typeof answer === "object" && "skill" in answer)
    return runInCore(scope, request, () => callSkillTool(scope.ctx, answer.skill, request, scope.signal));
  if (answer !== "flow") return answer;
  if (!isFlowEffect(request)) return { status: "pending" };
  return resolveNewFlowEffect(ctx, request, signal, lease);
}

/**
 * Runs a tool core serves (`save_artifact`, F8.1; the skill tools, R2 M4) for the run and records
 * its outcome, as a harness would record a call it ran: the run gets the outcome as the intent's
 * answer.
 */
async function runInCore(
  scope: RecordScope,
  request: HostEffect,
  call: () => Promise<unknown>
): Promise<IntentAnswer> {
  let value: unknown;
  try {
    value = await call();
  } catch (error) {
    if (isOwnershipLost(error)) throw error;
    return recordOutcome(scope, request.effectId, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return recordOutcome(scope, request.effectId, { value });
}

/** The failed outcome of a tool the Runtime cannot run: it would run the developer's code. */
function unrunnableTool(request: HostEffect) {
  return {
    kind: "failed",
    code: "tool.unavailable",
    message: `Tool '${request.toolName ?? ""}' runs your code, and the Runtime runs no code of yours during a session. Make it an http() tool or serve it from a remote MCP server.`,
  };
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
    if (request.context?.role === "verify-http") await recordVerdict(t, request, value);
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
