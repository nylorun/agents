import type { LiveEvent } from "@nylorun/agents";

export const TEXT_PREVIEW_BYTES = 256 * 1024;
export const IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;

export function previewKind(
  contentType: string,
): "text" | "image" | "download" {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (
    [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
      "image/bmp",
    ].includes(type)
  )
    return "image";
  if (
    type.startsWith("text/") ||
    /(?:json|xml)$/.test(type) ||
    type === "image/svg+xml"
  )
    return "text";
  return "download";
}

/** Stop at the preview cap even when a server ignores Range or lies about size. */
export async function previewBytes(
  response: Response,
  limit: number,
  signal: AbortSignal,
) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  if (!reader) return { bytes: new Uint8Array(), truncated };
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - length;
      if (value.length > remaining) {
        chunks.push(value.slice(0, remaining));
        length += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      length += value.length;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

export function artifactHref(
  artifactId: string,
  version: number,
  sessionId?: string,
) {
  const query = new URLSearchParams({
    selected: artifactId,
    version: String(version),
    tab: "preview",
  });
  if (sessionId) query.set("sessionId", sessionId);
  return `/artifacts?${query}`;
}

/** How deep `artifactReferences` looks into a tool result for the artifacts it was spilled to. */
const TOOL_OUTPUT_DEPTH = 6;

/**
 * Only public artifact references; never infer a version/turn from timestamps. A `tool.completed`
 * links the artifacts its harness spilled the result to (protocol 15): each `{artifactId,
 * version, size}` its output names, as a whole or in its parts, and its files' `reference`.
 */
export function artifactReferences(event: Pick<LiveEvent, "type" | "payload">) {
  if (!event.payload || typeof event.payload !== "object") return [];
  const payload = event.payload as Record<string, unknown>;
  const refs: { artifactId: string; version: number; name: string }[] = [];
  const add = (id: unknown, version: unknown, name: unknown) => {
    if (
      typeof id === "string" &&
      id !== "" &&
      typeof version === "number" &&
      Number.isSafeInteger(version) &&
      version > 0 &&
      !refs.some((ref) => ref.artifactId === id && ref.version === version)
    )
      refs.push({
        artifactId: id,
        version,
        name: typeof name === "string" && name !== "" ? name : id,
      });
  };
  const walk = (value: unknown, depth: number) => {
    if (depth > TOOL_OUTPUT_DEPTH || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const entry = value as Record<string, unknown>;
    // A stored result names its size beside its artifact; other ids in a result are the tool's own.
    if (typeof entry.size === "number") add(entry.artifactId, entry.version, entry.name);
    for (const child of Object.values(entry)) walk(child, depth + 1);
  };
  if (event.type === "tool.completed") {
    walk(payload.output, 0);
    if (Array.isArray(payload.files))
      for (const file of payload.files) walk(file, 0);
  }
  if (["artifact.created", "artifact.version.created"].includes(event.type))
    add(payload.artifactId, payload.version, payload.name);
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part && typeof part === "object" && part.type === "file")
        add(part.artifactId, part.version, part.name ?? part.artifactId);
    }
  }
  return refs;
}
