/**
 * Runtime limits (harness boundary S0): the sizes the Runtime holds what crosses it to, one
 * Tenant setting (`limits.config`, `GET`/`PUT /v1/tenant/limits`) with a default each. A harness
 * learns the ones in force from `turn.start.limits`.
 *
 * A limit is configuration; what the Runtime depends on is not. Each limit has a ceiling taken
 * from a dependency (S2's largest record, the Harness API's largest WebSocket frame, the longest
 * string the JavaScript engine makes), and a setting above its ceiling is refused when it is put
 * (`runtimeLimitIssues`).
 */
import { z } from "zod";
import { HARNESS_MAX_PAYLOAD } from "../harness-api/transport.js";

/**
 * S2's largest record: 1 MiB, metered as 8 bytes, plus its headers, plus its body. The stream
 * relay writes each event's JSON as one record's body, with no headers.
 */
export const S2_RECORD_MAX_BYTES = 1024 * 1024;

/**
 * Room an event's envelope takes beside its payload: ids, cursor, time, writer and principal
 * come to about 1 KiB; 64 KiB leaves them ample room under `S2_RECORD_MAX_BYTES`.
 */
export const RECORD_ENVELOPE_RESERVE_BYTES = 64 * 1024;

/**
 * The longest string V8 makes on 64-bit (`String::kMaxLength`, 2^29 - 24 code units): a JSON
 * body the Runtime reads whole, or a file it sends a provider in base64, is one such string.
 */
export const JS_STRING_MAX_LENGTH = 2 ** 29 - 24;

/** The most bytes base64 of `length` characters decodes to: groups of 4 characters, 3 bytes each. */
const base64Bytes = (length: number) => Math.floor(length / 4) * 3;

/**
 * The fewest characters one entry of a folder's manifest takes as JSON: an entry with a
 * one-character path and type, and the comma before the next. A folder's manifest is read as one
 * string, so it holds at most `JS_STRING_MAX_LENGTH` of them.
 */
const FOLDER_ENTRY_MIN_CHARS =
  JSON.stringify({ path: "a", size: 0, sha256: "0".repeat(64), contentType: "a" }).length + 1;

/**
 * The Runtime limits, in bytes but for `folderEntries`:
 *
 * - `recordEntryBytes`: the most JSON one entry of the record may hold: an event's payload (a
 *   harness's claimed event, a transcript update, core's own), and an effect outcome a harness
 *   reports. Past it the write is refused with `limit_exceeded`.
 * - `modelCallBytes`: the largest model call body the Model Gate reads.
 * - `modelFileBytes`: the largest file (an image, a text file) the Model Gate sends a model.
 * - `toolAnswerBytes`: the largest answer the Tool Gate keeps of an MCP or HTTP tool
 *   (`mcp.too-large`, `http.too-large` past it), and the largest tool call body it reads.
 * - `harnessStateBytes`: the most state a custom harness may keep per session, as JSON.
 * - `chunkBytes`: the most bytes one chunked Harness API answer carries (`definition.file` with
 *   a range).
 * - `folderEntries`: the most files one folder artifact a harness writes may hold
 *   (`artifact.write` with `kind: "folder"`, such as our engine's outputs folder).
 */
export const RuntimeLimitsSchema = z
  .object({
    recordEntryBytes: z.number().int().positive(),
    modelCallBytes: z.number().int().positive(),
    modelFileBytes: z.number().int().positive(),
    toolAnswerBytes: z.number().int().positive(),
    harnessStateBytes: z.number().int().positive(),
    chunkBytes: z.number().int().positive(),
    folderEntries: z.number().int().positive(),
  })
  .strict();
export type RuntimeLimits = z.infer<typeof RuntimeLimitsSchema>;
export type RuntimeLimit = keyof RuntimeLimits;

/** What a limit counts. */
export type RuntimeLimitUnit = "bytes" | "entries";

/**
 * Each limit's ceiling, which no setting may pass, what it counts, and the dependency it comes
 * from.
 */
export const RUNTIME_LIMIT_CEILINGS: {
  readonly [K in RuntimeLimit]: { readonly value: number; readonly unit: RuntimeLimitUnit; readonly why: string };
} = {
  recordEntryBytes: {
    value: S2_RECORD_MAX_BYTES - RECORD_ENVELOPE_RESERVE_BYTES,
    unit: "bytes",
    why: `S2 takes records of at most ${S2_RECORD_MAX_BYTES} bytes, and an event's envelope needs ${RECORD_ENVELOPE_RESERVE_BYTES} beside its payload`,
  },
  modelCallBytes: {
    value: JS_STRING_MAX_LENGTH,
    unit: "bytes",
    why: `the Model Gate reads a call's body as one string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  modelFileBytes: {
    value: base64Bytes(JS_STRING_MAX_LENGTH),
    unit: "bytes",
    why: `a file goes to the provider as one base64 string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  toolAnswerBytes: {
    value: HARNESS_MAX_PAYLOAD / 2,
    unit: "bytes",
    why: `a harness reports the answer to core in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes), as JSON, whose escapes may double it`,
  },
  harnessStateBytes: {
    value: HARNESS_MAX_PAYLOAD / 2,
    unit: "bytes",
    why: `the state crosses in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes) with the rest of its output or turn.start`,
  },
  chunkBytes: {
    value: base64Bytes(HARNESS_MAX_PAYLOAD) - RECORD_ENVELOPE_RESERVE_BYTES,
    unit: "bytes",
    why: `a chunk crosses in base64 in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes), with room for the frame's own JSON`,
  },
  folderEntries: {
    value: Math.floor(JS_STRING_MAX_LENGTH / FOLDER_ENTRY_MIN_CHARS),
    unit: "entries",
    why: `a folder's manifest is read as one string, of at most ${JS_STRING_MAX_LENGTH} characters, and each entry takes at least ${FOLDER_ENTRY_MIN_CHARS}`,
  },
};

/**
 * The limits a Tenant that sets none runs with: today's sizes. `recordEntryBytes` is its
 * ceiling, so every event S2 took before is still taken; what keeps a step's tool results well
 * inside it is the harness's shaping of them (Nylorun's engine: 256 KiB a step,
 * `shapeToolOutcome` in `@nylorun/harness`), since the record refuses an entry past it.
 */
export const RUNTIME_LIMIT_DEFAULTS: RuntimeLimits = Object.freeze({
  recordEntryBytes: RUNTIME_LIMIT_CEILINGS.recordEntryBytes.value,
  modelCallBytes: 32 * 1024 * 1024,
  modelFileBytes: 8 * 1024 * 1024,
  toolAnswerBytes: 8 * 1024 * 1024,
  harnessStateBytes: 256 * 1024,
  chunkBytes: 16 * 1024 * 1024,
  folderEntries: 10_000,
});

/** The limits in force: `set`, with the default for each it leaves out. */
export function runtimeLimitsOf(set: Partial<RuntimeLimits> | undefined): RuntimeLimits {
  const limits = { ...RUNTIME_LIMIT_DEFAULTS };
  for (const name of Object.keys(limits) as RuntimeLimit[]) {
    const value = set?.[name];
    if (value !== undefined) limits[name] = value;
  }
  return limits;
}

/** Why `set` cannot be put: each limit above its ceiling, naming the ceiling and its dependency. */
export function runtimeLimitIssues(set: Partial<RuntimeLimits> | undefined): string[] {
  const issues: string[] = [];
  for (const name of Object.keys(RUNTIME_LIMIT_CEILINGS) as RuntimeLimit[]) {
    const asked = set?.[name];
    const ceiling = RUNTIME_LIMIT_CEILINGS[name];
    if (asked !== undefined && asked > ceiling.value)
      issues.push(
        `limits.${name} asks for ${asked} ${ceiling.unit}; its ceiling is ${ceiling.value}: ${ceiling.why}.`,
      );
  }
  return issues;
}

/**
 * The message of a write refused for passing limit `name`: what was sent, the limit, and where an
 * operator sets it.
 */
export function limitExceededMessage(what: string, amount: number, name: RuntimeLimit, limit: number): string {
  const unit = RUNTIME_LIMIT_CEILINGS[name].unit;
  return `${what} is ${amount} ${unit}, over the Runtime limit ${name} (${limit} ${unit}; PUT /v1/tenant/limits).`;
}
