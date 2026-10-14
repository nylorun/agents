/**
 * R2b C9: per-tool MCP settings. A `tools` map keyed by the server's own tool names, with `"*"`
 * for the rest, and `deferred` on the server. A turn variant may only tighten them.
 */
import { describe, expect, it } from "vitest";
import { Agent, McpError, approvalRefusal, approvalsOf, mcpToolSettings } from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { isVariantOf } from "../src/definition/variant.js";
import { hashManifest } from "../src/utils/hash.js";
import type { AgentManifest, McpServerManifest } from "../src/types/manifest.js";

const URL = "https://api.githubcopilot.com/mcp/";
const github = { type: "streamable-http" as const, url: URL };

describe("resolving a tool's settings", () => {
  const server: McpServerManifest = {
    name: "github",
    ...github,
    approval: "never",
    deferred: true,
    tools: {
      "*": { enabled: false },
      search_issues: { enabled: true },
      create_issue: { enabled: true, approval: "always", deferred: false },
    },
  };

  it("takes the tool's entry, then '*', then the server, then the default", () => {
    expect(mcpToolSettings(server, "create_issue")).toEqual({ enabled: true, approval: "always", deferred: false });
    expect(mcpToolSettings(server, "search_issues")).toEqual({ enabled: true, approval: "never", deferred: true });
    expect(mcpToolSettings(server, "delete_repo")).toEqual({ enabled: false, approval: "never", deferred: true });
    expect(mcpToolSettings({ name: "plain", ...github }, "anything")).toEqual({ enabled: true, approval: "never" });
  });

  it("never reads a tool named like an Object property as an entry", () => {
    expect(mcpToolSettings({ name: "plain", ...github, tools: {} }, "constructor")).toEqual({
      enabled: true,
      approval: "never",
    });
  });
});

describe("the manifest's MCP settings", () => {
  it("are written as the author set them, on the flat manifest", () => {
    const plain = Agent({ id: "bot" }).mcp({ github }).build().manifest;
    expect(plain).toEqual({ manifestSchemaVersion: 7, id: "bot", mcpServers: { github: { name: "github", ...github } } });
    const allowlist = Agent({ id: "bot" })
      .mcp({ github: { ...github, tools: { "*": { enabled: false }, search_issues: { enabled: true } } } })
      .build().manifest;
    expect(allowlist.manifestSchemaVersion).toBe(7);
    expect(allowlist.mcpServers!.github).toEqual({
      name: "github",
      ...github,
      tools: { "*": { enabled: false }, search_issues: { enabled: true } },
    });
    const deferred = Agent({ id: "bot" }).mcp({ github: { ...github, deferred: true } }).build().manifest;
    expect(deferred.mcpServers!.github!.deferred).toBe(true);
    expect(AgentManifestSchema.safeParse(allowlist).success).toBe(true);
    expect(AgentManifestSchema.safeParse(deferred).success).toBe(true);
  });

  it("keeps the hash when a manifest is rebuilt from its JSON", () => {
    const json = {
      manifestSchemaVersion: 7 as const,
      id: "bot",
      mcpServers: { github: { name: "github", ...github } },
    };
    expect(AgentManifestSchema.parse(json)).toEqual(json);
    const built = Agent({ id: "bot" }).mcp({ github }).build().manifest;
    expect(hashManifest(built)).toBe(hashManifest(json));
    expect(Agent.from(json, {}).manifest).toEqual(json);
    const withSettings = Agent({ id: "bot" })
      .mcp({ github: { ...github, tools: { create_issue: { enabled: false } } } })
      .build().manifest;
    const restored = Agent.from(JSON.parse(JSON.stringify(withSettings)), {});
    expect(hashManifest(restored.manifest)).toBe(hashManifest(withSettings));
  });

  it("refuses settings other than enabled, approval and deferred", () => {
    const json = (tools: unknown) => ({
      manifestSchemaVersion: 7,
      id: "bot",
      mcpServers: { github: { name: "github", ...github, tools } },
    });
    expect(AgentManifestSchema.safeParse(json({ x: { enabled: true } })).success).toBe(true);
    expect(AgentManifestSchema.safeParse(json({ x: { hidden: true } })).success).toBe(false);
    expect(AgentManifestSchema.safeParse(json({ x: { approval: "sometimes" } })).success).toBe(false);
    expect(AgentManifestSchema.safeParse(json({ "": { enabled: true } })).success).toBe(false);
    expect(() =>
      Agent({ id: "bot" }).mcp({ github: { ...github, tools: { x: { hidden: true } as never } } })
    ).toThrow(McpError);
  });
});

describe("a turn variant (Q18)", () => {
  const pinned = (server: Partial<McpServerManifest> = {}): AgentManifest => ({
    manifestSchemaVersion: 7,
    id: "bot",
    mcpServers: { github: { name: "github", ...github, ...server } as McpServerManifest },
  });

  it("may disable a tool, and keeps a pinned approval but adds none (R5 step 2)", () => {
    const pin = pinned({ tools: { create_issue: { approval: "never" } } });
    // Tool approvals are the Tenant's tool policy: a variant cannot ask for one.
    expect(isVariantOf(pinned({ tools: { create_issue: { approval: "always" } } }), pin)).toBe(false);
    expect(
      isVariantOf(pinned({ tools: { create_issue: { approval: "never" }, delete_repo: { enabled: false } } }), pin)
    ).toBe(true);
    expect(isVariantOf(pinned({ tools: { create_issue: { approval: "never" }, "*": { enabled: false } } }), pin)).toBe(
      true
    );
  });

  it("may add a disabled tool's entry to a pin without settings", () => {
    expect(isVariantOf(pinned({ tools: { delete_repo: { enabled: false } } }), pinned())).toBe(true);
  });

  it("is refused when it widens", () => {
    const pin = pinned({
      approval: "always",
      tools: { "*": { enabled: false }, search_issues: { enabled: true }, create_issue: { approval: "always" } },
    });
    const widened: Partial<McpServerManifest>[] = [
      // Enables a tool the allowlist leaves out.
      { approval: "always", tools: { "*": { enabled: false }, search_issues: { enabled: true }, create_issue: { approval: "always" }, delete_repo: { enabled: true } } },
      // Drops the allowlist.
      { approval: "always", tools: { search_issues: { enabled: true }, create_issue: { approval: "always" } } },
      // Lifts an approval, on the tool or on the server.
      { approval: "always", tools: { "*": { enabled: false }, search_issues: { enabled: true }, create_issue: { approval: "never" } } },
      { approval: "never", tools: { "*": { enabled: false }, search_issues: { enabled: true }, create_issue: { approval: "always" } } },
      // Changes deferral, which the session pins.
      { approval: "always", deferred: true, tools: { "*": { enabled: false }, search_issues: { enabled: true }, create_issue: { approval: "always" } } },
      { approval: "always", tools: { "*": { enabled: false }, search_issues: { enabled: true, deferred: true }, create_issue: { approval: "always" } } },
      // Drops every setting.
      { approval: "always" },
    ];
    for (const server of widened) expect(isVariantOf(pinned(server), pin)).toBe(false);
    expect(isVariantOf(pin, pin)).toBe(true);
  });
});

describe("approval, removed (R5 step 2)", () => {
  it("is refused by the builder, on a server or on a tool's settings", () => {
    expect(() => Agent({ id: "bot" }).mcp({ github: { ...github, approval: "always" } as never })).toThrow(/approval was removed/);
    expect(() =>
      Agent({ id: "bot" }).mcp({ github: { ...github, tools: { create_issue: { approval: "always" } } } as never })
    ).toThrow(/approval was removed/);
  });

  it("names where a definition sets it, so a save can refuse it", () => {
    const manifest: AgentManifest = {
      manifestSchemaVersion: 7,
      id: "bot",
      mcpServers: {
        github: { name: "github", ...github, tools: { create_issue: { approval: "always" } } } as McpServerManifest,
      },
    };
    expect(approvalsOf(manifest)).toEqual(["tool 'create_issue' of MCP server 'github' of agent 'bot'"]);
    expect(approvalRefusal(manifest)).toMatch(/^approval was removed from the manifest: remove it from tool 'create_issue'/);
    expect(approvalRefusal(Agent({ id: "bot" }).mcp({ github }).build().manifest)).toBeUndefined();
  });
});
