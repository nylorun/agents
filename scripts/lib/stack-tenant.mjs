/**
 * The local Tenant, reset for a smoke or acceptance check: a Host serves one
 * Tenant, so a check starts from a clean one instead of creating its own.
 * Reset through the Management API (`POST /v1/tenant/reset`, scope `all`, active
 * work cancelled: what `nylo reset --all` does) with a management key, seeded
 * with the Tenant-level fixture model (no model credential), handed to `fn` as
 * NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY (the checks' application key, see
 * `hostTenant`) and NYLORUN_MANAGEMENT_KEY (no Project link is written), and
 * reset again afterwards.
 */
import { randomUUID } from "node:crypto";
import { runtimeHeaders } from "./stack.mjs";

/** The Host feature a fixture-model Tenant needs. */
export const FIXTURE_MODEL_FEATURE = "tenant-fixture-model";

/**
 * Reset everything in the Tenant (sessions, sandboxes, agents, Action
 * endpoints, vaults), cancelling its active work. Its settings stay.
 * @param {{ runtimeUrl: string, managementKey: string }} options
 */
export async function resetStackTenant({ runtimeUrl, managementKey }) {
  const response = await fetch(`${runtimeUrl}/v1/tenant/reset`, {
    method: "POST",
    headers: runtimeHeaders(managementKey, { "content-type": "application/json" }),
    body: JSON.stringify({ requestId: randomUUID(), scope: "all", activeWork: "cancel" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Resetting the Tenant failed (${response.status}): ${await response.text()}`);
}

/**
 * `stack`: a started Tenant (`withStack`); `stack.tenant()` gives its id, the checks'
 * application key and their management key.
 * @param {{ stack: { runtimeUrl?: string, tenant(): Promise<{ id: string, key: string, managementKey: string }> }, name: string, log?: (line: string) => void }} options
 * @param {(tenant: { id: string, key: string, managementKey: string, env: Record<string, string> }) => Promise<T>} fn
 * @template T
 */
export async function withResetTenant({ stack, name, log = console.log }, fn) {
  if (!stack.runtimeUrl) throw new Error("withResetTenant needs a started Tenant (stack.start).");
  const runtimeUrl = stack.runtimeUrl.replace(/\/$/, "");
  const health = await (await fetch(`${runtimeUrl}/health`, { signal: AbortSignal.timeout(5_000) })).json();
  if (!health.protocol?.features?.includes(FIXTURE_MODEL_FEATURE))
    throw new Error(
      `The Runtime at ${runtimeUrl} (${health.version ?? "?"}) lacks Host feature ${FIXTURE_MODEL_FEATURE}.`,
    );
  const { id, key, managementKey } = await stack.tenant();
  await resetStackTenant({ runtimeUrl, managementKey });
  try {
    const seeded = await fetch(`${runtimeUrl}/v1/tenant/config/seed`, {
      method: "PUT",
      headers: runtimeHeaders(managementKey, { "content-type": "application/json" }),
      body: JSON.stringify({ requestId: randomUUID(), fixtureModel: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!seeded.ok)
      throw new Error(`Seeding the fixture model failed (${seeded.status}): ${await seeded.text()}`);
    log(`[tenant] ${name}: reset Tenant ${id} (fixture model)`);
    return await fn({
      id,
      key,
      managementKey,
      env: {
        NYLORUN_RUNTIME_URL: runtimeUrl,
        NYLORUN_SERVER_KEY: key,
        NYLORUN_MANAGEMENT_KEY: managementKey,
      },
    });
  } finally {
    await resetStackTenant({ runtimeUrl, managementKey });
    log(`[tenant] ${name}: reset Tenant ${id} again`);
  }
}
