/**
 * The effect journal's tool calls (R5): every tool call is a row of `nylorun.effects`, and how
 * it ends is one `tool.completed` with its status, kind, server, attempts and duration (R5.1).
 *
 * Delivery (R5.3, R5.4). A tool call is sent at least once, and every send carries its effect
 * id as the key. After a crash, a shutdown or a lost gate hop, a row still `invoking` is sent
 * again: an MCP or HTTP tool call (it crosses the Tool Gate, which hands the tool the key) up to
 * the Tenant's Runtime limit `toolAttempts` sends, then it fails to the model as
 * `tool.interrupted`. A sandbox or
 * core-served call has no key to dedupe on, so a crash fails it to the model at once, and
 * nothing runs it again (Q2). No tool call leaves its session `uncertain`.
 *
 * The row body keeps the journal's facts: `toolKind`, `server`, `tool` (the identity, protocol
 * 15), `attempts`, `startedAt` and `settledAt`. A row written before R5 has none of them.
 *
 * Spans (R7.1). `tool.completed` also carries the call's effect id, the Tool Gate's own start
 * and end of its last send (`gate`, from its `tool_crossings` row: MCP and HTTP calls through
 * the gateway, while the row is kept), and what the tool policy did when it did more than allow
 * (`policy`). A flow's HTTP stage, which names no tool call, ends in `node.completed` instead.
 */
import type { EventPayload, EventWriter } from "@nylorun/core/contracts";
import { pluginOf, type AgentManifest, type PluginLabel } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { isFlowToolEffect } from "../core/flow-host.js";
import { declaredHttpTool } from "../gates/http-tool.js";
import type { Session } from "../tenant/context.js";
import {
  toolCompleted,
  type GateTimes,
  type ToolCallFacts,
  type ToolCallKind,
  type ToolCallStatus,
  type ToolPolicyFact,
} from "../tenant/transcript.js";
import type { EffectDoc, Tx } from "../store/types.js";
import { toolCallDuration, toolCallStatus } from "./tool-status.js";

/** A tool row's journal facts (R5), kept in its body. */
export interface ToolRowFacts {
  /** Why the Tool Gate held the call for approval, and since when (R5 step 2). */
  hold?: { reason: string; at: string };
  /** A person's approval of a held call (R5 step 2): the gate then sends it. */
  approval?: { approved: true; at: string; by?: string };
  toolKind?: ToolCallKind;
  server?: string;
  /** The tool's identity: an MCP tool's name on `server`, an HTTP tool's declared name. */
  tool?: string;
  /** The skill the call ran, and the plugin that brought its skill or MCP server. */
  skill?: string;
  plugin?: PluginLabel;
  attempts?: number;
  startedAt?: string;
  settledAt?: string;
  /**
   * The tool span's context (R7.4), `00-<trace>-<span>-01`: the Tool Gate reads it with the row
   * and sends it as `traceparent`, and a harness hands it to a sandbox command as `TRACEPARENT`.
   */
  traceparent?: string;
}

export type ToolRow = EffectDoc &
  ToolRowFacts & {
    requestHash?: string;
    outcome?: { value: unknown; statePatch?: Record<string, unknown> };
    error?: string;
  };

/** Where a tool call runs, and what it traces to (Q7, Q11). */
export interface ToolCallPlace {
  /** Its target's kind; absent for a call that names none (an author's code tool). */
  toolKind?: ToolCallKind;
  /** Its MCP server or, for an agent's HTTP tool, its URL's host. */
  server?: string;
  /** Its identity: an MCP tool's own name on the server, an HTTP tool's declared name. */
  tool?: string;
  skill?: string;
  plugin?: PluginLabel;
}

/**
 * Where a tool call runs, and what it traces to (protocol 15): its target's kind; an MCP call
 * names its identity (server and tool) and the plugin that brought the server, an HTTP call its
 * declared name and its URL's host. The skill the effect names (`skill`: a skill tool's, or a
 * sandbox call in a skill's folder) is kept when the agent has it, with the plugin that brought it.
 */
export function toolKindOf(
  s: Pick<Session, "manifest">,
  agentManifest: AgentManifest | undefined,
  request: HostEffect,
): ToolCallPlace {
  const target = request.target;
  const kind = target?.kind;
  if (target?.kind === "mcp") {
    const plugin = pluginOf(agentManifest, { server: target.server });
    return {
      toolKind: "mcp",
      server: target.server,
      tool: target.tool,
      ...(plugin === undefined ? {} : { plugin }),
    };
  }
  if (target?.kind === "http") {
    const host = httpHostOf(declaredHttpTool(s.manifest, request.agent?.id, target.tool)?.http.url);
    return { toolKind: "http", ...(host === undefined ? {} : { server: host }), tool: target.tool };
  }
  const skill =
    request.skill !== undefined && agentManifest?.skills?.[request.skill] !== undefined
      ? request.skill
      : undefined;
  const plugin = skill === undefined ? undefined : pluginOf(agentManifest, { skill });
  return {
    ...(kind === undefined ? {} : { toolKind: kind }),
    ...(skill === undefined ? {} : { skill }),
    ...(plugin === undefined ? {} : { plugin }),
  };
}

/** The host (and port, when it names one) of an HTTP tool's URL. */
function httpHostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** The facts a new tool row starts with: its first send, now. */
export function firstSend(kind: ToolCallPlace, now = new Date()): ToolRowFacts {
  return { ...kind, attempts: 1, startedAt: now.toISOString() };
}

/** A failed outcome the Runtime gives a call a crash interrupted: it may have run. */
export function interrupted(message: string) {
  return { kind: "failed", code: "tool.interrupted", message, retryable: false };
}

/** The facts `tool.completed` carries for `row`, settled with `status`, and the gate's times. */
export function factsOf(row: ToolRow, status: ToolCallStatus, gate?: GateTimes): ToolCallFacts {
  const durationMs = toolCallDuration(row);
  const policy = policyOf(row);
  return {
    status,
    ...(row.toolKind === undefined ? {} : { kind: row.toolKind }),
    ...(row.server === undefined ? {} : { server: row.server }),
    ...(row.tool === undefined ? {} : { tool: row.tool }),
    ...(row.skill === undefined ? {} : { skill: row.skill }),
    ...(row.plugin === undefined ? {} : { plugin: row.plugin }),
    ...(row.attempts === undefined ? {} : { attempts: row.attempts }),
    ...(durationMs === undefined ? {} : { durationMs }),
    effectId: row.request.effectId,
    ...(gate === undefined ? {} : { gate }),
    ...(policy === undefined ? {} : { policy }),
  };
}

/**
 * What the Tenant's tool policy did with `row` (R5 step 2), when it did more than allow it: held
 * it for a person (`ask`, with who approved it, when someone did), or refused it unsent (`deny`).
 */
export function policyOf(row: ToolRow): ToolPolicyFact | undefined {
  if (row.hold)
    return {
      decision: "ask",
      reason: row.hold.reason,
      ...(row.approval?.by === undefined ? {} : { approvedBy: row.approval.by }),
    };
  const value = row.outcome?.value as { code?: unknown; message?: unknown } | null | undefined;
  // `bypolicy` refuses a call before its first send.
  if (row.attempts === 0 && value?.code === "tool.denied")
    return { decision: "deny", reason: String(value.message ?? "") };
  return undefined;
}

/**
 * The Tool Gate's own start and end of `row`'s last send (R7.1), from its `tool_crossings` row:
 * an MCP or HTTP call the gateway ran and settled. Undefined for any other call, one never sent,
 * and one whose crossing is gone (pruned a day after it settled) or not settled.
 */
async function gateOf(t: Tx, row: ToolRow): Promise<GateTimes | undefined> {
  if ((row.toolKind !== "mcp" && row.toolKind !== "http") || !row.attempts) return undefined;
  const crossing = await t.toolCrossing(row.request.effectId);
  return crossing?.settledAt ? { startedAt: crossing.startedAt, endedAt: crossing.settledAt } : undefined;
}

/**
 * Settles a tool row with `value` (`completed`) or as `cancelled`, and writes its one
 * `tool.completed` (an agent's tool call), or `node.completed` (a flow's HTTP stage or verifier,
 * which names no call, R7.1). Writes `row`.
 */
export async function settleToolRow(
  t: Tx,
  s: Pick<Session, "id">,
  row: ToolRow,
  value: unknown,
  options: {
    cancelled?: boolean;
    now?: Date;
    /** Who reported the outcome (R4.9): the harness that ran the call; absent, core. */
    writer?: EventWriter;
  } = {},
): Promise<{ value: unknown }> {
  const request = row.request as HostEffect;
  row.status = options.cancelled ? "cancelled" : "completed";
  row.outcome = { value };
  row.settledAt = (options.now ?? new Date()).toISOString();
  await t.put("effects", request.effectId, row);
  const status = toolCallStatus(row) as ToolCallStatus;
  const gate = await gateOf(t, row);
  if (isFlowToolEffect(request)) {
    const durationMs = toolCallDuration(row);
    await t.event(
      s.id,
      request.turnId,
      "node.completed",
      {
        path: request.path!,
        kind: row.toolKind ?? "http",
        key: request.key!,
        ...(request.iterations !== undefined ? { iterations: request.iterations } : {}),
        effectId: request.effectId,
        status,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(gate === undefined ? {} : { gate }),
      },
      options.writer,
    );
    return row.outcome;
  }
  const transcript = toolCompleted(request, value, factsOf(row, status, gate));
  if (transcript)
    await t.event(s.id, request.turnId, "tool.completed", transcript as EventPayload<"tool.completed">, options.writer);
  return row.outcome;
}
