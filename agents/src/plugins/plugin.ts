import type { CapabilityDeclaration } from "@nylorun/core/define";
import { formatSkillCatalog, SKILLS_USAGE } from "../skills/catalog.js";
import {
  loadPlugin,
  type LoadedPlugin,
  type PluginDiagnostic,
} from "./load.js";

export interface PluginCapability extends CapabilityDeclaration {
  readonly diagnostics: readonly PluginDiagnostic[];
}

/**
 * Read an Agent Plugin package and return one capability for `Agent.use`. Each part it skips
 * (an invalid MCP server or skill) is a process warning, so building or registering the agent
 * says why the agent has less than the package declares.
 */
export function plugin(directory: string): PluginCapability {
  const loaded = loadPlugin(directory);
  warn(loaded);
  return capabilityFromPlugin(loaded);
}

function warn(loaded: LoadedPlugin): void {
  for (const diagnostic of loaded.diagnostics) {
    if (diagnostic.severity !== "warning") continue;
    process.emitWarning(`Plugin '${loaded.name}': ${diagnostic.message}`, {
      type: "NylorunPluginWarning",
      code: diagnostic.code,
      ...(diagnostic.path === undefined ? {} : { detail: diagnostic.path }),
    });
  }
}

export function capabilityFromPlugin(loaded: LoadedPlugin): PluginCapability {
  const names = Object.values(loaded.skills);
  const instructions =
    names.length === 0
      ? undefined
      : [
          SKILLS_USAGE,
          formatSkillCatalog(
            names.map((skill) => ({
              name: skill.name,
              description: skill.description,
            }))
          ),
        ];
  const skills = Object.fromEntries(
    names.map((skill) => [
      skill.name,
      { name: skill.name, description: skill.description },
    ])
  );
  return {
    id: loaded.name,
    type: "agent-plugin",
    pluginRoot: loaded.root,
    ...(loaded.description === undefined ? {} : { description: loaded.description }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(names.length === 0 ? {} : { skills, skillRecords: loaded.skills }),
    ...(Object.keys(loaded.mcpServers).length === 0
      ? {}
      : { mcpServers: loaded.mcpServers }),
    diagnostics: loaded.diagnostics,
  };
}
