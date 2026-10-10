import type { JsonObject, JsonValue } from "@nylorun/core/define";

/** Internal signal thrown by durable wait helpers; caught by the tool dispatcher. */
export class WaitSignal {
  readonly name = "WaitSignal";
  constructor(
    readonly outcome:
      | {
          readonly kind: "interaction-required";
          readonly interaction: {
            readonly kind: "approval" | "response";
            readonly prompt: string;
            readonly metadata?: JsonObject;
          };
          readonly token?: JsonValue;
          readonly wait: {
            readonly kind: "ask" | "approve" | "sleep" | "waitFor";
            readonly waitId: string;
            readonly name?: string;
          };
        }
      | {
          readonly kind: "deferred";
          readonly token?: JsonValue;
          readonly wait: {
            readonly kind: "ask" | "approve" | "sleep" | "waitFor";
            readonly waitId: string;
            readonly name?: string;
          };
        },
  ) {}
}

export function isWaitSignal(value: unknown): value is WaitSignal {
  return value instanceof WaitSignal;
}
