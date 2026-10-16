/**
 * Files that arrive inside a message (multimodal messages, M7): the AG-UI and A2A endpoints take
 * a file's bytes inline (base64), store them as an artifact of the message's session, and send
 * the message as `parts` through the session's normal command path, so every check a message
 * with file parts meets applies. A file by URL is refused: the Runtime fetches nothing.
 *
 * A retried message (the same idempotency key) reuses the files the first one stored rather than
 * storing them again, so it replays the first turn instead of conflicting with it. A message the
 * Runtime refuses takes the files it stored with it (`discardFiles`).
 */
import type { MessagePart } from "@nylorun/core/contracts";
import { commandKey } from "../core/flow-host.js";
import { extensionFor, normalizeContentType } from "@nylorun/core/contracts";
import { deleteArtifact, uploadArtifact, type ArtifactAccess } from "../artifacts/service.js";
import type { TenantContext } from "../tenant/context.js";
import { fail } from "../tenant/http.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";

/** A file sent inline: its name, declared media type and base64 bytes. */
export interface InlineFile {
  readonly name: string;
  readonly mediaType: string;
  /** The bytes, base64 (standard or URL-safe alphabet). */
  readonly data: string;
}

/** One part of an inbound message: text, a file sent inline, or an artifact the Runtime holds. */
export type InboundPart =
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "inline" } & InlineFile)
  | { readonly type: "artifact"; readonly artifactId: string };

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** The 400 for a file sent by URL. */
export function refuseUrl(): never {
  return fail(400, "File URLs are not fetched yet; send the bytes inline", {
    code: "invalid_request",
  });
}

/** A name for a file its client did not name: its place in the message and its type's extension. */
export function inlineFileName(mediaType: string, index: number): string {
  const extension = extensionFor(mediaType);
  return `file-${index + 1}${extension ? `.${extension}` : ""}`;
}

/**
 * Stores `file` as a new artifact of `sessionId`, within the Tenant's Runtime limit
 * `inlineFileBytes` (read for the file) and its artifact limits: `400` for bad base64 or a bad
 * media type, `413 limit_exceeded` past a limit.
 */
export async function storeInlineFile(
  ctx: TenantContext,
  sessionId: string,
  file: InlineFile,
  access: ArtifactAccess,
): Promise<{ artifactId: string; version: number }> {
  const data = file.data.replace(/\s+/gu, "");
  if (!BASE64.test(data) || data.length % 4 === 1)
    fail(400, `File "${file.name}" is not valid base64`, { code: "invalid_request" });
  const { inlineFileBytes } = await ctx.store.tx((t) => readRuntimeLimits(t));
  const tooLarge = () =>
    fail(413, `A file sent inline may hold at most ${inlineFileBytes} bytes (the Runtime limit inlineFileBytes)`, {
      code: "limit_exceeded",
      details: { limitBytes: inlineFileBytes },
    });
  // Three bytes per four characters, before decoding a byte; padding may take up to two.
  if (Math.floor((data.length * 3) / 4) > inlineFileBytes + 2) tooLarge();
  // Node's base64 decoder reads both alphabets.
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > inlineFileBytes) tooLarge();
  if (bytes.byteLength === 0) fail(400, `File "${file.name}" is empty`, { code: "invalid_request" });
  const contentType =
    normalizeContentType(file.mediaType) ??
    fail(400, `File "${file.name}" has no valid media type`, { code: "invalid_request" });
  const { artifact, version } = await uploadArtifact(
    ctx,
    {
      name: file.name,
      contentType,
      sessionId,
      declaredBytes: bytes.byteLength,
      source: "upload",
    },
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    access,
  );
  return { artifactId: artifact.artifactId, version: version.version };
}

/**
 * The parts of the message the session already took under `idempotencyKey`, when it took one
 * with parts: a retry sends the same files again.
 */
export async function priorParts(
  ctx: TenantContext,
  sessionId: string,
  idempotencyKey: string,
): Promise<readonly MessagePart[] | undefined> {
  const prior = await ctx.store.tx((t) =>
    t.get<{ command: { type?: string; parts?: MessagePart[] } }>(
      "commands",
      commandKey(sessionId, idempotencyKey),
    ),
  );
  return prior?.command.type === "message" && Array.isArray(prior.command.parts)
    ? prior.command.parts
    : undefined;
}

/**
 * A message's parts, its inline files stored as artifacts of `sessionId` (or, on a retry, the
 * first message's files in their place, by position). `stored` lists the artifacts this call
 * created, for `discardFiles` when the message is refused.
 */
export async function messageParts(
  ctx: TenantContext,
  sessionId: string,
  idempotencyKey: string,
  inbound: readonly InboundPart[],
  access: ArtifactAccess,
): Promise<{ parts: MessagePart[]; stored: string[] }> {
  const parts = inbound.filter((part) => part.type !== "text" || part.text !== "");
  const { messageParts: most } = await ctx.store.tx((t) => readRuntimeLimits(t));
  if (parts.length > most)
    fail(400, `A message may carry at most ${most} parts (the Runtime limit messageParts)`, { code: "invalid_request" });
  const prior = parts.some((part) => part.type === "inline")
    ? (await priorParts(ctx, sessionId, idempotencyKey))?.filter((part) => part.type === "file")
    : undefined;
  const out: MessagePart[] = [];
  const stored: string[] = [];
  let files = 0;
  try {
    for (const part of parts) {
      if (part.type === "text") {
        out.push({ type: "text", text: part.text });
        continue;
      }
      const index = files++;
      if (part.type === "artifact") {
        out.push({ type: "file", artifactId: part.artifactId });
        continue;
      }
      const again = prior?.[index];
      if (again) {
        out.push(again);
        continue;
      }
      const file = await storeInlineFile(ctx, sessionId, part, access);
      stored.push(file.artifactId);
      out.push({ type: "file", artifactId: file.artifactId, version: file.version });
    }
  } catch (error) {
    await discardFiles(ctx, stored, access);
    throw error;
  }
  return { parts: out, stored };
}

/** Deletes the artifacts a refused message stored; one already gone is no error. */
export async function discardFiles(
  ctx: TenantContext,
  artifactIds: readonly string[],
  access: ArtifactAccess,
): Promise<void> {
  for (const id of artifactIds) await deleteArtifact(ctx, id, access).catch(() => undefined);
}
