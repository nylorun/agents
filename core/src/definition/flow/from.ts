/**
 * Rebuild a flow agent from its workflow manifest v3 plus the tools its tool nodes name,
 * the way `Agent.from` rebuilds a ReAct agent from its manifest and implementations.
 */
import { HarnessError } from "../../errors.js";
import type { AgentManifest } from "../../types/manifest.js";
import type { ToolDefinition } from "../../types/tool.js";
import type {
  WorkflowBinding,
  WorkflowManifest,
  WorkflowNodeImplementation,
} from "../../types/workflow.js";
import { WorkflowManifestSchema } from "../../contracts.js";
import type { AgentBinding } from "../binding.js";
import type { Implementations } from "../implementations.js";
import { agentFrom } from "../from.js";
import { deepFreeze } from "../../utils/immutable.js";
import type { BuiltWorkflow } from "../workflow/types.js";
import { bindToolNode } from "../workflow/runnable.js";
import { forEachFlowNode, isWorkflowManifest } from "./paths.js";

/** The code a flow agent's manifest names, keyed as the manifest's stage keys. */
export interface FlowImplementations {
  /** Tool nodes, by stage key (`open_pr`). */
  readonly nodes?: Readonly<Record<string, ToolDefinition<any, any, any>>>;
  /** Implementations for each embedded agent, by agent id. */
  readonly agents?: Readonly<Record<string, Implementations<any>>>;
}

export function flowFrom(json: unknown, implementations: FlowImplementations = {}): BuiltWorkflow {
  const manifest = deepFreeze(
    JSON.parse(JSON.stringify(WorkflowManifestSchema.parse(json)))
  ) as WorkflowManifest;
  const needs: string[] = [];
  const agents: Record<string, AgentManifest> = {};
  collect(manifest, "", needs, agents);

  const nodes: Record<string, WorkflowNodeImplementation> = {};
  const given = implementations.nodes ?? {};
  const missing: string[] = [];
  for (const key of needs) {
    const impl = given[key];
    if (impl === undefined) {
      missing.push(key);
      continue;
    }
    if (typeof impl === "function")
      throw new HarnessError("agent.build-failed", `'${key}' is a tool node: pass a tool, not a function`);
    nodes[key] = { kind: "tool", tool: bindToolNode(impl) };
  }
  if (missing.length)
    throw new HarnessError(
      "agent.build-failed",
      `Missing flow implementation${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
    );
  const unknown = Object.keys(given).filter((key) => !needs.includes(key));
  if (unknown.length)
    throw new HarnessError(
      "agent.build-failed",
      `Flow agent '${manifest.id}' has no tool node${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`
    );

  const bindings: Record<string, AgentBinding> = {};
  for (const [id, agent] of Object.entries(agents))
    bindings[id] = agentFrom(agent, implementations.agents?.[id] ?? {}).getBinding();

  const binding: WorkflowBinding = Object.freeze({
    manifest,
    nodes: Object.freeze(nodes),
    agents: Object.freeze(bindings),
  });
  const built = { id: manifest.id, manifest, toJSON: () => manifest } as BuiltWorkflow;
  Object.defineProperty(built, "getBinding", { value: () => binding, enumerable: false });
  return built;
}

/** Every tool node's stage key, and every embedded ReAct agent. */
function collect(
  flow: WorkflowManifest,
  prefix: string,
  needs: string[],
  agents: Record<string, AgentManifest>
): void {
  forEachFlowNode(
    flow.root,
    ({ node, key }) => {
      if ("tool" in node) needs.push(key);
      if ("agent" in node) {
        const target = flow.agents[node.agent]!;
        if (isWorkflowManifest(target as WorkflowManifest))
          collect(target as WorkflowManifest, key, needs, agents);
        else agents[node.agent] = target as AgentManifest;
      }
    },
    { prefix }
  );
}
