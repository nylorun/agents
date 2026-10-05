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

const ARTIFACTS_INSTRUCTIONS =
  "Use save_artifact to hand the user a file you made: a path in the sandbox, or text you pass as content. " +
  "The user sees it as an artifact of this session and can download it; reply with its name, not its bytes. " +
  "Files you write under /workspace/outputs reach the user too: when your turn ends, they become the session's outputs folder.";

async function artifactsRuntimeOnly(): Promise<never> {
  throw new ToolError(
    "artifacts.runtime-only",
    "save_artifact runs in the Nylorun Runtime. Connect the agent to a Runtime to use it."
  );
}

/**
 * The capability manifest that gives a session `save_artifact`: one tool that stores a sandbox
 * file, or inline text, as a file artifact of the session. Its schema is part of the hashed
 * manifest; change it deliberately.
 */
export function artifactsCapabilityManifest(): CapabilityManifest {
  const saveArtifact = tool({
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
  const schemas = normalizedSchemasFor(saveArtifact);
  return {
    id: ARTIFACTS_CAPABILITY_ID,
    type: "agent",
    instructions: [ARTIFACTS_INSTRUCTIONS],
    tools: [
      {
        name: saveArtifact.name,
        ...(saveArtifact.description === undefined ? {} : { description: saveArtifact.description }),
        inputSchema: schemas.inputSchema.jsonSchema,
      },
    ],
  };
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
