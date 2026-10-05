/** What a flow stage may hold, and how a tool becomes a tool node. */
import type { AgentTool, BuiltAgent } from "../../types/agent.js";
import type { ToolDefinition } from "../../types/tool.js";
import type { WorkflowToolNode } from "../../types/workflow.js";
import type { BoundToolDefinition } from "../bound.js";
import { normalizeToolDefinition, normalizeSchema } from "../schema.js";
import { HarnessError } from "../../errors.js";
import type { ToolSchema, ToolSchemaSource } from "../../types/tool.js";
import { isBuiltWorkflow } from "./types.js";
import { diagnostic, fail } from "./diagnostics.js";

export function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!value || typeof value !== "object") return false;
  if (!("name" in value) || typeof (value as { name: unknown }).name !== "string") return false;
  // A named Agent builder has `name` and an `.input()` method; agents and flows are never tools.
  if (isBuiltWorkflow(value) || isAgentOrBuilder(value)) return false;
  const v = value as ToolDefinition;
  return (
    typeof v.execute === "function" ||
    typeof v.run === "function" ||
    v.inputSchema !== undefined ||
    v.input !== undefined
  );
}

function isAgentOrBuilder(value: object): boolean {
  return (
    typeof (value as { getBinding?: unknown }).getBinding === "function" ||
    typeof (value as { build?: unknown }).build === "function"
  );
}

export function builtAgentOf(run: BuiltAgent | AgentTool | { build(): BuiltAgent }): BuiltAgent {
  if (
    run &&
    typeof run === "object" &&
    "getBinding" in run &&
    typeof run.getBinding === "function" &&
    "manifest" in run &&
    !isBuiltWorkflow(run)
  )
    return run as BuiltAgent;
  if (run && typeof run === "object" && "build" in run && typeof run.build === "function")
    return run.build();
  fail([diagnostic("workflow.invalid-runnable", "Expected a built agent or Agent builder")]);
}

/**
 * Project a tool for use as a workflow node.
 * Unlike agent tools, workflow tool nodes may take any JSON Schema root type (workflows.md §9).
 * Built without `bindTool` so we skip the agent-only object-input rule in `normalizeSchema`.
 */
export function bindToolNode(tool: ToolDefinition): BoundToolDefinition {
  const normalized = normalizeToolDefinition(tool);
  if (!normalized.name)
    throw new HarnessError("tool.invalid-name", "Tool name must not be empty");
  const execute = normalized.execute ?? normalized.run;
  if (typeof execute !== "function")
    throw new HarnessError(
      "tool.invalid",
      `Tool '${normalized.name}' must provide run() or execute()`,
    );
  const rawInput = (normalized.inputSchema ?? normalized.input) as ToolSchemaSource | undefined;
  if (!rawInput)
    throw new HarnessError(
      "tool.invalid-schema",
      `Tool '${normalized.name}' must provide input or inputSchema`,
    );
  // role "output" skips the object-root check used for agent tool inputs.
  const inputSchema = schemaForNode(rawInput, "input");
  const rawOutput = (normalized.outputSchema ?? normalized.output) as
    | ToolSchemaSource
    | undefined;
  const outputSchema = rawOutput ? schemaForNode(rawOutput, "output") : undefined;
  return Object.freeze({
    source: tool,
    name: normalized.name,
    ...(normalized.description ? { description: normalized.description } : {}),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    execute: execute.bind(normalized) as BoundToolDefinition["execute"],
    ...(normalized.approval === undefined ? {} : { approval: normalized.approval }),
    ...(normalized.effects === undefined ? {} : { effects: normalized.effects }),
    owner: Object.freeze({ middlewareId: "workflow", slot: "tool-node" }),
  });
}

/** Normalize a schema for a workflow tool node (any JSON Schema root type allowed). */
function schemaForNode(
  source: ToolSchemaSource,
  role: "input" | "output",
): ToolSchema<unknown> {
  if (
    source &&
    typeof source === "object" &&
    "jsonSchema" in source &&
    typeof (source as ToolSchema<unknown>).validate === "function"
  )
    return source as ToolSchema<unknown>;
  // Pass role "output" so normalizeSchema does not require an object root.
  return normalizeSchema(source, role === "input" ? "output" : role);
}

export function toolManifestNode(bound: BoundToolDefinition): WorkflowToolNode {
  return {
    tool: {
      name: bound.name,
      ...(bound.description === undefined ? {} : { description: bound.description }),
      inputSchema: bound.inputSchema.jsonSchema,
      ...(bound.outputSchema === undefined
        ? {}
        : { outputSchema: bound.outputSchema.jsonSchema }),
    },
  };
}
