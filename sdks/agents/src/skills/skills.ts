import { basename } from "node:path";
import type { PartDeclaration, PluginLabel } from "@nylorun/core/define";
import {
  loadSkillsFromDirectory,
  resolveSkillsRoot,
  type LoadedSkill,
  type SkillDiagnostic,
} from "./load.js";

export interface SkillsPart extends PartDeclaration {
  readonly diagnostics: readonly SkillDiagnostic[];
  /** Absolute catalog directory that was loaded. */
  readonly root: string;
}

/**
 * Load an agentskills.io catalog folder as one part of an agent, for `.skills()`.
 *
 * Expected layout:
 * ```
 * assistant-skills/
 *   lookup-order/SKILL.md
 *   refund/
 *     SKILL.md
 *     references/policy.md
 * ```
 *
 * Sets `skills`: each skill's name, description and files (every file of its folder, binary
 * included, by content hash). A SKILL.md's frontmatter `secrets` (environment variable names)
 * become the skill's `secrets` in the harness section when the agent's manifest is saved. The
 * client uploads the files the Runtime lacks when it saves the agent's manifest; the Runtime adds
 * the skill catalog and serves `load_skill` / `read_skill_resource` from them.
 */
export function skills(directory: string): SkillsPart {
  const root = resolveSkillsRoot(directory);
  const diagnostics: SkillDiagnostic[] = [];
  const loaded = loadSkillsFromDirectory(root, diagnostics);
  const listed = Object.values(loaded);
  const id = `skills:${basename(root)}`;
  if (listed.length === 0) {
    return { id, root, diagnostics };
  }
  return { id, root, ...skillsDeclaration(listed), diagnostics };
}

/**
 * The manifest's skills, the bytes behind their files and the secret slots their SKILL.md lists
 * (`secrets`, the harness section's when the agent is saved). A plugin's skills carry its label,
 * so a tool call can be traced to the plugin that brought the skill.
 */
export function skillsDeclaration(
  listed: readonly LoadedSkill[],
  plugin?: PluginLabel
): Required<Pick<PartDeclaration, "skills" | "skillFiles">> & Pick<PartDeclaration, "skillSecrets"> {
  const secrets = listed.filter((skill) => skill.secrets !== undefined).map((skill) => [skill.name, skill.secrets!]);
  return {
    skills: Object.fromEntries(
      listed.map((skill) => [
        skill.name,
        {
          name: skill.name,
          description: skill.description,
          files: skill.files,
          ...(plugin === undefined ? {} : { plugin }),
        },
      ])
    ),
    skillFiles: Object.assign({}, ...listed.map((skill) => skill.sources)),
    ...(secrets.length === 0 ? {} : { skillSecrets: Object.fromEntries(secrets) }),
  };
}
