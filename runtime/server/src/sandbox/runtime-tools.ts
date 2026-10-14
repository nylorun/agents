import {
  isSandboxToolName,
  runtimeToolOf,
  type AgentManifest,
  type SandboxManifest,
} from "@nylorun/core/define";

/**
 * The session's sandbox spec when `toolName` is one of the sandbox tools the Runtime pinned on
 * `manifest` (its `runtime` block); undefined for any other tool. A tool's name alone says whose
 * it is: an author tool may not take a Runtime tool's name.
 */
export function sandboxToolSpec(
  manifest: AgentManifest | undefined,
  toolName: string | undefined
): SandboxManifest | undefined {
  if (!toolName || !isSandboxToolName(toolName)) return undefined;
  const sandbox = manifest?.runtime?.sandbox;
  return sandbox !== undefined && runtimeToolOf(manifest, toolName) !== undefined ? sandbox : undefined;
}

/** True when `toolName` is a tool the Runtime pinned on `manifest` (its `runtime.tools`). */
export function isPinnedRuntimeTool(
  manifest: AgentManifest | undefined,
  toolName: string | undefined
): boolean {
  return runtimeToolOf(manifest, toolName) !== undefined;
}
