import { expect, it } from "vitest";
import { createManagementClient } from "../src/index.js";

it("sets what a catalog model reads with PUT /v1/tenant/models/inputs (protocol 12)", async () => {
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const client = createManagementClient({
    url: "http://runtime",
    key: "management-key",
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, body });
      return Response.json({ provider: body.provider, model: body.model, inputs: ["text", "image", "pdf"] });
    },
  });
  const view = await client.models.setInputs({ provider: "anthropic", model: "claude", inputs: ["pdf"] });
  expect(view).toEqual({ provider: "anthropic", model: "claude", inputs: ["text", "image", "pdf"] });
  expect(requests).toEqual([
    {
      method: "PUT",
      path: "/v1/tenant/models/inputs",
      body: { provider: "anthropic", model: "claude", inputs: ["pdf"], requestId: expect.any(String) },
    },
  ]);
});

it("totals and caps the spend of the Agents made from one agent manifest (scope manifest, protocol 16)", async () => {
  const requests: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const client = createManagementClient({
    url: "http://runtime",
    key: "management-key",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
      });
      if (url.pathname === "/v1/tenant/usage")
        return Response.json({ scope: "manifest", id: "triage", period: "day", calls: 2, tokens: 30, costUsd: 0.01 });
      if (url.pathname === "/v1/tenant/reset") return Response.json({ ok: true });
      return Response.json({ budgets: [{ scope: "manifest", id: "triage", period: "month", limitUsd: 5 }] });
    },
  });
  await client.models.usage({ scope: "manifest", id: "triage", period: "day" });
  await client.models.budgets.put({ budgets: [{ scope: "manifest", id: "triage", period: "month", limitUsd: 5 }] });
  await client.tenant.reset({ scope: "agents", activeWork: "cancel" });
  expect(requests).toEqual([
    { method: "GET", path: "/v1/tenant/usage?scope=manifest&id=triage&period=day" },
    {
      method: "PUT",
      path: "/v1/tenant/budgets",
      body: { requestId: expect.any(String), budgets: [{ scope: "manifest", id: "triage", period: "month", limitUsd: 5 }] },
    },
    { method: "POST", path: "/v1/tenant/reset", body: { requestId: expect.any(String), scope: "agents", activeWork: "cancel" } },
  ]);
});
