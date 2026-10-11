/**
 * How a tool row of the effect journal reads (R5.1, R5.2), from its body alone: shared by the
 * journal (`tool-journal.ts`) and the session reads (`/calls/tool`).
 */
import { durationBetween } from "../tenant/transcript.js";

/** The codes of a call the Runtime ended rather than the tool: its status is `failed`. */
const RUNTIME_ENDED = new Set(["tool.disabled", "tool.unavailable", "tool.interrupted", "tool.denied"]);

/** What a tool row's body says of how it ended. */
export interface ToolRowState {
  readonly status: string;
  readonly outcome?: { readonly value: unknown };
  readonly startedAt?: string;
  readonly settledAt?: string;
}

/** How a tool row ended, as `tool.completed` and `/calls/tool` say it. */
export function toolCallStatus(
  row: ToolRowState,
): "completed" | "failed" | "cancelled" | "invoking" | "held" | "uncertain" {
  if (row.status === "cancelled") return "cancelled";
  if (row.status === "held") return "held";
  if (row.status === "uncertain") return "uncertain";
  if (row.status !== "completed") return "invoking";
  const value = row.outcome?.value as { kind?: unknown; code?: unknown } | null | undefined;
  return value?.kind === "failed" && typeof value.code === "string" && RUNTIME_ENDED.has(value.code)
    ? "failed"
    : "completed";
}

/** From the first send to the outcome, or undefined when the call never ran or has not ended. */
export function toolCallDuration(row: ToolRowState): number | undefined {
  return durationBetween(row.startedAt, row.settledAt);
}
