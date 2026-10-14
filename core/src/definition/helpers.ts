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

export type { ToolSchemaSource };
