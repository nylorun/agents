/**
 * Keeps the Runtime's own tokens out of the record (track R4, conformance HC14). A harness runs
 * model-written commands with the egress token in their proxy variables, and holds its run and
 * host tokens; a command that prints its environment, or a model that repeats it, would put
 * them into a tool result, an assistant message or a transcript edit. Core replaces every
 * Nylorun-signed token (a compact JWT whose `typ` is `nylorun-…`) in what a harness reports with
 * `[nylorun token redacted]` before recording it, whichever harness reported it. Other values
 * pass through unchanged, and the walk keeps the value's shape.
 */
import { tokenType } from "../tenant/jwt.js";

export const REDACTED_TOKEN = "[nylorun token redacted]";

/** A compact JWT: three base64url parts, the first two JSON objects. */
const COMPACT_JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;

function redactString(text: string): string {
  if (!text.includes("eyJ")) return text;
  return text.replace(COMPACT_JWT, (token) => (tokenType(token)?.startsWith("nylorun-") ? REDACTED_TOKEN : token));
}

/** `value` with every Nylorun-signed token in its strings replaced; the same value when there is none. */
export function redactTokens<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactTokens(item);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? next : value) as T;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const redacted = redactTokens(item);
      if (redacted !== item) changed = true;
      next[key] = redacted;
    }
    return (changed ? next : value) as T;
  }
  return value;
}
