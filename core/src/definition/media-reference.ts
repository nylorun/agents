import type { JsonValue } from "../types/shared.js";

/**
 * What a media part's `reference` holds when the Runtime made it (protocol 6, 12): the artifact
 * version, by id, with the file's name and size in bytes when known.
 */
export interface MediaReference {
  readonly artifactId: string;
  readonly version: number;
  readonly name?: string;
  readonly size?: number;
}

/** The reference of a media part the Runtime made, or undefined for another host's. */
export function mediaReferenceOf(value: JsonValue | undefined): MediaReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { artifactId, version, name, size } = value as Record<string, unknown>;
  if (typeof artifactId !== "string" || typeof version !== "number" || !Number.isInteger(version))
    return undefined;
  return {
    artifactId,
    version,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof size === "number" ? { size } : {}),
  };
}

/**
 * The line a file stands for in a prompt once its turn is over (protocol 12): its name, artifact
 * id and version, and how the model reads it again. A file a tool returned names the tool.
 */
export function mediaReferenceLine(
  part: { readonly mediaType: string; readonly reference: JsonValue },
  origin: "uploaded" | { readonly tool: string },
): string {
  const reference = mediaReferenceOf(part.reference);
  const what = origin === "uploaded" ? "Uploaded artifact" : `Tool ${origin.tool} returned artifact`;
  if (!reference) return `[${what} (${part.mediaType})]`;
  const name = JSON.stringify(reference.name ?? reference.artifactId);
  return `[${what} ${name} · ${reference.artifactId} v${reference.version} · read_artifact to view]`;
}
