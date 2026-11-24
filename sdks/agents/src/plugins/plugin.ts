import type { PartDeclaration, PluginLabel, PluginManifest } from "@nylorun/core/define";
import { skillsDeclaration } from "../skills/skills.js";
import {
  loadPlugin,
  type LoadedPlugin,
  type PluginDiagnostic,
} from "./load.js";

export interface PluginPart extends PartDeclaration {
  readonly diagnostics: readonly PluginDiagnostic[];
}

/**
 * Read an Agent Plugin package as one part of an agent, for `.plugin()`. Each part it skips
 * (an invalid MCP server or skill) is a process warning, so building or saving its manifest
 * says why the agent has less than the package declares. A stdio MCP server throws: Nylorun
 * accepts remote servers only.
 */
export function plugin(directory: string): PluginPart {
  const loaded = loadPlugin(directory);
  warn(loaded);
  return partFromPlugin(loaded);
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

/**
 * The part a plugin adds: its skills and remote MCP servers, each labelled with the plugin's name
 * and version, and, when it holds files beyond those parts, the plugin with its `files`, mounted
 * in the sandbox.
 */
export function partFromPlugin(loaded: LoadedPlugin): PluginPart {
  const label: PluginLabel = {
    name: loaded.name,
    ...(loaded.version === undefined ? {} : { version: loaded.version }),
  };
  const skills = Object.values(loaded.skills);
  const servers = Object.entries(loaded.mcpServers);
  const declared = skills.length === 0 ? undefined : skillsDeclaration(skills, label);
  const mounted: PluginManifest | undefined = loaded.files ? { ...label, files: loaded.files } : undefined;
  const skillFiles = { ...(declared?.skillFiles ?? {}), ...(loaded.fileSources ?? {}) };
  return {
    id: `plugin:${loaded.name}`,
    ...(declared ?? {}),
    ...(Object.keys(skillFiles).length === 0 ? {} : { skillFiles }),
    ...(mounted ? { plugins: [mounted] } : {}),
    ...(servers.length === 0
      ? {}
      : {
          mcpServers: Object.fromEntries(
            servers.map(([name, server]) => [name, { ...server, plugin: label }])
          ),
        }),
    diagnostics: loaded.diagnostics,
  };
}
