import { connectAgents, createTokenEndpoint, type AgentsClient } from "@nylorun/agents";
import { toNodeListener } from "@nylorun/agents/ag-ui";
import { support } from "../../agents/ag-ui/support.js";
import { userFromCookie } from "../ag-ui/demo-auth.js";

/**
 * A web backend for pages that call the Runtime themselves. Unlike the AG-UI example
 * (`src/ag-ui/`), no chat traffic passes through here: the backend signs people in, mints a
 * subject token for each (`POST /api/nylorun/token`), tells the page where the Runtime is and
 * which publishable key to send (`GET /api/nylorun/config`), and runs the agent's tools in its
 * executor. The application key stays here.
 */
export function createDirectApp(options: {
  client: AgentsClient;
  /** The Runtime's URL as the page reaches it. */
  runtimeUrl: string;
  publishableKey: string;
}) {
  const connection = connectAgents({ agents: [support], application: options.client });
  const token = createTokenEndpoint({
    client: options.client,
    role: "user",
    subject: (request) => userFromCookie(request)?.id,
  });
  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/api/nylorun/token") return token(request);
    if (path === "/api/nylorun/config" && request.method === "GET")
      return Response.json({
        url: options.runtimeUrl,
        publishableKey: options.publishableKey,
        agentId: support.id,
      });
    return Response.json({ error: "Not found" }, { status: 404 });
  };
  return { fetch, connection, listener: toNodeListener({ fetch }) };
}
