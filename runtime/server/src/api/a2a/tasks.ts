/**
 * A2A tasks over Nylorun sessions: a context is one session per subject, agent and
 * `contextId`; a task is one turn of it. The task id names both (`t1.<context>.<turn>`) until
 * the turn index lets a turn id stand alone; it is parsed, never trusted, because the session
 * is always derived from the caller's own subject; a queued message's task is named by the
 * message's queue id until a turn takes it. `buildTask` reads the state from the session row and
 * the turn's events, with the profile v2 data (interactions, progress, telemetry, effects,
 * files); `updatesOf` is the one translator from a session event to the A2A updates pushes carry.
 * Nothing here touches the store.
 */
import { createHash } from "node:crypto";
import type { LiveEvent } from "@nylorun/core/contracts";
import { A2A_EXTENSIONS } from "./extensions.js";
import type { Artifact, Message, Part, StreamResponse, Task, TaskState } from "./protocol.js";

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

/**
 * An interaction the paused turn waits for, as profile v2 names it (`interactions/v1`):
 * `approval` (a held tool call or an engine approval, answered with `approve`), `question` (an
 * ask, answered with `respond`) or `connection` (an ask whose metadata says `kind: "connection"`:
 * the agent needs an account the person has not connected; answered with `respond`).
 */
export interface PendingInteraction {
  readonly id: string;
  readonly kind: "approval" | "question" | "connection";
  /** The engine's kind: which command answers it. */
  readonly engineKind: "approval" | "response";
  readonly prompt: string;
  /** What a person needs to decide: a held call's server, tool and reason; an ask's metadata. */
  readonly detail?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An interaction from a session's waits or a `turn.paused` payload; never a call's input. */
export function interactionOf(raw: unknown): PendingInteraction | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string") return undefined;
  const engineKind = raw.kind === "approval" ? "approval" : "response";
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const kind =
    raw.kind === "connection" || metadata?.kind === "connection"
      ? "connection"
      : engineKind === "approval"
      ? "approval"
      : "question";
  let detail: Record<string, unknown> | undefined;
  if (engineKind === "approval" && kind === "approval") {
    // A held tool call names its tool; its arguments stay with the Runtime (profile v2 §1).
    const held = Object.fromEntries(
      (["server", "tool", "reason"] as const).flatMap((key) =>
        typeof raw[key] === "string" ? [[key, raw[key]]] : []
      )
    );
    detail = Object.keys(held).length > 0 ? held : metadata;
  } else if (metadata) {
    const { kind: _kind, ...rest } = metadata;
    detail = Object.keys(rest).length > 0 ? rest : undefined;
  }
  return {
    id: raw.id,
    kind,
    engineKind,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    ...(detail ? { detail } : {}),
  };
}

/** The interactions a paused session waits for, in order. */
export function pendingInteractions(session: SessionSnapshot): PendingInteraction[] {
  if (!Array.isArray(session.waits)) return [];
  return (session.waits as { status?: unknown; interaction?: unknown }[]).flatMap((call) => {
    const interaction = call?.status === "interaction" ? interactionOf(call.interaction) : undefined;
    return interaction ? [interaction] : [];
  });
}

/** The first interaction a paused session waits for. */
export function pendingInteraction(session: SessionSnapshot): PendingInteraction | undefined {
  return pendingInteractions(session)[0];
}

/** The state a task waiting on `interaction` is in (profile v2 §1). */
export function interruptedState(interaction: PendingInteraction): TaskState {
  return interaction.kind === "question" ? "TASK_STATE_INPUT_REQUIRED" : "TASK_STATE_AUTH_REQUIRED";
}

/** The status message that shows an open interaction, with its `interactions/v1` data. */
export function interactionMessage(
  interaction: PendingInteraction,
  contextId: string,
  taskId: string
): Message {
  return {
    messageId: interaction.id,
    role: "ROLE_AGENT",
    parts: [{ text: interaction.prompt }],
    contextId,
    taskId,
    extensions: [A2A_EXTENSIONS.interactions],
    metadata: {
      [A2A_EXTENSIONS.interactions]: {
        interactionId: interaction.id,
        kind: interaction.kind,
        prompt: interaction.prompt,
        ...(interaction.detail ? { detail: interaction.detail } : {}),
      },
    },
  };
}

export const ENDED: ReadonlySet<string> = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
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
          "content" in payload
            ? [{ text: String(payload.content) }]
            : Array.isArray(payload.parts)
            ? // Parts (protocol 6): text as text, a file part as its artifact reference.
              payload.parts.map((part: { type?: string; text?: unknown }) =>
                part.type === "text" ? valuePart(part.text) : valuePart(part)
              )
            : [valuePart(payload.data)]
        );
        break;
      case "command.respond":
        add(clientMessageId(event), "ROLE_USER", [valuePart(payload.value)]);
        break;
      case "message.assistant":
        // Agents used as tools speak inside the turn; only the agent's own words are history. A
        // step that said nothing (`text: ""`, R7.1) is none.
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

const UNCERTAIN_TEXT =
  "An action's outcome is uncertain; the agent's operator must resolve it before the task continues.";

/** How the A2A server shows one task: the ids its caller knows, and where its files are served. */
export interface TaskView {
  readonly contextId: string;
  /** The task id the caller knows: a queued message's own until a turn takes it. */
  readonly taskId: string;
  /** The Runtime's public URL, for file artifacts' `url` parts (`/v1/a2a/files/…`). */
  readonly baseUrl?: string;
  /** `telemetry/v1`'s trace id: the caller's `traceparent`'s, else the Runtime's own. */
  readonly traceId?: string;
}

// ---------------------------------------------------------------------------
// Profile v2 data

/** The states of a plan step (`progress/v1`, Contract 1). */
const STEP_STATES = new Set(["pending", "active", "done", "blocked", "skipped"]);
const MAX_STEPS = 20;
const MAX_LABEL = 120;
const MAX_NOTE = 280;

/**
 * `progress/v1` from a `plan.updated` payload (`{ steps }`, the whole plan each time): at most
 * 20 steps, each a label, a state and an optional note, cut to their lengths. Undefined when the
 * payload holds no plan.
 */
export function progressOf(payload: unknown): { steps: Record<string, string>[] } | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.steps)) return undefined;
  const steps = payload.steps.slice(0, MAX_STEPS).flatMap((step) => {
    if (!isRecord(step) || typeof step.label !== "string") return [];
    const state = typeof step.state === "string" && STEP_STATES.has(step.state) ? step.state : "pending";
    return [
      {
        label: step.label.slice(0, MAX_LABEL),
        state,
        ...(typeof step.note === "string" && step.note !== "" ? { note: step.note.slice(0, MAX_NOTE) } : {}),
      },
    ];
  });
  return { steps };
}

/** `telemetry/v1` from a terminal event's end facts (`totals`) and the task's trace id. */
export function telemetryOf(payload: unknown, traceId: string | undefined): Record<string, unknown> | undefined {
  const totals = isRecord(payload) && isRecord(payload.totals) ? payload.totals : undefined;
  const value = {
    ...(totals
      ? {
          totals: {
            steps: Number(totals.steps ?? 0),
            tokens: Number(totals.tokens ?? 0),
            costUsd: Number(totals.costUsd ?? 0),
          },
        }
      : {}),
    ...(traceId ? { traceId } : {}),
  };
  return Object.keys(value).length > 0 ? value : undefined;
}

/** The URL a caller downloads a file artifact's version from (scoped to the caller's subject). */
export function fileUrl(baseUrl: string | undefined, artifactId: string, version: number): string {
  return `${baseUrl ?? ""}/v1/a2a/files/${encodeURIComponent(artifactId)}/versions/${version}`;
}

/**
 * The A2A artifact of a file the turn wrote (`artifact.created`, `artifact.version.created`), with
 * `files/v1`, or undefined for the caller's own uploads. A folder is served as its zip.
 */
export function fileArtifact(payload: unknown, baseUrl: string | undefined): Artifact | undefined {
  if (!isRecord(payload) || typeof payload.artifactId !== "string" || typeof payload.name !== "string")
    return undefined;
  if (payload.source === "upload") return undefined;
  const version = Number(payload.version);
  const folder = payload.kind === "folder";
  return {
    artifactId: `${payload.artifactId}:${payload.name}`,
    name: payload.name,
    parts: [
      {
        url: fileUrl(baseUrl, payload.artifactId, version),
        mediaType: folder ? "application/zip" : String(payload.contentType ?? "application/octet-stream"),
        filename: folder ? `${payload.name}.zip` : payload.name,
      },
    ],
    extensions: [A2A_EXTENSIONS.files],
    metadata: {
      [A2A_EXTENSIONS.files]: {
        kind: folder ? "folder" : "file",
        path: payload.name,
        version,
        size: Number(payload.size ?? 0),
        sha256: String(payload.sha256 ?? ""),
        ...(typeof payload.fileCount === "number" ? { fileCount: payload.fileCount } : {}),
      },
    },
  };
}

const FILE_EVENTS = new Set(["artifact.created", "artifact.version.created"]);

function outputArtifact(output: unknown): Artifact | undefined {
  return output === undefined || output === null
    ? undefined
    : { artifactId: "output", name: "output", parts: [outputPart(output)] };
}

/**
 * The single translator from session events to A2A updates (profile v2, pushes): what one event
 * of the task's turn changes, as `StreamResponse`s. Every status update carries the event's time
 * as `status.timestamp`; clients order by it. Tool calls, arguments, results and delegations
 * never show (profile v2 §1): only states, step text, plans, interactions, files and the end.
 */
export function updatesOf(event: LiveEvent, view: TaskView): StreamResponse[] {
  const { contextId, taskId } = view;
  const payload = (event.payload ?? {}) as Record<string, any>;
  const status = (
    state: TaskState,
    extra: { message?: Message; metadata?: Record<string, unknown> } = {}
  ): StreamResponse => ({
    statusUpdate: {
      taskId,
      contextId,
      status: { state, ...(extra.message ? { message: extra.message } : {}), timestamp: event.time },
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    },
  });
  const artifact = (value: Artifact): StreamResponse => ({
    artifactUpdate: { taskId, contextId, artifact: value, append: false, lastChunk: true },
  });
  switch (event.type) {
    case "command.message":
    case "command.approve":
    case "command.respond":
      return [status("TASK_STATE_WORKING")];
    case "plan.updated": {
      const progress = progressOf(payload);
      return progress ? [status("TASK_STATE_WORKING", { metadata: { [A2A_EXTENSIONS.progress]: progress } })] : [];
    }
    case "message.assistant":
      // The agent's own step text; an agent used as a tool speaks inside the turn.
      return !payload.agent && typeof payload.text === "string" && payload.text.trim() !== ""
        ? [status("TASK_STATE_WORKING", { message: agentMessage(event.eventId, payload.text, contextId, taskId) })]
        : [];
    case "effect.uncertain":
      return [
        status("TASK_STATE_WORKING", {
          message: agentMessage(`${event.eventId}:uncertain`, UNCERTAIN_TEXT, contextId, taskId),
          metadata: { [A2A_EXTENSIONS.effects]: { uncertain: String(payload.effectId ?? "") } },
        }),
      ];
    case "turn.paused":
      return (Array.isArray(payload.interactions) ? payload.interactions : []).flatMap((entry: any) => {
        const interaction = interactionOf(entry?.interaction);
        return interaction
          ? [status(interruptedState(interaction), { message: interactionMessage(interaction, contextId, taskId) })]
          : [];
      });
    case "artifact.created":
    case "artifact.version.created": {
      const file = fileArtifact(payload, view.baseUrl);
      return file ? [artifact(file)] : [];
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": {
      const telemetry = telemetryOf(payload, view.traceId);
      const metadata = telemetry ? { [A2A_EXTENSIONS.telemetry]: telemetry } : undefined;
      if (event.type === "turn.completed") {
        const output = outputArtifact(payload.output);
        return [
          ...(output ? [artifact(output)] : []),
          status("TASK_STATE_COMPLETED", metadata ? { metadata } : {}),
        ];
      }
      if (event.type === "turn.cancelled") return [status("TASK_STATE_CANCELED", metadata ? { metadata } : {})];
      return [
        status("TASK_STATE_FAILED", {
          message: agentMessage(`${event.turnId}:failed`, failureText(payload.error?.code), contextId, taskId),
          ...(metadata ? { metadata } : {}),
        }),
      ];
    }
    default:
      return [];
  }
}

/**
 * The trace id of a turn the caller started with a `traceparent` (its `command.message`), or
 * undefined: the Runtime's own then (`traceIdOf`).
 */
export function callerTraceId(events: readonly LiveEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "command.message") continue;
    const traceparent = (event.payload as { trace?: { traceparent?: unknown } } | null)?.trace?.traceparent;
    const match = typeof traceparent === "string" ? /^[0-9a-f]{2}-([0-9a-f]{32})-/.exec(traceparent) : null;
    if (match) return match[1];
  }
  return undefined;
}

export interface BuildTaskInput {
  readonly contextId: string;
  readonly turnId: string;
  readonly session: SessionSnapshot;
  /** Every event of the turn, in stream order. */
  readonly events: readonly LiveEvent[];
  readonly historyLength?: number;
  /** The id the caller knows the task by, when not the turn's own (a queued message's). */
  readonly taskId?: string;
  readonly baseUrl?: string;
  readonly traceId?: string;
}

/**
 * The task for one turn, or undefined when the session never had that turn. An active turn
 * takes its state from the session row; an ended one from its terminal event, or from the row
 * while that event has not reached the stream yet. Its metadata holds the latest plan
 * (`progress/v1`), the uncertain effect (`effects/v1`) and, once it ended, `telemetry/v1`; its
 * artifacts are the output and the files the turn wrote (`files/v1`).
 */
export function buildTask(input: BuildTaskInput): Task | undefined {
  const { contextId, turnId, session, events } = input;
  const taskId = input.taskId ?? taskIdOf(contextId, turnId);
  const active = session.activeTurnId === turnId;
  const terminal = [...events].reverse().find((event) => ENDED.has(event.type));
  const latest = session.lastTurnId === turnId && !active;
  if (!active && !terminal && !latest && events.length === 0) return undefined;
  let state: TaskState;
  let message: Message | undefined;
  let output: Artifact | undefined;
  const metadata: Record<string, unknown> = {};
  const complete = (value: unknown) => {
    state = "TASK_STATE_COMPLETED";
    output = outputArtifact(value);
  };
  if (active) {
    const pending = session.status === "paused" ? pendingInteraction(session) : undefined;
    if (pending) {
      state = interruptedState(pending);
      message = interactionMessage(pending, contextId, taskId);
    } else {
      state = "TASK_STATE_WORKING";
      if (session.status === "uncertain") {
        message = agentMessage(`${turnId}:uncertain`, UNCERTAIN_TEXT, contextId, taskId);
        const uncertain = [...events].reverse().find((event) => event.type === "effect.uncertain");
        const effectId = (uncertain?.payload as { effectId?: unknown } | undefined)?.effectId;
        if (typeof effectId === "string") metadata[A2A_EXTENSIONS.effects] = { uncertain: effectId };
      }
    }
  } else if (terminal) {
    const payload = (terminal.payload ?? {}) as Record<string, any>;
    if (terminal.type === "turn.completed") complete(payload.output);
    else if (terminal.type === "turn.cancelled") state = "TASK_STATE_CANCELED";
    else {
      state = "TASK_STATE_FAILED";
      message = agentMessage(`${turnId}:failed`, failureText(payload.error?.code), contextId, taskId);
    }
    const telemetry = telemetryOf(payload, input.traceId);
    if (telemetry) metadata[A2A_EXTENSIONS.telemetry] = telemetry;
  } else if (latest && session.status === "completed") complete(session.lastOutput);
  else if (latest && session.status === "cancelled") state = "TASK_STATE_CANCELED";
  else if (latest && session.status === "failed") {
    state = "TASK_STATE_FAILED";
    message = agentMessage(`${turnId}:failed`, failureText(undefined), contextId, taskId);
  } else state = "TASK_STATE_WORKING";
  // The latest plan, and the files the turn wrote (the latest version of each, none deleted).
  const files = new Map<string, Artifact>();
  for (const event of events) {
    if (event.type === "plan.updated") {
      const progress = progressOf(event.payload);
      if (progress) metadata[A2A_EXTENSIONS.progress] = progress;
    } else if (FILE_EVENTS.has(event.type)) {
      const file = fileArtifact(event.payload, input.baseUrl);
      if (file) files.set(String((event.payload as { artifactId: string }).artifactId), file);
    } else if (event.type === "artifact.deleted")
      files.delete(String((event.payload as { artifactId?: unknown }).artifactId));
  }
  const artifacts = [...(output ? [output] : []), ...files.values()];
  const timestamp = events.at(-1)?.time;
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
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(limit === 0 ? {} : { history: limit === undefined ? history : history.slice(-limit) }),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/**
 * A queued message's task while it waits (profile v2 §1): `SUBMITTED`, from its `message.queued`
 * event, until a turn takes it.
 */
export function submittedTask(contextId: string, taskId: string, queued: LiveEvent): Task {
  return {
    id: taskId,
    contextId,
    status: { state: "TASK_STATE_SUBMITTED", timestamp: queued.time },
    history: [],
  };
}
