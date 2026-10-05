import { basename } from "node:path";
import type { CapabilityDeclaration } from "@nylorun/core/define";
import { formatSkillCatalog, SKILLS_USAGE } from "./catalog.js";
import {
  loadSkillsFromDirectory,
  resolveSkillsRoot,
  type LoadedSkill,
  type SkillDiagnostic,
} from "./load.js";

export interface SkillsOptions {
  /** Capability id. Defaults to the catalog directory basename. */
  readonly id?: string;
}

export interface SkillsCapability extends CapabilityDeclaration {
  readonly diagnostics: readonly SkillDiagnostic[];
  /** Absolute catalog directory that was loaded. */
  readonly root: string;
}

/**
 * Load an agentskills.io catalog folder and return one capability for `Agent.use`.
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
 * included, by content hash). The client uploads the files the Runtime lacks when it registers
 * the agent, and the Runtime serves `load_skill` / `read_skill_resource` from them.
 */
export function skills(
  directory: string,
  options: SkillsOptions = {}
): SkillsCapability {
  const root = resolveSkillsRoot(directory);
  const diagnostics: SkillDiagnostic[] = [];
  const loaded = loadSkillsFromDirectory(root, diagnostics);
  const listed = Object.values(loaded);
  const id = options.id ?? basename(root);
  if (listed.length === 0) {
    return { id, root, diagnostics };
  }
  const { skills: skillManifest, skillFiles } = skillsDeclaration(listed);
  return {
    id,
    root,
    instructions: [
      SKILLS_USAGE,
      formatSkillCatalog(
        listed.map((skill) => ({
          name: skill.name,
          description: skill.description,
        }))
      ),
    ],
    skills: skillManifest,
    skillFiles,
    diagnostics,
  };
}

/** The manifest's skills and the bytes behind their files, for a capability declaration. */
export function skillsDeclaration(
  listed: readonly LoadedSkill[]
): Required<Pick<CapabilityDeclaration, "skills" | "skillFiles">> {
  return {
    skills: Object.fromEntries(
      listed.map((skill) => [
        skill.name,
        { name: skill.name, description: skill.description, files: skill.files },
      ])
    ),
    skillFiles: Object.assign({}, ...listed.map((skill) => skill.sources)),
  };
}
