/**
 * A2A tasks over Nylorun sessions: a context is one session per subject, agent and
 * `contextId`; a task is one turn of it. The task id names both (`t1.<context>.<turn>`) until
 * the turn index lets a turn id stand alone; it is parsed, never trusted, because the session
 * is always derived from the caller's own subject. `buildTask` reads the state from the session
 * row and the turn's events; nothing here touches the store.
 */
import { createHash } from "node:crypto";
import type { LiveEvent } from "@nylorun/core/contracts";
import type { Artifact, Message, Part, Task, TaskState } from "./protocol.js";

const TASK_ID_PREFIX = "t1";

export function taskIdOf(contextId: string, turnId: string): string {
  return `${TASK_ID_PREFIX}.${Buffer.from(contextId, "utf8").toString("base64url")}.${turnId}`;
}

/** The context and turn a task id names, or undefined for anything this Runtime never issued. */
export function parseTaskId(id: string): { contextId: string; turnId: string } | undefined {
  const [prefix, context, turnId, ...rest] = id.split(".");
  if (prefix !== TASK_ID_PREFIX || !context || !turnId || rest.length > 0) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(context) || !/^[A-Za-z0-9-]{1,64}$/.test(turnId))
    return undefined;
  const contextId = Buffer.from(context, "base64url").toString("utf8");
  // Only the canonical encoding: two ids must never name one task.
  if (taskIdOf(contextId, turnId) !== id) return undefined;
  return { contextId, turnId };
}

/** The session behind a subject's A2A context with one agent. */
export function contextSessionId(subject: string, agentId: string, contextId: string): string {
  return createHash("sha256")
    .update(`a2a\u0000${subject}\u0000${agentId}\u0000${contextId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * The context the Runtime generates for a message that names none: derived from the message
 * id, so a retried message lands in the same context and replays instead of starting a task.
 * UUID-shaped, and opaque to clients.
 */
export function newContextId(subject: string, agentId: string, messageId: string): string {
  const hex = createHash("sha256")
    .update(`a2a-context\u0000${subject}\u0000${agentId}\u0000${messageId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The session fields a task's state comes from (`Session` in `tenant/context.ts`). */
export interface SessionSnapshot {
  readonly status: string;
  readonly activeTurnId: string | null;
  readonly lastTurnId?: string;
  readonly lastOutput?: unknown;
  readonly waits?: unknown;
}

/** An interaction the paused turn waits for. */
export interface PendingInteraction {
  readonly id: string;
  readonly kind: string;
  readonly prompt: string;
}

/** The first interaction a paused session waits for. */
export function pendingInteraction(session: SessionSnapshot): PendingInteraction | undefined {
  if (!Array.isArray(session.waits)) return undefined;
  for (const call of session.waits as { status?: unknown; interaction?: any }[]) {
    const interaction = call?.interaction;
    if (call?.status !== "interaction" || typeof interaction?.id !== "string") continue;
    return {
      id: interaction.id,
      kind: typeof interaction.kind === "string" ? interaction.kind : "response",
      prompt: typeof interaction.prompt === "string" ? interaction.prompt : "",
    };
  }
  return undefined;
}

const ENDED = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
/** Events after which a blocking `SendMessage` returns: the turn ended or is interrupted. */
export const SETTLED_EVENTS: ReadonlySet<string> = new Set([
  ...ENDED,
  "turn.paused",
  "effect.uncertain",
]);

/** A turn output as one part: text for a string, JSON data for anything else. */
function outputPart(output: unknown): Part {
  return typeof output === "string"
    ? { text: output }
    : { data: output, mediaType: "application/json" };
}

function valuePart(value: unknown): Part {
  return typeof value === "string" ? { text: value } : { data: value ?? null };
}

/** The client's own message id when an A2A caller sent the command. */
function clientMessageId(event: LiveEvent): string {
  const key = (event.payload as { idempotencyKey?: unknown } | null)?.idempotencyKey;
  return typeof key === "string" && key.startsWith("a2a:") ? key.slice(4) : event.eventId;
}

/** The turn's conversation as A2A messages: what the caller sent and what the agent said. */
export function historyOf(events: readonly LiveEvent[], contextId: string, taskId: string): Message[] {
  const messages: Message[] = [];
  const add = (messageId: string, role: Message["role"], parts: Part[]) =>
    messages.push({ messageId, role, parts, contextId, taskId });
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, any>;
    switch (event.type) {
      case "command.message":
        add(
          clientMessageId(event),
          "ROLE_USER",
          ["content" in payload ? { text: String(payload.content) } : valuePart(payload.data)]
        );
        break;
      case "command.respond":
        add(clientMessageId(event), "ROLE_USER", [valuePart(payload.value)]);
        break;
      case "message.assistant":
        // Agents used as tools speak inside the turn; only the agent's own words are history.
        if (!payload.agent && typeof payload.text === "string" && payload.text.trim() !== "")
          add(event.eventId, "ROLE_AGENT", [{ text: payload.text }]);
        break;
      case "turn.paused":
        for (const entry of Array.isArray(payload.interactions) ? payload.interactions : []) {
          const interaction = entry?.interaction;
          if (typeof interaction?.id === "string" && typeof interaction.prompt === "string")
            add(interaction.id, "ROLE_AGENT", [{ text: interaction.prompt }]);
        }
        break;
    }
  }
  return messages;
}

function agentMessage(messageId: string, text: string, contextId: string, taskId: string): Message {
  return { messageId, role: "ROLE_AGENT", parts: [{ text }], contextId, taskId };
}

function failureText(code: unknown): string {
  return typeof code === "string" && code !== ""
    ? `The agent failed (${code}).`
    : "The agent failed.";
}

export interface BuildTaskInput {
  readonly contextId: string;
  readonly turnId: string;
  readonly session: SessionSnapshot;
  /** Every event of the turn, in stream order. */
  readonly events: readonly LiveEvent[];
  readonly historyLength?: number;
}

/**
 * The task for one turn, or undefined when the session never had that turn. An active turn
 * takes its state from the session row; an ended one from its terminal event, or from the row
 * while that event has not reached the stream yet.
 */
export function buildTask(input: BuildTaskInput): Task | undefined {
  const { contextId, turnId, session, events } = input;
  const taskId = taskIdOf(contextId, turnId);
  const active = session.activeTurnId === turnId;
  const terminal = [...events].reverse().find((event) => ENDED.has(event.type));
  const latest = session.lastTurnId === turnId && !active;
  if (!active && !terminal && !latest && events.length === 0) return undefined;
  let state: TaskState;
  let message: Message | undefined;
  let artifacts: Artifact[] | undefined;
  const complete = (output: unknown) => {
    state = "TASK_STATE_COMPLETED";
    if (output !== undefined && output !== null)
      artifacts = [{ artifactId: "output", name: "output", parts: [outputPart(output)] }];
  };
  if (active) {
    const pending = session.status === "paused" ? pendingInteraction(session) : undefined;
    if (pending) {
      state = "TASK_STATE_INPUT_REQUIRED";
      message = agentMessage(pending.id, pending.prompt, contextId, taskId);
    } else {
      state = "TASK_STATE_WORKING";
      if (session.status === "uncertain")
        message = agentMessage(
          `${turnId}:uncertain`,
          "An action's outcome is uncertain; the agent's operator must resolve it before the task continues.",
          contextId,
          taskId
        );
    }
  } else if (terminal) {
    const payload = (terminal.payload ?? {}) as Record<string, any>;
    if (terminal.type === "turn.completed") complete(payload.output);
    else if (terminal.type === "turn.cancelled") state = "TASK_STATE_CANCELED";
    else {
      state = "TASK_STATE_FAILED";
      message = agentMessage(`${turnId}:failed`, failureText(payload.error?.code), contextId, taskId);
    }
  } else if (latest && session.status === "completed") complete(session.lastOutput);
  else if (latest && session.status === "cancelled") state = "TASK_STATE_CANCELED";
  else if (latest && session.status === "failed") {
    state = "TASK_STATE_FAILED";
    message = agentMessage(`${turnId}:failed`, failureText(undefined), contextId, taskId);
  } else state = "TASK_STATE_WORKING";
  const timestamp = events.at(-1)?.createdAt;
  const history = historyOf(events, contextId, taskId);
  const limit = input.historyLength;
  return {
    id: taskId,
    contextId,
    status: {
      state: state!,
      ...(message ? { message } : {}),
      ...(timestamp ? { timestamp } : {}),
    },
    ...(artifacts ? { artifacts } : {}),
    ...(limit === 0 ? {} : { history: limit === undefined ? history : history.slice(-limit) }),
  };
}
