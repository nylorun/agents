/**
 * The scope table: every Tenant route, called acting for a subject without the scope it needs
 * (403 `scope_required`, before anything is read or written) and with it (never 403).
 * Operator and executor routes are closed to subjects whatever their scopes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubjectScope } from "@nylorun/core/contracts";
import { Agent } from "@nylorun/core/define";
import { findTenantRoute } from "../../src/api/http/app.js";
import {
  ALL_SCOPES,
  createVault,
  startSubjectTenant,
  type SubjectTenant,
} from "./subjects.js";

let tenant: SubjectTenant;
let vaultId: string;
let credentialId: string;
beforeAll(async () => {
  tenant = await startSubjectTenant();
  const owner = { subject: "app:owner", scopes: ["sessions:own", "vaults:own"] } as const;
  await tenant.call("PUT", "/v1/sessions/owned", {
    as: owner,
    body: { requestId: "owned", agentId: "bot", ownerUserId: "app:owner" },
  });
  ({ vaultId, credentialId } = await createVault(tenant, owner));
});
afterAll(async () => {
  await tenant.close();
});

interface Route {
  method: string;
  path: string;
  /** Any one of these; `never` when no scope grants the route. */
  needs: readonly SubjectScope[] | "never";
  body?: (subject: string) => unknown;
}

const routes = (): Route[] => [
  { method: "GET", path: "/v1/agents", needs: ["agents:read", "agents:write"] },
  {
    method: "PUT",
    path: "/v1/agents/drafted",
    needs: ["agents:write"],
    body: () => ({
      requestId: "drafted",
      manifest: Agent({ id: "drafted", name: "Drafted" }).build().manifest,
      implementationVersion: "dev",
    }),
  },
  { method: "GET", path: "/v1/sessions", needs: ["sessions:own"] },
  {
    method: "PUT",
    path: "/v1/sessions/fresh",
    needs: ["sessions:own"],
    body: (subject) => ({ requestId: "fresh", agentId: "bot", ownerUserId: subject }),
  },
  { method: "GET", path: "/v1/sessions/owned", needs: ["sessions:own"] },
  { method: "GET", path: "/v1/sessions/owned/items", needs: ["sessions:own"] },
  { method: "GET", path: "/v1/sessions/owned/events", needs: ["sessions:own"] },
  {
    method: "POST",
    path: "/v1/sessions/owned/commands",
    needs: ["sessions:own"],
    body: () => ({ requestId: "c", idempotencyKey: "c", type: "cancel" }),
  },
  {
    method: "POST",
    path: "/v1/vaults",
    needs: ["vaults:own"],
    body: (subject) => ({
      requestId: "v",
      idempotencyKey: `v-${subject}`,
      name: "v",
      ownerUserId: subject,
    }),
  },
  { method: "GET", path: "/v1/vaults", needs: ["vaults:own"] },
  { method: "GET", path: `/v1/vaults/${vaultId}`, needs: ["vaults:own"] },
  { method: "DELETE", path: `/v1/vaults/${vaultId}`, needs: ["vaults:own"] },
  { method: "GET", path: `/v1/vaults/${vaultId}/credentials`, needs: ["vaults:own"] },
  { method: "POST", path: `/v1/vaults/${vaultId}/credentials`, needs: ["vaults:own"] },
  {
    method: "GET",
    path: `/v1/vaults/${vaultId}/credentials/${credentialId}`,
    needs: ["vaults:own"],
  },
  {
    method: "POST",
    path: `/v1/vaults/${vaultId}/credentials/${credentialId}`,
    needs: ["vaults:own"],
  },
  {
    method: "DELETE",
    path: `/v1/vaults/${vaultId}/credentials/${credentialId}`,
    needs: ["vaults:own"],
  },
  { method: "GET", path: "/v1/tenant", needs: ["tenant:settings"] },
  { method: "GET", path: "/v1/tenant/models", needs: ["tenant:settings", "agents:write"] },
  { method: "GET", path: "/v1/tenant/providers", needs: ["tenant:settings", "agents:write"] },
  { method: "GET", path: "/v1/tenant/sandbox", needs: ["tenant:settings"] },
  { method: "GET", path: "/v1/tenant/model", needs: ["tenant:settings"] },
  { method: "PUT", path: "/v1/tenant/model", needs: ["tenant:settings"], body: () => ({}) },
  {
    method: "PUT",
    path: "/v1/tenant/model/selection",
    needs: ["tenant:settings"],
    body: () => ({}),
  },
  {
    method: "POST",
    path: "/v1/tenant/reset",
    needs: "never",
    body: () => ({ requestId: "r", scope: "all", activeWork: "cancel" }),
  },
  { method: "PUT", path: "/v1/tenant/config/seed", needs: "never", body: () => ({ requestId: "s" }) },
  { method: "GET", path: "/v1/executors", needs: "never" },
  { method: "PUT", path: "/v1/executors", needs: "never", body: () => ({ executors: [] }) },
  { method: "DELETE", path: "/v1/executors/bot", needs: "never" },
  { method: "GET", path: "/v1/executors/connect", needs: "never" },
  { method: "GET", path: "/v1/endpoints", needs: "never" },
  { method: "PUT", path: "/v1/endpoints", needs: "never", body: () => ({ endpoints: [] }) },
  { method: "DELETE", path: "/v1/endpoints/bot", needs: "never" },
  { method: "POST", path: "/v1/endpoints/bot/ping", needs: "never" },
  { method: "GET", path: "/v1/actions", needs: "never" },
  { method: "POST", path: "/v1/actions/a1/claim", needs: "never" },
  { method: "POST", path: "/v1/actions/a1/sandbox/read", needs: "never" },
  { method: "POST", path: "/v1/sessions/owned/sandbox/read", needs: "never", body: () => ({}) },
];

/** The subject scopes a route declares (`api/http/define.ts`), if it is a route. */
function declaredScopes(method: string, path: readonly string[]) {
  return findTenantRoute(method, path)?.scopes;
}

describe("route declarations", () => {
  it("match the scope table for every route", () => {
    for (const route of routes()) {
      const path = new URL(route.path, "http://runtime").pathname.split("/").filter(Boolean);
      expect(declaredScopes(route.method, path), `${route.method} ${route.path}`).toEqual(
        route.needs
      );
    }
  });

  it("declare no other routes", () => {
    for (const [method, path] of [
      ["GET", "v1/nothing"],
      ["DELETE", "v1/agents/bot"],
      ["POST", "v1/sessions"],
      ["GET", "v1/sessions/s/items/extra"],
      ["PATCH", "v1/vaults/v"],
      ["GET", "v1/tenant/unknown"],
      ["GET", "health"],
    ] as const)
      expect(declaredScopes(method, path.split("/")), `${method} ${path}`).toBeUndefined();
  });
});

it("refuses a route without its scope before reading the request", async () => {
  for (const route of routes()) {
    const scopes =
      route.needs === "never"
        ? ALL_SCOPES
        : ALL_SCOPES.filter((scope) => !route.needs.includes(scope));
    const as = { subject: "app:probe", scopes };
    // No body: the refusal comes from the route alone.
    const reply = await tenant.call(route.method, route.path, { as });
    expect(reply.status, `${route.method} ${route.path}`).toBe(403);
    expect(reply.body.code).toBe("scope_required");
    expect(reply.body.details.scopes).toEqual(route.needs === "never" ? [] : route.needs);
  }
  // Nothing the refused writes named exists, and the reset did not run.
  const agents = await tenant.call("GET", "/v1/agents");
  expect(agents.body.agents.map((a: { agentId: string }) => a.agentId)).toEqual(["bot"]);
  expect((await tenant.call("GET", "/v1/sessions/fresh")).status).toBe(404);
  expect((await tenant.call("GET", "/v1/sessions/owned")).status).toBe(200);
  expect(
    (await tenant.call("GET", "/v1/vaults?ownerUserId=app:probe")).body.vaults
  ).toEqual([]);
});

it("passes a route with any one of its scopes", async () => {
  for (const route of routes()) {
    if (route.needs === "never") continue;
    // Skip the one route that would stream until closed; its owner check is in owner-isolation.
    if (route.path.endsWith("/events")) continue;
    for (const scope of route.needs) {
      const as = { subject: "app:probe", scopes: [scope] };
      const reply = await tenant.call(route.method, route.path, {
        as,
        ...(route.body ? { body: route.body(as.subject) } : {}),
      });
      expect(reply.status, `${route.method} ${route.path} with ${scope}`).not.toBe(403);
    }
  }
});

it("answers a subject on a route the table does not know with 404", async () => {
  const reply = await tenant.call("GET", "/v1/nothing", {
    as: { subject: "app:probe", scopes: ALL_SCOPES },
  });
  expect(reply.status).toBe(404);
});
