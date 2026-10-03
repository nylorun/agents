import {
  isSandboxToolName,
  type AgentManifest,
  type CapabilityManifest,
} from "@nylorun/core/define";

/** The sandbox capability that owns this tool call, when the call is a built-in sandbox tool. */
export function sandboxCapabilityOf(
  manifest: AgentManifest | undefined,
  capabilityId: string | undefined,
  toolName: string | undefined
): CapabilityManifest | undefined {
  if (!manifest || !capabilityId || !toolName || !isSandboxToolName(toolName)) return undefined;
  const capability = manifest.capabilities.find((item) => item.id === capabilityId);
  return capability?.sandbox && capability.tools?.some((tool) => tool.name === toolName)
    ? capability
    : undefined;
}
