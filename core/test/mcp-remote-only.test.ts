import { expect, it } from "vitest";
import { Agent, McpError, stdioMcpRefusal } from "../src/define.js";
import { AgentManifestSchema, PutAgentRequestSchema } from "../src/contracts.js";
import { HarnessError } from "../src/errors.js";

const refusal =
  "MCP server 'local' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL.";

const stdioManifest = {
  manifestSchemaVersion: 5 as const,
  id: "local-tools",
  capabilities: [
    {
      id: "mcp",
      type: "agent",
      mcpServers: { local: { name: "local", type: "stdio", command: "./server.mjs" } },
    },
  ],
};

it("words the refusal of a stdio server once", () => {
  expect(stdioMcpRefusal("local")).toBe(refusal);
});

it("refuses a stdio server in the builder", () => {
  const declare = () =>
    Agent({ id: "local-tools" }).mcp({
      local: { type: "stdio", command: "./server.mjs" },
    } as never);
  expect(declare).toThrow(McpError);
  expect(declare).toThrow(refusal);
});

it("refuses a stdio server when a manifest is parsed", () => {
  expect(() => Agent.from(stdioManifest, { mcp: {} })).toThrow(HarnessError);
  expect(() => Agent.from(stdioManifest, { mcp: {} })).toThrow(refusal);
});

it("refuses a stdio server in the wire schema with the same message", () => {
  const parsed = AgentManifestSchema.safeParse(stdioManifest);
  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues.map((issue) => issue.message)).toContain(refusal);
  const put = PutAgentRequestSchema.safeParse({
    requestId: "r1",
    manifest: stdioManifest,
    implementationVersion: "1",
  });
  expect(put.success).toBe(false);
  expect(JSON.stringify(put.error?.issues)).toContain(refusal);
});

it("keeps zod's own message for other bad servers and accepts remote ones", () => {
  const withServer = (server: Record<string, unknown>) => ({
    ...stdioManifest,
    capabilities: [{ id: "mcp", type: "agent", mcpServers: { local: { name: "local", ...server } } }],
  });
  const ftp = AgentManifestSchema.safeParse(withServer({ type: "ftp", url: "ftp://x" }));
  expect(ftp.success).toBe(false);
  expect(JSON.stringify(ftp.error?.issues)).not.toContain("stdio");
  for (const type of ["streamable-http", "sse"])
    expect(
      AgentManifestSchema.safeParse(withServer({ type, url: "https://mcp.example.com/x" })).success,
    ).toBe(true);
});
