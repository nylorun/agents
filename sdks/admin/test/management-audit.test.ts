import { expect, it } from "vitest";
import { createManagementClient } from "../src/index.js";

it("reads a page of the Tenant's audit with GET /v1/tenant/audit (ADR-159)", async () => {
  const requests: string[] = [];
  const page = { events: [], nextCursor: null };
  const client = createManagementClient({
    url: "http://runtime",
    key: "management-key",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      expect(init?.body).toBeUndefined();
      return Response.json(page);
    },
  });
  expect(await client.tenant.audit()).toEqual(page);
  await client.tenant.audit({
    since: "2026-11-01T00:00:00.000Z",
    until: "2026-11-20T00:00:00.000Z",
    types: ["key.created", "credential.used"],
    cursor: "abc",
    limit: 20,
  });
  // No types is no filter.
  await client.tenant.audit({ types: [] });
  expect(requests).toEqual([
    "GET /v1/tenant/audit",
    "GET /v1/tenant/audit?since=2026-11-01T00%3A00%3A00.000Z&until=2026-11-20T00%3A00%3A00.000Z&types=key.created%2Ccredential.used&cursor=abc&limit=20",
    "GET /v1/tenant/audit",
  ]);
});
