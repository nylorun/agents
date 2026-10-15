/**
 * Message attachments (protocol 12, 15): the files the composer holds for the next message.
 * Studio converts and resizes nothing, and any file goes: the agent's harness decides how its
 * model sees each one, and tells it when it cannot read one.
 */

/** A file in the composer: kept until its message is accepted, uploaded once. */
export type ComposerAttachment = Readonly<{
  id: string;
  file: File;
  /** The artifact it became, so a resend does not upload it again. */
  uploaded?: Readonly<{ artifactId: string; version: number }>;
  /** Why the upload failed. */
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
