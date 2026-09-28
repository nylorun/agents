import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";

const TENANT = "tn_00000000000000000000000001";
const KEY = "a".repeat(64);

function health() {
  return Response.json({
    status: "ok",
    protocol: { ...HOST_PROTOCOL, features: [...HOST_PROTOCOL.features] },
  });
}

/** A client over a fake Runtime that records the headers of every request. */
function recording() {
  const seen: { path: string; headers: Headers }[] = [];
  let healthChecks = 0;
  const client = new AgentsClient({
    url: "http://127.0.0.1:8787",
    key: KEY,
    tenant: TENANT,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") {
        healthChecks += 1;
        return health();
      }
      seen.push({ path: url.pathname, headers: new Headers(init?.headers) });
      if (url.pathname.endsWith("/events"))
        return new Response(
          `id: c1\ndata: ${JSON.stringify({
            eventId: "e1",
            sessionId: "s1",
            tenantId: TENANT,
            turnId: "t1",
            cursor: "c1",
            createdAt: "2026-09-28T00:00:00.000Z",
            type: "turn.completed",
            payload: {},
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        );
      if (url.pathname.endsWith("/items"))
        return Response.json({ items: [], cursor: null });
      return Response.json({ sessions: [] });
    },
  });
  return { client, seen, checks: () => healthChecks };
}

describe("AgentsClient.as", () => {
  it("sends Nylorun-Subject and Nylorun-Scopes on JSON and SSE routes", async () => {
    const { client, seen } = recording();
    const ada = client.as("app:42", { scopes: ["sessions:own", "vaults:own"] });
    expect(ada.subject).toBe("app:42");
    await ada.listSessions();
    await ada.session("s1").history();
    const abort = new AbortController();
    for await (const event of ada.session("s1").observe({ signal: abort.signal })) {
      expect(event.type).toBe("turn.completed");
      abort.abort();
    }
    expect(seen.map((r) => r.path)).toEqual([
      "/v1/sessions",
      "/v1/sessions/s1/items",
      "/v1/sessions/s1/events",
    ]);
    for (const { headers } of seen) {
      expect(headers.get("nylorun-subject")).toBe("app:42");
      expect(headers.get("nylorun-scopes")).toBe("sessions:own vaults:own");
      expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    }
  });

  it("defaults to sessions:own and leaves the principal's own client unchanged", async () => {
    const { client, seen } = recording();
    await client.as("app:42").listSessions();
    await client.listSessions();
    expect(seen[0]!.headers.get("nylorun-scopes")).toBe("sessions:own");
    expect(seen[1]!.headers.get("nylorun-subject")).toBeNull();
    expect(seen[1]!.headers.get("nylorun-scopes")).toBeNull();
    expect(client.subject).toBeUndefined();
  });

  it("shares the Host compatibility check with the client it came from", async () => {
    const { client, checks } = recording();
    await client.listSessions();
    for (const subject of ["app:1", "app:2", "app:3"])
      await client.as(subject).listSessions();
    expect(checks()).toBe(1);
  });

  it("refuses invalid subjects, unknown scopes and acting twice", () => {
    const { client } = recording();
    expect(() => client.as("")).toThrow(TypeError);
    expect(() => client.as("host")).toThrow(/reserved/);
    expect(() => client.as("app:42", { scopes: [] })).toThrow(/required/);
    expect(() => client.as("app:42", { scopes: ["sessions:all" as never] })).toThrow(
      /Unknown scope/
    );
    expect(() => client.as("app:1").as("app:2")).toThrow(/already acts for app:1/);
  });
});
