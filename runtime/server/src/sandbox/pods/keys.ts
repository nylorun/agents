/**
 * The hosts a pod sandbox has a key for (ADR-142), as the sandboxes service renders them on Agent
 * Substrate: an https rule per host whose header Substrate's egress asks the keys provider for.
 * agent-sandbox ignores them (egress-gate adds keys there).
 *
 * The hosts of the Environment's `environment_secret`s and slots (read from the clear binding,
 * no value), then the hosts the outside credential source lists for the Agent's owner, inside the
 * Tenant's egress ceiling; the vault's header wins for a host both name, as on egress-gate. A
 * source that fails names none (it logs once), so its hosts are passed through until the next
 * apply. Values are never read here: the keys provider asks for them per request.
 */
import type { TenantContext } from "../../tenant/context.js";
import { environmentSecretHosts } from "../../vault/service.js";
import { withinCeiling } from "../resolve.js";
import type { PodSpec } from "./client.js";

/** The most keyed hosts one sandbox's policy holds (the sandboxes service's bound). */
export const MAX_KEY_HOSTS = 200;

export async function podKeysOf(
  ctx: Pick<TenantContext, "store" | "credentialProvider">,
  input: { readonly sandboxId: string; readonly owner?: string; readonly ceiling?: readonly string[] },
): Promise<NonNullable<PodSpec["keys"]>> {
  const hosts = new Map<string, string>();
  for (const entry of await ctx.store.tx((t) => environmentSecretHosts(t, input.sandboxId))) hosts.set(entry.host, entry.header);
  if (ctx.credentialProvider && input.owner !== undefined) {
    const provider = ctx.credentialProvider;
    const listed = provider.keyedHosts
      ? await provider.keyedHosts(input.sandboxId, input.owner)
      : (await provider.hosts(input.sandboxId, input.owner)).map((host) => ({ host, header: "Authorization" }));
    for (const entry of listed) {
      if (hosts.has(entry.host)) continue;
      if (input.ceiling && !withinCeiling(entry.host, input.ceiling)) continue;
      hosts.set(entry.host, entry.header);
    }
  }
  const list = [...hosts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_KEY_HOSTS)
    .map(([host, header]) => ({ host, header }));
  return { sandbox: input.sandboxId, hosts: list };
}
