/**
 * A route for app servers that mints a subject token for the signed-in person (Host feature
 * `subject-tokens`). The browser client calls it whenever it needs a token. Mount it on your
 * app's own origin behind your sign-in: `POST` only, no CORS, never cached.
 *
 *   export const POST = createTokenEndpoint({
 *     client, role: "user", subject: (request) => userFromCookie(request)?.id,
 *   });
 */
import type { TokenScope } from "@nylorun/core/contracts";
import { RuntimeError } from "./http.js";
import type { AgentsClient } from "./session-client.js";

export interface TokenEndpointOptions {
  /** The application client (the Tenant key stays on the server). */
  client: AgentsClient | Promise<AgentsClient>;
  /** The signed-in person the token is for; `undefined` answers 401. */
  subject(request: Request): string | undefined | Promise<string | undefined>;
  /** The access policy role to mint for, or a function of the request and subject. */
  role: string | ((request: Request, subject: string) => string | Promise<string>);
  scopes?: readonly TokenScope[];
  agents?: readonly string[];
  ttlSeconds?: number;
}

const NO_STORE = { "cache-control": "no-store" };

export function createTokenEndpoint(
  options: TokenEndpointOptions
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { allow: "POST", ...NO_STORE } });
    const subject = await options.subject(request);
    if (!subject)
      return Response.json({ error: "Sign in required" }, { status: 401, headers: NO_STORE });
    const role =
      typeof options.role === "string"
        ? options.role
        : await options.role(request, subject);
    try {
      const client = await options.client;
      const minted = await client.tokens.create({
        subject,
        role,
        ...(options.scopes ? { scopes: options.scopes } : {}),
        ...(options.agents ? { agents: options.agents } : {}),
        ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      });
      return Response.json(
        { token: minted.token, expiresAt: minted.expiresAt },
        { headers: NO_STORE }
      );
    } catch (error) {
      // The person sees that a token could not be issued, never the Runtime's details.
      const status = error instanceof RuntimeError && error.status === 400 ? 403 : 502;
      return Response.json(
        { error: "Could not issue a token" },
        { status, headers: NO_STORE }
      );
    }
  };
}
