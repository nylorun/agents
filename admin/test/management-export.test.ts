import { expect, it } from "vitest";
import { createManagementClient } from "../src/index.js";

it("drains the Tenant's model-call export and exposes resumable positions", async () => {
  const requests: { path: string; authorization: string | null }[] = [];
  const client = createManagementClient({
    url: "http://runtime/",
    key: "management-key",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname + url.search,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        calls: [],
        next: url.searchParams.has("after") ? "next" : "resume",
        caughtUp: url.searchParams.has("after"),
        asOf: "2026-01-01T00:00:00Z",
      });
    },
  });
  const positions: (string | null)[] = [];
  for await (const page of client.models.exportCalls()) positions.push(page.next);
  expect(positions).toEqual(["resume", "next"]);
  expect(requests).toEqual([
    { path: "/v1/tenant/calls/model?limit=200", authorization: "Bearer management-key" },
    {
      path: "/v1/tenant/calls/model?limit=200&after=resume",
      authorization: "Bearer management-key",
    },
  ]);
});

it("stops when a page does not advance its cursor", async () => {
  const client = createManagementClient({
    url: "http://runtime",
    key: "management-key",
    fetch: async () =>
      Response.json({ calls: [], next: "same", caughtUp: false, asOf: "2026-01-01T00:00:00Z" }),
  });
  const pages = client.models.exportCalls({ after: "same" })[Symbol.asyncIterator]();
  await pages.next();
  await expect(pages.next()).rejects.toThrow(/did not advance/);
});
