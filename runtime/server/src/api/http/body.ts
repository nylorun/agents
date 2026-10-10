/**
 * Request bodies of Tenant routes, read as the router they replace read them
 * (`tenant/http.ts`): at most 1 MiB, UTF-8, and a missing or malformed JSON body is
 * `400 Invalid JSON`.
 */
import { fail } from "../../tenant/http.js";

const MAX_BODY_BYTES = 1024 * 1024;

/** The body as text. */
export async function readText(request: Request): Promise<string> {
  if (request.body === null) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      fail(413, "Request too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The body as JSON, before any schema. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await readText(request);
  try {
    return JSON.parse(text);
  } catch {
    return fail(400, "Invalid JSON");
  }
}
