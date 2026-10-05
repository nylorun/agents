import { HostSuspension } from "../host-suspension.js";
import type { ExecutionSnapshot, StepInput, StepRuntime } from "./runtime.js";
import type { TurnOutputContract } from "@nylorun/core/define";
import type { ModelCandidate, ModelConfigurationSnapshot } from "@nylorun/core/define";
import type { ObserveEvent, ObserveModelConfigurationSnapshot } from "@nylorun/core/define";
import type { InputEvent } from "@nylorun/core/define";
import type { ToolResult } from "@nylorun/core/define";
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
export interface StepRunResult {
  readonly stepId: string;
  readonly candidate?: ModelCandidate;
  readonly output: SealedStepOutput;
  readonly requestedModelId?: string;
  readonly modelInvocationId?: string;
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
}): Promise<StepRunResult> {
  let requestedModelId: string | undefined;
  let modelInvocationId: string | undefined;
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
        if (!context.currentCandidate)
          throw new HarnessError("model.candidate-missing", "Model candidate missing after mint");
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
  const output = sealStep(context, input.output);
  const candidate = output.kind === "tools" ? output.plan.candidate : context.currentCandidate;
  return Object.freeze({
    stepId: input.stepId,
    ...(candidate ? { candidate } : {}),
    ...(requestedModelId === undefined ? {} : { requestedModelId }),
    output,
    ...(modelInvocationId ? { modelInvocationId } : {}),
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
