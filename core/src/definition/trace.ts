import type { AgentManifest, PluginLabel } from "../types/manifest.js";
import { SKILLS_MOUNT } from "../utils/definition-files.js";
import { isSandboxToolName } from "../utils/sandbox.js";
import { SKILL_TOOL_NAMES } from "./skill-tools.js";

/** What a tool call is traced to: the skill it ran, and the plugin that brought its skill or server. */
export interface ToolCallTrace {
  readonly skill?: string;
  readonly plugin?: PluginLabel;
}

const MOUNT = new RegExp(`${SKILLS_MOUNT}/([^/@\\s"'\`]+)(?:@[0-9a-f]{12})?/`, "g");

/**
 * The skill of `manifest` a tool call ran. `load_skill` and `read_skill_resource` name it in their
 * input. A sandbox tool (`bash`, `read`, `grep`, `glob`, …) is matched on the skills' mount path,
 * `/skills/<name>@<hash>/` (or `/skills/<name>/`, before D66), in its input's text: exact for a path argument, and for `bash` only when the
 * command names the path. The first skill of the agent the input names wins.
 */
export function skillOfToolCall(
  manifest: Pick<AgentManifest, "skills"> | undefined,
  toolName: string | undefined,
  input: unknown
): string | undefined {
  const skills = manifest?.skills;
  if (!skills || toolName === undefined) return undefined;
  if (SKILL_TOOL_NAMES.has(toolName)) {
    const name = (input as { name?: unknown } | null | undefined)?.name;
    return typeof name === "string" && skills[name] !== undefined ? name : undefined;
  }
  if (!isSandboxToolName(toolName)) return undefined;
  for (const text of strings(input))
    for (const match of text.matchAll(MOUNT))
      if (skills[match[1]!] !== undefined) return match[1];
  return undefined;
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

/** The string values of a tool's input, one level deep: its path, pattern or command. */
function strings(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (!input || typeof input !== "object") return [];
  return Object.values(input).filter((value): value is string => typeof value === "string");
}
