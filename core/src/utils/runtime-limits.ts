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
 * The Runtime limits, in bytes:
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
 */
export const RuntimeLimitsSchema = z
  .object({
    recordEntryBytes: z.number().int().positive(),
    modelCallBytes: z.number().int().positive(),
    modelFileBytes: z.number().int().positive(),
    toolAnswerBytes: z.number().int().positive(),
    harnessStateBytes: z.number().int().positive(),
    chunkBytes: z.number().int().positive(),
  })
  .strict();
export type RuntimeLimits = z.infer<typeof RuntimeLimitsSchema>;
export type RuntimeLimit = keyof RuntimeLimits;

/**
 * Each limit's ceiling, which no setting may pass, and the dependency it comes from.
 */
export const RUNTIME_LIMIT_CEILINGS: {
  readonly [K in RuntimeLimit]: { readonly bytes: number; readonly why: string };
} = {
  recordEntryBytes: {
    bytes: S2_RECORD_MAX_BYTES - RECORD_ENVELOPE_RESERVE_BYTES,
    why: `S2 takes records of at most ${S2_RECORD_MAX_BYTES} bytes, and an event's envelope needs ${RECORD_ENVELOPE_RESERVE_BYTES} beside its payload`,
  },
  modelCallBytes: {
    bytes: JS_STRING_MAX_LENGTH,
    why: `the Model Gate reads a call's body as one string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  modelFileBytes: {
    bytes: base64Bytes(JS_STRING_MAX_LENGTH),
    why: `a file goes to the provider as one base64 string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  toolAnswerBytes: {
    bytes: HARNESS_MAX_PAYLOAD / 2,
    why: `a harness reports the answer to core in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes), as JSON, whose escapes may double it`,
  },
  harnessStateBytes: {
    bytes: HARNESS_MAX_PAYLOAD / 2,
    why: `the state crosses in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes) with the rest of its output or turn.start`,
  },
  chunkBytes: {
    bytes: base64Bytes(HARNESS_MAX_PAYLOAD) - RECORD_ENVELOPE_RESERVE_BYTES,
    why: `a chunk crosses in base64 in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes), with room for the frame's own JSON`,
  },
};

/**
 * The limits a Tenant that sets none runs with: today's sizes. `recordEntryBytes` is its
 * ceiling, so every event S2 took before is still taken; what keeps a step's tool results well
 * inside it is core's shaping of them (256 KiB a step, `tenant/tool-results.ts`).
 */
export const RUNTIME_LIMIT_DEFAULTS: RuntimeLimits = Object.freeze({
  recordEntryBytes: RUNTIME_LIMIT_CEILINGS.recordEntryBytes.bytes,
  modelCallBytes: 32 * 1024 * 1024,
  modelFileBytes: 8 * 1024 * 1024,
  toolAnswerBytes: 8 * 1024 * 1024,
  harnessStateBytes: 256 * 1024,
  chunkBytes: 16 * 1024 * 1024,
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
    if (asked !== undefined && asked > ceiling.bytes)
      issues.push(`limits.${name} asks for ${asked} bytes; its ceiling is ${ceiling.bytes}: ${ceiling.why}.`);
  }
  return issues;
}

/**
 * The message of a write refused for passing limit `name`: what was sent, the limit, and where an
 * operator sets it.
 */
export function limitExceededMessage(what: string, bytes: number, name: RuntimeLimit, limit: number): string {
  return `${what} is ${bytes} bytes, over the Runtime limit ${name} (${limit} bytes; PUT /v1/tenant/limits).`;
}
