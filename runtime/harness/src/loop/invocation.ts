import type { AgentDefinition } from "../definition/agent-definition.js";
import type { AgentRef, BoundToolDefinition } from "@nylorun/core/define";
import type { DelegationHost, ExecuteInternals } from "./delegation.js";
import type { ExecutionState, RunOptions } from "../types/execution.js";
import type { ObserveEvent } from "@nylorun/core/define";
import type { JsonValue } from "@nylorun/core/define";
import { HarnessError } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";
import { createId } from "../utils/ids.js";
import { createObservationSink, type ExecutionOutcomeEvent, type ObserveEmit } from "./observe.js";

export interface Invocation {
  readonly agent: AgentDefinition;
  readonly options: RunOptions<any>;
  readonly signal: AbortSignal;
  readonly definitions: Map<string, BoundToolDefinition>;
  /** Builds agents used as tools; absent means in-process children. */
  readonly delegation?: DelegationHost;
  /** Set when this invocation is itself an agent used as a tool. */
  readonly delegated?: AgentRef;
  state: ExecutionState;
  /** Mutable durable session memory for this invocation. */
  sessionBag: Record<string, JsonValue>;
  observe: ObserveEmit;
  emit(event: ObserveEvent | ExecutionOutcomeEvent): void;
  record(): Promise<void>;
}

export function createInvocation(input: {
  readonly agent: AgentDefinition;
  readonly options: RunOptions<any>;
  readonly state: ExecutionState;
  readonly definitions: Map<string, BoundToolDefinition>;
  readonly internals?: ExecuteInternals;
}): Invocation {
  const invocation = {
    agent: input.agent,
    options: input.options,
    signal: input.options.signal ?? new AbortController().signal,
    definitions: input.definitions,
    ...(input.internals?.delegation ? { delegation: input.internals.delegation } : {}),
    ...(input.internals?.delegated ? { delegated: input.internals.delegated } : {}),
    state: input.state,
    sessionBag: { ...((input.state.state ?? {}) as Record<string, JsonValue>) },
  } as Invocation;
  const sink = createObservationSink({
    listener: input.options.onEvent,
    executionId: () => invocation.state.executionId,
    runId: createId("run"),
  });
  invocation.observe = sink.observe;
  invocation.emit = sink.emit;
  invocation.record = async () => {
    invocation.state = copyJson({
      ...invocation.state,
      state: { ...invocation.sessionBag },
      revision: invocation.state.revision + 1,
    });
    if (!input.options.record) return;
    try {
      await input.options.record(copyJson(invocation.state));
    } catch (cause) {
      throw new HarnessError(
        "execution.record-failed",
        "Recording failed. Execution stopped; reconcile any external effects before retrying.",
        { cause },
      );
    }
  };
  return invocation;
}
