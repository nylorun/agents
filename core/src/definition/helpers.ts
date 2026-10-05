import type { ModelAdapter } from "../types/model.js";
import type { StepMiddleware } from "../types/middleware.js";
import type {
  ToolDefinition,
  ToolInputSchema,
  ToolOutputSchema,
  ToolSchemaSource,
} from "../types/tool.js";
import { prepareTool } from "./schema.js";

export const tool = <
  InputSchema extends ToolInputSchema,
  Info = unknown,
  OutputSchema extends ToolOutputSchema | undefined = undefined
>(
  value: ToolDefinition<InputSchema, Info, OutputSchema>
): ToolDefinition<InputSchema, Info, OutputSchema> =>
  prepareTool(value as ToolDefinition) as ToolDefinition<
    InputSchema,
    Info,
    OutputSchema
  >;

/** @deprecated Prefer Runtime model resolution. Capability-disguised `.use({ model })` is not the taught path. */
export const model = <T extends ModelAdapter>(value: T): T => value;

/** @deprecated Runs in the local engine only. Kept through 1.0. */
export const middleware = <T extends StepMiddleware>(value: T): T => value;

export { capability } from "./capability.js";

export type { ToolSchemaSource };
