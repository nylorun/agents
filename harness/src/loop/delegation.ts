import { HarnessError, isFlowDelegate, isHarnessError } from "@nylorun/core/define";
import type {
  AgentRef,
  Delegate,
  JsonObject,
  JsonValue,
  ModelAdapter,
  ToolOutcome,
} from "@nylorun/core/define";
import type { AgentDefinition } from "../definition/agent-definition.js";
import { definitionFromBinding } from "../definition/agent-definition.js";
import type { RunOptions, RunResult } from "../types/execution.js";
import { withNestedIds } from "../utils/ids.js";
import { initializeExecutionState } from "./initial-state.js";
import type { Invocation } from "./invocation.js";
import { textFromOutput } from "./model/normalize.js";
import { HostSuspension } from "./host-suspension.js";

/** How one agent used as a tool is built and journaled. Durable hosts supply their own. */
export interface DelegationHost {
  child(
    delegate: Delegate,
    ref: AgentRef,
  ): { readonly definition: AgentDefinition; readonly onModelCall: ModelAdapter };
  /**
   * Run a flow agent used as a tool: the host starts it in its own linked session and
   * returns the settled value (the flow's output, or a `{ kind: "failed" }` value). Only
   * durable hosts can; local runs have no flow engine.
   */
  flow?(delegate: Delegate, ref: AgentRef, task: string): Promise<JsonValue>;
  /**
   * Journal a lifecycle point exactly once. Local runs have nothing to journal. `callId` is
   * the parent model's tool call id, for display only; it is not part of the point's identity.
   */
  announce?(
    phase: "started" | "settled",
    ref: AgentRef,
    payload: JsonObject,
    ids?: { readonly callId: string },
  ): Promise<void>;
}

/** Engine-internal options for execute(); not part of the public RunOptions. */
export interface ExecuteInternals {
  readonly delegation?: DelegationHost;
  /** Set when this invocation is an agent used as a tool. */
  readonly delegated?: AgentRef;
  /**
   * Segment rollover (Model Calls §10): end the invocation with `yielded` at the next step
   * boundary once this many steps ran, or this much time passed, in this invocation.
   */
  readonly yieldAfter?: { readonly steps?: number; readonly ms?: number };
}

/** Codes are curated: a child's provider error bodies never reach the parent's context. */
export const INTERACTION_UNSUPPORTED =
  "Agents used as tools can't ask for input, approval or a wait yet; do this work on the parent agent.";

const PARTIAL_LIMIT = 4_000;

/** In-process children, built from the authored agent and sharing the parent's model callable. */
export function localDelegation(onModelCall: ModelAdapter): DelegationHost {
  return {
    child(delegate, ref) {
      if (!delegate.agent)
        throw new HarnessError(
          "execution.invalid-input",
          `Agent '${ref.id}' is used as a tool but has no local implementation; build the parent from authored agents`,
        );
      return { definition: definitionFromBinding(delegate.agent.getBinding()), onModelCall };
    },
  };
}

/** Run one agent used as a tool to settlement. Only its final output returns to the parent. */
export async function runDelegation(
  invocation: Invocation,
  execute: (
    agent: AgentDefinition,
    options: RunOptions<any>,
    internals: ExecuteInternals,
  ) => Promise<RunResult<JsonValue>>,
  call: {
    readonly turnId: string;
    readonly stepId: string;
    readonly callId: string;
    readonly invocationId: string;
    readonly toolName: string;
    readonly args: JsonValue;
  },
  delegate: Delegate,
): Promise<ToolOutcome> {
  const { signal, options } = invocation;
  const ref: AgentRef = {
    id: delegate.manifest.id,
    path: `${invocation.agent.id}/${delegate.manifest.id}`,
    delegationId: call.invocationId,
  };
  const ids = {
    turnId: call.turnId,
    stepId: call.stepId,
    callId: call.callId,
    invocationId: call.invocationId,
    toolName: call.toolName,
    agent: ref,
  };
  const task = (call.args as { task: string }).task;
  const host = invocation.delegation ?? localDelegation(options.onModelCall);
  await host.announce?.("started", ref, { task }, { callId: call.callId });
  invocation.observe({ type: "delegation.started", ...ids, attributes: { task } });
  let outcome: ToolOutcome;
  let status: RunResult<JsonValue>["status"] = "failed";
  try {
    if (isFlowDelegate(delegate)) {
      if (!host.flow)
        throw new HarnessError(
          "execution.invalid-input",
          `Agent '${ref.id}' is a flow agent; flow agents used as tools run on the Runtime`,
        );
      outcome = settleFlow(await host.flow(delegate, ref, task));
      status = outcome.kind === "completed" ? "completed" : "failed";
    } else {
      const child = host.child(delegate, ref);
      const listener = options.onEvent;
      const result = await withNestedIds(call.invocationId, () =>
        execute(
          child.definition,
          {
            input: task,
            onModelCall: child.onModelCall,
            signal,
            ...(options.info === undefined ? {} : { info: options.info }),
            state: initializeExecutionState(child.definition, {
              executionId: `${invocation.state.executionId}/${call.invocationId}`,
            }),
            ...(listener ? { onEvent: (event) => listener({ ...event, agent: ref }) } : {}),
          },
          { delegated: ref },
        ),
      );
      status = result.status;
      outcome = settle(result);
    }
  } catch (cause) {
    // Durable hosts suspend children mid-flight; that must escape to the parent journal.
    if (cause instanceof HostSuspension) throw cause;
    // Construction or setup failures still settle the journaled delegation; the parent
    // sees the same failed tool result as an empty or crashed child.
    if (isHarnessError(cause))
      outcome = { kind: "failed", code: cause.code, message: cause.message };
    else if (cause instanceof Error)
      outcome = { kind: "failed", code: "delegation.failed", message: cause.message };
    else outcome = { kind: "failed", code: "delegation.failed", message: String(cause) };
  }
  await host.announce?.(
    "settled",
    ref,
    { status, outcome: outcome as unknown as JsonValue },
    { callId: call.callId },
  );
  invocation.observe({
    type: "delegation.completed",
    ...ids,
    status,
    attributes:
      outcome.kind === "completed"
        ? {
            callId: call.callId,
            toolName: call.toolName,
            kind: "completed",
            output: outcome.output,
          }
        : {
            callId: call.callId,
            toolName: call.toolName,
            kind: "failed",
            code: (outcome as { code: string }).code,
            message: (outcome as { message: string }).message,
          },
  });
  return outcome;
}

/** "Done" means settled with real output; empty or unfinished work is a failure with evidence. */
function settle(result: RunResult<JsonValue>): ToolOutcome {
  if (result.status === "completed") {
    const output = result.output;
    if (output === null || (typeof output === "string" && output.trim() === ""))
      return {
        kind: "failed",
        code: "delegation.empty-output",
        message: "The agent finished without an answer.",
      };
    return { kind: "completed", output };
  }
  if (result.status === "cancelled")
    return { kind: "failed", code: "tool.cancelled", message: "The agent was cancelled." };
  if (result.status === "paused")
    return {
      kind: "failed",
      code: "delegation.interaction-unsupported",
      message: INTERACTION_UNSUPPORTED,
    };
  // Agents used as tools run inside one step of their parent and never roll over.
  if (result.status === "yielded")
    return { kind: "failed", code: "delegation.failed", message: "The agent stopped early." };
  const reason = result.error.code;
  const curated = reason.startsWith("execution.") ? reason : `${reason}: ${result.error.message}`;
  const partial = lastText(result);
  return {
    kind: "failed",
    code: "delegation.failed",
    message:
      `The agent failed (${curated}).` +
      (partial ? `\nPartial output (evidence, not an answer):\n${partial}` : ""),
  };
}

function lastText(result: RunResult<JsonValue>): string | undefined {
  for (let index = result.state.transcript.length - 1; index >= 0; index--) {
    const entry = result.state.transcript[index]!;
    if (entry.kind !== "candidate") continue;
    const text = textFromOutput(entry.candidate.output).trim();
    if (text) return text.length > PARTIAL_LIMIT ? `${text.slice(0, PARTIAL_LIMIT)}…` : text;
  }
  return undefined;
}

/** A flow's settled value: its output, or the `{ kind: "failed" }` value the host records. */
function settleFlow(value: JsonValue): ToolOutcome {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    if (record.kind === "failed" && typeof record.code === "string")
      return {
        kind: "failed",
        code: "delegation.failed",
        message: `The agent failed (${record.code}: ${typeof record.message === "string" ? record.message : record.code}).`,
      };
  }
  return settle({ status: "completed", output: value } as RunResult<JsonValue>);
}
