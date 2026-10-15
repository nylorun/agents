import type { AgentManifest, PluginLabel } from "../types/manifest.js";

/** What a tool call is traced to: the skill it ran, and the plugin that brought its skill or server. */
export interface ToolCallTrace {
  readonly skill?: string;
  readonly plugin?: PluginLabel;
}

/** The plugin that brought the skill or MCP server `name` to `manifest`, if one did. */
export function pluginOf(
  manifest: Pick<AgentManifest, "skills" | "mcpServers"> | undefined,
  what: { readonly skill?: string; readonly server?: string }
): PluginLabel | undefined {
  if (what.skill !== undefined) return manifest?.skills?.[what.skill]?.plugin;
  if (what.server !== undefined) return manifest?.mcpServers?.[what.server]?.plugin;
  return undefined;
}
