import { expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";

const VIEW = {
  configured: true,
  source: "session",
  provider: "openai",
  model: "gpt-4o-mini",
  choice: { provider: "openai", model: "gpt-4o-mini" },
};

function runtime(features: readonly string[] = HOST_PROTOCOL.features) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const client = new AgentsClient({
    url: "http://runtime",
    key: "a".repeat(64),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health")
        return Response.json({
          status: "ok",
          service: "nylorun-runtime",
          protocol: { ...HOST_PROTOCOL, features },
        });
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json(VIEW);
    },
  });
  return { client, requests };
}

it("reads, chooses and clears a session's own model", async () => {
  const { client, requests } = runtime([...HOST_PROTOCOL.features, "session-model"]);
  const session = client.session("s 1");
  expect(await session.model()).toEqual(VIEW);
  expect(await session.setModel({ provider: "openai", model: "gpt-4o-mini" })).toEqual(VIEW);
  await session.clearModel();
  expect(requests).toEqual([
    { method: "GET", path: "/v1/sessions/s%201/model" },
    { method: "PUT", path: "/v1/sessions/s%201/model", body: { provider: "openai", model: "gpt-4o-mini" } },
    { method: "DELETE", path: "/v1/sessions/s%201/model" },
  ]);
});

it("refuses before sending when the Host lacks session-model", async () => {
  const { client, requests } = runtime(HOST_PROTOCOL.features.filter((feature) => feature !== "session-model"));
  await expect(client.session("s").model()).rejects.toThrow(/session-model/);
  await expect(client.session("s").setModel({ provider: "openai", model: "x" })).rejects.toThrow(/session-model/);
  await expect(client.session("s").clearModel()).rejects.toThrow(/session-model/);
  expect(requests).toEqual([]);
});
