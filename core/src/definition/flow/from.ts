/**
 * Rebuild a flow agent from its workflow manifest v2 plus the code its stage keys name,
 * the way `Agent.from` rebuilds a ReAct agent from its manifest and implementations.
 */
import { HarnessError } from "../../errors.js";
import type { AgentManifest } from "../../types/manifest.js";
import type { ToolDefinition } from "../../types/tool.js";
import type {
  WorkflowBinding,
  WorkflowManifestV2,
  WorkflowNodeImplementation,
} from "../../types/workflow.js";
import { WorkflowManifestSchema } from "../../contracts.js";
import type { AgentBinding } from "../binding.js";
import type { Implementations } from "../implementations.js";
import { agentFrom } from "../from.js";
import { deepFreeze } from "../../utils/immutable.js";
import type { BuiltWorkflow } from "../workflow/types.js";
import { bindToolNode } from "../workflow/runnable.js";
import { forEachFlowNode, functionKey, isWorkflowManifestV2 } from "./paths.js";

/** The code a flow agent's manifest names, keyed as the manifest's stage keys. */
export interface FlowImplementations {
  /** Stage functions (`route:on`, `@1:input`) and tool nodes (`open_pr`). */
  readonly nodes?: Readonly<Record<string, ((args: any) => unknown) | ToolDefinition<any, any, any>>>;
  /** Implementations for each embedded agent, by agent id. */
  readonly agents?: Readonly<Record<string, Implementations<any>>>;
}

type Need = { readonly key: string; readonly kind: "fn" | "verify" | "tool" };

export function flowFrom(json: unknown, implementations: FlowImplementations = {}): BuiltWorkflow {
  const manifest = deepFreeze(
    JSON.parse(JSON.stringify(WorkflowManifestSchema.parse(json)))
  ) as WorkflowManifestV2;
  if (!isWorkflowManifestV2(manifest))
    throw new HarnessError(
      "agent.build-failed",
      "Agent.from reads workflow manifest v2; rebuild a v1 workflow with Chain, Switch, Parallel, Map or Loop"
    );
  const needs: Need[] = [];
  const agents: Record<string, AgentManifest> = {};
  collect(manifest, "", needs, agents);

  const nodes: Record<string, WorkflowNodeImplementation> = {};
  const given = implementations.nodes ?? {};
  const missing: string[] = [];
  for (const need of needs) {
    const impl = given[need.key];
    if (impl === undefined) {
      missing.push(need.key);
      continue;
    }
    if (need.kind === "tool") {
      if (typeof impl === "function")
        throw new HarnessError("agent.build-failed", `'${need.key}' is a tool node: pass a tool, not a function`);
      nodes[need.key] = { kind: "tool", tool: bindToolNode(impl) };
    } else {
      if (typeof impl !== "function")
        throw new HarnessError("agent.build-failed", `'${need.key}' is a flow function: pass a function`);
      nodes[need.key] = { kind: need.kind, fn: impl as never };
    }
  }
  if (missing.length)
    throw new HarnessError(
      "agent.build-failed",
      `Missing flow implementation${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
    );
  const unknown = Object.keys(given).filter((key) => !needs.some((need) => need.key === key));
  if (unknown.length)
    throw new HarnessError(
      "agent.build-failed",
      `Flow agent '${manifest.id}' has no stage key${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`
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

/** Every stage key the manifest binds code under, and every embedded ReAct agent. */
function collect(
  flow: WorkflowManifestV2,
  prefix: string,
  needs: Need[],
  agents: Record<string, AgentManifest>
): void {
  forEachFlowNode(
    flow.root,
    ({ node, key }) => {
      if (node.input) needs.push({ key: functionKey(key, "input"), kind: "fn" });
      if ("tool" in node) needs.push({ key, kind: "tool" });
      if ("switch" in node) needs.push({ key: functionKey(key, "on"), kind: "fn" });
      if ("loop" in node) {
        if ("fn" in node.loop.verify) needs.push({ key: functionKey(key, "verify"), kind: "verify" });
        if (node.loop.decide) needs.push({ key: functionKey(key, "decide"), kind: "fn" });
      }
      if ("agent" in node) {
        const target = flow.agents[node.agent]!;
        if (isWorkflowManifestV2(target as WorkflowManifestV2))
          collect(target as WorkflowManifestV2, key, needs, agents);
        else agents[node.agent] = target as AgentManifest;
      }
    },
    { prefix }
  );
}
