import { SKILLS_MOUNT, type AgentManifest } from "@nylorun/core/define";
import type { EffectTarget } from "@nylorun/core/harness-api";
import { isSkillTool } from "./skills.js";

const MOUNT = new RegExp(`${SKILLS_MOUNT}/([^/@\\s"'\`]+)(?:@[0-9a-f]{12})?/`, "g");

/**
 * The skill of `manifest` a call of our engine's tool ran, which the effect names (`skill`):
 * `load_skill` and `read_skill_resource` name it in their input. A sandbox call (`bash`, `read`,
 * `grep`, `glob`, …) is matched on the skills' folder, `/skills/<name>@<hash>/` (or
 * `/skills/<name>/`), in its input's text: exact for a path argument, and for `bash` only when the
 * command names the folder. The first skill of the agent the input names wins.
 */
export function skillOfToolCall(
  manifest: Pick<AgentManifest, "skills"> | undefined,
  tool: { readonly name: string; readonly target?: EffectTarget },
  input: unknown,
): string | undefined {
  const skills = manifest?.skills;
  if (!skills) return undefined;
  if (tool.target?.kind === "harness" && isSkillTool(tool.name)) {
    const name = (input as { name?: unknown } | null | undefined)?.name;
    return typeof name === "string" && skills[name] !== undefined ? name : undefined;
  }
  if (tool.target?.kind !== "sandbox") return undefined;
  for (const text of strings(input))
    for (const match of text.matchAll(MOUNT)) if (skills[match[1]!] !== undefined) return match[1];
  return undefined;
}

/** The string values of a tool's input, one level deep: its path, pattern or command. */
function strings(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (!input || typeof input !== "object") return [];
  return Object.values(input).filter((value): value is string => typeof value === "string");
}
