import { tool } from "@nylorun/agents/define";
import { z } from "zod";
import type { ArtifactsClient } from "@nylorun/agents";
import type { ImageEditor } from "./image-editor.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * The room photo comes in as a file artifact the user uploaded to the session (and named in a
 * message part, so the model saw it); the redesign goes back as a new artifact of the session.
 */
export function interiorDesign(
  artifacts: ArtifactsClient,
  editor: ImageEditor | undefined,
) {
  return {
    id: "interior-design",
    instructions: [
      "Use reimagine_interior only after the user supplies a room photo and a requested design theme.",
      "Preserve the room layout, viewpoint, windows, doors, and architectural constraints; change furnishings, materials, lighting, and decor to fit the requested theme.",
      "If the user supplied a photo without a theme, ask one concise question for their preferred theme before calling the tool.",
    ],
    tools: [
      tool({
        name: "reimagine_interior",
        description:
          "Create a redesigned image of the most recently uploaded room photo for a requested interior design theme.",
        inputSchema: z.object({ theme: z.string().min(3).max(300) }),
        async execute({ theme }, context) {
          if (!editor)
            return {
              kind: "failed" as const,
              code: "image.not-configured",
              message:
                "Set OPENAI_API_KEY to enable the Interior Design image editor.",
            };
          const sessionId =
            (context.info as { sessionId?: string } | undefined)?.sessionId ?? context.executionId;
          const source = (await artifacts.list({ sessionId }))
            .filter((artifact) => IMAGE_TYPES.has(artifact.contentType))
            .at(-1);
          if (!source)
            return {
              kind: "failed" as const,
              code: "image.missing-input",
              message: "Upload one room photo before requesting a redesign.",
            };
          try {
            const download = await artifacts.download(source.artifactId);
            const result = await editor.edit({
              bytes: new Uint8Array(await download.arrayBuffer()),
              mediaType: source.contentType,
              prompt: `Reimagine this exact interior in a ${theme} theme. Preserve the room's layout, camera viewpoint, architecture, windows, doors, and proportions. Change only furnishings, finishes, lighting, and decor. Produce a realistic interior design visualization.`,
              signal: context.signal,
            });
            const saved = await artifacts.upload(result.bytes, {
              name: "redesign.png",
              sessionId,
              contentType: result.mediaType,
            });
            return {
              kind: "completed" as const,
              output: {
                image: {
                  artifactId: saved.artifact.artifactId,
                  version: saved.version.version,
                  mediaType: saved.version.contentType,
                  bytes: saved.version.size,
                },
                theme,
              },
            };
          } catch (error) {
            return {
              kind: "failed" as const,
              code: "image.edit-failed",
              message:
                error instanceof Error ? error.message : "Image edit failed.",
            };
          }
        },
      }),
    ],
  } as const;
}
