/**
 * The Record seam of the Harness API: core's journal for the effects of a run. `recordIntent`
 * journals an effect before anything runs it, and either answers it from the journal, hands it
 * to core's own executors (flow work, delegation), tells the harness to `execute` it (model calls;
 * a flow's HTTP stages and HTTP verifiers; an agent's tool call whose target the session has,
 * protocol 15: an `mcp` tool it discovered and the turn leaves enabled, by `{server, tool}`; an
 * `http` tool it declares; a `sandbox` operation when it has a sandbox; a `harness` tool), or
 * fails a tool call it cannot run (no target, as an author's code tool has, R2 M6, or one the
 * session lacks). A tool call is routed by its target, never by its name. `recordOutcome`
 * records what the harness's call returned, as the harness reported it: one record entry, refused
 * past the Runtime limit `recordEntryBytes` (`limit_exceeded`), since the harness shapes tool
 * results, not core. Both run under the advance's lease: every write is epoch-checked
 * (`ownedSession`), and a lost epoch writes nothing.
 *
 * Rows store the request's hash (`requestHash`) and, for a model call, the request without its
 * prompt: drift is a hash compare. Rows written before carry their full request, hashed on read.
 *
 * Every row a run journals keeps when it was journaled (`startedAt`, R7.1), and a rejoin keeps
 * it: an outcome's `durationMs` is the journal's window, from the intent to the outcome. A model
 * call's outcome event also carries what the meter recorded for it (`modelOutcomeFacts`). A tool
 * row keeps its span's context (`traceparent`, R7.4), which the `execute` answer carries to the
 * harness and the Tool Gate reads with the row.
 */
import {
  HarnessApiError,
  effectRequestHash,
  isEffectIdOf,
  type EffectIntent,
  type IntentAnswer,
  type OutcomeAnswer,
  type RecordedOutcome,
} from "@nylorun/core/harness-api";
import type { EventPayload, EventWriter } from "@nylorun/core/contracts";
import { isSandboxToolName, type AgentManifest } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import {
  isFlowEffect,
  isFlowToolEffect,
  recordVerdict,
  settleAgentEffect,
  type FlowEffect,
} from "../core/flow-host.js";
import { sessionSandboxSpec } from "../sandbox/share.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";
import { checkEntry } from "../record/index.js";
import { turnManifestOf } from "../tenant/session.js";
import { isEnabledIn, manifestFor, mcpToolIn } from "../mcp/snapshot.js";
import { findServer } from "../mcp/pool.js";
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
  modelOutcomeFacts,
} from "../tenant/transcript.js";
import { abortKind } from "../tenant/worker.js";
import { redactTokens } from "./redact.js";
import { toolCallDecision } from "../gates/policy.js";
import type { Tx } from "../store/types.js";
import { traceKey } from "../traces/key.js";
import { effectSpanOf, traceparentOf, turnTraceIdOf, type TraceKey } from "../traces/ids.js";
import {
  MAX_TOOL_ATTEMPTS,
  firstSend,
  interrupted,
  settleToolRow,
  toolKindOf,
  type ToolRow,
} from "./tool-journal.js";

/** What a run's journal writes are scoped by: the advance's lease and its signal. */
export interface RecordScope {
  readonly ctx: TenantContext;
  readonly lease: Lease;
  readonly signal: AbortSignal;
  /**
   * Who reported what this scope records (R4.9): the run's harness, so the events derived from
   * its intents and outcomes are its claim. Absent, core recorded what it saw itself.
   */
  readonly writer?: EventWriter;
}

type StoredEffect = ToolRow & { agentSessionId?: string };

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
  const rows = await t.effectsForTurn<StoredEffect>(session.id, checkpoint.turnId, ["completed"]);
  return rows
    .filter((row) => isEffectIdOf(row.request.effectId, checkpoint.turnId, checkpoint.segment) && row.outcome)
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
  // Read before the transaction: the first read of the Tenant may create the key.
  const key = await traceKey(ctx.store);
  const answer = await ctx.store.tx(async (t): Promise<IntentAnswer | "flow"> => {
    const s = await ownedSession(t, lease, request.sessionId);
    if (s.status === "cancelled" || s.activeTurnId !== request.turnId) throw TURN_CANCELLED();
    // A tool call's span context (R7.4), kept on its row.
    const traced = () => ({ traceparent: toolTraceparent(key, ctx.store.tenantId, s, request) });
    // An aborted advance starts no effect; the advance decides what the abort means.
    signal.throwIfAborted();
    const existing = await t.get<StoredEffect>("effects", request.effectId);
    if (existing) {
      if (hashOf(existing) !== requestHash)
        throw new HarnessApiError("effect_drift", "Effect identity request drift");
      if (existing.status === "completed") return { status: "completed", outcome: existing.outcome! };
      // A call its previous owner left running at the gate: re-send it, same key and request,
      // to join it or collect its outcome (P1.2).
      if (existing.status === "invoking" && request.kind === "model" && recoversModelCalls(ctx))
        return { status: "execute", rejoin: true };
      // A tool call a crash, a shutdown or a lost gate hop interrupted (R5.3, R5.4).
      if (existing.status === "invoking" && existing.request.kind === "tool")
        return resend(t, s, existing, recoversToolCalls(ctx));
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
      const row: StoredEffect = { request, requestHash, status: "invoking", ...firstSend({ toolKind: "http" }), ...traced() };
      await t.event(
        s.id,
        s.activeTurnId,
        "node.started",
        {
          path: request.path!,
          kind: "http",
          key: request.key!,
          ...(request.iterations !== undefined ? { iterations: request.iterations } : {}),
        },
        scope.writer
      );
      const decided = await bypolicy(t, s, row, "http");
      if (decided) return decided;
      await t.put("effects", request.effectId, row);
      return { status: "execute", traceparent: row.traceparent! };
    }
    if (request.kind === "delegation") {
      // Lifecycle points of an agent used as a tool: journaled once, so replays never re-emit.
      const outcome = { value: null };
      const at = new Date().toISOString();
      await t.put("effects", request.effectId, {
        request,
        requestHash,
        status: "completed",
        outcome,
        startedAt: at,
        settledAt: at,
      });
      const settled = request.effectId.endsWith(":settled");
      const callId = (request.context as { callId?: unknown } | undefined)?.callId;
      await t.event(
        s.id,
        s.activeTurnId,
        settled ? "delegation.completed" : "delegation.started",
        {
          agent: request.agent!,
          ...(typeof callId === "string" ? { callId } : {}),
          ...(request.input as object),
        },
        scope.writer
      );
      return { status: "completed", outcome };
    }
    const agentManifest = manifestFor(s.manifest, request.agent);
    if (!agentManifest) throw new Error(`Agent '${request.agent?.id ?? ""}' is not used as a tool`);
    const refused = request.kind === "tool" ? refusal(s, request) : undefined;
    if (refused) {
      // A call with no target (an author's code tool, refused at save, so a backstop), or one
      // whose target the session lacks: an MCP tool it never discovered or the turn disables, an
      // HTTP tool its agent does not declare, a sandbox call without a sandbox. The model sees
      // the failure; nothing runs.
      const row: StoredEffect = {
        request,
        requestHash,
        status: "invoking",
        ...toolKindOf(s, agentManifest, request),
        attempts: 0,
      };
      const outcome = await settleToolRow(t, s, row, refused, { writer: coreIn(scope) });
      return { status: "completed", outcome };
    }
    const row: StoredEffect = {
      // A model row keeps no prompt; a tool row its whole request.
      request: storedRequest(request) as HostEffect,
      requestHash,
      status: "invoking",
      ...(request.kind === "tool"
        ? { ...firstSend(toolKindOf(s, agentManifest, request)), ...traced() }
        : { startedAt: new Date().toISOString() }),
    };
    // The Tenant's tool policy decides an MCP or HTTP tool call as it is journaled (R5 step 2).
    if (row.toolKind === "mcp" || row.toolKind === "http") {
      const decided = await bypolicy(t, s, row, row.toolKind);
      if (decided) return decided;
    }
    await t.put("effects", request.effectId, row);
    return { status: "execute", ...(row.traceparent ? { traceparent: row.traceparent } : {}) };
  });
  if (answer !== "flow") return answer;
  if (!isFlowEffect(request)) return { status: "pending" };
  return resolveNewFlowEffect(ctx, request, signal, lease);
}

/**
 * Why an agent's tool call cannot run, by what it names as its target (protocol 15), or
 * undefined when it can:
 *
 * - `mcp`: the tool `{server, tool}` of an MCP server its agent declares, as the session
 *   discovered it (`tool.unknown` otherwise), left enabled by the turn's manifest (R2b C9,
 *   `tool.disabled`);
 * - `http`: an HTTP tool its agent declares under that name (R2 M3), which crosses the Tool Gate;
 * - `sandbox`: one of the sandbox operations, in a session with a sandbox;
 * - `harness`: a tool the harness runs in its own process; its egress gate is its only control.
 *
 * No target, and anything else, runs nothing (`tool.unavailable`).
 */
function refusal(s: Session, request: HostEffect): ToolRefusal | undefined {
  const target = request.target;
  switch (target?.kind) {
    case "mcp": {
      const agentId = request.agent?.id;
      if (!findServer(s.manifest, agentId, target.server) || !mcpToolIn(s.mcpSnapshot, agentId, target.server, target.tool))
        return {
          kind: "failed",
          code: "tool.unknown",
          message: `Tool '${target.tool}' of MCP server '${target.server}' was not discovered for this session.`,
        };
      if (!isEnabledIn(turnManifestOf(s), agentId, target.server, target.tool))
        return {
          kind: "failed",
          code: "tool.disabled",
          message: `Tool '${target.tool}' is disabled by its MCP server's tools settings.`,
        };
      return undefined;
    }
    case "http":
      return isHttpToolCall(s.manifest, request) ? undefined : unrunnableTool(request);
    case "sandbox":
      return sessionSandboxSpec(s) !== undefined &&
        request.toolName !== undefined &&
        isSandboxToolName(request.toolName)
        ? undefined
        : unrunnableTool(request);
    case "harness":
      return undefined;
    default:
      return unrunnableTool(request);
  }
}

interface ToolRefusal {
  readonly kind: "failed";
  readonly code: string;
  readonly message: string;
}

/** Core's own write during the scope's run (R4.9): core saw it, in that run. */
function coreIn(scope: RecordScope): EventWriter | undefined {
  const runId = scope.writer?.runId;
  return runId === undefined ? undefined : { source: { kind: "core", id: "runtime" }, runId };
}

/**
 * The answer to a tool row still `invoking` (R5.3, R5.4): a crash, a shutdown or a lost gate
 * hop interrupted its send. An MCP or HTTP call (it crosses the Tool Gate, which hands the tool
 * its key) is sent again, one more attempt, until `MAX_TOOL_ATTEMPTS`; then it fails to the
 * model. Any other call (sandbox, harness, core-served) has no key to dedupe on: it fails to the
 * model now, and is not run again (Q2).
 */
async function resend(t: Tx, s: Session, row: StoredEffect, rejoin: boolean): Promise<IntentAnswer> {
  if (!isGateToolEffect(s, row.request)) {
    const outcome = await settleToolRow(
      t,
      s,
      row,
      interrupted("A crash interrupted this call before its outcome was recorded. It may have run; it is not run again."),
    );
    return { status: "completed", outcome };
  }
  const attempts = (row.attempts ?? 1) + 1;
  if (attempts > MAX_TOOL_ATTEMPTS) {
    const outcome = await settleToolRow(
      t,
      s,
      row,
      interrupted(`The call was interrupted ${MAX_TOOL_ATTEMPTS} times and may have run.`),
    );
    return { status: "completed", outcome };
  }
  row.attempts = attempts;
  await t.put("effects", row.request.effectId, row);
  const traced = row.traceparent ? { traceparent: row.traceparent } : {};
  return rejoin ? { status: "execute", rejoin: true, ...traced } : { status: "execute", ...traced };
}

/** The span context of tool call `request` (R7.4): its turn's trace, and its own span. */
function toolTraceparent(
  key: TraceKey,
  tenantId: string,
  s: Pick<Session, "id" | "turnTrace">,
  request: HostEffect,
): string {
  const traceId = turnTraceIdOf(key, { tenantId, sessionId: s.id, turnId: request.turnId }, s.turnTrace);
  return traceparentOf(traceId, effectSpanOf(key, request.effectId));
}

/**
 * The Tenant's tool policy on a tool call being journaled (R5 step 2, `gates/policy.ts`), or
 * undefined when it runs. `deny`: the call fails to the model as `tool.denied`, unsent. `ask`:
 * the row waits as `held` and the effect is pending; the segment ends waiting, the turn pauses,
 * and `approve` answers it (`tenant/commands.ts`). The Tool Gate refuses a row not `invoking`, so
 * neither runs whichever harness sends it. Writes `row`.
 */
async function bypolicy(
  t: Tx,
  s: Session,
  row: StoredEffect,
  kind: "mcp" | "http",
): Promise<IntentAnswer | undefined> {
  const decision = await toolCallDecision(t, s, row.request as HostEffect, kind);
  if (decision.effect === "allow") return undefined;
  // Nothing was sent.
  row.attempts = 0;
  if (decision.effect === "deny") {
    const outcome = await settleToolRow(t, s, row, {
      kind: "failed",
      code: "tool.denied",
      message: decision.reason,
      retryable: false,
    });
    return { status: "completed", outcome };
  }
  row.status = "held";
  row.hold = { reason: decision.reason, at: new Date().toISOString() };
  await t.put("effects", row.request.effectId, row);
  return { status: "pending" };
}

/**
 * The failed outcome of a tool call the Runtime cannot run: one that names no target (an author's
 * code tool: the Runtime runs agents from their manifests alone), or one whose target the session
 * lacks (a sandbox call without a sandbox).
 */
function unrunnableTool(request: HostEffect): ToolRefusal {
  if (request.target?.kind === "sandbox")
    return {
      kind: "failed",
      code: "tool.unavailable",
      message: `Tool '${request.toolName ?? ""}' runs in a sandbox, and this session has none.`,
    };
  if (request.target !== undefined)
    return {
      kind: "failed",
      code: "tool.unavailable",
      message: `Tool '${request.toolName ?? ""}' is not one this session can run (${request.target.kind}).`,
    };
  return {
    kind: "failed",
    code: "tool.unavailable",
    message: `Tool '${request.toolName ?? ""}' runs your code, but the Runtime runs agents from their manifests alone. Make it an http() tool or serve it from a remote MCP server.`,
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
  reported: { value: unknown } | { error: string }
): Promise<OutcomeAnswer> {
  const { ctx, lease, signal } = scope;
  const result = "error" in reported ? { error: redactTokens(reported.error) } : reported;
  if ("error" in result) {
    return ctx.store.tx(async (t): Promise<OutcomeAnswer> => {
      const s = await t.assertEpoch<Session>(lease.sessionId, lease.epoch);
      const effect = await t.get<StoredEffect>("effects", effectId);
      if (!effect) return { status: "uncertain" };
      const { request } = effect;
      const active = s && s.status !== "cancelled" && s.activeTurnId === request.turnId;
      // A tool call whose fate the harness could not learn fails to the model (R5.3): it may
      // have run, and nothing sends it again. A cancel already settled it.
      if (request.kind === "tool") {
        if (effect.status === "completed") return { status: "completed", outcome: effect.outcome! };
        if (effect.status !== "invoking" || !active) return { status: "uncertain" };
        effect.error = result.error;
        const outcome = await settleToolRow(
          t,
          s,
          effect,
          interrupted(`${result.error} (the call may have run; it is not sent again)`),
          { writer: coreIn(scope) }
        );
        return { status: "completed", outcome };
      }
      effect.status = "uncertain";
      effect.error = result.error;
      await t.put("effects", effectId, effect);
      if (active)
        await t.event(s.id, request.turnId, "effect.uncertain", { effectId, message: result.error }, scope.writer);
      return { status: "uncertain" };
    });
  }
  // What a harness reports never carries the Runtime's own tokens into the record (R4).
  const value = redactTokens(result.value);
  return ctx.store.tx(async (t) => {
    const s = await t.assertEpoch<Session>(lease.sessionId, lease.epoch);
    const effect = await t.get<StoredEffect>("effects", effectId);
    if (!effect) throw new HarnessApiError("invalid", `Effect ${effectId} was never journaled`);
    // An entry of the record (S0): past the Tenant's `recordEntryBytes`, `limit_exceeded`. The
    // harness shapes what it reports to fit, storing the rest with `artifact.write`; the row
    // stays as it was.
    checkEntry(
      `The outcome of effect ${effectId} (store the rest with artifact.write)`,
      value,
      (await readRuntimeLimits(t)).recordEntryBytes
    );
    const { request } = effect;
    if (s.status === "cancelled" || s.activeTurnId !== request.turnId || abortKind(signal) === "cancel")
      throw TURN_CANCELLED();
    if (request.kind === "tool") {
      // Settled already: a re-send after a lost hop collected what the first send recorded.
      if (effect.status === "completed") return { status: "completed" as const, outcome: effect.outcome! };
      // What the call returned is the harness's claim (R4.9).
      const outcome = await settleToolRow(t, s, effect, value, { writer: scope.writer });
      if (request.context?.role === "verify-http") await recordVerdict(t, request, value);
      return { status: "completed" as const, outcome };
    }
    effect.status = "completed";
    effect.outcome = { value };
    effect.settledAt = new Date().toISOString();
    await t.put("effects", effectId, effect);
    const model = request.kind === "model";
    const failed = model ? modelFailed(request, value) : undefined;
    // A summary call is never an assistant message; it publishes context.compacted, `partial`
    // unless it is the last.
    const summarizing = model && Boolean((request.context as { compaction?: unknown }).compaction);
    const compacted = summarizing && !failed ? contextCompacted(request, value) : undefined;
    const transcript = failed || summarizing || !model ? undefined : assistantMessage(request, value);
    if (request.context?.role === "verify-http") await recordVerdict(t, request, value);
    const writer = scope.writer;
    // The call's span (R7.1): the journal's window, and the meter's row for it when a gate ran it.
    const facts =
      failed || compacted || transcript
        ? modelOutcomeFacts(effectId, effect, await t.modelUsageOf(effectId))
        : undefined;
    if (failed) await t.event(s.id, request.turnId, "model.failed", { ...failed, ...facts }, writer);
    if (compacted) await t.event(s.id, request.turnId, "context.compacted", { ...compacted, ...facts }, writer);
    if (transcript)
      await t.event(
        s.id,
        request.turnId,
        "message.assistant",
        { ...transcript, ...facts } as EventPayload<"message.assistant">,
        writer
      );
    return { status: "completed" as const, outcome: effect.outcome };
  });
}

/** What a journal row keeps of a request: a model call without its prompt. */
function storedRequest(request: HostEffect): EffectIntent {
  if (request.kind !== "model" || request.input === undefined) return request;
  const { input: _, ...stored } = request;
  return stored;
}
