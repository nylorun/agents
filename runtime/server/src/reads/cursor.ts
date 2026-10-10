import { createHash } from "node:crypto";
import { z } from "zod";
import { decodeCursor } from "../record/index.js";
import { fail } from "../tenant/http.js";

const schema = z
  .object({
    version: z.literal(1),
    binding: z.string(),
    key: z.array(z.string().nullable()).max(3),
  })
  .strict();
/** Cursors carry position, not authority. Authorization is reapplied at every read. */
export function readCursor(tenant: string, route: string, filters: Record<string, unknown>) {
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        tenant,
        route,
        Object.entries(filters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    )
    .digest("hex");
  return {
    encode: (key: (string | null)[]) =>
      Buffer.from(JSON.stringify({ version: 1, binding, key })).toString("base64url"),
    decode(value: string | undefined): (string | null)[] | undefined {
      if (value === undefined) return undefined;
      if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
        return fail(400, "Invalid cursor", { code: "cursor_invalid" });
      let parsed;
      try {
        parsed = schema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
      } catch {
        return fail(400, "Invalid cursor", { code: "cursor_invalid" });
      }
      if (!parsed.success) return fail(400, "Invalid cursor", { code: "cursor_invalid" });
      if (parsed.data.binding !== binding)
        return fail(400, "Cursor belongs to another query", { code: "cursor_mismatch" });
      return parsed.data.key;
    },
  };
}

/** Page cursors also resume SSE. SSE accepts the filter captured by the history page. */
export function historyCursor(tenant: string, sessionId: string, agent?: string) {
  const codec = readCursor(tenant, "history", { sessionId, agent });
  return {
    encode: (eventCursor: string) => "h1." + codec.encode([eventCursor, agent ?? null]),
    decode(value: string | undefined): string | undefined {
      if (value === undefined) return undefined;
      if (!value.startsWith("h1."))
        return fail(400, "Invalid history page cursor", { code: "cursor_invalid" });
      const key = codec.decode(value.slice(3));
      if (!key || key.length !== 2 || key[0] === null || key[1] !== (agent ?? null))
        return fail(400, "Invalid history page cursor", { code: "cursor_invalid" });
      try {
        if (!Number.isSafeInteger(decodeCursor(sessionId, key[0])))
          throw new Error("Invalid cursor");
      } catch {
        return fail(400, "Invalid history page cursor", { code: "cursor_invalid" });
      }
      return key[0];
    },
  };
}
export function historyResume(
  tenant: string,
  sessionId: string,
  value: string | undefined,
): string | undefined {
  if (!value?.startsWith("h1.")) return value;
  let parsed;
  try {
    parsed = schema.safeParse(
      JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")),
    );
  } catch {
    return fail(400, "Invalid history cursor", { code: "cursor_invalid" });
  }
  if (!parsed.success || parsed.data.key.length !== 2)
    return fail(400, "Invalid history cursor", { code: "cursor_invalid" });
  return historyCursor(tenant, sessionId, parsed.data.key[1] ?? undefined).decode(value);
}
