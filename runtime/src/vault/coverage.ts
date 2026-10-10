/**
 * What an agent asks of a session's vaults (`POST /v1/tenant/credential-coverage`): each remote
 * MCP server and each HTTP tool with a `credential`, of the agent, the agents it uses as tools and
 * the agents of a flow. `VaultService.coverage` decides what a session would send for each, as
 * `authorize` decides it for a call.
 */
import {
  delegatesOf,
  flowDelegatesOf,
  forEachFlowNode,
  isWorkflowManifest,
  type AgentManifest,
  type WorkflowManifest,
} from "@nylorun/core/define";

/** One URL a manifest names that a vault credential may be bound to. */
export interface CredentialNeed {
  readonly kind: "mcp" | "http";
  /** The declaring agent; absent for the manifest's own agent. */
  readonly agentId?: string;
  /** A flow's HTTP stage or HTTP verifier: its stage key. */
  readonly stage?: string;
  /** The MCP server's name, or the HTTP tool's (or stage's) name. */
  readonly name: string;
  /** What a credential selection names: the server's name, or the HTTP tool's `credential`. */
  readonly serverName: string;
  /** The URL as the manifest names it. */
  readonly url: string;
}

/**
 * The manifest's needs: its own agent's, then each agent it uses as a tool, then a flow's
 * stages and agents (nested flow agents under their stage keys). Repeats are dropped.
 */
export function credentialNeeds(manifest: AgentManifest | WorkflowManifest): CredentialNeed[] {
  const needs = new Map<string, CredentialNeed>();
  const add = (need: CredentialNeed) => {
    const key = JSON.stringify([need.kind, need.agentId, need.stage, need.name, need.serverName, need.url]);
    if (!needs.has(key)) needs.set(key, need);
  };
  const owner = (agentId: string | undefined) => (agentId === undefined ? {} : { agentId });

  const agent = (manifest: AgentManifest, agentId?: string): void => {
    for (const capability of manifest.capabilities) {
      for (const server of Object.values(capability.mcpServers ?? {}))
        add({ kind: "mcp", ...owner(agentId), name: server.name, serverName: server.name, url: server.url });
      for (const tool of capability.tools ?? [])
        if (tool.http?.credential !== undefined)
          add({
            kind: "http",
            ...owner(agentId),
            name: tool.name,
            serverName: tool.http.credential,
            url: tool.http.url,
          });
    }
    for (const child of delegatesOf(manifest)) agent(child.manifest, child.manifest.id);
    for (const child of flowDelegatesOf(manifest)) flow(child.manifest, child.manifest.id);
  };

  const flow = (manifest: WorkflowManifest, prefix: string): void => {
    forEachFlowNode(
      manifest.root,
      ({ node, key }) => {
        const http = "http" in node ? node.http : "tool" in node ? node.tool.http : undefined;
        if (http?.credential === undefined) return;
        add({
          kind: "http",
          stage: key,
          name: "tool" in node ? node.tool.name : key,
          serverName: http.credential,
          url: http.url,
        });
      },
      { prefix },
    );
    for (const [id, embedded] of Object.entries(manifest.agents)) {
      if (isWorkflowManifest(embedded as WorkflowManifest))
        flow(embedded as WorkflowManifest, prefix ? `${prefix}/${id}` : id);
      else agent(embedded as AgentManifest, id);
    }
  };

  if (isWorkflowManifest(manifest as WorkflowManifest)) flow(manifest as WorkflowManifest, "");
  else agent(manifest as AgentManifest);
  return [...needs.values()];
}
