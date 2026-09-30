import { createActionHandler, createTokenEndpoint, type AgentsClient } from "@nylorun/agents";
import { toNodeListener } from "@nylorun/agents/ag-ui";
import { support } from "../../agents/ag-ui/support.js";
import { ACTIONS_PATH } from "../ag-ui/app.js";
import { userFromCookie } from "../ag-ui/demo-auth.js";

/**
 * A web backend for pages that call the Runtime themselves. Unlike the AG-UI example
 * (`src/ag-ui/`), no chat traffic passes through here: the backend signs people in, mints a
 * subject token for each (`POST /api/nylorun/token`), tells the page where the Runtime is and
 * which publishable key to send (`GET /api/nylorun/config`), and serves the agent's tools as an
 * Action endpoint (`/nylorun/actions`) the Runtime delivers them to. The application key stays
 * here.
 */
export function createDirectApp(options: {
  client: AgentsClient;
  /** The Runtime's URL as the page reaches it. */
  runtimeUrl: string;
  publishableKey: string;
}) {
  const actions = createActionHandler({ agents: [support], client: options.client });
  const token = createTokenEndpoint({
    client: options.client,
    role: "user",
    subject: (request) => userFromCookie(request)?.id,
  });
  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === ACTIONS_PATH) return actions.fetch(request);
    if (path === "/api/nylorun/token") return token(request);
    if (path === "/api/nylorun/config" && request.method === "GET")
      return Response.json({
        url: options.runtimeUrl,
        publishableKey: options.publishableKey,
        agentId: support.id,
      });
    return Response.json({ error: "Not found" }, { status: 404 });
  };
  return {
    fetch,
    actions,
    listener: toNodeListener({ fetch }),
    /** Points the Runtime at this app's Action endpoint, `origin` + `ACTIONS_PATH`. */
    register: (origin: string) => actions.register({ url: `${origin}${ACTIONS_PATH}` }),
  };
}
