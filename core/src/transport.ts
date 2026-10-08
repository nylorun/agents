/**
 * What every Runtime client does on the wire (`@nylorun/core/transport`): the headers of an
 * authenticated request, reading a response body, and the `/health` compatibility probe. It
 * imports nothing from Node, so browser clients use it too. `@nylorun/agents` (the Runtime
 * API), `@nylorun/admin` (the Management API) and Studio's server build on it.
 */
import {
  PROTOCOL_FEATURES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  checkCompatibility,
  type Compatibility,
  type ProtocolRange,
} from "./compatibility.js";
import { ProtocolRangeSchema } from "./contracts.js";

export type Incompatibility = Extract<Compatibility, { ok: false }>;

// A newer Host may add fields to its range: they are ignored, not refused.
const ProtocolRangeReader = ProtocolRangeSchema.strip();

/** A protocol range (`{ min, max, features }`); undefined when `value` is not one. */
export function parseProtocolRange(value: unknown): ProtocolRange | undefined {
  const parsed = ProtocolRangeReader.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The `protocol` a `/health` or `426` body advertises; undefined when it has none. */
export function advertisedProtocol(body: unknown): ProtocolRange | undefined {
  return body && typeof body === "object" && !Array.isArray(body)
    ? parseProtocolRange((body as { protocol?: unknown }).protocol)
    : undefined;
}

/** Whether a Host advertising `host` serves this client's protocol and required features. */
export function clientCompatibility(host: ProtocolRange): Compatibility {
  return checkCompatibility(
    { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
    host,
  );
}

/** Why a Host does not serve this client, starting lowercase. */
export function describeIncompatibility(result: Incompatibility): string {
  return result.reason === "version"
    ? `client protocol ${result.client} is outside Host range ${result.host.min}–${result.host.max}`
    : `Host is missing required features: ${result.missing.join(", ")}`;
}

/** The headers of an authenticated request: this client's protocol and the bearer, when given. */
export function requestHeaders(bearer?: string): Record<string, string> {
  return {
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  };
}

/** A response body's text as JSON, or the text itself when it is not JSON. */
export function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Reads `response`'s body: JSON, else its text. */
export async function readBody(response: Response): Promise<unknown> {
  return parseBody(await response.text());
}

/** What the Host's `/health` says about this client. */
export type HealthCheck =
  /** `/health` answered an error status; `body` is what it sent. */
  | { result: "failed"; status: number; body: unknown }
  /** `/health` advertised no protocol range: a Host older than protocol ranges. */
  | { result: "unadvertised"; body: unknown }
  | { result: "incompatible"; protocol: ProtocolRange; compatibility: Incompatibility }
  | { result: "compatible"; protocol: ProtocolRange };

/**
 * `GET <url>/health` (no credential, no redirects) and whether the Host serves this client. A
 * network failure rejects.
 */
export async function checkHealth(
  url: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<HealthCheck> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(`${url}/health`, {
    method: "GET",
    redirect: "error",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await readBody(response);
  if (!response.ok) return { result: "failed", status: response.status, body };
  const protocol = advertisedProtocol(body);
  if (!protocol) return { result: "unadvertised", body };
  const compatibility = clientCompatibility(protocol);
  return compatibility.ok
    ? { result: "compatible", protocol }
    : { result: "incompatible", protocol, compatibility };
}
