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
import type { EffectTarget } from "@nylorun/core/harness-api";
import type { DurableSessionTool, HostEffect } from "../run/durable.js";
import { cut } from "./plan.js";

/** The tool's name. */
export const REQUEST_CONNECTION_TOOL = "request_connection";
/** The most characters of the app's name and of the reason. */
export const CONNECTION_LIMITS = Object.freeze({ appChars: 80, reasonChars: 280 });

const HARNESS: EffectTarget = Object.freeze({ kind: "harness" });

const DESCRIPTION = [
  "Ask the person or agent who gave you this task to connect an app you need and cannot reach, such as their GitHub, Linear or Google Drive, then wait for their answer.",
  "Give the app's name and the reason, in a sentence they can act on.",
  "It answers Connected: <app> once they connected it, so try again; or Not connected: <app>, so go on without it or say what you could not do.",
  "Use it only when a tool says the app is not connected or its credential is missing; never to ask anything else.",
].join(" ");

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    app: {
      type: "string",
      minLength: 1,
      description: `The app to connect, by its name (at most ${CONNECTION_LIMITS.appChars} characters).`,
    },
    reason: {
      type: "string",
      minLength: 1,
      description: `Why you need it, in a sentence (at most ${CONNECTION_LIMITS.reasonChars} characters).`,
    },
  },
  required: ["app", "reason"],
  additionalProperties: false,
} as const;

const INSTRUCTIONS =
  "When a tool fails because an app is not connected or its credential is missing, ask for it with request_connection, then try again once it is connected.";

/** The tool, and the text the model reads with it. */
export function connectionTool(): { tool: DurableSessionTool; instructions: string } {
  return {
    tool: {
      name: REQUEST_CONNECTION_TOOL,
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA as unknown as DurableSessionTool["inputSchema"],
      target: HARNESS,
    },
    instructions: INSTRUCTIONS,
  };
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
