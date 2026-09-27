/**
 * A temporary Tenant for smoke and acceptance checks: what `nylorun dev
 * --ephemeral` did before Tenant creation left the stack command. Created
 * through the Admin API (no Project link or credentials are written), seeded
 * with the Tenant-level fixture model (no model credential), handed to `fn` as
 * the three NYLORUN_* variables, and deleted afterwards, cancelling its active
 * work. Test-only: developers create Tenants with `nylo tenant create`.
 */
import { randomUUID } from "node:crypto";
import { tenantHeaders } from "./stack.mjs";

/** The Host feature a fixture-model Tenant needs. */
export const FIXTURE_MODEL_FEATURE = "tenant-fixture-model";

/**
 * @param {{ admin: { url: string, createTenant(o: { name: string }): Promise<{ tenant: { id: string, name: string }, applicationKey: string }>, deleteTenant(id: string, o: { activeWork: "cancel" }): Promise<unknown> }, name: string, log?: (line: string) => void }} options
 * @param {(tenant: { id: string, name: string, env: Record<string, string> }) => Promise<T>} fn
 * @template T
 */
export async function withTemporaryTenant({ admin, name, log = console.log }, fn) {
  const runtimeUrl = admin.url.replace(/\/$/, "");
  const health = await (await fetch(`${runtimeUrl}/health`, { signal: AbortSignal.timeout(5_000) })).json();
  if (!health.protocol?.features?.includes(FIXTURE_MODEL_FEATURE))
    throw new Error(
      `The Runtime at ${runtimeUrl} (${health.version ?? "?"}) lacks Host feature ${FIXTURE_MODEL_FEATURE}.`,
    );
  const { tenant, applicationKey } = await admin.createTenant({ name: `${name} (temporary)` });
  try {
    const seeded = await fetch(`${runtimeUrl}/v1/tenant/config/seed`, {
      method: "PUT",
      headers: tenantHeaders(tenant.id, applicationKey, { "content-type": "application/json" }),
      body: JSON.stringify({ requestId: randomUUID(), fixtureModel: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!seeded.ok)
      throw new Error(`Seeding the fixture model failed (${seeded.status}): ${await seeded.text()}`);
    log(`[tenant] temporary Tenant ${tenant.id} (fixture model)`);
    return await fn({
      id: tenant.id,
      name: tenant.name,
      env: {
        NYLORUN_RUNTIME_URL: runtimeUrl,
        NYLORUN_TENANT: tenant.id,
        NYLORUN_SERVER_KEY: applicationKey,
      },
    });
  } finally {
    await admin.deleteTenant(tenant.id, { activeWork: "cancel" });
    log(`[tenant] deleted temporary Tenant ${tenant.id}`);
  }
}
