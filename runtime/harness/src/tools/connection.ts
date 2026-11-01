/**
 * `request_connection` (A2A profile v2, `interactions/v1` kind `connection`): the agent asks
 * whoever started the task to connect an app it needs (an account, a workspace), and waits.
 * Offered to the session's root agent when the version the session runs sets
 * `harness.loop.connections: true` (`turn.start.loop.connections`; in an agent folder,
 * `loop: { connections: true }` in `AGENT.md`), unless the agent has its own tool of that name.
 *
 * It runs here (`harness`). A first call pauses the turn with an interaction of kind `response`
 * whose `metadata` is `{ kind: "connection", app, reason }`, which the session's waits carry and
 * the A2A server shows as kind `connection`. The answer (`respond`) runs it again, in the next
 * segment, with the value: `true` or `{ connected: true }` answers `Connected: <app>`, anything
 * else `Not connected: <app>`. A replayed call answers its recorded outcome.
 *
 * Long input is cut, never refused: an app of at most `CONNECTION_LIMITS.appChars` characters
 * and a reason of at most `reasonChars`, each cut ending in `…`.
 */
import {
  CONNECTION_LIMITS,
  CONNECTION_TEXT,
  REQUEST_CONNECTION_TOOL,
  connectionToolOf,
} from "@nylorun/core/engine";
import type { DurableSessionTool, HostEffect } from "../run/durable.js";
import { cut } from "./plan.js";

export { CONNECTION_LIMITS, REQUEST_CONNECTION_TOOL } from "@nylorun/core/engine";

/** The tool, and the text the model reads with it (block `connection`, `@nylorun/core/engine`). */
export function connectionTool(): { tool: DurableSessionTool; instructions: string } {
  return { tool: connectionToolOf(), instructions: CONNECTION_TEXT };
}

/** True when `effect` is a call of `request_connection` (ours: a `harness` call). */
export function isConnectionTool(effect: HostEffect): boolean {
  return effect.target?.kind === "harness" && effect.toolName === REQUEST_CONNECTION_TOOL;
}

/** Whether an answer says the app is connected: `true`, or `{ connected: true }`. */
export function connectedIn(value: unknown): boolean {
  if (value === true) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { connected?: unknown }).connected === true
  );
}

/**
 * Runs a call of `request_connection`: the interaction to wait on, or, once answered (the effect's
 * `context.resume`), what the answer says.
 */
export function runConnectionTool(effect: HostEffect) {
  const input = (effect.input ?? {}) as { app?: unknown; reason?: unknown };
  const app = typeof input.app === "string" ? input.app.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (app === "" || reason === "")
    return {
      kind: "failed",
      code: "connection.invalid_input",
      message: "Give app, the app to connect, and reason, why you need it.",
    } as const;
  const named = cut(app, CONNECTION_LIMITS.appChars);
  const why = cut(reason, CONNECTION_LIMITS.reasonChars);
  const resume = effect.context?.resume as { kind?: unknown; value?: unknown } | undefined;
  if (resume?.kind === "response")
    return {
      kind: "completed",
      output: connectedIn(resume.value) ? `Connected: ${named}` : `Not connected: ${named}`,
    } as const;
  return {
    kind: "interaction-required",
    interaction: {
      kind: "response",
      prompt: `Connect ${named}: ${why}`,
      metadata: { kind: "connection", app: named, reason: why },
    },
  } as const;
}
