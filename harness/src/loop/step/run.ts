import { HostSuspension } from "../host-suspension.js";
import type { ExecutionSnapshot, StepInput, StepRuntime, StepTurnHooks } from "./runtime.js";
import type { TurnOutputContract } from "@nylorun/core/define";
import type { ModelCandidate, ModelConfigurationSnapshot } from "@nylorun/core/define";
import type { ObserveEvent, ObserveModelConfigurationSnapshot } from "@nylorun/core/define";
import type { InputEvent } from "@nylorun/core/define";
import type { ToolResult } from "@nylorun/core/define";
import type { JsonValue } from "@nylorun/core/define";
import { normalizeCandidate } from "../model/normalize.js";
import { HarnessError, isHarnessError, isModelFailureOutcome } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";
import type { ObserveEmit } from "../observe.js";
import { runMiddleware } from "./compose.js";
import { ContextDraft } from "./context-draft.js";
import { StepContext } from "./step-context.js";
import { projectModelCall } from "../model/project.js";
import { resolveModelRequest } from "./resolve.js";
import { sealStep, type SealedStepOutput } from "./seal.js";
import { ModelConfigurationDraft } from "./model-configuration.js";
import { createId } from "../../utils/ids.js";
import {
  applyPatch,
  asDecisions,
  callHooks,
  combinePatches,
  layerPatches,
  mergeDecisions,
  type CallPatch,
} from "./hooks.js";
import type { Decision } from "@nylorun/core/define";

export interface StepRunResult {
  readonly stepId: string;
  readonly candidate?: ModelCandidate;
  readonly output: SealedStepOutput;
  readonly requestedModelId?: string;
  readonly modelInvocationId?: string;
  /** Feedback when an after("step") hook asked a text-only answer to be redone. */
  readonly retry?: string;
  /** True when an after("step") hook requested a retry (text or tool calls). */
  readonly retried?: boolean;
  /** Validated before("turn") patch, returned on the first step of a turn. */
  readonly turnPatch?: CallPatch;
}

export async function runStep(input: {
  agent: StepRuntime;
  observe: ObserveEmit;
  state: ExecutionSnapshot;
  executionId: string;
  turnId: string;
  stepId: string;
  turnNumber: number;
  stepNumber: number;
  arrivals: readonly InputEvent[];
  toolResults: readonly ToolResult[];
  signal: AbortSignal;
  info?: unknown;
  output?: TurnOutputContract;
  /** Turn-scoped hook state; omitted when the agent registers no hooks. */
  turn?: StepTurnHooks;
}): Promise<StepRunResult> {
  let requestedModelId: string | undefined;
  let modelInvocationId: string | undefined;
  let retryFeedback: string | undefined;
  let retried = false;
  let turnPatch: CallPatch | undefined;
  const stepInput = Object.freeze({
    executionId: input.executionId,
    turnId: input.turnId,
    stepId: input.stepId,
    turnNumber: input.turnNumber,
    stepNumber: input.stepNumber,
    info: input.info,
    arrivals: Object.freeze([...input.arrivals]),
    toolResults: Object.freeze([...input.toolResults]),
    transcript: Object.freeze([...input.state.transcript]),
  });
  const configuration = new ModelConfigurationDraft();
  const runtimeContext = new ContextDraft();
  const context = new StepContext(stepInput, input.observe, configuration, runtimeContext);
  input.observe(() => ({
    type: "step.started",
    turnId: input.turnId,
    stepId: input.stepId,
    turnNumber: input.turnNumber,
    stepNumber: input.stepNumber,
    attributes: snapshotStepStart(stepInput),
  }));
  await runMiddleware(
    input.agent.middleware,
    context,
    async () => {
      input.signal.throwIfAborted();
      if (context.currentTripwire) return context.tripwire(context.currentTripwire);

      const definition = input.agent.definition;
      const turn = input.turn;
      if (definition && turn) {
        try {
          const messages = projectModelCall(
            resolveModelRequest({
              context,
              arrivals: input.arrivals,
              toolResults: input.toolResults,
              output: input.output,
            }),
          ).prompt;
          const sessionState = input.agent.sessionState ?? {};
          const base = { input: turn.input, info: input.info, messages };
          let patch = turn.patch;
          if (turn.start) {
            const combined = combinePatches(
              definition,
              await callHooks(
                definition,
                { at: "before", scope: "turn" },
                { ...base, state: { ...sessionState } },
                "before-turn",
              ),
            );
            if (combined.state) Object.assign(sessionState, combined.state);
            if (combined.block !== undefined)
              return context.tripwire({
                code: "dynamics.blocked",
                message: combined.block,
                scope: "execution",
              });
            patch = turnPatch = combined.patch;
          }
          const step = combinePatches(
            definition,
            await callHooks(
              definition,
              { at: "before", scope: "step" },
              { ...base, state: { ...sessionState }, step: input.stepNumber - 1 },
              `before-step:${input.stepId}`,
            ),
          );
          if (step.state) Object.assign(sessionState, step.state);
          if (input.agent.recordAfterDynamics) await input.agent.recordAfterDynamics();
          if (step.block !== undefined)
            return context.tripwire({ code: "dynamics.blocked", message: step.block });
          applyPatch(configuration, layerPatches(patch, step.patch), 10_000);
        } catch (error) {
          if (error instanceof HostSuspension) throw error;
          return context.tripwire({
            code: isHarnessError(error) ? error.code : "configuration.invalid",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      try {
        const selected = configuration.snapshot();
        for (const tool of selected.tools) input.agent.registry.reference(tool);
        context.sealConfiguration(selected);
        context.sealContext(runtimeContext.snapshot());
      } catch (error) {
        if (error instanceof HostSuspension) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return context.tripwire({
          code: isHarnessError(error) ? error.code : "configuration.invalid",
          message,
        });
      }
      const request = resolveModelRequest({
        context,
        arrivals: input.arrivals,
        toolResults: input.toolResults,
        output: input.output,
      });
      requestedModelId = request.model?.id;
      const call = projectModelCall(request);
      const invocationId = createId("invocation");
      modelInvocationId = invocationId;
      input.observe(() => ({
        type: "model.requested",
        invocationId,
        turnId: input.turnId,
        stepId: input.stepId,
        ...(request.model?.id === undefined ? {} : { requestedModelId: request.model.id }),
        attributes: Object.freeze({
          call,
          configuration: snapshotConfiguration(request.configuration),
          context: copyJson(request.context),
        }),
      }));
      try {
        let prepared = false;
        const outcome = await input.agent.invoke(call, {
          request,
          invocationId,
          signal: input.signal,
          reportPreparedCall(value) {
            if (prepared)
              throw new HarnessError(
                "model.adapter-invalid-options",
                "Model adapter may report only one prepared call per invocation",
              );
            if (typeof value.adapter !== "string" || value.adapter === "")
              throw new HarnessError(
                "model.adapter-invalid-options",
                "Prepared model call adapter must be a non-empty string",
              );
            prepared = true;
            const reported = Object.freeze({ adapter: value.adapter, call: copyJson(value.call) });
            input.observe(() => ({
              type: "model.prepared",
              invocationId,
              turnId: input.turnId,
              stepId: input.stepId,
              ...(request.model?.id === undefined ? {} : { requestedModelId: request.model.id }),
              attributes: reported,
            }));
          },
        });
        if (input.signal.aborted) throw input.signal.reason;
        // A provider failure the adapter classified ends the step with `model.<code>`.
        if (isModelFailureOutcome(outcome))
          throw new HarnessError(`model.${outcome.code}`, outcome.message, {
            details: {
              retryable: outcome.retryable,
              ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
            },
          });
        const minted = context.mintFromModel(normalizeCandidate(outcome));
        const candidate = context.currentCandidate;
        if (!candidate)
          throw new HarnessError("model.candidate-missing", "Model candidate missing after mint");

        if (definition && turn) {
          const text = candidate.output
            ?.filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("");
          const toolCalls = (candidate.output ?? [])
            .filter((block) => block.type === "tool-call")
            .map((block) => {
              const call = block as {
                readonly type: "tool-call";
                readonly id: string;
                readonly name: string;
                readonly args: JsonValue;
              };
              return { id: call.id, name: call.name, args: call.args };
            });
          const decision = mergeDecisions(
            asDecisions<Decision>(
              await callHooks(
                definition,
                { at: "after", scope: "step" },
                {
                  ...(text ? { text } : {}),
                  toolCalls,
                  info: input.info,
                  state: { ...(input.agent.sessionState ?? {}) },
                  step: input.stepNumber - 1,
                  attempt: turn.afterStepAttempts,
                },
                `after-step:${input.stepId}`,
              ),
            ),
          );
          if (input.agent.recordAfterDynamics) await input.agent.recordAfterDynamics();
          if (decision.block) {
            return context.tripwire({ code: "dynamics.blocked", message: decision.block });
          }
          if (decision.retry) {
            retried = true;
            // Denied calls reach the model as tool results carrying the feedback.
            if (toolCalls.length)
              for (const call of toolCalls) minted.deny(call.id, decision.retry);
            else retryFeedback = decision.retry;
            return minted;
          }
          if (decision.text !== undefined) {
            minted.replace({
              output: [{ type: "text", text: decision.text }],
            });
          }
          for (const item of decision.deny ?? []) minted.deny(item.id, item.reason);
          for (const item of decision.approve ?? [])
            minted.requireInteraction(item.id, {
              kind: "approval",
              prompt: item.prompt,
            });
        }

        return minted;
      } catch (error) {
        if (error instanceof HostSuspension) throw error;
        if (input.signal.aborted) throw input.signal.reason;
        return context.tripwire({
          code: isHarnessError(error) ? error.code : "model.failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    input.observe,
  );
  // A text answer sent back for a retry is not the turn's output, so skip output sealing.
  const output = sealStep(context, retryFeedback === undefined ? input.output : undefined);
  const candidate = output.kind === "tools" ? output.plan.candidate : context.currentCandidate;
  return Object.freeze({
    stepId: input.stepId,
    ...(candidate ? { candidate } : {}),
    ...(requestedModelId === undefined ? {} : { requestedModelId }),
    output,
    ...(modelInvocationId ? { modelInvocationId } : {}),
    ...(retryFeedback ? { retry: retryFeedback } : {}),
    ...(retried ? { retried } : {}),
    ...(turnPatch === undefined ? {} : { turnPatch }),
  });
}

function snapshotStepStart(
  input: StepInput,
): Extract<ObserveEvent, { type: "step.started" }>["attributes"] {
  return Object.freeze({
    arrivals: copyJson(input.arrivals),
    toolResults: copyJson(input.toolResults),
    transcript: input.transcript,
  });
}

function snapshotConfiguration(
  configuration: ModelConfigurationSnapshot,
): ObserveModelConfigurationSnapshot {
  return copyJson(configuration);
}
