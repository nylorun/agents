import {
  StudioLoginTokenRequestSchema,
  StudioLoginTokenResponseSchema,
  type StudioLoginTokenResponse,
} from "@nylorun/core/contracts";
import { AdminError } from "./errors.js";

/**
 * Mints a single-use Studio login token with the admin key (`POST
 * /_studio/login-tokens`, Studio §8.4). An app that embeds Studio, such as
 * Babai, calls this from its backend and hands only the token to its page,
 * which passes it to the framed Studio in `init`.
 *
 * - `tenant` limits the session the token leads to to one Tenant; omit it for
 *   a Host-wide token (what `nylorun studio` uses).
 * - `subject` names the person, for Studio's logs.
 */
export async function mintStudioLoginToken(options: {
  /** Studio's URL, e.g. `studio.url` from `nylorun status --json`. */
  studioUrl: string;
  adminKey: string;
  tenant?: string;
  subject?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<StudioLoginTokenResponse> {
  const body = StudioLoginTokenRequestSchema.safeParse({
    ...(options.tenant !== undefined ? { tenant: options.tenant } : {}),
    ...(options.subject !== undefined ? { subject: options.subject } : {}),
  });
  if (!body.success)
    throw new AdminError(
      "invalid_request",
      `Invalid Studio login token request: ${body.error.issues[0]?.message ?? "invalid"}`,
    );
  const fetcher = options.fetch ?? fetch;
  const url = new URL("/_studio/login-tokens", options.studioUrl);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.adminKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body.data),
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new AdminError(
      "connection_missing",
      `Studio is unavailable at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    let message = `Studio refused a login token (HTTP ${response.status}).`;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      /* keep the status message */
    }
    throw new AdminError(
      response.status === 401 ? "host_rejected" : "request_rejected",
      message,
      { status: response.status },
    );
  }
  const parsed = StudioLoginTokenResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new AdminError(
      "incompatible_host",
      "This Studio does not support login tokens limited to a Tenant; update the stack.",
    );
  return parsed.data;
}
