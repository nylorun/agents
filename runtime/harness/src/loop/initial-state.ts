import type { AgentDefinition } from "../definition/agent-definition.js";
import type { ExecutionState } from "../types/execution.js";
import type { JsonObject, JsonValue } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";
import { createId } from "../utils/ids.js";

export function initializeExecutionState(
  agent: AgentDefinition,
  options: { readonly executionId?: string; readonly state?: JsonObject } = {},
): ExecutionState {
  return copyJson({
    version: 1,
    agentId: agent.id,
    manifestHash: agent.hash,
    executionId: options.executionId ?? createId("execution"),
    revision: 0,
    turnCount: 0,
    transcript: [],
    status: "ready",
    state: options.state ?? {},
    ...(agent.output ? { outputContract: agent.output.schema.jsonSchema } : {}),
  });
}

/** Mutable session-memory bag backed by Invocation / ExecutionState.state. */
export function createSessionStateBag(bag: Record<string, JsonValue>) {
  return {
    get(key: string): JsonValue | undefined {
      return bag[key];
    },
    set(key: string, value: JsonValue): void {
      bag[key] = value;
    },
    entries(): Readonly<Record<string, JsonValue>> {
      return { ...bag };
    },
  };
}
