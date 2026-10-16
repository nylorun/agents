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
      if (url.pathname.endsWith("/trace"))
        return Response.json({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [] }] });
      if (url.pathname.endsWith("/items"))
        return Response.json({
          items: [],
          cursor: null,
          ...(url.searchParams.has("limit") ? { tail: true } : {}),
        });
      return Response.json({
        [url.pathname.startsWith("/v1/agents") ? "agents" : "sessions"]: [],
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
  await client.sessions.page({ agentId: "users/alice/triage", manifest: "triage", status: "waiting" });
  await client.agents.list();
  await client.agents.page({ labels: { env: "dev", team: "one" }, state: "failing" });
  await client.session("s").history();
  await client.session("s").history({ limit: 50 });
  expect(paths).toEqual([
    "/v1/sessions",
    "/v1/sessions?limit=50",
    "/v1/sessions?limit=50&agentId=users%2Falice%2Ftriage&manifest=triage&status=waiting",
    "/v1/agents",
    "/v1/agents?limit=50&label=env%3Ddev&label=team%3Done&state=failing",
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
  await expect(client.agents.page()).rejects.toThrow(/session-reads/);
  // The Tenant's ledger export is the Management API's (`@nylorun/admin`), not the SDK's.
  expect("calls" in client).toBe(false);
  expect(paths).toEqual([]);
});
it("reads a turn's trace (feature traces), and refuses it on a Runtime without the feature", async () => {
  const { client, paths } = runtime();
  expect(await client.session("s 1").trace("trn/1")).toEqual({
    resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [] }],
  });
  expect(paths).toEqual(["/v1/sessions/s%201/turns/trn%2F1/trace"]);
  const older = runtime(HOST_PROTOCOL.features.filter((f) => f !== "traces"));
  await expect(older.client.session("s").trace("t")).rejects.toThrow(/traces/);
  expect(older.paths).toEqual([]);
});
