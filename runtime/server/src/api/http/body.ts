/**
 * Request bodies of Tenant routes, read as the router they replace read them
 * (`tenant/http.ts`): at most the Tenant's Runtime limit `requestBodyBytes`, or for an endpoint
 * that takes files inline `inlineBodyBytes` of its limits (one file at `inlineFileBytes` in
 * base64, and the rest), UTF-8, and a missing or malformed JSON body is `400 Invalid JSON`. The
 * limits are read for each request.
 */
import { inlineBodyBytes } from "@nylorun/core/contracts";
import type { TenantContext } from "../../tenant/context.js";
import { fail } from "../../tenant/http.js";
import { readRuntimeLimits } from "../../tenant/runtime-limits.js";

/** What a body is: a JSON request (`requestBodyBytes`), or a message that may carry files inline. */
export type BodyKind = "json" | "inline";

/** The most bytes the Tenant's route reads of a body of `kind`. */
export async function bodyLimit(tenant: TenantContext, kind: BodyKind = "json"): Promise<number> {
  const limits = await tenant.store.tx((t) => readRuntimeLimits(t));
  return kind === "inline" ? inlineBodyBytes(limits) : limits.requestBodyBytes;
}

/** The body as text; past `maxBytes`, `413 Request too large`. */
export async function readText(request: Request, maxBytes: number): Promise<string> {
  if (request.body === null) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      fail(413, "Request too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The body's bytes; past `maxBytes`, `413` with code `limit_exceeded`. */
export async function readBytes(request: Request, maxBytes: number, limit: string): Promise<Buffer> {
  if (request.body === null) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      fail(413, `The body is over ${maxBytes} bytes, the Runtime limit ${limit}`, { code: "limit_exceeded" });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The body of a Tenant route's request as JSON, before any schema. */
export async function readJson(
  c: { readonly req: { readonly raw: Request }; readonly env: { readonly tenant: TenantContext } },
  kind: BodyKind = "json",
): Promise<unknown> {
  const text = await readText(c.req.raw, await bodyLimit(c.env.tenant, kind));
  try {
    return JSON.parse(text);
  } catch {
    return fail(400, "Invalid JSON");
  }
}
