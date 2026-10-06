/**
 * G4 — Cross-Tenant fuzz for every §5.3 Tenant route family. A Host serves one Tenant, so
 * two Tenants are two installations (two Hosts, two databases): a credential or a Tenant
 * named for the other one reaches nothing.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/agents";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";
import {
  getJson,
  startSecurityHost,
  tenantHeaders,
} from "./support.js";

const agentA = Agent({ id: "agent-a", name: "A" }).build();
const agentB = Agent({ id: "agent-b", name: "B" }).build();

it("G4: cross-Tenant ids and credentials never leak or mutate the other Tenant", async () => {
  const options = {
    sandboxBackend: "virtual" as const,
    model: { kind: "scripted" as const, output: "ok" },
  };
  const host = await startSecurityHost({ ...options, tenantName: "alpha" });
  const other = await startSecurityHost({ ...options, tenantName: "beta" });
  const a = host.tenant;
  const b = other.tenant;

  // Seed distinct resources in each Tenant.
  for (const [url, tenant, agent, sessionId] of [
    [host.url, a, agentA, "sess-a"] as const,
    [other.url, b, agentB, "sess-b"] as const,
  ]) {
    expect(
      (
        await getJson(`${url}/v1/agents/${agent.manifest.id}`, {
          method: "PUT",
          headers: tenant.headers(),
          body: JSON.stringify({
            requestId: randomUUID(),
            implementationVersion: "dev",
            manifest: agent.manifest,
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await getJson(`${url}/v1/sessions/${sessionId}`, {
          method: "PUT",
          headers: tenant.headers(),
          body: JSON.stringify({
            requestId: randomUUID(),
            agentId: agent.manifest.id,
            ownerUserId: "user-1",
          }),
        })
      ).status,
    ).toBe(200);
    const vault = await getJson(`${url}/v1/tenant/vaults`, {
      method: "POST",
      headers: tenant.managementHeaders(),
      body: JSON.stringify({
        requestId: randomUUID(),
        idempotencyKey: `vault-${tenant.id}`,
        name: `Vault ${tenant.name}`,
        ownerUserId: "user-1",
      }),
    });
    expect(vault.status).toBe(200);
    (tenant as { vaultId?: string }).vaultId = (
      vault.body as { id: string }
    ).id;
  }

  const vaultA = (a as { vaultId?: string }).vaultId!;
  const vaultB = (b as { vaultId?: string }).vaultId!;

  const routes: Array<{
    label: string;
    init: RequestInit & { path: string };
    expectOpaque?: boolean;
    /** A credential this Host's Tenant does not know: `401 credential_invalid` (protocol 9). */
    expectRejected?: boolean;
    expectAScoped?: boolean;
  }> = [
    {
      label: "B token → 401",
      init: {
        path: "/v1/agents",
        headers: tenantHeaders(b.applicationKey),
      },
      expectRejected: true,
    },
    {
      label: "B management key → 401",
      init: {
        path: "/v1/tenant",
        headers: tenantHeaders(b.managementKey),
      },
      expectRejected: true,
    },
    {
      label: "A header + B token → 401",
      init: {
        path: "/v1/agents",
        headers: tenantHeaders(b.applicationKey, a.id),
      },
      expectRejected: true,
    },
    {
      label: "B header + A token → opaque (names the other Tenant)",
      init: {
        path: "/v1/agents",
        headers: tenantHeaders(a.applicationKey, b.id),
      },
      expectOpaque: true,
    },
    {
      label: "A auth + B session id → A-scoped miss",
      init: {
        path: "/v1/sessions/sess-b",
        headers: a.headers(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B agent id list still A-only",
      init: {
        path: "/v1/agents",
        headers: a.headers(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B vault id",
      init: {
        path: `/v1/tenant/vaults/${vaultB}`,
        headers: a.managementHeaders(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B tenant status path is still A",
      init: {
        path: "/v1/tenant",
        headers: a.managementHeaders(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B model route",
      init: {
        path: "/v1/tenant/model",
        headers: a.managementHeaders(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B sandbox route",
      init: {
        path: "/v1/tenant/sandbox",
        headers: a.managementHeaders(),
      },
      expectAScoped: true,
    },
    {
      label: "B header with A session path → opaque (names the other Tenant)",
      init: {
        path: "/v1/sessions/sess-a",
        headers: tenantHeaders(a.applicationKey, b.id),
      },
      expectOpaque: true,
    },
  ];

  for (const route of routes) {
    const result = await getJson(`${host.url}${route.init.path}`, {
      method: route.init.method ?? "GET",
      headers: route.init.headers,
      body: route.init.body,
    });
    if (route.expectOpaque) {
      expect(result.status, route.label).toBe(404);
      expect(result.body, route.label).toEqual(OPAQUE_NOT_FOUND);
      continue;
    }
    if (route.expectRejected) {
      expect(result.status, route.label).toBe(401);
      expect(result.body, route.label).toMatchObject({ code: "credential_invalid" });
      expect(result.raw, route.label).not.toContain(b.id);
      continue;
    }
    // A-scoped: either success that only reflects A, or a non-leak 404/403/400.
    expect([200, 400, 403, 404], route.label).toContain(result.status);
    if (result.status === 200) {
      const text = result.raw;
      expect(text, route.label).not.toContain(b.id);
      expect(text, route.label).not.toContain("sess-b");
      expect(text, route.label).not.toContain(vaultB);
      expect(text, route.label).not.toContain(agentB.manifest.id);
      if (route.init.path === "/v1/agents") {
        expect(text).toContain(agentA.manifest.id);
      }
      if (route.init.path === "/v1/tenant") {
        expect(text).toContain(a.id);
      }
    } else if (result.status === 404) {
      // Misses inside A must not reveal B's existence via a distinct body.
      expect(result.raw, route.label).not.toContain(b.id);
      expect(result.raw, route.label).not.toContain(vaultB);
    }
  }

  // Positive control: A can still read its own vault/session.
  const ownSession = await getJson(`${host.url}/v1/sessions/sess-a`, {
    headers: a.headers(),
  });
  expect(ownSession.status).toBe(200);
  const ownVault = await getJson(`${host.url}/v1/tenant/vaults/${vaultA}`, {
    headers: a.managementHeaders(),
  });
  expect(ownVault.status).toBe(200);

  // B still has its own session after the fuzz, on its own Host; A's key reaches nothing there.
  const bSession = await getJson(`${other.url}/v1/sessions/sess-b`, {
    headers: b.headers(),
  });
  expect(bSession.status).toBe(200);
  const crossed = await getJson(`${other.url}/v1/sessions/sess-b`, {
    headers: a.headers(),
  });
  expect(crossed.status).toBe(401);
  expect(crossed.body).toMatchObject({ code: "credential_invalid" });
});
