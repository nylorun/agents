/**
 * The effect journal's tool calls (R5): every tool call is a row of `nylorun.effects`, and how
 * it ends is one `tool.completed` with its status, kind, server, attempts and duration (R5.1).
 *
 * Delivery (R5.3, R5.4). A tool call is sent at least once, and every send carries its effect
 * id as the key. After a crash, a shutdown or a lost gate hop, a row still `invoking` is sent
 * again: an MCP or HTTP tool call (it crosses the Tool Gate, which hands the tool the key) up to
 * `MAX_TOOL_ATTEMPTS` sends, then it fails to the model as `tool.interrupted`. A sandbox or
 * core-served call has no key to dedupe on, so a crash fails it to the model at once, and
 * nothing runs it again (Q2). No tool call leaves its session `uncertain`.
 *
 * The row body keeps the journal's facts: `toolKind`, `server`, `attempts`, `startedAt` and
 * `settledAt`. A row written before R5 has none of them.
 */
import type { EventPayload, EventWriter } from "@nylorun/core/contracts";
import type { AgentManifest } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { isHttpToolCall } from "../gates/http-tool.js";
import { mcpToolOf } from "../mcp/snapshot.js";
import { sandboxCapabilityOf } from "../sandbox/capability.js";
import type { Session } from "../tenant/context.js";
import {
  toolCompleted,
  type ToolCallFacts,
  type ToolCallKind,
  type ToolCallStatus,
} from "../tenant/transcript.js";
import type { EffectDoc, Tx } from "../store/types.js";
import { toolCallDuration, toolCallStatus } from "./tool-status.js";

/** How many times a tool call is sent before it fails to the model as `tool.interrupted`. */
export const MAX_TOOL_ATTEMPTS = 3;

/** A tool row's journal facts (R5), kept in its body. */
export interface ToolRowFacts {
  toolKind?: ToolCallKind;
  server?: string;
  attempts?: number;
  startedAt?: string;
  settledAt?: string;
}

export type ToolRow = EffectDoc &
  ToolRowFacts & {
    requestHash?: string;
    outcome?: { value: unknown; statePatch?: Record<string, unknown> };
    error?: string;
  };

/** Where a tool call runs, and its MCP server or HTTP tool capability. */
export function toolKindOf(
  s: Pick<Session, "manifest" | "mcpSnapshot">,
  agentManifest: AgentManifest | undefined,
  request: HostEffect,
): { toolKind: ToolCallKind; server?: string } {
  const mcp = mcpToolOf(s.mcpSnapshot, request);
  if (mcp) return { toolKind: "mcp", server: mcp.serverName };
  if (isHttpToolCall(s.manifest, request))
    return { toolKind: "http", ...(request.capabilityId ? { server: request.capabilityId } : {}) };
  if (sandboxCapabilityOf(agentManifest, request.capabilityId, request.toolName))
    return { toolKind: "sandbox" };
  return { toolKind: "platform" };
}

/** The facts a new tool row starts with: its first send, now. */
export function firstSend(kind: { toolKind: ToolCallKind; server?: string }, now = new Date()): ToolRowFacts {
  return { ...kind, attempts: 1, startedAt: now.toISOString() };
}

/** A failed outcome the Runtime gives a call a crash interrupted: it may have run. */
export function interrupted(message: string) {
  return { kind: "failed", code: "tool.interrupted", message, retryable: false };
}

/** The facts `tool.completed` carries for `row`, settled with `status`. */
export function factsOf(row: ToolRow, status: ToolCallStatus): ToolCallFacts {
  const durationMs = toolCallDuration(row);
  return {
    status,
    ...(row.toolKind === undefined ? {} : { kind: row.toolKind }),
    ...(row.server === undefined ? {} : { server: row.server }),
    ...(row.attempts === undefined ? {} : { attempts: row.attempts }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

/**
 * Settles a tool row with `value` (`completed`) or as `cancelled`, and writes its one
 * `tool.completed` (an agent's tool call; a flow's HTTP stage names no call and writes none).
 * Writes `row`.
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
  const transcript = toolCompleted(request, value, factsOf(row, status));
  if (transcript)
    await t.event(s.id, request.turnId, "tool.completed", transcript as EventPayload<"tool.completed">, options.writer);
  return row.outcome;
}
