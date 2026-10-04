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
      if (url.pathname === "/v1/tenant/calls/model")
        return Response.json({
          calls: [],
          next: url.searchParams.has("after") ? "next" : "resume",
          caughtUp: url.searchParams.has("after"),
          asOf: "2026-01-01T00:00:00Z",
        });
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
it("drains export pages and exposes resumable positions", async () => {
  const { client, paths } = runtime();
  const positions: (string | null)[] = [];
  for await (const page of client.calls.exportModel()) positions.push(page.next);
  expect(positions).toEqual(["resume", "next"]);
  expect(paths).toEqual([
    "/v1/tenant/calls/model?limit=200",
    "/v1/tenant/calls/model?limit=200&after=resume",
  ]);
});
it("rejects unsupported optional reads before sending their requests", async () => {
  const { client, paths } = runtime(
    HOST_PROTOCOL.features.filter((f) => f !== "session-reads" && f !== "calls-export"),
  );
  await expect(client.sessions.page()).rejects.toThrow(/session-reads/);
  await expect(client.session("s").manifest()).rejects.toThrow(/session-reads/);
  await expect(client.session("s").usage()).rejects.toThrow(/session-reads/);
  await expect(client.session("s").modelCalls()).rejects.toThrow(/session-reads/);
  await expect(client.session("s").history({ limit: 50 })).rejects.toThrow(/session-reads/);
  await expect(client.sandboxes.page()).rejects.toThrow(/session-reads/);
  await expect(client.calls.exportModel()[Symbol.asyncIterator]().next()).rejects.toThrow(
    /calls-export/,
  );
  expect(paths).toEqual([]);
});
