/** A Runtime's `GET /v1/tenant` for fixtures: an open, healthy Tenant with no model set. */
export function tenantStatus(id: string, name: string, agents: readonly string[] = []) {
  const time = "2026-10-10T00:00:00.000Z";
  return {
    tenant: { id, name, createdAt: time, updatedAt: time, schemaVersion: 12 },
    path: `/var/lib/nylorun/tenants/${id}`,
    checks: { store: true, scheduler: true, model: true, schema: true },
    model: { configured: false },
    agents: agents.map((agentId) => ({ agentId })),
    counts: { sessions: 1, runningSessions: 0, uncertainEffects: 0 },
    sandbox: { backend: "virtual", retained: 0 },
    harness: { mode: "in-process", connected: 1, workspace: true },
    execution: { stuckInvocations: [] },
  };
}
