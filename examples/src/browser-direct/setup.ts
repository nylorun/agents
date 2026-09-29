import type { AgentsClient } from "@nylorun/agents";
import { support } from "../../agents/ag-ui/support.js";

/**
 * One-time Tenant setup for direct access, safe to run on every start: a `user` role that may
 * use the support agent within limits, and a publishable key for the page's origins. The same
 * is possible from the terminal with `nylo access policy set` and `nylo access keys create`.
 */
export async function setUpAccess(
  client: AgentsClient,
  origins: readonly string[] = ["http://localhost:*"]
): Promise<{ publishableKey: string }> {
  const policy = await client.access.getPolicy();
  if (!policy.roles.user)
    await client.access.putPolicy({
      ...policy,
      roles: {
        ...policy.roles,
        user: {
          scopes: ["sessions:own", "agents:read"],
          agents: [support.id],
          limits: { turnsPerHour: 60, concurrentTurns: 2 },
        },
      },
    });
  const keys = await client.access.publishableKeys.list();
  const existing = keys.find((key) => key.name === "web" && key.revokedAt === null);
  const key =
    existing ??
    (await client.access.publishableKeys.create({ name: "web", origins }));
  return { publishableKey: key.key };
}
