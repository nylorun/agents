/**
 * An Action endpoint for the acceptance scripts: serves `agents` with `createActionHandler` on a
 * free port of this machine and registers it. On a local Tenant the Runtime runs in Docker and
 * maps `localhost` to this machine, so the server listens on every interface.
 */
import { createServer } from "node:http";
import { createActionHandler } from "@nylorun/agents";

export const ACTIONS_PATH = "/nylorun/actions";

/**
 * @param {{
 *   agents: Parameters<typeof createActionHandler>[0]["agents"];
 *   client: import("@nylorun/agents").AgentsClient;
 *   implementationVersion?: string;
 *   host?: string;
 *   onError?: (error: unknown) => void;
 * }} options
 */
export async function serveActionEndpoint(options) {
  const actions = createActionHandler({
    agents: options.agents,
    client: options.client,
    implementationVersion: options.implementationVersion ?? "dev",
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const server = createServer(actions.node);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  const url = `http://${options.host ?? "localhost"}:${server.address().port}${ACTIONS_PATH}`;
  try {
    await actions.register({ url });
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    actions,
    url,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
