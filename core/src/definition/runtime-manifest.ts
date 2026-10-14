import { z } from "zod";
import { SANDBOX_INSTRUCTIONS, createSandboxTools } from "./sandbox-tools.js";
import { tool } from "./helpers.js";
import { ToolError } from "./tool-error.js";
import { SANDBOX_WORKSPACE } from "../utils/sandbox.js";
import { SKILLS_MOUNT } from "../utils/definition-files.js";
import { normalizedSchemasFor } from "./schema.js";
import { createSkillTools, formatSkillCatalog, SKILLS_USAGE } from "./skill-tools.js";
import { copyJsonObject } from "../utils/immutable.js";
import { READ_ARTIFACT_TOOL, SAVE_ARTIFACT_TOOL } from "../utils/runtime-tools.js";
import type {
  AgentManifest,
  RuntimeManifest,
  SandboxManifest,
  ToolManifest,
} from "../types/manifest.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolDefinition } from "../types/tool.js";

/**
 * `save_artifact` stores a file the agent made (protocol 6). `read_artifact` reads an artifact of
 * the session in pages (R2b C11, Q24): a tool result the Runtime stored because it was too large
 * to show, or a file of an earlier turn (protocol 12).
 */
export { READ_ARTIFACT_TOOL, SAVE_ARTIFACT_TOOL };
/** The most `read_artifact` returns per call (R2b C11): 32 KiB, the inline cap of a tool result. */
export const READ_ARTIFACT_MAX_BYTES = 32 * 1024;

const ARTIFACTS_INSTRUCTIONS =
  "Use save_artifact to hand the user a file you made: a path in the sandbox, or text you pass as content. " +
  "The user sees it as an artifact of this session and can download it; reply with its name, not its bytes. " +
  "Files you write under /workspace/outputs reach the user too: when your turn ends, they become the session's outputs folder.";

const READ_ARTIFACT_INSTRUCTIONS =
  "A tool result too large to show is saved as an artifact of this session: the result says truncated: true, with its artifactId, its size in bytes and a preview of its start and end. " +
  "Images and other files a tool returns are saved as artifacts too. Use read_artifact to read more of one, a page at a time, only when the preview is not enough. " +
  'Files from earlier turns appear as lines like [Uploaded artifact "name" · <artifactId> v<version> · read_artifact to view]: call read_artifact with that artifactId and version only when you need the file again.';

async function artifactsRuntimeOnly(): Promise<never> {
  throw new ToolError(
    "artifacts.runtime-only",
    "The artifact tools run in the Nylorun Runtime. Connect the agent to a Runtime to use them."
  );
}

function readArtifactTool() {
  return tool({
    name: READ_ARTIFACT_TOOL,
    description:
      `Read an artifact of this session, such as a tool result marked truncated or a file from an earlier turn. A text file returns up to ${READ_ARTIFACT_MAX_BYTES} bytes from offset, ` +
      "with nextOffset while more remains: pass it as offset to read on. An image or another file you can read is shown to you.",
    inputSchema: z.object({
      artifactId: z.string().min(1).describe("The artifact to read, e.g. a truncated result's artifactId."),
      version: z.number().int().min(1).optional().describe("The version to read. Default: the latest."),
      offset: z.number().int().min(0).optional().describe("The byte to start at. Default 0."),
      length: z
        .number()
        .int()
        .min(1)
        .max(READ_ARTIFACT_MAX_BYTES)
        .optional()
        .describe(`How many bytes to read. Default and most: ${READ_ARTIFACT_MAX_BYTES}.`),
    }),
    effects: "read",
    execute: artifactsRuntimeOnly,
  });
}

function saveArtifactTool() {
  return tool({
    name: SAVE_ARTIFACT_TOOL,
    description:
      `Save a file as an artifact of this session, for the user to download. Give path (a file in the sandbox; relative paths resolve under ${SANDBOX_WORKSPACE}) or content (text), not both. ` +
      "Returns the artifact's id and version. Pass artifactId to save a new version of an artifact you saved before.",
    inputSchema: z.object({
      path: z.string().min(1).optional().describe("A file in the sandbox."),
      content: z.string().optional().describe("Text to save instead of a file."),
      name: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe("The artifact's name. Default: the file's name."),
      contentType: z
        .string()
        .min(1)
        .optional()
        .describe("The media type, e.g. image/png. Default: from the name's extension."),
      artifactId: z.string().min(1).optional().describe("Save a new version of this artifact."),
    }),
    effects: "write",
    execute: artifactsRuntimeOnly,
  });
}

/** What the Runtime adds to a session's agent (`runtimeManifestFor`). */
export interface RuntimeManifestOptions {
  /** The session's sandbox: the six sandbox tools, their instructions and the spec. */
  readonly sandbox?: SandboxManifest;
  /** The workspace path the backend uses, named in the tools' text. Default `/workspace`. */
  readonly workspace?: string;
  /** `save_artifact`, which stores a sandbox file or text. Default: with a sandbox. */
  readonly save?: boolean;
  /** `read_artifact`, which reads the session's artifacts. Default false. */
  readonly read?: boolean;
}

/**
 * The `runtime` block the Runtime pins on a session's agent: the sandbox and its tools, the
 * artifact tools, and the skill tools with the skill catalog when the agent has skills. Its tools
 * are projected the way the builder projects any tool, so their schemas are part of the pinned
 * manifest's hash; change them deliberately. Undefined when the Runtime adds nothing.
 */
export function runtimeManifestFor(
  manifest: Pick<AgentManifest, "skills">,
  options: RuntimeManifestOptions = {}
): RuntimeManifest | undefined {
  const workspace = options.workspace ?? SANDBOX_WORKSPACE;
  const text = (value: string) => value.replaceAll(SANDBOX_WORKSPACE, workspace);
  const skills = Object.values(manifest.skills ?? {});
  const save = options.save ?? options.sandbox !== undefined;
  const read = options.read ?? false;
  const instructions: string[] = [];
  const tools: ToolDefinition[] = [];
  if (skills.length > 0)
    instructions.push(
      SKILLS_USAGE,
      formatSkillCatalog(skills.map(({ name, description }) => ({ name, description })))
    );
  if (options.sandbox !== undefined) {
    instructions.push(text(SANDBOX_INSTRUCTIONS));
    if (skills.length > 0)
      instructions.push(
        `Each skill's files are in the sandbox, read-only, under ${SKILLS_MOUNT}/<name>/ (${skills
          .map((skill) => `${SKILLS_MOUNT}/${skill.name}/`)
          .join(", ")}): read them there and run their scripts with bash.`
      );
    tools.push(...createSandboxTools());
  }
  if (save) {
    instructions.push(ARTIFACTS_INSTRUCTIONS);
    tools.push(saveArtifactTool());
  }
  if (read) {
    instructions.push(READ_ARTIFACT_INSTRUCTIONS);
    tools.push(readArtifactTool());
  }
  if (skills.length > 0)
    tools.push(...createSkillTools(new Map(skills.map((skill) => [skill.name, skill]))));
  if (instructions.length === 0 && tools.length === 0 && options.sandbox === undefined)
    return undefined;
  return {
    ...(options.sandbox === undefined
      ? {}
      : { sandbox: copyJsonObject(options.sandbox as unknown as JsonObject, "sandbox") as SandboxManifest }),
    ...(tools.length === 0 ? {} : { tools: tools.map((tool) => projectRuntimeTool(tool, text)) }),
    ...(instructions.length === 0 ? {} : { instructions }),
  };
}

/** The tool of `name` the Runtime added to `manifest`, if any. */
export function runtimeToolOf(
  manifest: AgentManifest | undefined,
  name: string | undefined
): ToolManifest | undefined {
  if (name === undefined) return undefined;
  return manifest?.runtime?.tools?.find((tool) => tool.name === name);
}

function projectRuntimeTool(tool: ToolDefinition, text: (value: string) => string): ToolManifest {
  const schemas = normalizedSchemasFor(tool);
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: text(tool.description) }),
    inputSchema: schemas.inputSchema.jsonSchema,
    ...(schemas.outputSchema === undefined ? {} : { outputSchema: schemas.outputSchema.jsonSchema }),
  };
}
