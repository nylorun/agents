/**
 * Message attachments (protocol 12): what the composer accepts, from the active model's
 * inputs, and how a refused file comes back. Studio converts and resizes nothing; the
 * Runtime refuses a file the model does not read (`422 attachment_unsupported`).
 */

/** What a model reads when the Runtime does not say: text and images. */
export const DEFAULT_MODEL_INPUTS: readonly string[] = ["text", "image"];

const ACCEPT: Readonly<Record<string, readonly string[]>> = {
  image: ["image/*"],
  pdf: ["application/pdf"],
  office: [".docx", ".xlsx", ".pptx"],
  audio: ["audio/*"],
  video: ["video/*"],
  text: ["text/*", ".md", ".json", ".csv", ".txt"],
};

/** The file picker's `accept` for a model's inputs; an unknown input adds nothing. */
export function acceptFor(inputs: readonly string[] | undefined): string {
  const accepted = new Set<string>();
  for (const input of inputs ?? DEFAULT_MODEL_INPUTS)
    for (const type of ACCEPT[input] ?? []) accepted.add(type);
  return [...accepted].join(",");
}

/** A file in the composer: kept until its message is accepted, uploaded once. */
export type ComposerAttachment = Readonly<{
  id: string;
  file: File;
  /** The artifact it became, so a resend does not upload it again. */
  uploaded?: Readonly<{ artifactId: string; version: number }>;
  /** Why the upload or the Runtime refused it. */
  error?: string;
}>;

/** `1.2 MB`, `512 KB`, `40 B`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export type AttachmentRefusal = Readonly<{
  message: string;
  /** Each refused file's reason, by artifact id. */
  reasons: ReadonlyMap<string, string>;
}>;

/** A `422 attachment_unsupported` from the Runtime, or undefined for any other error. */
export function attachmentRefusal(error: unknown): AttachmentRefusal | undefined {
  const { status, body } = (error ?? {}) as { status?: unknown; body?: unknown };
  if (status !== 422 || !body || typeof body !== "object") return undefined;
  const { code, message, details } = body as Record<string, unknown>;
  if (code !== "attachment_unsupported") return undefined;
  const reasons = new Map<string, string>();
  const parts = (details as { parts?: unknown } | undefined)?.parts;
  if (Array.isArray(parts))
    for (const part of parts) {
      const { artifactId, reason } = (part ?? {}) as Record<string, unknown>;
      if (typeof artifactId === "string")
        reasons.set(artifactId, typeof reason === "string" ? reason : "This model does not read this file.");
    }
  return {
    message: typeof message === "string" && message ? message : "The model does not read one of these files.",
    reasons,
  };
}
