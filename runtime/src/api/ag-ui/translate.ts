/**
 * Runtime transcript events → AG-UI 1.0 events for one run. Ids: an assistant message is its
 * model call's `invocationId`, a tool call is the model's `callId`, a tool result is
 * `<callId>:result`, so live runs and `messagesFromEvents` agree.
 */
import { EventType, type BaseEvent, type Interrupt } from "@ag-ui/core";
import {
  parseTranscriptEvent,
  type LiveEvent,
  type TranscriptEvent,
} from "@nylorun/core/contracts";

/** The text a tool result shows; `undefined` while there is no result yet. */
export function toolResultText(result: unknown): string | undefined {
  const value = result as {
    kind?: unknown;
    output?: unknown;
    code?: unknown;
    message?: unknown;
    reason?: unknown;
  } | null;
  switch (value?.kind) {
    case "completed":
      return outputText(value.output ?? null);
    case "failed":
      return JSON.stringify({ error: value.code, message: value.message });
    case "denied":
      return JSON.stringify({ denied: true, reason: value.reason });
    default:
      // interaction-required and deferred: the call is still open.
      return undefined;
  }
}

export function outputText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

/** One Runtime event's result for a run: AG-UI events, and whether the run ended. */
export interface Step {
  readonly events: BaseEvent[];
  readonly finished: boolean;
}

const none: Step = { events: [], finished: false };

/** A tool result from any of the three places a call can end. */
export function toolResultOf(
  event: TranscriptEvent
): { callId: string; content: string } | undefined {
  switch (event.type) {
    case "action.completed": {
      const p = event.payload;
      if (p.kind !== "tool" || !p.callId || p.agent) return undefined;
      const content = toolResultText(p.result);
      return content === undefined ? undefined : { callId: p.callId, content };
    }
    case "tool.completed": {
      const p = event.payload;
      if (p.agent) return undefined;
      return {
        callId: p.callId,
        content:
          p.error !== undefined
            ? JSON.stringify({ error: p.error.code, message: p.error.message })
            : outputText(p.output ?? null),
      };
    }
    case "delegation.completed": {
      // An agent used as a tool: its own work stays inside it; the parent sees the result.
      const p = event.payload as { callId?: string; outcome?: unknown };
      if (!p.callId) return undefined;
      const content = toolResultText(p.outcome);
      return content === undefined ? undefined : { callId: p.callId, content };
    }
    default:
      return undefined;
  }
}

export class RunTranslator {
  /** Tool invocation → the model's call id, for interrupts that name the invocation. */
  private readonly callIds = new Map<string, string>();
  private readonly closed = new Set<string>();
  private sawAssistant: boolean;

  /**
   * `reattached`: the run continues from a cursor, so earlier assistant messages already
   * reached the client and a workflow's output is not repeated as text.
   */
  constructor(
    private readonly threadId: string,
    private readonly runId: string,
    options: { reattached?: boolean } = {}
  ) {
    this.sawAssistant = options.reattached ?? false;
  }

  translate(raw: LiveEvent): Step {
    const event = parseTranscriptEvent(raw);
    if (!event) return none;
    if (event.type === "action.pending" || event.type === "action.completed") {
      const { callId, invocationId } = event.payload;
      if (callId && invocationId) this.callIds.set(invocationId, callId);
    }
    const result = toolResultOf(event);
    if (result) {
      if (this.closed.has(result.callId)) return none;
      this.closed.add(result.callId);
      return {
        events: [
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${result.callId}:result`,
            toolCallId: result.callId,
            content: result.content,
            role: "tool",
          } as BaseEvent,
        ],
        finished: false,
      };
    }
    switch (event.type) {
      case "message.assistant": {
        const p = event.payload;
        if (p.agent) return none;
        this.sawAssistant = true;
        return { events: assistantEvents(p), finished: false };
      }
      case "turn.completed": {
        const p = event.payload;
        // Workflows finish without a model step of their own: show their output.
        const text =
          this.sawAssistant || p.output === undefined || p.output === null
            ? []
            : textEvents(raw.eventId, outputText(p.output));
        return {
          events: [...text, this.finished({ type: "success" }, p.output)],
          finished: true,
        };
      }
      case "turn.paused": {
        const interrupts: Interrupt[] = event.payload.interactions.map((w) => {
          const interaction = w.interaction as {
            id: string;
            kind: string;
            prompt?: unknown;
          };
          const toolCallId = this.callIds.get(w.invocationId);
          return {
            id: interaction.id,
            reason:
              interaction.kind === "approval" ? "tool_approval" : "input_required",
            ...(typeof interaction.prompt === "string"
              ? { message: interaction.prompt }
              : {}),
            ...(toolCallId ? { toolCallId } : {}),
            ...(interaction.kind === "approval"
              ? {
                  responseSchema: {
                    type: "object",
                    properties: { approved: { type: "boolean" } },
                    required: ["approved"],
                  },
                }
              : {}),
            metadata: { nylorun: { kind: interaction.kind } },
          } as Interrupt;
        });
        return {
          events: [this.finished({ type: "interrupt", interrupts })],
          finished: true,
        };
      }
      case "turn.cancelled":
        return { events: [this.finished({ type: "cancelled" })], finished: true };
      case "turn.failed": {
        const p = event.payload;
        return {
          events: [
            {
              type: EventType.RUN_ERROR,
              message: p.error?.message ?? p.message ?? "The agent failed",
              code: p.error?.code ?? "turn.failed",
            } as BaseEvent,
          ],
          finished: true,
        };
      }
      case "effect.uncertain":
      case "action.uncertain":
        // The Runtime cannot tell whether a side effect happened; the run goes on.
        return {
          events: [
            {
              type: EventType.CUSTOM,
              name: "nylorun.uncertain",
              value: event.payload,
            } as BaseEvent,
          ],
          finished: false,
        };
      default:
        return none;
    }
  }

  started(): BaseEvent {
    return {
      type: EventType.RUN_STARTED,
      threadId: this.threadId,
      runId: this.runId,
    } as BaseEvent;
  }

  private finished(outcome: unknown, result?: unknown): BaseEvent {
    return {
      type: EventType.RUN_FINISHED,
      threadId: this.threadId,
      runId: this.runId,
      outcome,
      ...(result === undefined ? {} : { result }),
    } as BaseEvent;
  }
}

function textEvents(messageId: string, text: string): BaseEvent[] {
  if (!text) return [];
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
  ];
}

function assistantEvents(p: {
  invocationId: string;
  text: string;
  toolCalls: { callId: string; name: string; input: unknown }[];
}): BaseEvent[] {
  const events = textEvents(p.invocationId, p.text);
  for (const call of p.toolCalls)
    events.push(
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: call.callId,
        toolCallName: call.name,
        parentMessageId: p.invocationId,
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: call.callId,
        delta: JSON.stringify(call.input ?? {}),
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: call.callId } as BaseEvent
    );
  return events;
}
