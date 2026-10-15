/**
 * Our engine's skill tools (protocol 15), which run here, in the harness: `load_skill` for an
 * agent with skills, and `read_skill_resource` when a skill has files besides `SKILL.md`. With
 * them come the skill catalog the model reads (`skillCatalogText`) and, with a sandbox, the note
 * on where each skill's files are (`skillFolderNote`).
 *
 * - `load_skill`: the skill's instructions (its `SKILL.md` after the frontmatter), the paths of
 *   its other files, and, when the session has a sandbox, where they are in it
 *   (`/skills/<name>@<hash>/`, read-only).
 * - `read_skill_resource`: one text file of the skill. A binary file, or one larger than the
 *   harness reads into the model's context (`readBytes`, at most what one record entry holds), is
 *   refused: the model uses it in the sandbox, when there is one.
 *
 * A skill's bytes come over the Harness API's `definition.file` seam, a range of at most
 * `turn.start.limits.chunkBytes` at a time. Expected problems are failed outcomes the model sees;
 * only the run's own failures throw.
 */
import {
  SKILL_ENTRY,
  SKILLS_MOUNT,
  skillFolderOf,
  skillInstructions,
  type AgentManifest,
  type JsonObject,
  type SkillManifest,
} from "@nylorun/core/define";
import { fromBase64, type EffectTarget, type HarnessChannel } from "@nylorun/core/harness-api";
import type { DurableSessionTool, HostEffect } from "../run/durable.js";
import type { FailedFileOutcome, HarnessRun } from "../api/executors.js";

/** Loads a skill's `SKILL.md`. */
export const LOAD_SKILL_TOOL = "load_skill";
/** Reads one resource file of a skill. */
export const READ_SKILL_RESOURCE_TOOL = "read_skill_resource";

/** The most bytes of one skill file the skill tools read into the model's context by default. */
export const DEFAULT_SKILL_READ_BYTES = 10 * 1024 * 1024;

/** True when `name` is one of our engine's skill tools. */
export function isSkillTool(name: string | undefined): boolean {
  return name === LOAD_SKILL_TOOL || name === READ_SKILL_RESOURCE_TOOL;
}

/** The text before the skill catalog: when to load a skill. */
export const SKILLS_USAGE =
  "The following skills provide specialized instructions. When a task matches a skill description, call load_skill with that name before proceeding.";

/** The skills the model may load, by name and description. */
export function formatSkillCatalog(
  skills: readonly { readonly name: string; readonly description: string }[],
): string {
  const entries = skills
    .map(
      (skill) =>
        `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n  </skill>`,
    )
    .join("\n");
  return `<available_skills>\n${entries}\n</available_skills>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** What the model reads of an agent's skills: when to load one, and the catalog. */
export function skillCatalogText(
  skills: readonly { readonly name: string; readonly description: string }[],
): string[] {
  return [
    SKILLS_USAGE,
    formatSkillCatalog(skills.map(({ name, description }) => ({ name, description }))),
  ];
}

/** Where each skill's files are in the sandbox, for an agent with skills and a sandbox. */
export function skillFolderNote(skills: readonly SkillManifest[]): string {
  return `Each skill's files are in the sandbox, read-only, in its own folder under ${SKILLS_MOUNT}/ (${skills
    .map((skill) => `${skill.name}: ${skillFolderOf(skill)}/`)
    .join(", ")}): read them there and run their scripts with bash.`;
}

const HARNESS: EffectTarget = Object.freeze({ kind: "harness" });
const SCHEMA = "http://json-schema.org/draft-07/schema#";

/**
 * `load_skill` for the agent's skills, and `read_skill_resource` when a skill has files besides
 * `SKILL.md`. Empty for an agent without skills. Each runs here (`harness`).
 */
export function skillTools(skills: readonly SkillManifest[]): DurableSessionTool[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => skill.name).sort();
  const name: JsonObject =
    names.length === 1 ? { type: "string", const: names[0]! } : { type: "string", enum: names };
  const tools: DurableSessionTool[] = [
    {
      name: LOAD_SKILL_TOOL,
      description:
        "Load the full instructions for a named skill. Call this before following a skill.",
      inputSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: { name },
        required: ["name"],
        additionalProperties: false,
      },
      target: HARNESS,
    },
  ];
  if (skills.some((skill) => Object.keys(skill.files).some((path) => path !== SKILL_ENTRY)))
    tools.push({
      name: READ_SKILL_RESOURCE_TOOL,
      description: "Read one text resource from a skill after load_skill.",
      inputSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: { name, path: { type: "string", minLength: 1 } },
        required: ["name", "path"],
        additionalProperties: false,
      },
      target: HARNESS,
    });
  return tools;
}

/** What a skill tool runs with. */
export interface SkillToolContext {
  readonly channel: Pick<HarnessChannel, "request">;
  readonly run: HarnessRun;
  /** The agent whose skill the call reads: the turn's agent, or the agent used as a tool. */
  readonly agent: Pick<AgentManifest, "skills">;
  /**
   * The most bytes of one file read into the model's context: the harness's `skillReadBytes`.
   * The answer is also held to the run's `limits.recordEntryBytes`, since it is one record entry.
   */
  readonly readBytes: number;
  /** The session has a sandbox: the skill's files are in it. */
  readonly sandboxed: boolean;
  readonly signal: AbortSignal;
}

type Outcome =
  { readonly kind: "completed"; readonly output: Record<string, unknown> } | FailedFileOutcome;

const failed = (code: string, message: string): FailedFileOutcome => ({
  kind: "failed",
  code,
  message,
});

/** UTF-8 text, or undefined for bytes that are not (a NUL byte, or invalid UTF-8). */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The bytes of definition file `sha256`, or undefined once it passes `maxBytes`. */
async function readDefinitionFile(
  context: SkillToolContext,
  sha256: string,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const { channel, run, signal } = context;
  // No range asks for more than one byte past what the file may hold.
  const length = Math.min(run.start.limits.chunkBytes, maxBytes + 1);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let offset = 0; ; offset += length) {
    const { base64 } = await channel.request(
      "definition.file",
      { runId: run.runId, sha256, offset, length },
      signal,
    );
    const chunk = fromBase64(base64);
    total += chunk.byteLength;
    if (total > maxBytes) return undefined;
    if (chunk.byteLength > 0) chunks.push(chunk);
    if (chunk.byteLength < length) break;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The size of `value` as JSON, in UTF-8 bytes. */
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Runs a call of one of our engine's skill tools, as its outcome. */
export async function runSkillTool(
  effect: HostEffect,
  context: SkillToolContext,
): Promise<Outcome> {
  const input = (effect.input ?? {}) as { name?: unknown; path?: unknown };
  const skills = new Map(
    Object.values(context.agent.skills ?? {}).map((skill) => [skill.name, skill]),
  );
  const name = typeof input.name === "string" ? input.name : "";
  const skill = skills.get(name);
  if (!skill)
    return effect.toolName === LOAD_SKILL_TOOL
      ? { kind: "completed", output: { unknown: name, available: [...skills.keys()].sort() } }
      : failed("skill.unknown", `There is no skill '${name}'.`);
  const { sandboxed } = context;
  const recordBytes = context.run.start.limits.recordEntryBytes;
  const maxBytes = Math.min(context.readBytes, recordBytes);
  const directory = `${skillFolderOf(skill)}/`;
  const tooLarge = (path: string) =>
    failed(
      "skill.resource_too_large",
      sandboxed
        ? `${path} is larger than ${maxBytes} bytes, too large to read here. It is in the sandbox at ${directory}${path}; use it there.`
        : `${path} is larger than ${maxBytes} bytes; only smaller files can be read without a sandbox.`,
    );
  /** The answer, unless it is larger than one record entry holds. */
  const answer = (path: string, output: Record<string, unknown>): Outcome => {
    const outcome = { kind: "completed" as const, output };
    return jsonBytes(outcome) > recordBytes ? tooLarge(path) : outcome;
  };

  if (effect.toolName === LOAD_SKILL_TOOL) {
    const entry = await readDefinitionFile(context, skill.files[SKILL_ENTRY]!, maxBytes);
    if (!entry) return tooLarge(SKILL_ENTRY);
    const text = textOf(entry);
    if (text === undefined)
      return failed("skill.binary_resource", `${SKILL_ENTRY} of '${skill.name}' is not text.`);
    const resources = Object.keys(skill.files)
      .filter((path) => path !== SKILL_ENTRY)
      .sort();
    return answer(SKILL_ENTRY, {
      name: skill.name,
      content: skillInstructions(text),
      ...(resources.length === 0 ? {} : { resources }),
      ...(sandboxed ? { sandboxPath: directory } : {}),
    });
  }

  const path = typeof input.path === "string" ? input.path : "";
  if (skill.files[path] === undefined)
    return failed("skill.unknown_resource", `Skill '${skill.name}' has no resource '${path}'.`);
  const bytes = await readDefinitionFile(context, skill.files[path]!, maxBytes);
  if (!bytes) return tooLarge(path);
  const content = textOf(bytes);
  if (content === undefined)
    return failed(
      "skill.binary_resource",
      sandboxed
        ? `${path} is not a text file. It is in the sandbox at ${directory}${path}; use it there.`
        : `${path} is not a text file; only text files can be read without a sandbox.`,
    );
  return answer(path, { name: skill.name, path, content });
}
