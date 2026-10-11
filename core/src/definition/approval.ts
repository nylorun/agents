/**
 * `approval` in a manifest (R5 step 2). Tool approvals are the Tenant's tool policy now, decided
 * at the Runtime's Tool Gate for every harness: `PUT /v1/tenant/tool-policy`, a rule with
 * `effect: "ask"`. So `PUT /v1/agents/:id` and a turn's manifest refuse a definition that sets
 * `approval` on an HTTP tool, an MCP server or an MCP tool's settings, and the SDK refuses it
 * before sending. A manifest saved before keeps it: the gateway reads it from the session's
 * pinned manifest as an ask, so no session loses the approval it was opened with.
 */
import type { AgentManifest } from "../types/manifest.js";
import type { WorkflowManifest } from "../types/workflow.js";

/** Why the SDK refuses an `approval` option. */
export const APPROVAL_REMOVED =
  'approval was removed: tool approvals are the Tenant\'s tool policy now, decided at the Tool Gate for every harness (PUT /v1/tenant/tool-policy, a rule with effect "ask"; see MIGRATION.md)';

/** Where a definition sets `approval`, as a person reads it. */
export function approvalsOf(manifest: AgentManifest | WorkflowManifest, into: string[] = []): string[] {
  if ("kind" in manifest && manifest.kind === "workflow") {
    for (const agent of Object.values(manifest.agents)) approvalsOf(agent, into);
    return into;
  }
  const agent = manifest as AgentManifest;
  for (const capability of agent.capabilities) {
    for (const tool of capability.tools ?? []) {
      if (tool.agent !== undefined) approvalsOf(tool.agent as AgentManifest | WorkflowManifest, into);
      else if (tool.approval !== undefined) into.push(`tool '${tool.name}' of agent '${agent.id}'`);
    }
    for (const [key, server] of Object.entries(capability.mcpServers ?? {})) {
      if (server.approval !== undefined) into.push(`MCP server '${server.name ?? key}' of agent '${agent.id}'`);
      for (const [name, settings] of Object.entries(server.tools ?? {}))
        if (settings.approval !== undefined)
          into.push(`tool '${name}' of MCP server '${server.name ?? key}' of agent '${agent.id}'`);
    }
  }
  return into;
}

/** Why a definition that sets `approval` is refused, naming the first; undefined when none does. */
export function approvalRefusal(manifest: AgentManifest | WorkflowManifest): string | undefined {
  const [first, ...rest] = approvalsOf(manifest);
  if (!first) return undefined;
  const more = rest.length === 0 ? "" : ` (and ${rest.length} more)`;
  return `approval was removed from the manifest: remove it from ${first}${more}. Tool approvals are the Tenant's tool policy now, decided at the Tool Gate for every harness: PUT /v1/tenant/tool-policy with a rule whose effect is "ask" (see MIGRATION.md).`;
}
