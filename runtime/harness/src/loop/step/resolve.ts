import type { TurnOutputContract } from "@nylorun/core/define";
import { describeConfiguration } from "./describe.js";
import type { InputEvent } from "@nylorun/core/define";
import type { ModelRequest } from "@nylorun/core/define";
import type { ToolResult } from "@nylorun/core/define";
import type { StepContext } from "./step-context.js";

export function resolveModelRequest(input: {
  context: StepContext;
  arrivals: readonly InputEvent[];
  toolResults: readonly ToolResult[];
  output?: TurnOutputContract;
}): ModelRequest {
  const ctx = input.context;
  const configuration = describeConfiguration(ctx.configurationSnapshot());
  return Object.freeze({
    executionId: ctx.input.executionId,
    turnId: ctx.input.turnId,
    stepId: ctx.input.stepId,
    ...(ctx.selectedDirective === undefined ? {} : { model: ctx.selectedDirective }),
    configuration,
    instructions: Object.freeze([...ctx.instructions]),
    context: ctx.contextSnapshot(),
    transcript: Object.freeze([...ctx.input.transcript]),
    arrivals: Object.freeze([...input.arrivals]),
    toolResults: Object.freeze([...input.toolResults]),
    tools: configuration.tools,
    ...(input.output === undefined ? {} : { outputSchema: input.output.schema.jsonSchema }),
  });
}
