import { HostSuspension } from "./host-suspension.js";
import type { AgentDefinition } from "../definition/agent-definition.js";
import type { ExecutionSnapshot } from "./step/runtime.js";
import { HarnessError, isHarnessError } from "@nylorun/core/define";
import { runStep } from "./step/run.js";
import { compact, contextBudget, estimateTokens } from "./compaction/index.js";
import type { RunOptions, RunResult, SavedToolCall } from "../types/execution.js";
import type { InputEvent } from "@nylorun/core/define";
import type { JsonValue, Tripwire } from "@nylorun/core/define";
import type { ToolResult } from "@nylorun/core/define";
import { createId } from "../utils/ids.js";
import { dispatchPlan } from "./dispatch.js";
import type { ExecuteInternals } from "./delegation.js";
import { createInvocation, type Invocation } from "./invocation.js";
import { openExecution, validateRunOptions } from "./options.js";
import { applyResume } from "./resume.js";

/** All mutable progress belongs to this invocation and is discarded when it settles. */
export async function execute(
  agent: AgentDefinition,
  options: RunOptions<any>,
  internals: ExecuteInternals = {},
): Promise<RunResult<JsonValue>> {
  validateRunOptions(options);
  const opened = openExecution(agent, options);
  let { state } = opened;
  const { input, definitions } = opened;
  if (state.status === "paused" && !(input.kind === "continue" && options.signal?.aborted)) {
    state = applyResume(state, input, definitions);
    if (input.kind === "approve" || input.kind === "respond")
      state = {
        ...state,
        transcript: [
          ...state.transcript,
          { kind: "input", turnId: state.plan!.turnId, event: input },
        ],
      };
  } else if (input.kind === "approve" || input.kind === "respond" || input.kind === "settle") {
    throw new HarnessError(
      "execution.invalid-input",
      "There is no matching paused operation for this input",
    );
  }
  const invocation = createInvocation({ agent, options, state, definitions, internals });
  const { signal, observe, record } = invocation;
  const finish = (result: FinishInput) => finishInvocation(invocation, result);

  try {
    signal.throwIfAborted();
    let turnId: string;
    let stepNumber: number;
    /** Steps run and when this invocation started, for segment rollover. */
    let stepsRun = 0;
    const started = Date.now();
    /** One compaction and retry per overflow; reset once a step succeeds. */
    let overflowCompacted = false;
    /** Summarize older history into a compaction entry (Model Calls §8). */
    const compactHistory = async (
      trigger: "threshold" | "overflow",
      stepId: string,
    ): Promise<boolean> => {
      const next = await compact({
        transcript: invocation.state.transcript,
        executionId: invocation.state.executionId,
        turnId,
        stepId,
        trigger,
        budget: contextBudget(invocation.state.transcript),
        invoke: options.onModelCall,
        signal,
      });
      if (!next) return false;
      invocation.state = { ...invocation.state, transcript: next };
      await record();
      return true;
    };
    let arrivals: readonly InputEvent[] = [];
    let toolResults: readonly ToolResult[] = [];
    if (invocation.state.plan) {
      turnId = invocation.state.plan.turnId;
      stepNumber = invocation.state.plan.stepNumber + 1;
      invocation.state = { ...invocation.state, status: "active" };
      await record();
      if ((await dispatchPlan(invocation)) === "paused") return finish({ status: "paused" });
      toolResults = lastResults(invocation.state);
    } else if (invocation.state.turn) {
      // Continue a turn that yielded, or crash-continue inside it: keep the turn.
      turnId = invocation.state.turn.turnId;
      stepNumber =
        1 +
        invocation.state.transcript.filter(
          (entry) => entry.kind === "candidate" && entry.turnId === turnId,
        ).length;
      invocation.state = { ...invocation.state, status: "active" };
      toolResults = lastResults(invocation.state);
      await record();
    } else {
      turnId = createId("turn");
      stepNumber = 1;
      if (input.kind !== "continue" && input.kind !== "settle") arrivals = [input];
      invocation.state = {
        ...invocation.state,
        status: "active",
        turnCount: invocation.state.turnCount + 1,
        transcript: [
          ...invocation.state.transcript,
          ...arrivals.map((event) => ({ kind: "input" as const, turnId, event })),
        ],
      };
      await record();
    }
    for (; ; stepNumber++) {
      signal.throwIfAborted();
      // Segment rollover: end this segment between steps; the host continues the turn.
      const yieldAfter = internals.yieldAfter;
      if (
        yieldAfter &&
        stepsRun > 0 &&
        !invocation.state.plan &&
        ((yieldAfter.steps !== undefined && stepsRun >= yieldAfter.steps) ||
          (yieldAfter.ms !== undefined && Date.now() - started >= yieldAfter.ms))
      ) {
        if (!invocation.state.turn) invocation.state = { ...invocation.state, turn: { turnId } };
        return finish({ status: "yielded" });
      }
      stepsRun++;
      const stepId = createId("step");
      // Keep the next prompt inside the model's window, before it is sent.
      const budget = contextBudget(invocation.state.transcript);
      if (
        budget &&
        estimateTokens(invocation.state.transcript) > budget.contextWindow - budget.reserve
      )
        await compactHistory("threshold", stepId);
      const snapshot: ExecutionSnapshot = {
        id: invocation.state.executionId,
        status: "running",
        revision: invocation.state.revision,
        turnCount: invocation.state.turnCount,
        transcript: invocation.state.transcript,
      };
      const result = await runStep({
        agent: {
          middleware: agent.middleware,
          invoke: options.onModelCall,
          registry: agent.registry,
          sessionState: invocation.sessionBag,
        },
        state: snapshot,
        executionId: invocation.state.executionId,
        turnId,
        stepId,
        turnNumber: invocation.state.turnCount,
        stepNumber,
        arrivals,
        toolResults,
        signal,
        info: options.info,
        observe,
        output: agent.output,
      });
      signal.throwIfAborted();
      // The prompt did not fit: compact once and ask again with the same inputs.
      if (
        result.output.kind === "tripwire" &&
        result.output.tripwire.code === "model.context_overflow" &&
        !overflowCompacted
      ) {
        overflowCompacted = true;
        if (await compactHistory("overflow", stepId)) continue;
      }
      if (result.output.kind !== "tripwire") overflowCompacted = false;
      const candidate = result.candidate;
      if (candidate) {
        invocation.state = {
          ...invocation.state,
          transcript: [
            ...invocation.state.transcript,
            { kind: "candidate", turnId, stepId, candidate },
          ],
        };
        observe({
          type: "model.completed",
          turnId,
          stepId,
          ...(result.modelInvocationId ? { invocationId: result.modelInvocationId } : {}),
          ...(result.requestedModelId === undefined
            ? {}
            : { requestedModelId: result.requestedModelId }),
          attributes: candidate,
        });
      }
      if (result.output.kind === "tripwire") {
        observe({
          type: "tripwire",
          turnId,
          stepId,
          code: result.output.tripwire.code,
          scope: result.output.tripwire.scope ?? "step",
          attributes: { message: result.output.tripwire.message },
        });
        return finish({ status: "failed", error: result.output.tripwire });
      }
      if (result.output.kind === "final") {
        const output = result.output.output as JsonValue;
        invocation.state = {
          ...invocation.state,
          transcript: [
            ...invocation.state.transcript,
            { kind: "final", turnId, stepId, output: output },
          ],
        };
        observe({
          type: "turn.completed",
          turnId,
          stepId,
          attributes: { output: output },
        });
        return finish({ status: "completed", output: output });
      }
      const plan = result.output.plan;
      const calls: SavedToolCall[] = plan.executable.map((entry) => {
        const reference = agent.registry.reference(entry.definition);
        definitions.set(entry.invocationId, agent.registry.restore(reference));
        return {
          callId: entry.call.callId,
          toolName: entry.call.toolName,
          args: entry.call.args,
          rawArgs: entry.rawArgs,
          invocationId: entry.invocationId,
          reference,
          status: entry.interaction ? "interaction" : "pending",
          ...(entry.interaction
            ? { interaction: entry.interaction, interactionPhase: "before" as const }
            : {}),
        };
      });
      invocation.state = {
        ...invocation.state,
        plan: {
          turnId,
          stepId,
          stepNumber,
          order: plan.order,
          immediate: plan.immediateResults,
          calls,
        },
      };
      observe({
        type: "tool.sealed",
        turnId,
        stepId,
        attributes: {
          executable: plan.executable.map((entry) => ({
            callId: entry.call.callId,
            toolName: entry.call.toolName,
            args: entry.call.args,
            rawArgs: entry.rawArgs,
            invocationId: entry.invocationId,
            owner: entry.owner,
            ...(entry.interaction ? { interaction: entry.interaction } : {}),
          })),
          immediate: plan.immediateResults,
        },
      });
      await record();
      if ((await dispatchPlan(invocation)) === "paused") return finish({ status: "paused" });
      toolResults = lastResults(invocation.state);
      arrivals = [];
    }
  } catch (error) {
    if (error instanceof HostSuspension) throw error;
    if (isHarnessError(error) && error.code === "execution.record-failed") throw error;
    if (signal.aborted) return finish({ status: "cancelled" });
    return finish({
      status: "failed",
      error: {
        code: isHarnessError(error) ? error.code : "execution.failed",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

type FinishInput =
  | Omit<Extract<RunResult<JsonValue>, { status: "completed" }>, "state">
  | { status: "paused" }
  | { status: "yielded" }
  | { status: "cancelled" }
  | { status: "failed"; error: Tripwire };

async function finishInvocation(
  invocation: Invocation,
  result: FinishInput,
): Promise<RunResult<JsonValue>> {
  if (result.status === "cancelled" && invocation.state.plan) {
    const plan = invocation.state.plan;
    const results = [
      ...plan.immediate,
      ...plan.calls.map(
        (call) =>
          call.result ?? {
            kind: "failed" as const,
            callId: call.callId,
            toolName: call.toolName,
            code: "tool.cancelled",
            message: "Invocation cancelled; external effects are not automatically retried",
          },
      ),
    ];
    const { plan: _, ...rest } = invocation.state;
    invocation.state = {
      ...rest,
      cancelledCalls: [
        ...(rest.cancelledCalls ?? []),
        ...plan.calls.filter((call) => !call.result),
      ],
      transcript: [
        ...invocation.state.transcript,
        {
          kind: "tool-results",
          turnId: plan.turnId,
          stepId: plan.stepId,
          results: plan.order.map((item) =>
            results.find(
              (result) => result.callId === item.callId && result.toolName === item.toolName,
            )!,
          ),
        },
      ],
    };
  }
  if (result.status === "yielded") {
    // Mid-turn: the state keeps its turn and stays active, so `continue` picks it up.
    invocation.state = { ...invocation.state, status: "active" };
    await invocation.record();
    return { status: "yielded", state: invocation.state };
  }
  if (result.status !== "paused" && invocation.state.turn) {
    const { turn: _turn, ...rest } = invocation.state;
    invocation.state = rest;
  }
  invocation.state = { ...invocation.state, status: result.status };
  await invocation.record();
  invocation.emit({
    type: `execution.${result.status}`,
    ...(result.status === "completed"
      ? { attributes: { output: result.output } }
      : result.status === "failed"
        ? { attributes: { error: result.error as unknown as JsonValue } }
        : {}),
  });
  if (result.status === "paused")
    return {
      status: "paused",
      state: invocation.state,
      pending: invocation.state.plan!.calls.filter(
        (call) => call.status === "interaction" || call.status === "deferred",
      ),
    };
  return { ...result, state: invocation.state };
}

function lastResults(state: Invocation["state"]): readonly ToolResult[] {
  const entry = state.transcript[state.transcript.length - 1];
  return entry?.kind === "tool-results" ? entry.results : [];
}
