/**
 * R2 M3: HTTP tools in the manifest. A tool is an agent or an HTTP request (never both), `fn`
 * and `command` are reserved, and `approval` is static: on an HTTP tool, or on a remote MCP
 * server for all its tools.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, http, httpToolOf, isToolError } from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { HarnessError } from "../src/errors.js";
import { hashManifest } from "../src/utils/hash.js";

const input = { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] };

function manifest(tool: Record<string, unknown>, mcpServers?: Record<string, unknown>) {
  return {
    manifestSchemaVersion: 5 as const,
    id: "orders",
    capabilities: [
      {
        id: "order-tools",
        type: "agent" as const,
        tools: [{ name: "refund", inputSchema: input, ...tool }],
        ...(mcpServers ? { mcpServers } : {}),
      },
    ],
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

  it("refuses methods without a body, a bad timeout, an empty credential and unknown fields", () => {
    expect(issues(manifest({ http: { url: "https://example.com/x", method: "GET" } }))).toHaveLength(1);
    expect(issues(manifest({ http: { url: "https://example.com/x", method: "DELETE" } }))).toHaveLength(1);
    for (const timeoutMs of [0, -1, 1.5, 300_001])
      expect(issues(manifest({ http: { url: "https://example.com/x", timeoutMs } }))).toHaveLength(1);
    expect(issues(manifest({ http: { url: "https://example.com/x", credential: "" } }))).toHaveLength(1);
    expect(issues(manifest({ http: { url: "https://example.com/x", headers: {} } }))).toHaveLength(1);
  });

  it("refuses a tool that is both an agent and an HTTP request", () => {
    const agent = { manifestSchemaVersion: 5, id: "helper", capabilities: [] };
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

  it("rebuilds an HTTP tool from its manifest without an implementation, keeping the hash", () => {
    const json = manifest({
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      http: { url: "https://billing.example.com/refunds", credential: "billing" },
      approval: "always",
    });
    const restored = Agent.from(json, {});
    expect(restored.manifest.capabilities[0]!.tools![0]).toEqual(json.capabilities[0]!.tools[0]);
    expect(hashManifest(restored.manifest)).toBe(hashManifest(json));
    const tool = restored.getBinding().tools[0]!;
    expect(httpToolOf(tool)).toEqual({ http: json.capabilities[0]!.tools[0]!.http, approval: "always" });
    expect(tool.approval?.({} as never)).toBe(true);
  });
});

describe("http()", () => {
  it("refuses a bad target when it is built", () => {
    expect(() => http({ name: "refund", input: z.object({}), url: "/refunds" })).toThrow(HarnessError);
    expect(() =>
      http({ name: "refund", input: z.object({}), url: "https://example.com/x", timeoutMs: 1_000_000 }),
    ).toThrow(/timeoutMs/);
    expect(() =>
      http({ name: "refund", input: z.object({}), url: "https://example.com/x", approval: "sometimes" as never }),
    ).toThrow(/approval/);
  });

  it("has no implementation in this process", async () => {
    const tool = http({ name: "refund", input: z.object({}), url: "https://example.com/x" });
    const error = await tool.execute!({} as never, {} as never).catch((caught: unknown) => caught);
    expect(isToolError(error)).toBe(true);
    expect(error).toMatchObject({ code: "http.runtime-only" });
  });

  it("is not a flow stage", () => {
    const refund = http({ name: "refund", input: z.object({}), url: "https://example.com/x" });
    expect(() => Agent({ id: "refunds" }).pipe(refund as never).build()).toThrow(/HTTP tool/);
  });
});
