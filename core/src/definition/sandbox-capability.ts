import { z } from "zod";
import { SANDBOX_INSTRUCTIONS, createSandboxTools } from "./sandbox-tools.js";
import { tool } from "./helpers.js";
import { ToolError } from "./tool-error.js";
import { SANDBOX_WORKSPACE } from "../utils/sandbox.js";
import { SKILLS_MOUNT } from "../utils/definition-files.js";
import { normalizedSchemasFor } from "./schema.js";
import { copyJsonObject } from "../utils/immutable.js";
import type { CapabilityManifest, SandboxManifest, ToolManifest } from "../types/manifest.js";
import type { JsonObject } from "../types/shared.js";

/** Id of the capability the Runtime adds to a session whose sandbox was chosen at open. */
export const SANDBOX_CAPABILITY_ID = "nylorun.sandbox";
/**
 * Id of the capability that gives our engine `save_artifact` (protocol 6): the Runtime adds it
 * beside the sandbox capability, so `nylorun.artifacts/save_artifact` is the built-in tool
 * `nylorun.save_artifact`.
 */
export const ARTIFACTS_CAPABILITY_ID = "nylorun.artifacts";
export const SAVE_ARTIFACT_TOOL = "save_artifact";
/**
 * The tool that reads an artifact of the session in pages (R2b C11, Q24): how the model reads a
 * tool result the Runtime stored because it was too large to show. With or without a sandbox.
 */
export const READ_ARTIFACT_TOOL = "read_artifact";
/** The most `read_artifact` returns per call (R2b C11): 32 KiB, the inline cap of a tool result. */
export const READ_ARTIFACT_MAX_BYTES = 32 * 1024;

const ARTIFACTS_INSTRUCTIONS =
  "Use save_artifact to hand the user a file you made: a path in the sandbox, or text you pass as content. " +
  "The user sees it as an artifact of this session and can download it; reply with its name, not its bytes. " +
  "Files you write under /workspace/outputs reach the user too: when your turn ends, they become the session's outputs folder.";

const READ_ARTIFACT_INSTRUCTIONS =
  "A tool result too large to show is saved as an artifact of this session: the result says truncated: true, with its artifactId, its size in bytes and a preview of its start and end. " +
  "Images and other files a tool returns are saved as artifacts too. Use read_artifact to read more of one, a page at a time, only when the preview is not enough.";

async function artifactsRuntimeOnly(): Promise<never> {
  throw new ToolError(
    "artifacts.runtime-only",
    "The artifact tools run in the Nylorun Runtime. Connect the agent to a Runtime to use them."
  );
}

/** What the `nylorun.artifacts` capability gives a session. */
export interface ArtifactsCapabilityOptions {
  /** `save_artifact`, which comes with a sandbox. Default true. */
  readonly save?: boolean;
  /**
   * `read_artifact` (R2b C11), for an agent whose MCP or HTTP tool results the Runtime may store
   * as artifacts. Default false.
   */
  readonly read?: boolean;
}

/**
 * The capability manifest that gives a session `save_artifact`, which stores a sandbox file, or
 * inline text, as a file artifact of the session, and `read_artifact`, which reads one in pages.
 * Its schemas are part of the hashed manifest; change them deliberately.
 */
export function artifactsCapabilityManifest(
  options: ArtifactsCapabilityOptions = {}
): CapabilityManifest {
  const save = options.save ?? true;
  const read = options.read ?? false;
  const tools = [...(save ? [saveArtifactTool()] : []), ...(read ? [readArtifactTool()] : [])];
  return {
    id: ARTIFACTS_CAPABILITY_ID,
    type: "agent",
    instructions: [
      ...(save ? [ARTIFACTS_INSTRUCTIONS] : []),
      ...(read ? [READ_ARTIFACT_INSTRUCTIONS] : []),
    ],
    tools: tools.map((item): ToolManifest => {
      const schemas = normalizedSchemasFor(item);
      return {
        name: item.name,
        ...(item.description === undefined ? {} : { description: item.description }),
        inputSchema: schemas.inputSchema.jsonSchema,
      };
    }),
  };
}

function readArtifactTool() {
  return tool({
    name: READ_ARTIFACT_TOOL,
    description:
      `Read a text artifact of this session, such as a tool result marked truncated: up to ${READ_ARTIFACT_MAX_BYTES} bytes from offset. ` +
      "Returns content, and nextOffset while more remains: pass it as offset to read on. An image is shown to you when you can see images.",
    inputSchema: z.object({
      artifactId: z.string().min(1).describe("The artifact to read, e.g. a truncated result's artifactId."),
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

/**
 * The capability manifest that gives a session its sandbox: the six built-in tools, the sandbox
 * instructions and the resolved spec. The Runtime adds it to a session's pinned manifest. Its
 * tools are projected the way the builder projects any tool.
 */
export function sandboxCapabilityManifest(
  spec: SandboxManifest,
  options: {
    /** The workspace path the backend uses, named in the tools' text. Default `/workspace`. */
    readonly workspace?: string;
    /** The agent's skills, whose files the sandbox holds under `/skills/<name>/`. */
    readonly skills?: readonly string[];
  } = {}
): CapabilityManifest {
  const workspace = options.workspace ?? SANDBOX_WORKSPACE;
  const text = (value: string) => value.replaceAll(SANDBOX_WORKSPACE, workspace);
  const tools = createSandboxTools().map((tool): ToolManifest => {
    const schemas = normalizedSchemasFor(tool);
    return {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: text(tool.description) }),
      inputSchema: schemas.inputSchema.jsonSchema,
      ...(schemas.outputSchema === undefined
        ? {}
        : { outputSchema: schemas.outputSchema.jsonSchema }),
    };
  });
  return {
    id: SANDBOX_CAPABILITY_ID,
    type: "agent",
    instructions: [
      text(SANDBOX_INSTRUCTIONS),
      ...(options.skills?.length
        ? [
            `Each skill's files are in the sandbox, read-only, under ${SKILLS_MOUNT}/<name>/ (${options.skills
              .map((name) => `${SKILLS_MOUNT}/${name}/`)
              .join(", ")}): read them there and run their scripts with bash.`,
          ]
        : []),
    ],
    tools,
    sandbox: copyJsonObject(spec as unknown as JsonObject, "sandbox") as SandboxManifest,
  };
}
