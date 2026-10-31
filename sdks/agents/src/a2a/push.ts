/**
 * Verifying a push delivery from a Nylorun agent (profile v2): Standard Webhooks signatures over
 * the raw body with the installation's `whsec_` secret. Web Crypto only, so it runs wherever
 * `fetch` does; HMAC comparison is `crypto.subtle.verify`'s, in constant time.
 */
import type { StreamResponse } from "./types.js";

export type A2aPushFailure =
  | "missing_headers"
  | "invalid_secret"
  | "invalid_timestamp"
  | "timestamp_out_of_range"
  | "invalid_signature"
  | "invalid_token"
  | "invalid_body";

/** A delivery that is not provably from the agent: answer it `400` or `401` and drop it. */
export class A2aPushVerificationError extends Error {
  constructor(
    readonly reason: A2aPushFailure,
    message: string
  ) {
    super(message);
    this.name = "A2aPushVerificationError";
  }
}

/** Request headers as `Headers`, a `node:http` `IncomingHttpHeaders`, or a plain record. */
export type PushHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyA2aPushOptions {
  /** The installation's webhook secret, `whsec_<base64>`. */
  secret: string;
  headers: PushHeaders;
  /** The request body exactly as received: verify before parsing. */
  body: string | Uint8Array;
  /** How far `webhook-timestamp` may be from now, either way. Default 300. */
  toleranceSeconds?: number;
  /**
   * The push config's `token`, when the client gave one: the delivery's
   * `X-A2A-Notification-Token` must match it.
   */
  token?: string;
}

function header(headers: PushHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function")
    return (headers as Headers).get(name) ?? undefined;
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value.join(" ") : (value as string | undefined);
}

function base64Bytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

const encoder = new TextEncoder();

/** Equal strings, compared without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/**
 * Checks one push delivery and returns its body, an A2A `StreamResponse`. Throws
 * `A2aPushVerificationError` when a header is missing, the timestamp is more than
 * `toleranceSeconds` from now, no `v1` signature matches, or the token differs. Several
 * signatures (space-separated) are allowed, as during a secret's rotation.
 */
export async function verifyA2aPush(options: VerifyA2aPushOptions): Promise<StreamResponse> {
  const id = header(options.headers, "webhook-id");
  const timestamp = header(options.headers, "webhook-timestamp");
  const signatures = header(options.headers, "webhook-signature");
  if (!id || !timestamp || !signatures)
    throw new A2aPushVerificationError(
      "missing_headers",
      "webhook-id, webhook-timestamp and webhook-signature are required"
    );
  const secret = base64Bytes(options.secret.replace(/^whsec_/, ""));
  if (!secret || secret.length === 0)
    throw new A2aPushVerificationError("invalid_secret", "The secret must be whsec_<base64>");
  if (!/^\d{1,15}$/.test(timestamp))
    throw new A2aPushVerificationError("invalid_timestamp", "webhook-timestamp must be unix seconds");
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > tolerance)
    throw new A2aPushVerificationError(
      "timestamp_out_of_range",
      `webhook-timestamp is more than ${tolerance} seconds from now`
    );
  const body =
    typeof options.body === "string" ? options.body : new TextDecoder().decode(options.body);
  const key = await crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = encoder.encode(`${id}.${timestamp}.${body}`);
  let verified = false;
  for (const entry of signatures.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    const signature = base64Bytes(entry.slice(comma + 1));
    if (!signature) continue;
    // Every candidate is checked, so the time taken says nothing about which one matched.
    if (await crypto.subtle.verify("HMAC", key, signature as Uint8Array<ArrayBuffer>, signed))
      verified = true;
  }
  if (!verified)
    throw new A2aPushVerificationError("invalid_signature", "No webhook-signature matches");
  if (options.token !== undefined) {
    const token = header(options.headers, "x-a2a-notification-token");
    if (token === undefined || !sameText(token, options.token))
      throw new A2aPushVerificationError(
        "invalid_token",
        "X-A2A-Notification-Token does not match the push config's token"
      );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new A2aPushVerificationError("invalid_body", "The body is not JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !["task", "message", "statusUpdate", "artifactUpdate"].some((key) => key in parsed)
  )
    throw new A2aPushVerificationError("invalid_body", "The body is not an A2A StreamResponse");
  return parsed as StreamResponse;
}
