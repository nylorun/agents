/**
 * Tools that would run the developer's code (track R2 M6): an agent tool with no `http` and no
 * `agent` that is not one of the Runtime's built-ins (sandbox tools, skill tools,
 * `save_artifact`, `read_artifact`), and a flow agent's `tool` stage without `http`. The
 * Runtime runs agents from their manifests alone, so `PUT /v1/agents/:id` refuses a definition
 * with one, and the SDK refuses it before sending. The local engine (`@nylorun/harness/run`)
 * still runs `tool({ run })`.
 */
import type { AgentManifest, CapabilityManifest, ToolManifest } from "../types/manifest.js";
import type { WorkflowManifest } from "../types/workflow.js";
import { isSandboxToolName } from "../utils/sandbox.js";
import { forEachFlowNode } from "./flow/paths.js";
import {
  ARTIFACTS_CAPABILITY_ID,
  READ_ARTIFACT_TOOL,
  SAVE_ARTIFACT_TOOL,
} from "./sandbox-capability.js";
import { isSkillTool } from "./skill-tools.js";

/** One tool that would run the developer's code, and the definition that declares it. */
export interface CodeTool {
  /** The tool's name, or a flow stage's tool name. */
  readonly name: string;
  /** The agent or flow agent that declares it. */
  readonly owner: string;
  readonly kind: "tool" | "stage";
}

/** Every code tool of a definition document, the agents it embeds or uses as tools included. */
export function codeToolsOf(
  manifest: AgentManifest | WorkflowManifest,
  into: CodeTool[] = []
): CodeTool[] {
  if ("kind" in manifest && manifest.kind === "workflow") {
    forEachFlowNode(manifest.root, ({ node }) => {
      // An HTTP stage (`tool.http`) and an HTTP verifier are requests the Runtime makes.
      if ("tool" in node && node.tool.http === undefined)
        into.push({ name: node.tool.name, owner: manifest.id, kind: "stage" });
    });
    for (const agent of Object.values(manifest.agents)) codeToolsOf(agent, into);
    return into;
  }
  for (const capability of (manifest as AgentManifest).capabilities)
    for (const tool of capability.tools ?? []) {
      if (tool.agent !== undefined) codeToolsOf(tool.agent as AgentManifest | WorkflowManifest, into);
      else if (!runsWithoutCode(capability, tool))
        into.push({ name: tool.name, owner: manifest.id, kind: "tool" });
    }
  return into;
}

/** An HTTP tool, or a built-in the Runtime serves. */
function runsWithoutCode(capability: CapabilityManifest, tool: ToolManifest): boolean {
  if (tool.http !== undefined) return true;
  if (capability.sandbox !== undefined && isSandboxToolName(tool.name)) return true;
  if (
    capability.id === ARTIFACTS_CAPABILITY_ID &&
    (tool.name === SAVE_ARTIFACT_TOOL || tool.name === READ_ARTIFACT_TOOL)
  )
    return true;
  return isSkillTool(capability, tool.name);
}

/** Why a definition with code tools is refused, naming the first; undefined when it has none. */
export function codeToolRefusal(manifest: AgentManifest | WorkflowManifest): string | undefined {
  const [first, ...rest] = codeToolsOf(manifest);
  if (!first) return undefined;
  const what =
    first.kind === "stage"
      ? `The tool stage '${first.name}' of flow agent '${first.owner}'`
      : `Tool '${first.name}' of agent '${first.owner}'`;
  const more = rest.length === 0 ? "" : ` (and ${rest.length} more)`;
  return `${what}${more} runs your code, but the Runtime runs agents from their manifests alone. Make it an http() tool or serve it from a remote MCP server (see MIGRATION.md).`;
}
