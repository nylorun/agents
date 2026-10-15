/**
 * The skill tools (track R2 M4): `load_skill` and `read_skill_resource`, which the Runtime pins
 * in the `runtime` block of an agent with skills. The Runtime runs them itself, like `save_artifact`, from the
 * definition files uploaded with the agent: no developer process is involved.
 *
 * - `load_skill`: the skill's instructions (its `SKILL.md` after the frontmatter), the paths of
 *   its other files, and, when the session has a sandbox, where they are in it
 *   (`/skills/<name>@<hash>/`, read-only, D66).
 * - `read_skill_resource`: one text file of the skill. A binary file, or one over
 *   `SKILL_READ_MAX_BYTES`, is refused: the model reads it in the sandbox, when there is one.
 *
 * Expected problems are failed outcomes the model sees; only infrastructure errors throw.
 */
import type { SandboxToolOutcome } from "@nylorun/core/contracts";
import {
  LOAD_SKILL_TOOL,
  SKILL_ENTRY,
  skillFolderOf,
  isSkillTool,
  skillInstructions,
  type AgentManifest,
  type SkillManifest,
} from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { sandboxToolSpec } from "../sandbox/runtime-tools.js";
import { definitionFileKey, readDefinitionFile } from "./definition-files.js";
import type { TenantContext } from "./context.js";

const failed = (code: string, message: string): SandboxToolOutcome => ({ kind: "failed", code, message });

/**
 * The largest file the skill tools read into the model's context (10 MiB). A skill's files may
 * hold up to 2 GiB together: a larger file is used in the sandbox.
 */
export const SKILL_READ_MAX_BYTES = 10 * 1024 * 1024;

/** True when `request` calls a skill tool the Runtime serves for `manifest`'s agent. */
export function isSkillToolCall(manifest: AgentManifest | undefined, request: HostEffect): boolean {
  return request.kind === "tool" && isSkillTool(manifest, request.toolName);
}

/** Every skill of the agent, by name. */
function skillsOf(manifest: AgentManifest): Map<string, SkillManifest> {
  return new Map(Object.values(manifest.skills ?? {}).map((skill) => [skill.name, skill]));
}

/** UTF-8 text, or undefined for bytes that are not (a NUL byte, or invalid UTF-8). */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function callSkillTool(
  ctx: TenantContext,
  manifest: AgentManifest,
  request: HostEffect,
  signal: AbortSignal
): Promise<SandboxToolOutcome> {
  const input = (request.input ?? {}) as { name?: unknown; path?: unknown };
  const skills = skillsOf(manifest);
  const name = typeof input.name === "string" ? input.name : "";
  const skill = skills.get(name);
  if (!skill)
    return request.toolName === LOAD_SKILL_TOOL
      ? { kind: "completed", output: { unknown: name, available: [...skills.keys()].sort() } }
      : failed("skill.unknown", `There is no skill '${name}'.`);
  const sandboxed = sandboxToolSpec(manifest, "bash") !== undefined;
  const directory = `${skillFolderOf(skill)}/`;
  const missing = (path: string) =>
    new Error(`The bytes of ${skill.files[path]} (${skill.name}/${path}) are missing from the Object store`);
  /** The file's bytes, or undefined when it is too large to read into the context. */
  const read = async (path: string) => {
    const meta = await ctx.blobs.head(definitionFileKey(skill.files[path]!));
    if (!meta) throw missing(path);
    if (meta.size > SKILL_READ_MAX_BYTES) return undefined;
    const bytes = await readDefinitionFile(ctx.blobs, skill.files[path]!, signal);
    if (!bytes) throw missing(path);
    return bytes;
  };
  const tooLarge = (path: string) =>
    failed(
      "skill.resource_too_large",
      sandboxed
        ? `${path} is larger than ${SKILL_READ_MAX_BYTES} bytes, too large to read here. It is in the sandbox at ${directory}${path}; use it there.`
        : `${path} is larger than ${SKILL_READ_MAX_BYTES} bytes; only smaller files can be read without a sandbox.`
    );

  if (request.toolName === LOAD_SKILL_TOOL) {
    const entry = await read(SKILL_ENTRY);
    if (!entry) return tooLarge(SKILL_ENTRY);
    const text = textOf(entry);
    if (text === undefined) return failed("skill.binary_resource", `${SKILL_ENTRY} of '${skill.name}' is not text.`);
    const resources = Object.keys(skill.files)
      .filter((path) => path !== SKILL_ENTRY)
      .sort();
    return {
      kind: "completed",
      output: {
        name: skill.name,
        content: skillInstructions(text),
        ...(resources.length === 0 ? {} : { resources }),
        ...(sandboxed ? { sandboxPath: directory } : {}),
      },
    };
  }

  const path = typeof input.path === "string" ? input.path : "";
  if (skill.files[path] === undefined)
    return failed("skill.unknown_resource", `Skill '${skill.name}' has no resource '${path}'.`);
  const bytes = await read(path);
  if (!bytes) return tooLarge(path);
  const content = textOf(bytes);
  if (content === undefined)
    return failed(
      "skill.binary_resource",
      sandboxed
        ? `${path} is not a text file. It is in the sandbox at ${directory}${path}; use it there.`
        : `${path} is not a text file; only text files can be read without a sandbox.`
    );
  return { kind: "completed", output: { name: skill.name, path, content } };
}
