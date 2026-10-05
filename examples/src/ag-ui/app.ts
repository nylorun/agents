import { createClient, type AgentsClient } from "@nylorun/agents";
import { createAgUiHandler, toNodeListener } from "@nylorun/agents/ag-ui";
import { supportAgent } from "../../agents/ag-ui/support.js";
import { lookupOrderCode } from "../../agents/shared/orders.js";
import { toolsService } from "../../agents/shared/tools/service.js";
import { userFromCookie } from "./demo-auth.js";

/** Where this app answers the support agent's tool calls; everything else is the AG-UI endpoint. */
export const TOOLS_PATH = "/lookup_order";

/**
 * A web backend's whole Nylorun integration: the AG-UI endpoint its browser talks to, and the
 * order lookup the Runtime calls for the agent's `lookup_order` (an HTTP tool; the Runtime runs
 * no code of this app). The application key stays here; the AG-UI handler calls the Runtime as
 * each signed-in person, so people only reach their own threads. Without `client`, both resolve
 * the Runtime from the environment or the Project link.
 */
export function createSupportApp(options: { client?: AgentsClient } = {}) {
  const { client } = options;
  const tools = toolsService([lookupOrderCode]);
  const handler = createAgUiHandler({
    basePath: "/api/agui",
    agents: ["support"],
    ...(client ? { client } : {}),
    subject: (request) => userFromCookie(request)?.id,
  });
  const fetch = (request: Request) =>
    new URL(request.url).pathname === TOOLS_PATH ? tools(request) : handler.fetch(request);
  return {
    handler,
    listener: toNodeListener({ fetch }),
    /** Saves the support agent, whose tool the Runtime reaches at `origin` + `TOOLS_PATH`. */
    save: async (origin: string) => (client ?? (await createClient())).saveAgent(supportAgent(origin)),
  };
}
