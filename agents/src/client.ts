export * from "./session-client.js";
import { AgentsClient } from "./session-client.js";
import { resolveConnection } from "./connection.js";
import type { Destination } from "./http.js";

/**
 * Build a Tenant API client.
 * Explicit connection fields keep today's sync Transport resolution (including
 * environment fill-ins). With no connection fields, resolves via
 * `resolveConnection` (environment → project link).
 */
export function createClient(destination: Destination): AgentsClient;
export function createClient(destination?: undefined): Promise<AgentsClient>;
export function createClient(
  destination: Destination = {},
): AgentsClient | Promise<AgentsClient> {
  if (
    destination.url !== undefined ||
    destination.key !== undefined ||
    destination.tenant !== undefined
  ) {
    return new AgentsClient(destination);
  }
  return resolveConnection().then(
    (connection) =>
      new AgentsClient({
        url: connection.url,
        key: connection.key,
        tenant: connection.tenant,
        ...(destination.fetch ? { fetch: destination.fetch } : {}),
      }),
  );
}
