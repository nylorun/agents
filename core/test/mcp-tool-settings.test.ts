/**
 * R2b C9: per-tool MCP settings in manifest v6. A `tools` map keyed by the server's own tool
 * names, with `"*"` for the rest, and `deferred` on the server; v5 manifests are accepted
 * unchanged, and the builder writes v6 only for a manifest that uses them. A turn variant may only
 * tighten them.
 */
import { describe, expect, it } from "vitest";
import { Agent, McpError, mcpToolSettings } from "../src/define.js";
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

describe("manifest v6", () => {
  it("is what the builder writes only when a server sets tools or deferred", () => {
    const plain = Agent({ id: "bot" }).mcp({ github }).build().manifest;
    expect(plain.manifestSchemaVersion).toBe(5);
    const allowlist = Agent({ id: "bot" })
      .mcp({ github: { ...github, tools: { "*": { enabled: false }, search_issues: { enabled: true } } } })
      .build().manifest;
    expect(allowlist.manifestSchemaVersion).toBe(6);
    expect(allowlist.capabilities[0]!.mcpServers!.github).toEqual({
      name: "github",
      ...github,
      tools: { "*": { enabled: false }, search_issues: { enabled: true } },
    });
    const deferred = Agent({ id: "bot" }).mcp({ github: { ...github, deferred: true } }).build().manifest;
    expect(deferred.manifestSchemaVersion).toBe(6);
    expect(AgentManifestSchema.safeParse(allowlist).success).toBe(true);
    expect(AgentManifestSchema.safeParse(deferred).success).toBe(true);
  });

  it("keeps a v5 manifest's hash: the same JSON as before, accepted unchanged", () => {
    const json = {
      manifestSchemaVersion: 5 as const,
      id: "bot",
      capabilities: [{ id: "mcp", type: "agent" as const, mcpServers: { github: { name: "github", ...github } } }],
    };
    expect(AgentManifestSchema.parse(json)).toEqual(json);
    const built = Agent({ id: "bot" }).mcp({ github }).build().manifest;
    expect(hashManifest(built)).toBe(hashManifest(json));
    const restored = Agent.from(json, {});
    expect(restored.manifest).toEqual(json);
  });

  it("refuses tools or deferred in a v5 manifest, with the version they need", () => {
    for (const settings of [{ tools: { "*": { enabled: false } } }, { deferred: true }]) {
      const json = {
        manifestSchemaVersion: 5,
        id: "bot",
        capabilities: [{ id: "mcp", type: "agent", mcpServers: { github: { name: "github", ...github, ...settings } } }],
      };
      const parsed = AgentManifestSchema.safeParse(json);
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues.map((issue) => issue.message)).toContain(
        "MCP server 'github' sets tools or deferred, which need manifestSchemaVersion 6. Rebuild the agent with the current SDK"
      );
      expect(() => Agent.from(json, {})).toThrow(/need manifestSchemaVersion 6/);
    }
  });

  it("refuses settings other than enabled, approval and deferred", () => {
    const json = (tools: unknown) => ({
      manifestSchemaVersion: 6,
      id: "bot",
      capabilities: [{ id: "mcp", type: "agent", mcpServers: { github: { name: "github", ...github, tools } } }],
    });
    expect(AgentManifestSchema.safeParse(json({ x: { enabled: true } })).success).toBe(true);
    expect(AgentManifestSchema.safeParse(json({ x: { hidden: true } })).success).toBe(false);
    expect(AgentManifestSchema.safeParse(json({ x: { approval: "sometimes" } })).success).toBe(false);
    expect(AgentManifestSchema.safeParse(json({ "": { enabled: true } })).success).toBe(false);
    expect(() =>
      Agent({ id: "bot" }).mcp({ github: { ...github, tools: { x: { hidden: true } as never } } })
    ).toThrow(McpError);
  });

  it("rebuilds a v6 manifest at v6, with or without v6 fields, so its hash holds", () => {
    const withSettings = Agent({ id: "bot" })
      .mcp({ github: { ...github, tools: { create_issue: { approval: "always" } } } })
      .build().manifest;
    const restored = Agent.from(JSON.parse(JSON.stringify(withSettings)), {});
    expect(hashManifest(restored.manifest)).toBe(hashManifest(withSettings));
    const bare = { manifestSchemaVersion: 6 as const, id: "bot", capabilities: [] };
    expect(AgentManifestSchema.safeParse(bare).success).toBe(true);
    expect(Agent.from(bare, {}).manifest.manifestSchemaVersion).toBe(6);
  });

  it("still refuses an unknown version", () => {
    const parsed = AgentManifestSchema.safeParse({ manifestSchemaVersion: 7, id: "bot", capabilities: [] });
    expect(parsed.error!.issues[0]!.message).toBe("Unsupported manifestSchemaVersion 7");
  });
});

describe("a turn variant (Q18)", () => {
  const pinned = (server: Partial<McpServerManifest> = {}): AgentManifest => ({
    manifestSchemaVersion: 6,
    id: "bot",
    capabilities: [
      {
        id: "mcp",
        type: "agent",
        mcpServers: { github: { name: "github", ...github, ...server } as McpServerManifest },
      },
    ],
  });

  it("may disable a tool or require its approval", () => {
    const pin = pinned({ tools: { create_issue: { approval: "never" } } });
    expect(isVariantOf(pinned({ tools: { create_issue: { approval: "always" } } }), pin)).toBe(true);
    expect(
      isVariantOf(pinned({ tools: { create_issue: { approval: "never" }, delete_repo: { enabled: false } } }), pin)
    ).toBe(true);
    expect(isVariantOf(pinned({ tools: { create_issue: { approval: "never" }, "*": { enabled: false } } }), pin)).toBe(
      true
    );
  });

  it("may tighten a v5 pin with a v6 variant", () => {
    const pin = { ...pinned(), manifestSchemaVersion: 5 as const };
    expect(isVariantOf(pinned({ tools: { delete_repo: { enabled: false } } }), pin)).toBe(true);
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
