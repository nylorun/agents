export * from "./session-client.js";
import { AgentsClient } from "./session-client.js";
import type { Destination } from "./http.js";

/**
 * Build a Tenant API client.
 * Explicit connection fields keep today's sync Transport resolution (including
 * environment fill-ins). With no connection fields, resolves via
 * `resolveConnection` (environment → project link), which reads the Project's files: it is
 * loaded only then, so this entry point imports no Node module (Studio's web bundle uses it).
 */
export function createClient(destination: Destination): AgentsClient;
export function createClient(destination?: undefined): Promise<AgentsClient>;
export function createClient(
  destination: Destination = {},
): AgentsClient | Promise<AgentsClient> {
  if (destination.url !== undefined || destination.key !== undefined) {
    return new AgentsClient(destination);
  }
  return import("./connection.js").then(async ({ resolveConnection }) => {
    const connection = await resolveConnection();
    return new AgentsClient({
      url: connection.url,
      key: connection.key,
      ...(destination.fetch ? { fetch: destination.fetch } : {}),
    });
  });
}
