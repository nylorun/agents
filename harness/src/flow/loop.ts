import { HarnessError, isVariantOf } from "@nylorun/core/define";
import type { AgentManifest, JsonValue, Verdict, WorkflowManifest } from "@nylorun/core/define";
import type { WorkflowLoopNode, WorkflowNode } from "@nylorun/core";
import type { DurableHost } from "../run/durable.js";
import { HostSuspension } from "../loop/host-suspension.js";
import type { FlowCheckpoint } from "./checkpoint.js";
import {
  createFlowContext,
  failureOf,
  settleInFlight,
  suspendedResult,
  type FlowContext,
} from "./context.js";
import { assertLoopIteration, type FlowOperatorLimits } from "./limits.js";
import { joinPath, nodeKeyOf } from "./paths.js";
import { runNode, unwrapSlot } from "./node.js";
import { FlowNodeError, type FlowDurableResult, type FlowRunResult } from "./types.js";

export type { FlowDurableResult, FlowRunResult } from "./types.js";

type LoopHistoryEntry = {
  readonly iteration: number;
  readonly output: JsonValue;
  readonly verdict: Verdict;
};

type Decision =
  { readonly input: JsonValue; readonly agent?: AgentManifest } | { readonly output: JsonValue };

/** Host may wrap agent-effect outcomes so the Loop learns the turn's manifest. */
export const AGENT_TURN_MARKER = "__nylorunAgentTurn" as const;

export type AgentTurnValue = {
  readonly [AGENT_TURN_MARKER]: 1;
  readonly output: JsonValue;
  readonly agent: AgentManifest;
};

export function agentTurnValue(output: JsonValue, agent: AgentManifest): AgentTurnValue {
  return { [AGENT_TURN_MARKER]: 1, output, agent };
}

export function readAgentTurn(value: unknown): {
  output: JsonValue;
  agent?: AgentManifest;
} {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as AgentTurnValue)[AGENT_TURN_MARKER] === 1 &&
    "output" in value &&
    "agent" in value
  ) {
    return {
      output: (value as AgentTurnValue).output,
      agent: (value as AgentTurnValue).agent,
    };
  }
  return { output: value as JsonValue };
}

function invalidAgent(path: string, message: string): never {
  throw new FlowNodeError({ code: "loop.invalid-agent", message, path });
}

/**
 * Interpret a root Loop node. Returns effects only; the host journals outcomes.
 */
export async function runLoop(options: {
  readonly manifest: WorkflowManifest;
  readonly checkpoint: FlowCheckpoint;
  readonly host: DurableHost;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<FlowOperatorLimits> | null;
}): Promise<FlowDurableResult> {
  const { manifest, checkpoint, host } = options;
  if (manifest.workflowSchemaVersion !== 1)
    throw new HarnessError("execution.invalid-state", "runLoop expects a workflow manifest v1");
  const root = manifest.root;
  if (!("loop" in root))
    throw new HarnessError("execution.invalid-state", "runLoop expects a loop root");

  const ctx = createFlowContext({
    manifest,
    checkpoint,
    host,
    signal: options.signal,
    limits: options.limits,
  });

  try {
    if (options.signal?.aborted)
      return { status: "cancelled", checkpoint, result: { status: "cancelled" } };
    const output = await runLoopNode(ctx, root.loop, root.loop.id, checkpoint.input);
    return {
      status: "completed",
      checkpoint,
      result: { status: "completed", output },
    };
  } catch (error) {
    await settleInFlight(ctx);
    if (error instanceof HostSuspension) return suspendedResult(ctx);
    if (error instanceof FlowNodeError && error.failure.code === "cancelled")
      return { status: "cancelled", checkpoint, result: { status: "cancelled" } };
    const failure = failureOf(error, root.loop.id);
    return {
      status: "failed",
      checkpoint,
      result: { status: "failed", error: failure },
      ...(ctx.cancelEffectIds.size > 0 ? { cancelEffectIds: [...ctx.cancelEffectIds] } : {}),
    };
  }
}

/**
 * Nested or root Loop body: run → verify → decide until `{ output }` or stop.
 * Agent turn pinning / decide patches (`decision.agent`) are L5.
 */
export async function runLoopNode(
  ctx: FlowContext,
  loop: WorkflowLoopNode["loop"],
  path: string,
  input: JsonValue,
): Promise<JsonValue> {
  let iteration = 1;
  let currentInput: JsonValue = input;
  const history: LoopHistoryEntry[] = [];
  const loopInput = input;
  const runIsAgent = "agent" in loop.run;
  // Session pin (first turn's manifest) and the patch carried within this run.
  let pinnedAgent: AgentManifest | undefined;
  let currentAgent: AgentManifest | undefined;

  for (;;) {
    if (ctx.signal?.aborted)
      throw new FlowNodeError({ code: "cancelled", message: "cancelled", path });

    // Operator ceiling before starting this iteration (WF-L3 / LOOP-A8).
    assertLoopIteration(iteration, ctx.limits, path);

    ctx.iterations = [...ctx.iterations, iteration];
    const iterations = ctx.iterationsString();

    try {
      let runOutput: JsonValue;

      if (runIsAgent) {
        const agentId = loop.run.agent;
        const agentPath = runPath(path, loop.run);
        const rawAgent = await ctx.effect(
          "agent",
          {
            agentId,
            input: currentInput,
            path: agentPath,
            ...(currentAgent ? { manifest: currentAgent } : {}),
          },
          { path: agentPath, key: nodeKeyOf(agentPath), iterations },
          { loopPath: path, n: iteration },
        );
        const turned = readAgentTurn(rawAgent);
        runOutput = turned.output;
        if (turned.agent) {
          // First turn establishes the session pin; later turns may be variants.
          pinnedAgent ??= turned.agent;
          currentAgent = turned.agent;
        }
      } else {
        runOutput = await runNode(ctx, loop.run, runPath(path, loop.run), currentInput, {
          ownerInput: loopInput,
        });
      }

      const verdict = await runVerify(ctx, loop.verify, path, {
        input: loopInput,
        output: runOutput,
        iteration,
      });

      let decision: Decision;
      try {
        decision = (await ctx.effect(
          "fn",
          {
            output: runOutput,
            verdict,
            iteration,
            input: loopInput,
            history,
            ...(currentAgent ? { agent: currentAgent } : {}),
          },
          { path, key: `${nodeKeyOf(path)}/decide`, iterations },
          { loopPath: path, n: iteration, role: "decide" },
        )) as Decision;
      } catch (error) {
        if (error instanceof FlowNodeError && error.failure.code === "fn.failed") {
          throw new FlowNodeError({
            code: "loop.stopped",
            message: error.failure.message,
            path,
          });
        }
        if (
          error instanceof Error &&
          !(error instanceof HostSuspension) &&
          !(error instanceof FlowNodeError)
        ) {
          throw new FlowNodeError({
            code: "loop.stopped",
            message: error.message,
            path,
          });
        }
        throw error;
      }

      if ("output" in decision && !("input" in decision)) return decision.output;

      if (!("input" in decision))
        throw new HarnessError(
          "execution.invalid-state",
          "Decide returned neither input nor output",
        );

      const next = decision as {
        readonly input: JsonValue;
        readonly agent?: AgentManifest;
      };

      if (next.agent !== undefined) {
        if (!runIsAgent) {
          invalidAgent(path, "Decide returned agent but Loop.run is not an agent");
        }
        if (pinnedAgent && !isVariantOf(next.agent, pinnedAgent)) {
          invalidAgent(
            path,
            "Decide returned a manifest that is not a variant of the pinned agent",
          );
        }
        currentAgent = next.agent;
      }

      history.push({ iteration, output: runOutput, verdict });
      currentInput = next.input;
      iteration += 1;
    } finally {
      ctx.iterations.pop();
    }
  }
}

function runPath(loopPath: string, run: WorkflowNode): string {
  const { part } = unwrapSlot(run);
  return joinPath(loopPath, part);
}

async function runVerify(
  ctx: FlowContext,
  verify: WorkflowLoopNode["loop"]["verify"],
  loopPath: string,
  args: { input: JsonValue; output: JsonValue; iteration: number },
): Promise<Verdict> {
  const iterations = ctx.iterationsString();

  if ("fn" in verify) {
    try {
      return (await ctx.effect(
        "verify",
        args,
        { path: loopPath, key: nodeKeyOf(loopPath), iterations },
        { loopPath, n: args.iteration },
      )) as Verdict;
    } catch (error) {
      if (error instanceof FlowNodeError) {
        if (error.failure.code === "loop.verify-failed") throw error;
        throw new FlowNodeError({
          code: "loop.verify-failed",
          message: error.failure.message,
          path: loopPath,
        });
      }
      throw error;
    }
  }

  // Verifier agent (or slot wrapping one): input is { task, response, iteration }.
  const judgePayload = {
    task: args.input,
    response: args.output,
    iteration: args.iteration,
  } as JsonValue;

  try {
    if ("slot" in verify) {
      const { part } = unwrapSlot(verify);
      const verifyPath = joinPath(loopPath, part);
      const value = await runNode(ctx, verify, verifyPath, judgePayload);
      return value as Verdict;
    }
    if ("agent" in verify) {
      const verifyPath = joinPath(loopPath, verify.agent);
      const value = await ctx.effect(
        "agent",
        { agentId: verify.agent, input: judgePayload, path: verifyPath },
        { path: verifyPath, key: nodeKeyOf(verifyPath), iterations },
        { loopPath, n: args.iteration, role: "verify-agent" },
      );
      return value as Verdict;
    }
  } catch (error) {
    if (error instanceof HostSuspension) throw error;
    if (error instanceof FlowNodeError) {
      throw new FlowNodeError({
        code: "loop.verify-failed",
        message: error.failure.message,
        path: loopPath,
      });
    }
    throw new FlowNodeError({
      code: "loop.verify-failed",
      message: error instanceof Error ? error.message : String(error),
      path: loopPath,
    });
  }

  throw new HarnessError("execution.invalid-state", "Unsupported Loop.verify node");
}
