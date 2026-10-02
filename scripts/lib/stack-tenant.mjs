/**
 * The stack's one Tenant, reset for a smoke or acceptance check: a Host serves
 * one Tenant, so a check starts from a clean one instead of creating its own.
 * Reset through the Tenant API (`POST /v1/tenant/reset`, scope `all`, active
 * work cancelled: what `nylo reset --all` does), seeded with the Tenant-level
 * fixture model (no model credential), handed to `fn` as NYLORUN_RUNTIME_URL
 * and NYLORUN_SERVER_KEY (the `project` key; no Project link is written), and
 * reset again afterwards.
 */
import { randomUUID } from "node:crypto";
import { hostTenant, runtimeHeaders } from "./stack.mjs";

/** The Host feature a fixture-model Tenant needs. */
export const FIXTURE_MODEL_FEATURE = "tenant-fixture-model";

/**
 * Reset everything in the Tenant (sessions, sandboxes, agents, Action
 * endpoints, vaults), cancelling its active work. Its settings stay.
 * @param {{ runtimeUrl: string, key: string }} options
 */
export async function resetStackTenant({ runtimeUrl, key }) {
  const response = await fetch(`${runtimeUrl}/v1/tenant/reset`, {
    method: "POST",
    headers: runtimeHeaders(key, { "content-type": "application/json" }),
    body: JSON.stringify({ requestId: randomUUID(), scope: "all", activeWork: "cancel" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Resetting the Tenant failed (${response.status}): ${await response.text()}`);
}

/**
 * @param {{ admin: { url: string, status(): Promise<{ tenant: { id: string | null, state: string } }>, deriveTenantKey(tenantId: string, principalId: string): string }, name: string, log?: (line: string) => void }} options
 * @param {(tenant: { id: string, key: string, env: Record<string, string> }) => Promise<T>} fn
 * @template T
 */
export async function withResetTenant({ admin, name, log = console.log }, fn) {
  const runtimeUrl = admin.url.replace(/\/$/, "");
  const health = await (await fetch(`${runtimeUrl}/health`, { signal: AbortSignal.timeout(5_000) })).json();
  if (!health.protocol?.features?.includes(FIXTURE_MODEL_FEATURE))
    throw new Error(
      `The Runtime at ${runtimeUrl} (${health.version ?? "?"}) lacks Host feature ${FIXTURE_MODEL_FEATURE}.`,
    );
  const { id, key } = await hostTenant(admin);
  await resetStackTenant({ runtimeUrl, key });
  try {
    const seeded = await fetch(`${runtimeUrl}/v1/tenant/config/seed`, {
      method: "PUT",
      headers: runtimeHeaders(key, { "content-type": "application/json" }),
      body: JSON.stringify({ requestId: randomUUID(), fixtureModel: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!seeded.ok)
      throw new Error(`Seeding the fixture model failed (${seeded.status}): ${await seeded.text()}`);
    log(`[tenant] ${name}: reset Tenant ${id} (fixture model)`);
    return await fn({
      id,
      key,
      env: { NYLORUN_RUNTIME_URL: runtimeUrl, NYLORUN_SERVER_KEY: key },
    });
  } finally {
    await resetStackTenant({ runtimeUrl, key });
    log(`[tenant] ${name}: reset Tenant ${id} again`);
  }
}
