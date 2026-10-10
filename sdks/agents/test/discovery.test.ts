import { expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/core/compatibility";
import { createClient } from "../src/client.js";


it("shares authenticated, abortable discovery for Studio and application clients", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const controller = new AbortController();
  const client = createClient({
    url: "http://localhost:8787",
    key: "test-key",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/health"))
        return Response.json({
          status: "ok",
          service: "nylorun-runtime",
          version: "0.9.0-beta",
          protocol: { ...HOST_PROTOCOL },
          coreVersion: "0.4.0-beta",
          hostId: "host_00000000000000000000000001",
          pid: 1,
        });
      return Response.json(
        String(url).includes("/agents") ? { agents: [] } : { sessions: [] },
      );
    },
  });
  expect(await client.listAgents({ signal: controller.signal })).toEqual({
    agents: [],
  });
  expect(
    await client.listSessions({ agentId: "a/b", signal: controller.signal }),
  ).toEqual({ sessions: [] });
  expect(calls.map((c) => c.url)).toEqual([
    "http://localhost:8787/health",
    "http://localhost:8787/v1/agents",
    "http://localhost:8787/v1/sessions?agentId=a%2Fb",
  ]);
  for (const call of calls.slice(1)) {
    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get(TENANT_HEADER)).toBeNull();
    expect(headers.get(PROTOCOL_HEADER)).toBe(String(PROTOCOL_VERSION));
    expect(call.init?.signal).toBe(controller.signal);
  }
});
