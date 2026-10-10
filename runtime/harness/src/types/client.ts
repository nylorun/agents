import type { JsonObject, JsonValue } from "@nylorun/core/define";
import type { MessageInput } from "@nylorun/core/define";
import type { SavedToolCall } from "./execution.js";

/**
 * Definition-parameterized client types (H11). Types only — harness does not implement Session.
 * Runtime imports these for session and stream typing.
 */

export interface InputAccepted {
  readonly status: "accepted" | "rejected";
  readonly error?: { readonly code: string; readonly message: string };
  readonly turnId?: string;
  readonly cursor?: string;
  readonly steered?: boolean;
}

export type Result<Output = unknown> =
  | { readonly status: "completed"; readonly output: Output }
  | { readonly status: "paused"; readonly pending: readonly SavedToolCall[] }
  | {
      readonly status: "failed";
      readonly error: { readonly code: string; readonly message: string };
    }
  | { readonly status: "cancelled" };

export interface Turn<Output = unknown> {
  readonly id: string;
  readonly sessionId: string;
  readonly status: "running" | "settled";
  readonly result?: Result<Output>;
}

export type Event<Output = unknown> =
  | {
      readonly type: "turn.started";
      readonly cursor: string;
      readonly at: string;
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "status";
      readonly status: "thinking" | "calling_tool" | "waiting" | "requires_action";
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "text.delta";
      readonly text: string;
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "tool.started" | "tool.progress" | "tool.completed" | "tool.failed";
      readonly tool: string;
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "interaction.required";
      readonly id: string;
      readonly prompt: string;
      readonly options?: JsonObject;
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "turn.settled";
      readonly result: Result<Output>;
      readonly sessionId: string;
      readonly turnId: string;
    };

/** Structural agent identity used to parameterize Session/Event types. */
export interface AgentIdentity {
  readonly id: string;
}

export interface Session<A extends AgentIdentity = AgentIdentity, Output = unknown> {
  readonly id: string;
  readonly agentId: A["id"];
  input(message: MessageInput | string): Promise<InputAccepted>;
  stream(opts?: { readonly after?: string }): AsyncIterable<Event<Output>>;
  history(): Promise<readonly JsonValue[]>;
  approve(id: string, approved: boolean): Promise<void>;
  respond(id: string, value: JsonValue): Promise<void>;
  cancel(): Promise<void>;
}
