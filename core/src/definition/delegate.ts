import { z } from "zod";
import type { BuiltAgent } from "../types/agent.js";
import type { AgentManifest } from "../types/manifest.js";
import type { WorkflowManifestV2 } from "../types/workflow.js";
import type { BuiltWorkflow } from "./workflow/types.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolDefinition } from "../types/tool.js";
import { ToolError } from "./tool-error.js";
import { normalizeSchema } from "./schema.js";
import { schemaFromJSON } from "./schema-json.js";

/** Survives duplicate installed copies of core, like the error brands. */
const DELEGATE = Symbol.for("@nylorun/core/delegate");

/** An agent used as another agent's tool. The engine runs it; customer code never does. */
export interface Delegate {
  /**
   * The child's manifest, inlined into the parent's tool. A flow agent's workflow manifest
   * v2 runs in its own linked session on the Runtime, not inside the parent's run.
   */
  readonly manifest: AgentManifest | WorkflowManifestV2;
  /** The authored child, when available locally. Absent when rebuilt from a manifest. */
  readonly agent?: BuiltAgent;
  /** The authored flow agent, when the child is one and available locally. */
  readonly workflow?: BuiltWorkflow;
}

/** True when the delegate is a flow agent, which runs in its own linked session. */
export function isFlowDelegate(
  delegate: Delegate
): delegate is Delegate & { readonly manifest: WorkflowManifestV2 } {
  return (delegate.manifest as { kind?: unknown }).kind === "workflow";
}

/** Model-facing tool names: what every supported provider accepts. */
export const DELEGATE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const taskSchema = z
  .object({
    task: z
      .string()
      .min(1)
      .describe("A complete, self-contained task. The agent sees nothing else."),
  })
  .strict();

/** The input every agent used as a tool accepts. Part of the hashed manifest; change deliberately. */
export const DELEGATE_INPUT_SCHEMA: JsonObject = normalizeSchema(taskSchema, "input").jsonSchema;

async function engineOnly(): Promise<never> {
  throw new ToolError(
    "delegation.engine-only",
    "Agents used as tools are run by the Nylorun engine, not by an executor"
  );
}

/** A built agent or an agent builder; both expose getBinding() and manifest. */
export function isAgentItem(value: unknown): value is Pick<BuiltAgent, "id" | "manifest" | "getBinding"> & {
  build?: () => BuiltAgent;
} {
  if (value === null || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.getBinding === "function" &&
    typeof item.execute !== "function" &&
    typeof item.run !== "function"
  );
}

/** Turn an agent placed in `tools` into the tool that delegates to it. */
export function delegateTool(item: unknown): ToolDefinition {
  const candidate = item as { build?: () => BuiltAgent | BuiltWorkflow } & BuiltAgent;
  const built = typeof candidate.build === "function" ? candidate.build() : candidate;
  if ((built.manifest as { kind?: unknown }).kind === "workflow") {
    const workflow = built as unknown as BuiltWorkflow;
    return withDelegate(workflow.manifest as WorkflowManifestV2, undefined, undefined, workflow);
  }
  return withDelegate(built.manifest as AgentManifest, built as BuiltAgent);
}

/** Rebuild the delegating tool from a manifest's `agent` body. */
export function delegateFromManifest(
  manifest: AgentManifest | WorkflowManifestV2,
  tool: { readonly description?: string; readonly inputSchema: JsonObject }
): ToolDefinition {
  return withDelegate(manifest, undefined, tool);
}

function withDelegate(
  manifest: AgentManifest | WorkflowManifestV2,
  agent: BuiltAgent | undefined,
  declared?: { readonly description?: string; readonly inputSchema: JsonObject },
  workflow?: BuiltWorkflow
): ToolDefinition {
  const description = declared ? declared.description : manifest.description;
  const definition: ToolDefinition = {
    name: manifest.id,
    ...(description === undefined ? {} : { description }),
    inputSchema: declared ? schemaFromJSON(declared.inputSchema) : taskSchema,
    execute: engineOnly,
  };
  const delegate: Delegate = Object.freeze({
    manifest,
    ...(agent ? { agent } : {}),
    ...(workflow ? { workflow } : {}),
  });
  Object.defineProperty(definition, DELEGATE, { value: delegate, enumerable: false });
  return Object.freeze(definition);
}

/** The delegate behind a tool definition, or behind the bound snapshot of one. */
export function delegateOf(tool: unknown): Delegate | undefined {
  if (tool === null || typeof tool !== "object") return undefined;
  const value = tool as Record<symbol, Delegate | undefined> & { source?: unknown };
  return value[DELEGATE] ?? (value.source === tool ? undefined : delegateOf(value.source));
}

/**
 * The ReAct agents a manifest delegates to, which the engine runs inside the parent's run,
 * with the capability that declares each. Flow agents are in `flowDelegatesOf`.
 */
export function delegatesOf(
  manifest: AgentManifest
): readonly { readonly capabilityId: string; readonly manifest: AgentManifest }[] {
  const found: { capabilityId: string; manifest: AgentManifest }[] = [];
  for (const capability of manifest.capabilities)
    for (const tool of capability.tools ?? [])
      if (tool.agent && !("kind" in tool.agent))
        found.push({ capabilityId: capability.id, manifest: tool.agent });
  return found;
}

/** The flow agents a manifest delegates to: each runs in its own linked session. */
export function flowDelegatesOf(
  manifest: AgentManifest
): readonly { readonly capabilityId: string; readonly manifest: WorkflowManifestV2 }[] {
  const found: { capabilityId: string; manifest: WorkflowManifestV2 }[] = [];
  for (const capability of manifest.capabilities)
    for (const tool of capability.tools ?? [])
      if (tool.agent && "kind" in tool.agent)
        found.push({ capabilityId: capability.id, manifest: tool.agent });
  return found;
}

/** The flow agent `id` a manifest delegates to, or undefined. */
export function flowDelegateManifest(
  manifest: AgentManifest,
  id: string
): WorkflowManifestV2 | undefined {
  return flowDelegatesOf(manifest).find((item) => item.manifest.id === id)?.manifest;
}

/** The manifest of the delegated agent `id`, or undefined. One level deep by construction. */
export function delegateManifest(
  manifest: AgentManifest,
  id: string
): AgentManifest | undefined {
  return delegatesOf(manifest).find((item) => item.manifest.id === id)?.manifest;
}
