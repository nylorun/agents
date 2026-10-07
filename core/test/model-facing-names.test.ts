/**
 * R2b C6: a declared tool's name and an MCP server's name, which prefixes its tools' names, are
 * names every model provider accepts: `^[A-Za-z0-9_-]{1,64}$`, the rule agent tools already use.
 * A manifest naming one otherwise is refused at save.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, http } from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";

const issues = (manifest: unknown) => {
  const parsed = AgentManifestSchema.safeParse(manifest);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

const input = z.object({ id: z.string() });
const withTool = (name: string) =>
  Agent({ id: "bot" })
    .tools(http({ name, input, url: "https://api.example.com/refunds" }))
    .build().manifest;
const withServer = (name: string) =>
  Agent({ id: "bot" })
    .mcp({ [name]: { type: "streamable-http", url: "https://mcp.example.com/mcp" } })
    .build().manifest;

describe("model-facing names at save", () => {
  it("accepts letters, digits, _ and - up to 64 characters", () => {
    expect(issues(withTool("refund_order-2"))).toEqual([]);
    expect(issues(withTool("a".repeat(64)))).toEqual([]);
    expect(issues(withServer("git-hub_2"))).toEqual([]);
  });

  it("refuses a declared HTTP tool named with a dot, or over 64 characters", () => {
    expect(issues(withTool("refunds.create"))).toEqual([
      "Tool name 'refunds.create' may use only letters, digits, _ and -, up to 64 characters, so that every model provider accepts it",
    ]);
    expect(issues(withTool("a".repeat(65)))).toHaveLength(1);
  });

  it("refuses an MCP server named with a dot or a space", () => {
    for (const name of ["github.com", "my server"])
      expect(issues(withServer(name))).toContain(
        `MCP server name '${name}' may use only letters, digits, _ and -, up to 64 characters, so that every model provider accepts it`,
      );
  });
});
