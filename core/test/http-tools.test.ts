/**
 * R2 M3: HTTP tools in the manifest. A tool is an agent or an HTTP request (never both), `fn`
 * and `command` are reserved, and `approval` is static: on an HTTP tool, or on a remote MCP
 * server for all its tools.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, http, httpToolOf, httpToolRequest, isToolError } from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { HarnessError } from "../src/errors.js";
import { hashManifest } from "../src/utils/hash.js";

const input = { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] };

function manifest(tool: Record<string, unknown>, mcpServers?: Record<string, unknown>) {
  return {
    manifestSchemaVersion: 7 as const,
    id: "orders",
    tools: [{ name: "refund", inputSchema: input, ...tool }],
    ...(mcpServers ? { mcpServers } : {}),
  };
}

const issues = (value: unknown) => {
  const parsed = AgentManifestSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("the manifest's HTTP tools", () => {
  it("accepts an HTTP target with every field, and approval", () => {
    expect(
      issues(
        manifest({
          http: {
            url: "https://billing.example.com/refunds?v=2",
            method: "PUT",
            credential: "billing",
            timeoutMs: 300_000,
          },
          approval: "always",
        }),
      ),
    ).toEqual([]);
    expect(issues(manifest({ http: { url: "http://localhost:4000/refund" }, approval: "never" }))).toEqual([]);
  });

  it("refuses a URL that is not absolute http(s), or carries credentials or a fragment", () => {
    for (const url of ["/refunds", "ftp://example.com/x", "https://user:pw@example.com/x", "https://example.com/x#a"])
      expect(issues(manifest({ http: { url } }))).toHaveLength(1);
  });

  it("refuses an unknown method, a bad timeout, an empty credential and unknown fields", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
      expect(issues(manifest({ http: { url: "https://example.com/x", method } }))).toEqual([]);
    expect(issues(manifest({ http: { url: "https://example.com/x", method: "HEAD" } }))).toHaveLength(1);
    expect(issues(manifest({ http: { url: "https://example.com/x", method: "get" } }))).toHaveLength(1);
    for (const timeoutMs of [0, -1, 1.5, 300_001])
      expect(issues(manifest({ http: { url: "https://example.com/x", timeoutMs } }))).toHaveLength(1);
    expect(issues(manifest({ http: { url: "https://example.com/x", credential: "" } }))).toHaveLength(1);
    expect(issues(manifest({ http: { url: "https://example.com/x", headers: {} } }))).toHaveLength(1);
  });

  it("refuses a tool that is both an agent and an HTTP request", () => {
    const agent = { manifestSchemaVersion: 7, id: "helper" };
    expect(issues(manifest({ http: { url: "https://example.com/x" }, agent }))).toContain(
      "Tool 'refund' is an agent or an HTTP request, not both",
    );
  });

  it("reserves fn and command for later kinds of tool", () => {
    expect(issues(manifest({ fn: { name: "refund" } }))).toEqual(["Functions are not available yet"]);
    expect(issues(manifest({ command: ["node", "refund.js"] }))).toEqual(["Functions are not available yet"]);
  });

  it("takes approval only on an HTTP tool, as never or always", () => {
    expect(issues(manifest({ approval: "always" }))).toEqual(["Tool 'refund' takes approval only as an HTTP tool"]);
    expect(issues(manifest({ http: { url: "https://example.com/x" }, approval: "sometimes" }))).toHaveLength(1);
  });

  it("takes approval on a remote MCP server, not a stdio one", () => {
    const remote = { name: "github", type: "streamable-http", url: "https://mcp.example.com/github" };
    expect(issues(manifest({ http: { url: "https://example.com/x" } }, { github: { ...remote, approval: "always" } }))).toEqual([]);
    expect(
      issues(manifest({ http: { url: "https://example.com/x" } }, { docs: { name: "docs", type: "sse", url: remote.url, approval: "never" } })),
    ).toEqual([]);
    expect(
      issues(manifest({ http: { url: "https://example.com/x" } }, { github: { ...remote, approval: "maybe" } })),
    ).toHaveLength(1);
    expect(
      issues(
        manifest({ http: { url: "https://example.com/x" } }, { local: { name: "local", type: "stdio", command: "x", approval: "always" } }),
      ),
    ).not.toEqual([]);
  });

  it("rebuilds an HTTP tool from its manifest without an implementation, keeping the hash, a pinned approval included", () => {
    const json = manifest({
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      http: { url: "https://billing.example.com/refunds", credential: "billing" },
      approval: "always",
    });
    const restored = Agent.from(json, {});
    expect(restored.manifest.tools![0]).toEqual(json.tools[0]);
    expect(hashManifest(restored.manifest)).toBe(hashManifest(json));
    const tool = restored.getBinding().tools[0]!;
    expect(httpToolOf(tool)).toEqual({ http: json.tools[0]!.http, approval: "always" });
    // The Tool Gate holds such a call (R5 step 2): the tool itself never asks.
    expect(tool.approval).toBeUndefined();
  });
});

describe("http()", () => {
  it("refuses a bad target when it is built", () => {
    expect(() => http({ name: "refund", input: z.object({}), url: "/refunds" })).toThrow(HarnessError);
    expect(() =>
      http({ name: "refund", input: z.object({}), url: "https://example.com/x", timeoutMs: 1_000_000 }),
    ).toThrow(/timeoutMs/);
    // Tool approvals are the Tenant's tool policy (R5 step 2).
    expect(() =>
      http({ name: "refund", input: z.object({}), url: "https://example.com/x", approval: "always" } as never),
    ).toThrow(/approval was removed/);
  });

  it("has no implementation in this process", async () => {
    const tool = http({ name: "refund", input: z.object({}), url: "https://example.com/x" });
    const error = await tool.execute!({} as never, {} as never).catch((caught: unknown) => caught);
    expect(isToolError(error)).toBe(true);
    expect(error).toMatchObject({ code: "http.runtime-only" });
  });
});

describe("URL parameters and methods without a body", () => {
  const order = {
    type: "object",
    properties: { orderId: { type: "string" }, status: { type: "string" } },
    required: ["orderId"],
  };
  const at = (http: Record<string, unknown>, inputSchema: unknown = order) =>
    issues({ manifestSchemaVersion: 7, id: "orders", tools: [{ name: "order", inputSchema, http }] });

  it("accepts {field} in the path for a required scalar field", () => {
    expect(at({ url: "https://api.example.com/orders/{orderId}", method: "GET" })).toEqual([]);
    expect(at({ url: "https://api.example.com/orders/{orderId}/items?v=2", method: "DELETE" })).toEqual([]);
    expect(at({ url: "https://api.example.com/orders/{orderId}", method: "PATCH" })).toEqual([]);
    expect(at({ url: "http://localhost:4000/{orderId}.json" })).toEqual([]);
  });

  it("refuses a malformed template, or one outside the path", () => {
    for (const [url, message] of [
      ["https://api.example.com/orders/{orderId", "url has an unmatched { or }"],
      ["https://api.example.com/orders/orderId}", "url has an unmatched { or }"],
      ["https://api.example.com/orders?id={orderId}", "url may name input fields as {field} only in its path"],
      ["https://api.example.com/{order-id}", "url parameter {order-id} must be an input field name"],
      ["https://api.example.com/{}", "url parameter {} must be an input field name"],
      ["https://api.example.com/{orderId}/{orderId}", "url names {orderId} twice"],
    ])
      expect(at({ url }), url).toEqual([message]);
    expect(at({ url: "https://{host}.example.com/x" })).toHaveLength(1);
  });

  it("refuses a URL parameter that is not a required scalar property of the input", () => {
    expect(at({ url: "https://api.example.com/{status}" })).toEqual([
      "Tool 'order': url names {status}, which the input schema must list as required",
    ]);
    expect(at({ url: "https://api.example.com/{missing}" })).toEqual([
      "Tool 'order': url names {missing}, which is not a property of the input schema",
    ]);
    const tags = { type: "object", properties: { tags: { type: "array" } }, required: ["tags"] };
    expect(at({ url: "https://api.example.com/{tags}" }, tags)).toEqual([
      "Tool 'order': url names {tags}, which must be a string, a number or a boolean",
    ]);
  });

  it("refuses, for GET and DELETE, a field that is an object or a query parameter the URL fixes", () => {
    const filter = {
      type: "object",
      properties: { filter: { type: "object" }, rows: { type: "array", items: { type: "object" } } },
    };
    expect(at({ url: "https://api.example.com/search", method: "GET" }, filter)).toEqual([
      "Tool 'order': 'filter' is sent in the query string by GET, so it must not be an object or hold objects",
    ]);
    expect(at({ url: "https://api.example.com/search", method: "POST" }, filter)).toEqual([]);
    expect(at({ url: "https://api.example.com/orders?status=open", method: "GET" })).toEqual([
      "Tool 'order': 'status' is both an input field and a query parameter the url fixes",
    ]);
  });

  it("is checked when http() builds the tool", () => {
    expect(() =>
      http({ name: "order", input: z.object({ id: z.string() }), url: "https://api.example.com/{orderId}", method: "GET" }),
    ).toThrow("HTTP tool 'order': url names {orderId}, which is not a property of the input schema");
    const tool = http({
      name: "order",
      input: z.object({ orderId: z.string(), expand: z.array(z.string()).optional() }),
      url: "https://api.example.com/orders/{orderId}",
      method: "GET",
    });
    expect(httpToolOf(tool)).toEqual({ http: { url: "https://api.example.com/orders/{orderId}", method: "GET" } });
  });
});

describe("httpToolRequest", () => {
  const request = (url: string, method: string | undefined, input: unknown) =>
    httpToolRequest({ url, ...(method ? { method: method as "GET" } : {}) }, input);

  it("sends a body method's input as it is, as before", () => {
    expect(request("https://api.example.com/refunds", undefined, { orderId: "o-1", amount: 2 })).toEqual({
      url: "https://api.example.com/refunds",
      method: "POST",
      body: '{"orderId":"o-1","amount":2}',
    });
    expect(request("https://api.example.com/refunds", "PUT", undefined)).toMatchObject({ method: "PUT", body: "{}" });
  });

  it("puts a GET's fields in the query string, after the URL's own", () => {
    expect(
      request("https://api.open-meteo.com/v1/forecast?current=temperature_2m,wind_speed_10m", "GET", {
        latitude: 22.57,
        longitude: 88.36,
        timezone: "Asia/Kolkata",
        past_days: null,
        models: ["icon", "gfs"],
        metric: true,
      }),
    ).toEqual({
      url: "https://api.open-meteo.com/v1/forecast?current=temperature_2m,wind_speed_10m&latitude=22.57&longitude=88.36&timezone=Asia%2FKolkata&models=icon&models=gfs&metric=true",
      method: "GET",
    });
    expect(request("https://api.example.com/search", "GET", { q: "a b&c=d#e" })).toEqual({
      url: "https://api.example.com/search?q=a%20b%26c%3Dd%23e",
      method: "GET",
    });
    expect(request("https://api.example.com/search?", "GET", { q: "x" })).toMatchObject({
      url: "https://api.example.com/search?q=x",
    });
    expect(request("https://api.example.com/all", "GET", {})).toEqual({ url: "https://api.example.com/all", method: "GET" });
  });

  it("fills URL parameters percent-encoded, and leaves them out of the query string and the body", () => {
    expect(request("https://api.example.com/orders/{orderId}", "DELETE", { orderId: "a/b?c#d", reason: "dup" })).toEqual({
      url: "https://api.example.com/orders/a%2Fb%3Fc%23d?reason=dup",
      method: "DELETE",
    });
    expect(request("https://api.example.com/users/{id}/orders/{orderId}", "PATCH", { id: 7, orderId: "ö", note: "x" })).toEqual({
      url: "https://api.example.com/users/7/orders/%C3%B6",
      method: "PATCH",
      body: '{"note":"x"}',
    });
    expect(request("https://api.example.com/flags/{on}", "GET", { on: false })).toMatchObject({
      url: "https://api.example.com/flags/false",
    });
  });

  it("refuses a URL parameter that would move the request, and a value the URL cannot hold", () => {
    for (const orderId of ["", ".", "..", null, undefined, { a: 1 }, ["a"], Number.NaN])
      expect(request("https://api.example.com/orders/{orderId}", "GET", { orderId })).toHaveProperty("issue");
    expect(request("https://api.example.com/{a}{b}/x", "GET", { a: ".", b: "." })).toEqual({
      issue: "'a' must be a non-empty string, a number or a boolean, and not . or ..: it fills {a} in the URL",
    });
    expect(request("https://api.example.com/.{a}/x", "GET", { a: "." })).toHaveProperty("issue");
    expect(request("https://api.example.com/{a}{b}/x", "GET", { a: ".x", b: "..y" })).toMatchObject({
      url: "https://api.example.com/.x..y/x",
    });
  });

  it("refuses an object in the query string, and an input that is not an object", () => {
    expect(request("https://api.example.com/search", "GET", { filter: { a: 1 } })).toEqual({
      issue: "'filter' is sent in the query string, so it must not be an object or hold objects",
    });
    expect(request("https://api.example.com/search", "GET", { rows: [{ a: 1 }] })).toHaveProperty("issue");
    expect(request("https://api.example.com/search", "GET", "text")).toEqual({ issue: "The tool input must be an object" });
    expect(request("https://api.example.com/{id}", "POST", ["x"])).toEqual({ issue: "The tool input must be an object" });
  });
});
