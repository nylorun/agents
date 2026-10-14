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
