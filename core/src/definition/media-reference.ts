import type { JsonValue } from "../types/shared.js";

/**
 * What a media part's `reference` holds when the Runtime made it (protocol 6, 12): the artifact
 * version, by id, with the file's name and size in bytes when known. The Model Gate fetches it,
 * and a harness reads it to decide how the model sees the file (protocol 15).
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
