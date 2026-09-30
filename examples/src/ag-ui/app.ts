import { createActionHandler, type AgentsClient } from "@nylorun/agents";
import { createAgUiHandler, toNodeListener } from "@nylorun/agents/ag-ui";
import { support } from "../../agents/ag-ui/support.js";
import { userFromCookie } from "./demo-auth.js";

/** Where this app serves its Action endpoint; everything else is the AG-UI endpoint. */
export const ACTIONS_PATH = "/nylorun/actions";

/**
 * A web backend's whole Nylorun integration: the AG-UI endpoint its browser talks to, and the
 * Action endpoint the Runtime delivers the agent's tool calls to. The application key stays
 * here; the AG-UI handler calls the Runtime as each signed-in person, so people only reach their
 * own threads. Without `client`, both resolve the Runtime from the environment or the Project
 * link.
 */
export function createSupportApp(options: { client?: AgentsClient } = {}) {
  const { client } = options;
  const actions = createActionHandler({
    agents: [support],
    ...(client ? { client } : {}),
  });
  const handler = createAgUiHandler({
    basePath: "/api/agui",
    agents: [support],
    ...(client ? { client } : {}),
    subject: (request) => userFromCookie(request)?.id,
  });
  const fetch = (request: Request) =>
    new URL(request.url).pathname === ACTIONS_PATH ? actions.fetch(request) : handler.fetch(request);
  return {
    handler,
    actions,
    listener: toNodeListener({ fetch }),
    /** Points the Runtime at this app's Action endpoint, `origin` + `ACTIONS_PATH`. */
    register: (origin: string) => actions.register({ url: `${origin}${ACTIONS_PATH}` }),
  };
}
