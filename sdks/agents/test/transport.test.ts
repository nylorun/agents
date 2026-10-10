import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/core/compatibility";
import {
  IncompatibleRuntimeError,
  RuntimeError,
  Transport,
} from "../src/http.js";
import { createClient } from "../src/client.js";

const TENANT = "tn_00000000000000000000000001";

function healthOk(overrides: Record<string, unknown> = {}) {
  return Response.json({
    status: "ok",
    service: "nylorun-runtime",
    version: "0.9.0-beta",
    protocol: { ...HOST_PROTOCOL },
    coreVersion: "0.4.0-beta",
    hostId: "host_00000000000000000000000001",
    pid: 1,
    ...overrides,
  });
}

afterEach(() => {
  delete process.env.NYLORUN_TENANT;
  delete process.env.NYLORUN_RUNTIME_URL;
  delete process.env.NYLORUN_SERVER_KEY;
});

describe("Transport destination", () => {
  it("needs a URL and a key, and names no Tenant (protocol 5)", () => {
    process.env.NYLORUN_TENANT = TENANT;
    const transport = new Transport({ url: "http://127.0.0.1:8787", key: "k" });
    expect(transport.url).toBe("http://127.0.0.1:8787");
    expect("tenant" in transport).toBe(false);
    expect(() => new Transport({ url: "http://127.0.0.1:8787" })).toThrow(
      "Set Runtime url and server key",
    );
  });
});

describe("Transport headers and compatibility", () => {
  it("fetches /health once, then sends Protocol and no Tenant on authenticated requests", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const transport = new Transport({
      url: "http://127.0.0.1:8787",
      key: "secret",
      fetch: async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        if (String(url).endsWith("/health")) return healthOk();
        return Response.json({ ok: true });
      },
    });
    await transport.json("/v1/agents");
    await transport.json("/v1/sessions");
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:8787/health",
      "http://127.0.0.1:8787/v1/agents",
      "http://127.0.0.1:8787/v1/sessions",
    ]);
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    for (const call of calls.slice(1)) {
      expect(call.headers.get("authorization")).toBe("Bearer secret");
      expect(call.headers.get(TENANT_HEADER)).toBeNull();
      expect(call.headers.get(PROTOCOL_HEADER)).toBe(String(PROTOCOL_VERSION));
    }
  });

  it("never takes a Tenant header from a request body or query", async () => {
    const seen: Headers[] = [];
    const transport = new Transport({
      url: "http://127.0.0.1:8787",
      key: "secret",
      fetch: async (url, init) => {
        seen.push(new Headers(init?.headers));
        if (String(url).endsWith("/health")) return healthOk();
        return Response.json({});
      },
    });
    await transport.json("/v1/sessions?tenant=from-query", "POST", {
      tenant: "from-body",
      requestId: "r1",
    });
    expect(seen[1]!.get(TENANT_HEADER)).toBeNull();
  });

  it("throws IncompatibleRuntimeError before the authenticated request when features are missing", async () => {
    const calls: string[] = [];
    const transport = new Transport({
      url: "http://127.0.0.1:8787",
      key: "secret",
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/health"))
          return healthOk({ protocol: { min: 2, max: 2, features: [] } });
        return Response.json({});
      },
    });
    await expect(transport.json("/v1/agents")).rejects.toBeInstanceOf(
      IncompatibleRuntimeError,
    );
    expect(calls).toEqual(["http://127.0.0.1:8787/health"]);
  });

  it("throws IncompatibleRuntimeError when the Host protocol range excludes the client", async () => {
    const transport = new Transport({
      url: "http://127.0.0.1:8787",
      key: "secret",
      fetch: async (url) => {
        if (String(url).endsWith("/health"))
          return healthOk({
            protocol: { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1, features: [...PROTOCOL_FEATURES] },
          });
        return Response.json({});
      },
    });
    const error = await transport.json("/v1/agents").catch((e) => e);
    expect(error).toBeInstanceOf(IncompatibleRuntimeError);
    expect(error.compatibility.reason).toBe("version");
    expect(error.remedy).toMatch(/nylorun runtime restart|npm i/);
  });

  it("clears the compatibility cache on 426 and rechecks once", async () => {
    let health = 0;
    let agents = 0;
    const transport = new Transport({
      url: "http://127.0.0.1:8787",
      key: "secret",
      fetch: async (url) => {
        if (String(url).endsWith("/health")) {
          health += 1;
          return healthOk(
            health === 1
              ? {}
              : {
                  protocol: {
                    min: 11,
                    max: 11,
                    features: [...PROTOCOL_FEATURES],
                  },
                },
          );
        }
        agents += 1;
        if (agents === 1) {
          return new Response(
            JSON.stringify({
              status: "rejected",
              code: "protocol_unsupported",
              protocol: { min: 11, max: 11, features: [...PROTOCOL_FEATURES] },
            }),
            { status: 426, headers: { "content-type": "application/json" } },
          );
        }
        return Response.json({ agents: [] });
      },
    });
    await expect(transport.json("/v1/agents")).rejects.toBeInstanceOf(
      IncompatibleRuntimeError,
    );
    expect(health).toBe(2);
    expect(agents).toBe(1);
  });

  it("retries the authenticated request once when a 426 recheck still reports compatible", async () => {
    let health = 0;
    let agents = 0;
    const transport = new Transport({
      url: "http://127.0.0.1:8787",
      key: "secret",
      fetch: async (url) => {
        if (String(url).endsWith("/health")) {
          health += 1;
          return healthOk();
        }
        agents += 1;
        if (agents === 1) {
          return new Response(
            JSON.stringify({
              status: "rejected",
              code: "protocol_unsupported",
              protocol: { ...HOST_PROTOCOL },
            }),
            { status: 426, headers: { "content-type": "application/json" } },
          );
        }
        return Response.json({ agents: [] });
      },
    });
    await expect(transport.json("/v1/agents")).resolves.toEqual({
      agents: [],
    });
    expect(health).toBe(2);
    expect(agents).toBe(2);
  });

  it("surfaces non-426 RuntimeError without clearing the cache", async () => {
    let health = 0;
    const transport = new Transport({
      url: "http://127.0.0.1:8787",
      key: "secret",
      fetch: async (url) => {
        if (String(url).endsWith("/health")) {
          health += 1;
          return healthOk();
        }
        return new Response(JSON.stringify({ message: "boom" }), {
          status: 500,
        });
      },
    });
    await expect(transport.json("/v1/agents")).rejects.toBeInstanceOf(
      RuntimeError,
    );
    await expect(transport.json("/v1/agents")).rejects.toBeInstanceOf(
      RuntimeError,
    );
    expect(health).toBe(1);
  });
});

describe("createClient({ url, key })", () => {
  it("accepts the public signature and wires Transport", async () => {
    const client = createClient({
      url: "http://127.0.0.1:8787",
      key: "k",
      fetch: async (url) => {
        if (String(url).endsWith("/health")) return healthOk();
        return Response.json({ agents: [] });
      },
    });
    await expect(client.listAgents()).resolves.toEqual({ agents: [] });
  });
});
