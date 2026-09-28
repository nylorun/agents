import { connectAgents, type AgentsClient } from "@nylorun/agents";
import { createAgUiHandler, toNodeListener } from "@nylorun/agents/ag-ui";
import { support } from "../../agents/ag-ui/support.js";
import { userFromCookie } from "./demo-auth.js";

/**
 * A web backend's whole Nylorun integration: the AG-UI endpoint its browser talks to, and the
 * executor that runs the agent's tools in this process. The application key stays here; the
 * handler calls the Runtime as each signed-in person, so people only reach their own threads.
 * Without `client`, both resolve the Runtime from the environment or the Project link.
 */
export function createSupportApp(options: { client?: AgentsClient } = {}) {
  const { client } = options;
  const connection = connectAgents({
    agents: [support],
    ...(client ? { application: client } : {}),
  });
  const handler = createAgUiHandler({
    basePath: "/api/agui",
    agents: [support],
    ...(client ? { client } : {}),
    subject: (request) => userFromCookie(request)?.id,
  });
  return { handler, connection, listener: toNodeListener(handler) };
}
