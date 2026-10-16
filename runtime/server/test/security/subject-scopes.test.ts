/**
 * The scope table: every Tenant route, called acting for a subject without the scope it needs
 * (403 `scope_required`, before anything is read or written) and with it (never 403).
 * Operator routes and Action callbacks are closed to subjects whatever their scopes; the
 * Management API (`/v1/tenant/*`, protocol 8) turns the application key away first
 * (`key_role_mismatch`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubjectScope } from "@nylorun/core/contracts";
import { Agent } from "@nylorun/core/define";
import { manifestOf } from "../support/agents.js";
import { findTenantRoute } from "../../src/api/http/app.js";
import {
  ALL_SCOPES,
  createEnvironment,
  startSubjectTenant,
  type SubjectTenant,
} from "./subjects.js";

let tenant: SubjectTenant;
let agentId: string;
let secretName: string;
beforeAll(async () => {
  tenant = await startSubjectTenant();
  const owner = { subject: "app:owner", scopes: ["sessions:own"] } as const;
  await tenant.call("PUT", "/v1/sessions/owned", {
    as: owner,
    body: { requestId: "owned", agent: "bot", ownerUserId: "app:owner" },
  });
  ({ environmentId: agentId, secretName } = await createEnvironment(tenant, owner));
  await createEnvironment(tenant, owner, { id: "doomed" });
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

/** The Management API's routes take no application key, with or without a subject. */
const isManagement = (route: Route) => route.path.startsWith("/v1/tenant");

const MANIFEST_READ: readonly SubjectScope[] = ["agents:read", "agents:write", "agent-manifests:write"];
const AGENT_READ: readonly SubjectScope[] = ["sessions:own", "agents:read", "agents:write"];

const routes = (): Route[] => [
  { method: "GET", path: "/v1/agent-manifests", needs: MANIFEST_READ },
  {
    method: "PUT",
    path: "/v1/agent-manifests/drafted",
    needs: ["agent-manifests:write"],
    body: () => manifestOf(Agent({ id: "drafted", name: "Drafted" }).build()),
  },
  { method: "GET", path: "/v1/agent-manifests/bot", needs: MANIFEST_READ },
  { method: "GET", path: "/v1/agent-manifests/bot/versions", needs: MANIFEST_READ },
  { method: "GET", path: "/v1/agent-manifests/bot/versions/1", needs: MANIFEST_READ },
  { method: "DELETE", path: "/v1/agent-manifests/drafted", needs: ["agent-manifests:write"] },
  { method: "GET", path: "/v1/sessions", needs: ["sessions:own"] },
  {
    method: "PUT",
    path: "/v1/sessions/fresh",
    needs: ["sessions:own"],
    body: (subject) => ({ requestId: "fresh", agent: "bot", ownerUserId: subject }),
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
  { method: "GET", path: "/v1/agents", needs: AGENT_READ },
  {
    method: "PUT",
    path: "/v1/agents/probe-agent",
    needs: ["agents:write"],
    body: () => ({ requestId: "probe-agent", manifest: "bot" }),
  },
  { method: "GET", path: `/v1/agents/${agentId}`, needs: AGENT_READ },
  { method: "GET", path: `/v1/agents/${agentId}/events`, needs: AGENT_READ },
  { method: "GET", path: `/v1/agents/${agentId}/versions`, needs: AGENT_READ },
  { method: "GET", path: `/v1/agents/${agentId}/secrets`, needs: AGENT_READ },
  { method: "GET", path: `/v1/agents/${agentId}/secrets/${secretName}`, needs: AGENT_READ },
  {
    method: "PUT",
    path: `/v1/agents/${agentId}/secrets/probe`,
    needs: ["agents:write"],
    body: () => ({
      requestId: "probe-secret",
      type: "bearer",
      url: "https://probe.example.com/tools",
      value: "probe-token",
    }),
  },
  { method: "DELETE", path: `/v1/agents/${agentId}/secrets/probe`, needs: ["agents:write"] },
  { method: "POST", path: `/v1/agents/${agentId}/stop`, needs: ["agents:write"] },
  { method: "POST", path: `/v1/agents/${agentId}/reset`, needs: ["agents:write"] },
  { method: "POST", path: `/v1/agents/${agentId}/snapshot`, needs: ["agents:write"], body: () => ({}) },
  {
    method: "POST",
    path: `/v1/agents/${agentId}/fork`,
    needs: ["agents:write"],
    body: () => ({ id: "forked", dryRun: true }),
  },
  { method: "DELETE", path: "/v1/agents/doomed", needs: ["agents:write"] },
  {
    method: "POST",
    path: "/v1/tenant/credential-coverage",
    needs: "never",
    body: () => ({ agentId }),
  },
  {
    method: "POST",
    path: "/v1/tenant/mcp/preview",
    needs: "never",
    body: () => ({ url: "https://mcp.example.com/tools", agentId }),
  },
  // `tenant:settings` is retired (protocol 8): no scope reaches the Tenant's settings.
  { method: "GET", path: "/v1/tenant", needs: "never" },
  { method: "GET", path: "/v1/tenant/models", needs: "never" },
  { method: "PUT", path: "/v1/tenant/models/inputs", needs: "never", body: () => ({}) },
  { method: "GET", path: "/v1/tenant/providers", needs: "never" },
  { method: "GET", path: "/v1/tenant/sandbox", needs: "never" },
  { method: "GET", path: "/v1/tenant/model", needs: "never" },
  { method: "PUT", path: "/v1/tenant/model", needs: "never", body: () => ({}) },
  {
    method: "PUT",
    path: "/v1/tenant/model/selection",
    needs: "never",
    body: () => ({}),
  },
  {
    method: "POST",
    path: "/v1/tenant/reset",
    needs: "never",
    body: () => ({ requestId: "r", scope: "all", activeWork: "cancel" }),
  },
  { method: "PUT", path: "/v1/tenant/config/seed", needs: "never", body: () => ({ requestId: "s" }) },
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
      ["PATCH", "v1/agents/bot"],
      ["POST", "v1/sessions"],
      ["GET", "v1/sessions/s/items/extra"],
      // Environments are Agents, made from agent manifests (protocol 16).
      ["GET", "v1/environments"],
      ["PUT", "v1/environments/e"],
      ["GET", "v1/environment-manifests"],
      ["PUT", "v1/environment-manifests/m"],
      // The vault and sandbox paths are gone (protocol 11).
      ["GET", "v1/tenant/vaults"],
      ["POST", "v1/tenant/vaults"],
      ["GET", "v1/tenant/vaults/v/credentials"],
      ["GET", "v1/sandboxes"],
      ["PUT", "v1/sandboxes/s"],
      // The old vault and signing-key paths are gone (protocol 8).
      ["GET", "v1/vaults"],
      ["GET", "v1/access/signing-keys"],
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
    if (isManagement(route)) {
      expect(reply.body.code, `${route.method} ${route.path}`).toBe("key_role_mismatch");
      continue;
    }
    expect(reply.body.code).toBe("scope_required");
    expect(reply.body.details.scopes).toEqual(route.needs === "never" ? [] : route.needs);
  }
  // Nothing the refused writes named exists, and the reset did not run.
  const manifests = await tenant.call("GET", "/v1/agent-manifests");
  expect(manifests.body.manifests.map((m: { name: string }) => m.name)).toEqual(["bot"]);
  expect((await tenant.call("GET", "/v1/sessions/fresh")).status).toBe(404);
  expect((await tenant.call("GET", "/v1/sessions/owned")).status).toBe(200);
  expect((await tenant.call("GET", "/v1/agents/probe-agent")).status).toBe(404);
  expect((await tenant.call("GET", "/v1/agents/doomed")).status).toBe(200);
  expect(
    (await tenant.call("GET", `/v1/agents/${agentId}/secrets`)).body.secrets.map(
      (secret: { name: string }) => secret.name
    )
  ).toEqual([secretName]);
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

it("refuses the old scopes sandboxes:write and environments:write with a 400 naming agents:write", async () => {
  for (const scopes of [
    "sandboxes:write",
    "sessions:own sandboxes:write",
    "environments:write",
    "agents:read environments:write",
  ]) {
    const reply = await tenant.call("GET", "/v1/agents", {
      as: { subject: "app:probe", scopes },
    });
    expect(reply.status, scopes).toBe(400);
    expect(reply.text, scopes).toContain("agents:write");
  }
  // The new name passes.
  const renamed = await tenant.call("GET", "/v1/agents", {
    as: { subject: "app:probe", scopes: "agents:write" },
  });
  expect(renamed.status).toBe(200);
});
