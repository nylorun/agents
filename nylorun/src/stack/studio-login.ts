import { STACK_CLIENT_HOST } from "./host-files.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Studio's origin as the CLI opens it: always `localhost` (the cookie's host). */
export function studioOrigin(port: number): string {
  return `http://${STACK_CLIENT_HOST}:${port}`;
}

/**
 * Ask the Studio container for a single-use login token with the admin key
 * (`POST /_studio/login-tokens`, Studio §6) and return the URL to open.
 * Accepts `{ loginUrl }`, `{ url }` or `{ token }` in the response.
 */
export async function mintStudioLogin(input: {
  fetch: FetchLike;
  studioPort: number;
  adminKey: string;
  timeoutMs?: number;
}): Promise<string> {
  const origin = studioOrigin(input.studioPort);
  const response = await input.fetch(`${origin}/_studio/login-tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.adminKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(input.timeoutMs ?? 5000),
  });
  if (!response.ok)
    throw new Error(`Studio refused a login token (HTTP ${response.status}).`);
  const body = (await response.json()) as Record<string, unknown>;
  for (const field of ["loginUrl", "url"]) {
    const value = body[field];
    if (typeof value === "string" && value !== "") {
      // A relative URL is resolved against the published origin.
      return new URL(value, origin).toString();
    }
  }
  if (typeof body.token === "string" && body.token !== "")
    return `${origin}/login?token=${encodeURIComponent(body.token)}`;
  throw new Error("Studio answered without a login token.");
}
