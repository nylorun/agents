import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL, PROTOCOL_FEATURES } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";
import { createA2aHandler, type A2aHandlerOptions } from "../src/a2a/index.js";

const TENANT = "tn_00000000000000000000000001";
const KEY = "a".repeat(64);
const RUNTIME = "http://127.0.0.1:8787";

function health(features: readonly string[]) {
  return Response.json({
    status: "ok",
    service: "nylorun-runtime",
    protocol: { ...HOST_PROTOCOL, features: [...features] },
    hostId: "host_00000000000000000000000001",
  });
}

interface Sent {
  path: string;
  headers: Headers;
  body?: string;
}

/** A client whose Runtime answers `/health` and records every other request. */
function fakeRuntime(
  options: {
    features?: readonly string[];
    respond?: (url: URL) => Response | undefined;
  } = {}
) {
  const sent: Sent[] = [];
  const client = new AgentsClient({
    url: RUNTIME,
    key: KEY,
    tenant: TENANT,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return health(options.features ?? HOST_PROTOCOL.features);
      sent.push({
        path: url.pathname + url.search,
        headers: new Headers(init?.headers),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return (
        options.respond?.(url) ??
        Response.json({ jsonrpc: "2.0", id: 1, result: { task: { id: "t" } } })
      );
    },
  });
  return { client, sent };
}

const PARTNERS: Record<string, string | { subject: string; agents: string[] }> = {
  acme: "a2a:acme",
  limited: { subject: "a2a:limited", agents: ["support"] },
};

function handler(client: AgentsClient, extra: Partial<A2aHandlerOptions> = {}) {
  return createA2aHandler({
    basePath: "/a2a",
    agents: ["support", "billing"],
    client,
    subject: (request) => PARTNERS[request.headers.get("x-partner") ?? ""],
    ...extra,
  });
}

const call = (path: string, init: RequestInit & { partner?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.partner) headers.set("x-partner", init.partner);
  return new Request(`https://gw.example.com${path}`, {
    method: "POST",
    body: '{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"t"}}',
    ...init,
    headers,
  });
};

describe("createA2aHandler", () => {
  it("forwards the JSON-RPC body as the partner's subject, with sessions:own only", async () => {
    const { client, sent } = fakeRuntime();
    const response = await handler(client).fetch(
      call("/a2a/support", {
        partner: "acme",
        headers: {
          "A2A-Version": "1.0",
          "A2A-Extensions": "https://example.com/ext/v1",
          "Nylorun-Subject": "a2a:someone-else",
          "Nylorun-Scopes": "tenant:settings",
          "Nylorun-Tenant": "tn_other",
          authorization: "Bearer partner-secret",
        },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { task: { id: "t" } } });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request!.path).toBe("/v1/a2a/agents/support");
    expect(request!.body).toBe('{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"t"}}');
    expect(request!.headers.get("nylorun-subject")).toBe("a2a:acme");
    expect(request!.headers.get("nylorun-scopes")).toBe("sessions:own");
    expect(request!.headers.get("nylorun-tenant")).toBe(TENANT);
    expect(request!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request!.headers.get("a2a-version")).toBe("1.0");
    expect(request!.headers.get("a2a-extensions")).toBe("https://example.com/ext/v1");
  });

  it("sends A2A-Version from the query when there is no header, and none when neither", async () => {
    const { client, sent } = fakeRuntime();
    const a2a = handler(client);
    await a2a.fetch(call("/a2a/support?A2A-Version=1.0", { partner: "acme" }));
    await a2a.fetch(call("/a2a/support", { partner: "acme" }));
    expect(sent[0]!.headers.get("a2a-version")).toBe("1.0");
    expect(sent[1]!.headers.get("a2a-version")).toBeNull();
  });

  it("answers 401 without a partner and 404 for agents it does not serve", async () => {
    const { client, sent } = fakeRuntime();
    const a2a = handler(client);
    expect((await a2a.fetch(call("/a2a/support"))).status).toBe(401);
    expect((await a2a.fetch(call("/a2a/other", { partner: "acme" }))).status).toBe(404);
    expect((await a2a.fetch(call("/a2a/billing", { partner: "limited" }))).status).toBe(404);
    expect((await a2a.fetch(call("/elsewhere/support", { partner: "acme" }))).status).toBe(404);
    expect(sent).toHaveLength(0);
    const get = await a2a.fetch(call("/a2a/support", { partner: "acme", method: "GET", body: null }));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("maps Runtime refusals without passing their bodies on", async () => {
    const status = (code: number) =>
      fakeRuntime({
        respond: () =>
          Response.json(
            { status: "rejected", code: "x", message: "internal detail" },
            { status: code, headers: code === 429 ? { "retry-after": "7" } : {} }
          ),
      }).client;
    const answer = async (code: number) => {
      const response = await handler(status(code)).fetch(call("/a2a/support", { partner: "acme" }));
      return { status: response.status, retry: response.headers.get("retry-after"), text: await response.text() };
    };
    expect((await answer(404)).status).toBe(404);
    expect(await answer(429)).toMatchObject({ status: 429, retry: "7" });
    expect((await answer(503)).status).toBe(503);
    const failed = await answer(400);
    expect(failed.status).toBe(502);
    expect(failed.text).not.toContain("internal detail");
  });

  it("answers 502 when the Runtime does not serve A2A", async () => {
    const { client, sent } = fakeRuntime({
      features: [...PROTOCOL_FEATURES, "subject-headers"],
    });
    const response = await handler(client).fetch(call("/a2a/support", { partner: "acme" }));
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("runtime_feature_missing");
    expect(sent).toHaveLength(0);
  });

  it("serves the card with its URL, provider and security schemes, without a partner", async () => {
    const { client, sent } = fakeRuntime({
      respond: (url) =>
        url.pathname === "/v1/a2a/agents/support/card"
          ? Response.json({
              name: "Support",
              description: "Answers questions.",
              supportedInterfaces: [],
              version: "dev",
              capabilities: { streaming: false },
              defaultInputModes: ["text/plain"],
              defaultOutputModes: ["text/plain"],
              skills: [],
            })
          : undefined,
    });
    const a2a = handler(client, {
      publicUrl: "https://api.example.com/a2a/",
      card: {
        provider: { organization: "Example Inc.", url: "https://example.com" },
        securitySchemes: { key: { apiKeySecurityScheme: { location: "header", name: "X-Partner" } } },
        securityRequirements: [{ schemes: { key: { list: [] } } }],
      },
    });
    const response = await a2a.fetch(
      new Request("https://internal:8080/a2a/support/.well-known/agent-card.json")
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "Support",
      supportedInterfaces: [
        { url: "https://api.example.com/a2a/support", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
      provider: { organization: "Example Inc.", url: "https://example.com" },
      securitySchemes: { key: { apiKeySecurityScheme: { location: "header", name: "X-Partner" } } },
      securityRequirements: [{ schemes: { key: { list: [] } } }],
    });
    // The card is read with the application key alone.
    expect(sent[0]!.headers.get("nylorun-subject")).toBeNull();
  });

  it("uses the request's origin for the card URL by default", async () => {
    const { client } = fakeRuntime({ respond: () => Response.json({ name: "Support" }) });
    const response = await handler(client).fetch(
      new Request("http://127.0.0.1:3000/a2a/support/.well-known/agent-card.json")
    );
    expect((await response.json()).supportedInterfaces[0].url).toBe(
      "http://127.0.0.1:3000/a2a/support"
    );
  });

  it("refuses a publicUrl that is not http(s)", () => {
    const { client } = fakeRuntime();
    expect(() => handler(client, { publicUrl: "ftp://x" })).toThrow(TypeError);
  });
});
