import { expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";

function runtime(features: readonly string[] = HOST_PROTOCOL.features) {
  const paths: string[] = [];
  const client = new AgentsClient({
    url: "http://runtime",
    key: "a".repeat(64),
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/health")
        return Response.json({
          status: "ok",
          service: "nylorun-runtime",
          protocol: { ...HOST_PROTOCOL, features },
        });
      paths.push(url.pathname + url.search);
      if (url.pathname.endsWith("/items"))
        return Response.json({
          items: [],
          cursor: null,
          ...(url.searchParams.has("limit") ? { tail: true } : {}),
        });
      return Response.json({
        [url.pathname.includes("sandboxes") ? "sandboxes" : "sessions"]: [],
        ...(url.searchParams.has("limit") ? { nextCursor: null } : {}),
      });
    },
  });
  return { client, paths };
}
it("opts into pages with SDK defaults while retaining legacy requests", async () => {
  const { client, paths } = runtime();
  await client.listSessions();
  await client.sessions.page();
  await client.sandboxes.list();
  await client.sandboxes.page({ labels: { env: "dev", team: "one" } });
  await client.session("s").history();
  await client.session("s").history({ limit: 50 });
  expect(paths).toEqual([
    "/v1/sessions",
    "/v1/sessions?limit=50",
    "/v1/sandboxes",
    "/v1/sandboxes?limit=50&label=env%3Ddev&label=team%3Done",
    "/v1/sessions/s/items",
    "/v1/sessions/s/items?limit=50",
  ]);
});
it("rejects unsupported optional reads before sending their requests", async () => {
  const { client, paths } = runtime(
    HOST_PROTOCOL.features.filter((f) => f !== "session-reads"),
  );
  await expect(client.sessions.page()).rejects.toThrow(/session-reads/);
  await expect(client.session("s").manifest()).rejects.toThrow(/session-reads/);
  await expect(client.session("s").usage()).rejects.toThrow(/session-reads/);
  await expect(client.session("s").modelCalls()).rejects.toThrow(/session-reads/);
  await expect(client.session("s").history({ limit: 50 })).rejects.toThrow(/session-reads/);
  await expect(client.sandboxes.page()).rejects.toThrow(/session-reads/);
  // The Tenant's ledger export is the Management API's (`@nylorun/admin`), not the SDK's.
  expect("calls" in client).toBe(false);
  expect(paths).toEqual([]);
});
